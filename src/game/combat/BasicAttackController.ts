import { hasFlag } from '@/utils/index';
import ActionState from '@/game/enums/ActionState';
import EventType from '@/game/enums/EventType';
import { canSee } from '@/game/combat/Vision';
import { breakStealthOn } from '@/game/combat/StealthBreak';
import type AttackableUnit from '@/game/gameObject/attackableUnits/AttackableUnit';
import { FALLBACK_CHASE_MARGIN, findAttackTargetNearPoint } from './AttackTargeting';
import {
  BasicAttackBolt,
  BasicAttackSwing,
  MELEE_RANGE_THRESHOLD,
  MELEE_WINDUP_MS,
  RANGED_BOLT_UNITS_PER_SECOND,
  RANGED_WINDUP_FRACTION,
  RANGED_WINDUP_MAX_MS,
  canBeHit,
} from './BasicAttack';

/**
 * Why an attack order stopped. Surfaced so callers (the AI, later an order
 * queue) can tell "it died" from "it walked out of my sight".
 */
export type AttackOrderEnd = 'KILLED' | 'LOST' | 'CLEARED' | 'DISABLED';

/** `EventType.ON_ATTACK_LAUNCH`'s payload: one committed swing, both ends of it. */
export interface AttackLaunchEvent {
  attacker: AttackableUnit;
  target: AttackableUnit;
}

/** The sweep's cadence — the same beat the bot brain thinks on. */
export const ATTACK_MOVE_SCAN_INTERVAL_MS = 250;
/** Close enough to an attack-move point to call the order done. */
export const ATTACK_MOVE_ARRIVE_PX = 25;

/**
 * Owns one unit's basic attack: the standing order, the walk into range, the
 * swing timer, the wind-up hold, and the two events that make the attack
 * visible to spells.
 *
 * Composition rather than a base class, because the three units that already
 * attack (Minion, Monster, Turret) each grew their own loop and unifying them is
 * a separate change. This one is written to be adoptable by them as it is: it
 * only ever touches `owner.stats`, `owner.moveTo/stopMovement` and the object
 * manager.
 *
 * The controller never scans for targets — a target is always *given* to it,
 * by the player's right click or by the AI's own jittered scan — with one
 * stated exception: a standing **attack-move** order (`orderAttackMove`, the
 * player's `A` onto empty ground) sweeps for the nearest visible enemy on a
 * 250ms beat while it walks its point down. Only that order pays a query, and
 * only while it stands, so an idle champion still costs zero per frame.
 */
export default class BasicAttackController {
  readonly owner: AttackableUnit;

  /** Standing order. Null means the unit is not attacking anything. */
  target: AttackableUnit | null = null;
  /** ms until the next swing may start. Runs whether or not there is a target,
   *  so switching targets does not refund the wind-down of the last swing. */
  cooldownMs = 0;
  /** Why the last order ended. Reset when a new one is issued. */
  lastEnd: AttackOrderEnd | null = null;
  /**
   * ms during which the owner's own move order outranks this controller's
   * "stand still and wait for the swing".
   *
   * Kiting needs it and nothing else does. Once a target is inside reach this
   * controller calls `stopMovement()` every frame, which is right for a unit
   * that has nothing better to do — and which deleted a step back before the
   * champion had taken it, so a ranged bot stood in the gaps between its own
   * swings. `BotBrain.kiteStep` opens a window here and the window closes on
   * its own; committing to a swing closes it early, so a kiting bot fires on
   * the beat rather than running away from the fight.
   *
   * A plain countdown rather than a flag, because the writer thinks four times
   * a second and this is read sixty: a flag would have to be cleared by
   * somebody, and the somebody would be a frame that never came.
   */
  repositionMs = 0;
  /**
   * ms the current swing still roots its owner — the wind-up, the one beat of
   * stillness that stands in for an attack animation this canvas does not
   * have. While it runs, the owner's own move orders are overridden rather
   * than obeyed; hit-and-run is still the game, but each hit costs its beat.
   * Crowd control that clears CAN_ATTACK is the only cancel, and the nocked
   * bolt (`BasicAttackBolt.armMs`) or the swing's own reach check
   * (`BasicAttackSwing.strike`) cancels with it.
   */
  windupMs = 0;
  /**
   * The attack-move order: walk here, fighting whatever the sweep meets on
   * the way. Survives the targets the sweep itself picks — a kill hands the
   * walk back — and is cleared by any explicit order, move or attack.
   */
  moveOrder: { x: number; y: number } | null = null;
  private scanMs = 0;

