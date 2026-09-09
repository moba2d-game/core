import EventType from '@/game/enums/EventType';
import { applyOnHitEffects } from '@/game/combat/OnHit';
import {
  BASIC_ATTACK_ATTRIBUTION,
  BASIC_ATTACK_SOURCE,
  beginAttribution,
  endAttribution,
} from '@/game/combat/DamageAttribution';
import { drawMeleeStrike, drawMeleeWindup } from '@/game/vfx/MeleeSwing';
import MissileSpellObject, { STALLED_CHASE_MS } from '@/game/gameObject/MissileSpellObject';
import SpellObject from '@/game/gameObject/SpellObject';
import TrailSystem from '@/game/gameObject/helpers/TrailSystem';
import type AttackableUnit from '@/game/gameObject/attackableUnits/AttackableUnit';

/**
 * Basic attack delivery: the two objects that carry a swing from the attacker to
 * the victim, and the single function where a basic attack is allowed to become
 * damage.
 *
 * Nothing here decides *when* to attack — that is BasicAttackController. This
 * module only owns the part between the swing starting and the damage landing,
 * which is where every "did the target die / walk away / go untargetable in the
 * meantime" question has to be answered.
 */

/**
 * The *fallback* projectile speed in world units per second — what a ranged
 * unit with no tuning of its own fires at (a monster, a structure without a
 * turret class). A champion never uses this: `Champion.applyAttackTuning`
 * always sets `attackBoltUnitsPerSecond`, defaulting to
 * `DEFAULT_CHAMPION_ATTACK`'s 1000 and tuned per champion by the pack
 * (~500-1900, the source game's own per-champion missile speeds at half
 * scale — a buckshot near-hitscan and an enchanter's lob are different
 * weapons and read as such).
 *
 * 420 used to be every champion's speed too, chosen only to sit above the
 * minions' 360 — 2.3× the champion's own 180 units/s walk, against the 5-11×
 * the genre tunes autos to, and every ranged auto read as a lob. Champion
 * bolts now overlap the 780-1200 band spell missiles fly in; what keeps a
 * basic attack from being mistaken for a skillshot is not the speed band any
 * more but what it always really was — a bolt is small, homes on its victim
 * and cannot be sidestepped, where a skillshot is bigger, flies a straight
 * line and misses.
 */
export const RANGED_BOLT_UNITS_PER_SECOND = 420;
/** The engine steps missiles once per frame at 60fps. */
export const RANGED_BOLT_SPEED = RANGED_BOLT_UNITS_PER_SECOND / 60;
/** ms of wind-up before a melee swing resolves. Heavier than a minion's 130ms. */
export const MELEE_WINDUP_MS = 180;
/** Total ms a melee swing's visual lives, wind-up through fade. */
export const MELEE_SWING_TOTAL_MS = 380;
/**
 * attackRange at or below this is delivered as a melee swing, above it as a
 * travelling bolt. One number decides which a champion is, so a melee champion
 * is a stat edit rather than a subclass.
 */
export const MELEE_RANGE_THRESHOLD = 140;
/**
 * The wind-up: the beat of stillness a swing costs before it releases.
 *
 * A basic attack used to leave the attacker fully mobile — the bolt left on
 * the commit frame and nothing in the body ever acknowledged the shot, so a
 * kiting champion read as a gun turret strapped to a walk. This canvas has no
 * attack animations; the stop *is* the animation. The source game roots an
 * attacker for the front fraction of every swing and kiting is the skill of
 * moving in the gaps between them, so the ranged wind-up here is a fraction
 * of the live interval — attack speed buys the lock down, exactly as it does
 * there — under a ceiling so a slow attacker reads as deliberate rather than
 * stuck. Melee's beat is MELEE_WINDUP_MS, which BasicAttackSwing already
 * carries; the controller holds the attacker for the same span so a strike
 * cannot be walked out of its own reach.
 */
export const RANGED_WINDUP_FRACTION = 0.25;
export const RANGED_WINDUP_MAX_MS = 300;

/**
 * Payload of EventType.ON_ATTACK_HIT. This is the seam an on-hit passive (Toxic
 * Shot, a lifesteal item, an attack-speed-on-hit stack) subscribes to: it fires
 * once per landed basic attack, after the damage has been applied, so a listener
 * can read the real number that landed.
 *
 * EventType.ON_ATTACK is the other half and fires when the swing *starts*, with
 * the attacking unit as its whole payload — that shape predates this module
 * (a channel-breaking ultimate cancels on it) and is kept as it is.
 */