  constructor(owner: AttackableUnit) {
    this.owner = owner;
  }

  get attackDamage(): number {
    return this.owner.stats.attackDamage.value;
  }

  /** Attacks per second, floored so a zeroed stat cannot divide by zero. */
  get attacksPerSecond(): number {
    return Math.max(0.05, this.owner.stats.attackSpeed.value);
  }

  get intervalMs(): number {
    return 1_000 / this.attacksPerSecond;
  }

  get isRanged(): boolean {
    return this.owner.stats.attackRange.value > MELEE_RANGE_THRESHOLD;
  }

  /** Surface to surface: a 40-unit reach can never satisfy itself against two
   *  55-unit bodies standing next to each other. */
  reachTo(target: AttackableUnit): number {
    return (
      this.owner.stats.attackRange.value +
      this.owner.stats.size.value / 2 +
      (target.stats?.size?.value ?? 0) / 2
    );
  }

  /** The ranged wind-up: a fraction of the live interval, so attack speed buys
   *  the lock down, under the ceiling. See RANGED_WINDUP_FRACTION's header. */
  windupFor(): number {
    return Math.min(RANGED_WINDUP_MAX_MS, this.intervalMs * RANGED_WINDUP_FRACTION);
  }

  order(target: AttackableUnit | null): void {
    if (!target || target === this.owner || target.teamId === this.owner.teamId) return;
    if (!canBeHit(target)) return;
    // an explicit order replaces a standing attack-move sweep
    this.moveOrder = null;
    this.target = target;
    this.lastEnd = null;
  }

  /**
   * The attack-move order — the source game's `A` onto empty ground. The unit
   * walks toward the point, sweeping as it goes, and opens fire on the first
   * visible enemy the sweep meets; the point is resumed after each kill and
   * the order ends on arrival, on any explicit order, or on crowd control.
   */
  orderAttackMove(x: number, y: number): void {
    this.target = null;
    this.moveOrder = { x, y };
    this.scanMs = 0;
    this.lastEnd = null;
  }

  /** Drop the order without stopping the unit — a move order does its own moving. */
  clear(): void {
    if (this.target) this.lastEnd = 'CLEARED';
    this.target = null;
    this.moveOrder = null;
  }

  update(): void {
    if (this.cooldownMs > 0) this.cooldownMs -= deltaTime;
    if (this.repositionMs > 0) this.repositionMs -= deltaTime;

    if (this.owner.isDead) {
      this.target = null;
      this.moveOrder = null;
      this.windupMs = 0;
      return;
    }

    // The wind-up hold. The commit already happened — the bolt is nocked, or
    // the melee swing object is winding — so all that is left to do here is
    // keep the feet planted until the beat has passed. Crowd control ends the
    // hold (and the delivery objects cancel themselves off the same fact).
    if (this.windupMs > 0) {
      this.windupMs -= deltaTime;
      if (this.owner.canAttack) {
        this.owner.stopMovement();
        return;
      }
      this.windupMs = 0;
    }

    const target = this.target;
    if (!target) {
      this.sweep();
      return;
    }

    // Crowd control ends the order, it does not pause it. A stun, charm, fear,
    // suppression or disarm all clear ActionState.CAN_ATTACK, and every one of
    // them is a moment where the unit stopped being the one deciding what it is
    // doing — coming out of it still glued to whoever it was chasing is how a
    // sticky order turns into a unit that walks itself into a losing fight. The
    // player presses again; the AI re-scans within its interval.
    if (!this.owner.canAttack) {
      this.lastEnd = 'DISABLED';
      this.target = null;
      this.moveOrder = null;
      this.owner.stopMovement();
      return;
    }

    const reach = this.reachTo(target);
    if (!this.canKeep(target)) {
      // A lock goes stale between frames: the target dies, is removed, is made
      // untargetable, vanishes into stealth, or slips out of everything the
      // team can see. In every one of those cases the unit stops where it is
      // rather than picking a new fight nobody ordered.
      this.lastEnd = target.isDead || target.toRemove ? 'KILLED' : 'LOST';
      this.target = null;
      this.owner.stopMovement();
      return;
    }

    const distance = p5.Vector.dist(this.owner.position, target.position);
    if (distance > reach) {
      // Routed, not straight: a chase across a wall used to end with the
      // attacker pressed into it. This is called every frame at a target that
      // keeps moving, which PathAgent collapses into one plan re-checked a few
      // times a second — see the throttles there.
      this.owner.navigateTo(target.position.x, target.position.y);
      return;
    }

    // In reach. Plant, unless somebody has claimed the next few hundred ms to
    // reposition with — see `repositionMs`.
    if (this.repositionMs <= 0) this.owner.stopMovement();
    if (this.cooldownMs > 0) return;
    if (!this.owner.canAttack) return;

    // The swing wins over the step: a kiting unit plants for the frame it fires
    // on, whatever window was still open — and now for the whole wind-up.
    this.repositionMs = 0;
    this.owner.stopMovement();
    this.cooldownMs = this.intervalMs;
    this.windupMs = this.isRanged ? this.windupFor() : MELEE_WINDUP_MS;
    this.launch(target, reach);
  }

  /** Whether the standing order is still worth keeping this frame. */
  canKeep(target: AttackableUnit): boolean {
    if (!canBeHit(target)) return false;
    // stealth is not untargetability, but chasing something invisible is the
    // same bad experience, so an order drops on it too
    if (hasFlag(target.stats.actionState, ActionState.STEALTHED)) return false;
    // A unit with no sight of its own — a trap-pet, a chomper — keeps the old
    // touch-range leash. It cannot *see* anything, and `canSee`'s own-view
    // pass is deliberately distance-free (bounding candidates is the caller's
    // job — this is that bounding), so handing it to `canSee` turned every
    // blind trap into a fighter that never lets go.
    const ownSight = this.owner.stats.visionRadius.value;
    if (ownSight <= 0) {
      const touch = ownSight + (target.stats?.size?.value ?? 0) / 2;
      return p5.Vector.dist(this.owner.position, target.position) <= touch;
    }
    // The leash is sight, not a radius of the chaser's own: an ordered target
    // is pursued as far as the team can actually see it — across the whole
    // map in open ground, the source game's own rule — and the order drops
    // the moment it slips into fog or an unshared bush. This used to be
    // `visionRadius` as a distance, which dropped a perfectly visible target
    // the player had explicitly clicked, two steps into the chase, and left
    // the champion standing still on an order it looked like it accepted.
    return canSee(this.owner, target);
  }

  /**
   * One tick of a standing attack-move order: scan on the beat, otherwise
   * walk the point down, and end the order on arrival.
   */
  private sweep(): void {
    const destination = this.moveOrder;
    if (!destination) return;

    this.scanMs -= deltaTime;
    if (this.scanMs <= 0) {
      this.scanMs = ATTACK_MOVE_SCAN_INTERVAL_MS;
      const found = findAttackTargetNearPoint(this.owner, this.owner.position, this.sweepRadius());
      if (found) {
        // Straight onto `target`, not through `order()`: an explicit order
        // replaces the sweep, but the sweep's own pick must leave the walk
        // standing so a kill resumes it.
        this.target = found;
        this.lastEnd = null;
        return;
      }
    }

    const dx = destination.x - this.owner.position.x;
    const dy = destination.y - this.owner.position.y;
    if (Math.hypot(dx, dy) <= ATTACK_MOVE_ARRIVE_PX) {
      this.moveOrder = null;
      this.owner.stopMovement();
      return;
    }
    this.owner.navigateTo(destination.x, destination.y);
  }