export interface BasicAttackHit {
  attacker: AttackableUnit;
  victim: AttackableUnit;
  /** Damage requested, before the victim's shields and modifiers see it. */
  damage: number;
  /** True for a bolt, false for a melee swing. */
  ranged: boolean;
  /** True when the crit roll came up. Absent on anything that predates the roll. */
  crit?: boolean;
}

/** A unit that can still be hit right now. */
export const canBeHit = (victim: AttackableUnit | null): victim is AttackableUnit =>
  !!victim && !victim.isDead && !victim.toRemove && !!victim.position && victim.targetable;

/** One frame at 60fps — `stats.speed` is units per frame at that rate. */
const FRAME_MS = 1000 / 60;

/**
 * Whether a swing whose wind-up has just finished may still land.
 *
 * **A target cannot walk out of a melee attack. It can blink, dash or be
 * knocked out of one.** That is the whole rule, and the reason it needs stating
 * is that the obvious check — `dist > reach` against the same reach the swing
 * was launched at — quietly meant the opposite.
 *
 * The controller launches on the first frame the target is inside reach, which
 * when chasing something is exactly *at* the boundary, and then roots the
 * attacker for the whole wind-up (`stopMovement()` every frame). So the target
 * walks and the attacker cannot. At `MELEE_WINDUP_MS` of 180 and a default
 * `speed` of 2.6 units per frame that is ~28 units of separation the attacker
 * has no way to answer — every basic attack aimed at anything walking away
 * missed, permanently, while `BasicAttackBolt.onArrive` checked no distance at
 * all and a ranged champion never missed. Reported as melee champions whiffing
 * constantly, which is exactly what it was.
 *
 * The tolerance is what the victim could have *walked* in that window, so the
 * cancellation is exact: walking is never enough, and anything that covers more
 * ground than walking still gets away. Read off the victim's own speed rather
 * than a constant, because a fast champion opens a bigger gap and it is the
 * same gap that has to be forgiven.
 */
export function stillInReach(
  attacker: AttackableUnit,
  victim: AttackableUnit,
  reach: number,
  windupMs: number
): boolean {
  const walked = Math.max(0, victim.stats?.speed?.value ?? 0) * (windupMs / FRAME_MS);
  return p5.Vector.dist(attacker.position, victim.position) <= reach + walked;
}

/**
 * The one place a basic attack turns into damage. Both delivery objects funnel
 * through here so the validity rules and the on-hit event can never drift apart.
 * Returns whether the attack actually landed.
 *
 * The whole of it runs under `BASIC_ATTACK_ATTRIBUTION` — a swing is a swing
 * whatever built the object that delivered it, rather than whatever cast
 * happened to be ambient when the controller launched it. See that constant.
 * Anything that brackets an attribution of its own from in here (a buff
 * reacting to the hit) still wins: `beginAttribution` nests.
 */
export function landBasicAttack(
  attacker: AttackableUnit,
  victim: AttackableUnit | null,
  damage: number,
  ranged: boolean
): boolean {
  if (attacker.isDead || !canBeHit(victim)) return false;

  const previousAttribution = beginAttribution(BASIC_ATTACK_ATTRIBUTION);
  try {
    return landSwing(attacker, victim, damage, ranged);
  } finally {
    endAttribution(previousAttribution);
  }
}

/** The swing itself, once the validity rules above have let it through. */
function landSwing(
  attacker: AttackableUnit,
  victim: AttackableUnit,
  damage: number,
  ranged: boolean
): boolean {
  // On-hit first, then the crit multiplier over the total — the order League
  // uses, and the one that makes stacking the two feel worth it. Both stats
  // sit at 0 by default, so a unit nobody has buffed swings for exactly what
  // it swung for before these existed.
  const bonus = attacker.stats?.onHitDamage?.value ?? 0;
  const crit = rollCrit(attacker);
  const total = (damage + bonus) * (crit ? (attacker.stats?.critDamage?.value ?? 1) : 1);

  // **The one caller that names a type.** Everything else in the game is an
  // ability, and an ability is magic unless it says otherwise — see
  // `combat/Mitigation.ts`'s header on why the default runs that way round.
  // `landBasicAttack` is the sole place a swing becomes damage, so this single
  // line is what makes armour mean anything at all.
  // `crit` rides along as presentation only: the multiplier is already in
  // `total`, and the victim's `presentHit` is what makes a crit look like one
  // (bigger number, longer flash, the spark) — on both ends of a LAN match.
  victim.takeDamage(total, attacker, 'PHYSICAL', BASIC_ATTACK_SOURCE, { crit });
  // After the swing's own damage, before the observation event: an on-hit
  // effect is part of the attack (League's order too), so anything watching
  // ON_ATTACK_HIT sees the world with the whole attack already applied. Each
  // effect deals its own separately-typed damage — nothing here re-enters the
  // physical hit above. See `combat/OnHit.ts`.
  applyOnHitEffects({ attacker, victim, damage: total, ranged, crit, echo: false });
  attacker.game?.eventManager?.emit(EventType.ON_ATTACK_HIT, {
    attacker,
    victim,
    damage: total,
    ranged,
    crit,
  } satisfies BasicAttackHit);
  return true;
}

/**
 * The dice, in one place. `critChance` defaults to 0 and nothing in the base
 * game grants it, so this returns false — deterministically — for every unit
 * that has not been handed the stat, which is what keeps the combat tests from
 * having to seed a random.
 */
function rollCrit(attacker: AttackableUnit): boolean {
  const chance = attacker.stats?.critChance?.value ?? 0;
  return chance > 0 && Math.random() < chance;
}

/**
 * The ranged basic attack. Homes on one unit and damages it on arrival, nothing
 * on the way — `maxHitCount = 0` switches MissileSpellObject's in-flight
 * collision off entirely, the same trick TurretBolt uses.
 *
 * A disarm landing while this is in the air does not stop it: the shot has left
 * the bow. Only the victim going away can.
 */
export class BasicAttackBolt extends MissileSpellObject {
  speed = RANGED_BOLT_SPEED;
  size = 16;
  maxHitCount = 0;
  removeOnArrive = true;
  damage = 0;
  target: AttackableUnit | null = null;
  color: number[] = [255, 236, 190];
  /**
   * Chases until it lands or its target is gone; gives up only on a target
   * outrunning it. Was `BOLT_MAX_LIFE_MS`, a 1260px wall a champion on a map
   * with a widened `attackRange` shot straight into. See
   * `MissileSpellObject.stalledChaseMs`.
   */
  stalledChaseMs = STALLED_CHASE_MS;
  /**
   * ms the bolt is still on the string — the attacker's wind-up. While nocked
   * it rides the attacker instead of flying, brightening as the release nears
   * (the wind-up made visible), and it cancels itself outright if the attacker
   * dies or loses CAN_ATTACK: there is no shot to dodge yet.
   */
  armMs = 0;
  private armTotalMs = 0;
  private flightSpeed: number | null = null;

  trailSystem: TrailSystem | null = new TrailSystem({
    trailColor: '#ffe9bcaa',
    trailSize: 6,
    maxLength: 9,
    trailLifeTime: 180,
  });

  /** Nock the bolt for `ms` — the controller's wind-up, handed over once. */
  arm(ms: number): void {
    this.armMs = ms;
    this.armTotalMs = ms;
  }

  /**
   * How far through the nock this bolt is: 0 as it is drawn, 1 as it leaves.
   *
   * `protected` rather than private state read inline, because a subclass draws
   * a different shot from the same nock — `MinionBolt` paints a caster's
   * gathering orb and a cart's shell — and reproducing this expression is how
   * two bolts end up charging at different rates from the same timer.
   */
  protected nockCharge(): number {
    return this.armTotalMs > 0 ? 1 - Math.max(0, this.armMs) / this.armTotalMs : 1;
  }

  onBeforeMove(): void {
    if (this.armMs > 0) {
      this.armMs -= deltaTime;
      if (this.owner.isDead || !this.owner.canAttack) {
        this.toRemove = true;
        return;
      }
      if (this.flightSpeed === null) this.flightSpeed = this.speed;
      this.speed = 0;
      this.position.set(this.owner.position.x, this.owner.position.y);
      if (this.target && !this.target.isDead && !this.target.toRemove) {
        this.destination.set(this.target.position.x, this.target.position.y);
      }
      return;
    }
    if (this.flightSpeed !== null) {
      this.speed = this.flightSpeed;
      this.flightSpeed = null;
    }
    // keep homing while the target lives; once it is gone the bolt finishes its
    // flight to the last known point and lands on nobody
    if (this.target && !this.target.isDead && !this.target.toRemove) {
      this.destination.set(this.target.position.x, this.target.position.y);
    }
  }