  /**
   * What the sweep may open fire on: the same derivation as the `A` key's own
   * fallback — someone this unit can plausibly engage, never a charge across
   * open ground after a speck at the edge of vision.
   */
  sweepRadius(): number {
    const reach = this.owner.stats.attackRange.value + this.owner.stats.size.value / 2;
    return Math.min(reach + FALLBACK_CHASE_MARGIN, this.owner.stats.visionRadius.value);
  }

  /**
   * One committed swing, replayed on a LAN client from the host's
   * `ON_ATTACK_LAUNCH` — the wind-up and the carrier object, nothing else.
   * No order, no cooldown bookkeeping, no `canAttack` question: the host
   * already answered all of that when it committed the swing, and this
   * controller's own decision path never runs on a puppet (it holds no
   * orders). The carrier's damage then dies in the client's gated
   * `takeDamage`, which is what makes a pure visual replay safe.
   */
  replayLaunch(target: AttackableUnit): void {
    this.windupMs = this.isRanged ? this.windupFor() : MELEE_WINDUP_MS;
    this.launch(target, this.reachTo(target));
  }

  /**
   * Fires one swing. ON_ATTACK is emitted here, at the start, with the attacker
   * as its payload — that is the shape one channel-breaking ultimate already listens for, and
   * "the unit committed to a swing" is exactly when a channel should break.
   * ON_ATTACK_HIT comes later, from whichever object actually lands.
   */
  launch(target: AttackableUnit, reach: number): void {
    const damage = this.attackDamage;
    const ranged = this.isRanged;

    // Committing to a swing is what gives a unit away, not landing it: League
    // grants the reveal for the *action*, and hanging it on the bolt's impact
    // would leave a ranged attacker invisible for the whole of its flight —
    // the exact stretch in which the victim is trying to work out where the
    // arrow came from. See `combat/AttackReveal.ts`.
    this.owner.revealForAttack();
    // And the harder half of the same fact: a hidden attacker stops being
    // hidden. This is the one stealth seam that is not the damage funnel, and
    // it is here for the same reason the reveal above is — a swing is a
    // committed hit, and waiting for the bolt to land would hide the attacker
    // through the whole flight. See `combat/StealthBreak.ts`.
    breakStealthOn(this.owner);

    this.owner.game?.eventManager?.emit(EventType.ON_ATTACK, this.owner);
    // The richer twin, for the LAN host to forward (see the enum's comment):
    // a client's puppet champions hold no orders, so this controller never
    // fires there and every champion swing a client sees is a replay.
    this.owner.game?.eventManager?.emit(EventType.ON_ATTACK_LAUNCH, {
      attacker: this.owner,
      target,
    } satisfies AttackLaunchEvent);

    if (ranged) {
      const bolt = new BasicAttackBolt(this.owner);
      bolt.target = target;
      bolt.damage = damage;
      // The unit's own missile speed — the per-champion tuning a pack ships —
      // over the slow shared default for anything that declares none.
      bolt.speed = (this.owner.attackBoltUnitsPerSecond ?? RANGED_BOLT_UNITS_PER_SECOND) / 60;
      bolt.position.set(this.owner.position.x, this.owner.position.y);
      bolt.destination.set(target.position.x, target.position.y);
      // Nocked for the wind-up: it rides the attacker, charging visibly, and
      // flies when the beat has passed.
      bolt.arm(this.windupMs);
      this.owner.game.objectManager.addObject?.(bolt);
    } else {
      const swing = new BasicAttackSwing(this.owner, target);
      swing.damage = damage;
      swing.reach = reach;
      this.owner.game.objectManager.addObject?.(swing);
    }
  }
}