  onArrive(): void {
    landBasicAttack(this.owner, this.target, this.damage, true);
  }

  draw(): void {
    const pos = this.position;
    const [r, g, b] = this.color;
    const nocked = this.armMs > 0;
    const charge = this.nockCharge();
    push();
    noStroke();
    if (nocked) {
      // charging on the attacker: small and dim to full and bright at release
      fill(r, g, b, 40 + 50 * charge);
      circle(pos.x, pos.y, this.size * (0.8 + 1.1 * charge));
      fill(255, 255, 255, 110 + 120 * charge);
      circle(pos.x, pos.y, this.size * (0.25 + 0.35 * charge));
    } else {
      fill(r, g, b, 90);
      circle(pos.x, pos.y, this.size * 1.9);
      fill(255, 255, 255, 230);
      circle(pos.x, pos.y, this.size * 0.6);
    }
    pop();
  }
}

/**
 * The melee basic attack. Nothing travels, so this is a plain SpellObject: a
 * wind-up, then a fan-shaped swipe that resolves on contact. The wind-up is what
 * makes a melee exchange readable, and it is also a real window — a disarm, a
 * death, or the target walking out of reach during it all cancel the strike.
 */
export class BasicAttackSwing extends SpellObject {
  target: AttackableUnit | null;
  damage = 0;
  /** Surface-to-surface reach, re-checked at the strike instant. */
  reach = 0;
  color: number[] = [255, 220, 160];
  age = 0;
  struck = false;

  constructor(owner: AttackableUnit, target: AttackableUnit) {
    super(owner);
    this.target = target;
  }

  update(): void {
    this.age += deltaTime;
    this.position.set(this.owner.position.x, this.owner.position.y);

    if (!this.struck && this.age >= MELEE_WINDUP_MS) {
      this.struck = true;
      this.strike();
    }
    if (this.age >= MELEE_SWING_TOTAL_MS) this.toRemove = true;
  }

  strike(): boolean {
    const target = this.target;
    // the wind-up is a real window: the attacker can be disarmed or killed and
    // the target can die, go untargetable or simply walk out of reach inside it
    if (!this.owner.canAttack || !canBeHit(target)) return false;
    if (!stillInReach(this.owner, target, this.reach, MELEE_WINDUP_MS)) return false;
    return landBasicAttack(this.owner, target, this.damage, false);
  }

  draw(): void {
    const pos = this.owner.position;
    const target = this.target;
    let dirX = 1;
    let dirY = 0;
    if (target?.position) {
      const dx = target.position.x - pos.x;
      const dy = target.position.y - pos.y;
      const length = Math.hypot(dx, dy);
      if (length > 0) {
        dirX = dx / length;
        dirY = dy / length;
      }
    }
    const style = {
      bodyRadius: this.owner.stats.size.value / 2,
      reach: this.reach,
      color: this.color,
    };

    push();
    translate(pos.x, pos.y);
    rotate(Math.atan2(dirY, dirX));

    if (this.age < MELEE_WINDUP_MS) {
      drawMeleeWindup(style, this.age / MELEE_WINDUP_MS);
    } else {
      drawMeleeStrike(
        style,
        constrain(
          (this.age - MELEE_WINDUP_MS) / (MELEE_SWING_TOTAL_MS - MELEE_WINDUP_MS),
          0,
          1
        )
      );
    }
    pop();
  }

  /**
   * Wide enough for the fan, which opens out to a whole reach past the body.
   *
   * `SpellObject`'s default derives a zero-area box from `visionRadius`, so
   * without this the entire swing is culled the moment the attacker's centre
   * leaves the screen — which for a melee fight at the edge of the view is most
   * of it. Pre-existing and unrelated to how the swing is drawn; the minion's
   * swing had one all along. See `docs/TRAPS.md`, rendering.
   */
  getDisplayBoundingBox() {
    return this.squareDisplayBoundingBox(
      (this.owner.stats.size.value + this.reach + 40) * 2
    );
  }
}
