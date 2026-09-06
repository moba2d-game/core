import { Circle } from '@/libs/quadtree';
import { hasFlag } from '@/utils/index';
import ActionState from '@/game/enums/ActionState';
import BuffAddType from '@/game/enums/BuffAddType';
import StatusFlags from '@/game/enums/StatusFlags';
import GameObject from '@/game/gameObject/GameObject';
import type { GameObjectOptions, GameObjectRuntimeContext } from '@/game/gameObject/GameObject';
import Stats from '@/game/gameObject/Stats';
import EventType from '@/game/enums/EventType';
import { DEFAULT_DAMAGE_TYPE, effectiveDamage, type DamageType } from '@/game/combat/Mitigation';
import {
  DEATH_SHAKE_TRAUMA,
  KILL_SHAKE_TRAUMA,
  hitFlashMs,
  hitFraction,
  hitShakeTrauma,
} from '@/game/render/hitFeedback';
import AoePulse from '@/game/gameObject/spellObjects/AoePulse';
import { feelHaptic, type FeedbackKind } from '@/game/input/haptics';
import { vampFraction } from '@/game/combat/Vamp';
import { healingMultiplier } from '@/game/combat/Healing';
import { resolveEconomy } from '@/game/config/mapTuning';
import CombatText, {
  DAMAGE_TEXT_COLOR,
  GOLD_TEXT_COLOR,
} from '@/game/gameObject/helpers/CombatText';
import MatchTally, { type KillCredit } from '@/game/combat/MatchTally';
import type { ObjectiveKind } from '@/game/combat/Announcer';
import type Wallet from '@/game/economy/Wallet';
import AssetManager, { type AssetHandle } from '@/managers/AssetManager';
import PathAgent from '@/game/nav/PathAgent';
import { NAV_MAX_TERRAIN_RADIUS } from '@/game/nav/NavGrid';
import type Buff from '@/game/gameObject/Buff';
import type { BuffConstructor, BuffStackId } from '@/game/gameObject/Buff';
import {
  abilityPowerScales,
  beginAttribution,
  currentAttributionName,
  endAttribution,
} from '@/game/combat/DamageAttribution';
import { amplifiedAbilityDamage, type AmplificationSource } from '@/game/combat/Amplification';
import { isNetClient } from '@/game/net/netRole';
import { resolveVisionTuning } from '@/game/config/mapTuning';

export interface AttackableUnitOptions extends Omit<GameObjectOptions, 'game'> {
  game: GameObjectRuntimeContext;
  avatar?: AssetHandle;
  stats?: Stats;
}

export interface AttackableUnitRenderOptions {
  compactUnits?: boolean;
  /**
   * The machine is a long way under its frame target and the anonymous bodies
   * in the fight may be drawn with fewer strokes.
   *
   * Deliberately not `compactUnits`, which it would be easy to mistake it for.
   * Compact art is about *size* — a body twelve screen pixels wide on a phone
   * — and it drops health numbers, buff icons and status text, which is
   * information a player decides from; taking that away on a late frame was
   * reported as a bug and `renderStress.test.ts` pins that it no longer
   * happens. This is about *anonymity*: a minion in a wave of a hundred and
   * sixty carries nothing but its team colour and which way it faces, so it can
   * lose detail without anybody losing a decision. Bodies that carry
   * information — champions above all — must ignore it.
   */
  thinCrowd?: boolean;
}

// There used to be a third flag here — `plainFrames`, the first stress rung
// stripping the champion frame's ticks, border and shield-overflow flag. It
// was removed on purpose, not forgotten: the two looks flickered against each
// other whenever a fight sat near the stress threshold, and the report was
// that reading health mid-combat got *harder* — the exact failure the flag's
// own comment promised to avoid. The frame is painted through the native
// context now (see `Champion.drawHealthBar`), which makes the full frame
// cheaper than the plain one ever was; a health bar has one face, always.

export interface UnitDeathData {
  attacker?: AttackableUnit;
  reviveAfter: number;
}

/**
 * What a hit *looks* like, as `presentHit` shows it: the shown number, its
 * type (for the colour), and whether the swing that landed it was a crit.
 * Presentation only — nothing here feeds back into the arithmetic.
 */
export interface HitPresentation {
  amount: number;
  type: DamageType;
  crit?: boolean;
}

/**
 * `takeDamage`'s fifth argument: the part of a hit that only matters to how
 * it is shown. Only `landBasicAttack` sets anything today, because only a
 * swing can crit.
 */
export interface HitPresentationOptions {
  crit?: boolean;
}

/**
 * `EventType.ON_DIE`'s payload, emitted once per death on the transition in
 * `die()` — after the tally, the bounty and the assists have been paid, so a
 * listener sees the world with the kill already counted. `killer` is whatever
 * landed the blow (a champion, a turret, a minion), or absent for a death
 * nobody caused; `credit` is the victim's `killCredit`, so a listener can
 * tell a champion's death from a minion's without knowing the classes.
 *
 * `creditedTo` is who the kill was actually *booked* to, which is not always
 * who swung: a summon's last hit belongs to whoever summoned it, and a
 * champion finished off by a turret, a minion or a camp is booked to the last
 * enemy champion who hurt them (`creditForDeath`). It is a separate field
 * rather than a redefinition of `killer` because the two are different
 * questions and a listener may want either — the announcer names the player,
 * a damage log names the turret. It can therefore be set on a death whose
 * `killer` is absent, and a listener that wants "who gets this" should read
 * `creditedTo ?? killer` rather than the other way round.
 */
export interface UnitDeathEvent {
  unit: AttackableUnit;
  killer?: AttackableUnit;
  creditedTo?: AttackableUnit;
  credit: KillCredit;
}

/**
 * Who a kill by `killer` is booked to.
 *
 * Walks `killCreditedTo`, which is the unit itself for everything that fights
 * on its own account and the owner for a summon. Iterative and capped rather
 * than recursive: a pet of a pet is a shape nobody builds on purpose, and a
 * cycle built by accident should not take the whole match down with a stack
 * overflow at the moment somebody dies.
 */
const creditFor = (killer: AttackableUnit): AttackableUnit => {
  let at = killer;
  for (let hop = 0; hop < 4 && at.killCreditedTo !== at; hop++) at = at.killCreditedTo;
  return at;
};

/** Peak alpha of the white disc a hit lights on a body. See `drawHitFlash`. */
const HIT_FLASH_PEAK_ALPHA = 150;

export type HealSource = GameObject;

/**
 * Frames a displaced unit is left out of body separation for. Displacements
 * (Flash, a hook, a knockback) write `position` straight, so a push-out fighting
 * them reads as a stutter. Two frames covers the frame the displacement landed
 * on and the one after it, which is enough for the one-shot kind; a dash keeps
 * itself out for its whole duration through the Ghosted flag instead.
 */
export const DISPLACEMENT_GRACE_FRAMES = 2;

/**
 * How long a unit remembers the enemy that last hit it, in ms. Read by
 * `Turret.findTarget` for ally-protection aggro: a tower punishes an enemy
 * champion attacking an ally under it, and holds that aggro this long after the
 * last hit so a single stray shot does not pin the tower forever.
 */
export const RECENT_ATTACKER_MS = 1500;

/**
 * The widest window a map may ask the participation ledger for, and the only
 * thing the per-hit prune measures against — `rememberParticipant` says why it
 * is not the map's own number.
 *
 * A ceiling rather than the default, so a map that wants a thirty-second
 * window gets one and the ledger still cannot grow without bound. Both readers
 * of the ledger measure against it: `payAssists` and `creditForDeath`.
 */
export const MAX_ASSIST_WINDOW_MS = 60_000;

/**
 * How many participants a ledger holds before it is worth walking to prune.
 *
 * One entry per attacker, not per hit, so ten is already more bodies than a
 * fight ever puts on one target; the check exists so an ordinary duel never pays
 * for the walk at all.
 */
const ASSIST_LEDGER_PRUNE_AT = 10;

/**
 * The status flags that count as crowd control — what a cleanse takes off.
 *
 * A mask rather than a list of buff classes, so a pack's own stun is cleansed
 * without core having ever heard of it. The definition lives here because it
 * is already core's: `Stats.updateActionState` derives `CAN_MOVE`/`CAN_CAST`
 * from these same bits every frame, and a pack computing its own answer would
 * be a second one.
 *
 * `Invulnerable`, `Stealthed`, `Ghosted` and `Targetable` are deliberately
 * out: they are not things done *to* you, and a cleanse that stripped them
 * would be a dispel wearing a smaller name. So is `Slow`, which is not a
 * status flag at all — it is a stat modifier, and it stays.
 */
/**
 * The disables tenacity may **not** shorten, and the floor under the ones it
 * may.
 *
 * League exempts knock-ups, suppression, nearsight, drowsy and stasis by name,
 * and the through-line is that each is an effect the victim cannot play around
 * *at all* — no flash out, no cleanse window, nothing to do but watch. Those
 * are exactly the effects whose duration is the whole design, so an item that
 * shaved a share off them would be deleting counterplay rather than buying it.
 * Airborne is already out (it carries no `CROWD_CONTROL_FLAGS` bit) and Stasis
 * is self-applied, which `addBuff` skips for `cleanse`'s reason.
 */
export const TENACITY_EXEMPT_FLAGS = StatusFlags.NearSighted | StatusFlags.Suppressed;

/**
 * However much tenacity a build carries, a disable that was longer than this
 * still lands for at least this long: a stun has to remain a stun. One that was
 * *already* shorter is left where it is rather than extended up to the floor.
 */
export const TENACITY_FLOOR_MS = 300;

export const CROWD_CONTROL_FLAGS =
  StatusFlags.Disarmed |
  StatusFlags.Charmed |
  StatusFlags.Taunted |
  StatusFlags.Feared |
  StatusFlags.Grounded |
  StatusFlags.NearSighted |
  StatusFlags.Rooted |
  StatusFlags.Silenced |
  StatusFlags.Stunned |
  StatusFlags.Suppressed;

export default class AttackableUnit extends GameObject {
  declare game: GameObjectRuntimeContext;

  /**
   * Whether **the player's team** currently has vision of this unit.
   *
   * Written once a frame by `FogOfWar.calculateSight`, which clears it on every
   * unit and re-lights it from `game.player.teamId`'s eyes. Read by the three
   * things that render the player's point of view — the draw cull, the minimap
   * and the debug overlay — and by nothing else.
   *
   * **It is not a targeting gate, and it is not a general "should I paint
   * this" flag.** It used to be called `willDraw` and lived on `GameObject`,
   * and both halves of that name were wrong: thirteen abilities read it as
   * "can my caster see this", which silently gated every bot's spell on what
   * the *human* could see — a bot could not target an enemy beside it in a
   * bush the player had not lit, and could target one across the map the
   * player had. `combat/Vision.ts` (`canSee` / `PredefinedFilters.visibleTo`)
   * answers that question per observer and is the only thing that may decide
   * what a unit is allowed to do; `target-vision-seam.test.ts`
   * keeps the old name from coming back.
   *
   * It lives here rather than on `GameObject` because the fog only ever
   * touches units — asking a particle system whether the player's team can see
   * it never meant anything.
   */
  visibleToPlayerTeam = true;

  /** Kills, deaths, farm and damage — the scoreboard. See `combat/MatchTally.ts`. */
  readonly tally = new MatchTally();

  /**
   * What killing this unit is worth to whoever did it. A lane minion and a
   * jungle camp are farm, which is the default; `Champion` is a kill, and
   * `Pet`/`Turret` are neither.
   */
  killCredit: KillCredit = 'minion';

  /**
   * What the kill feed calls this body when it dies, if it calls it anything.
   *
   * A declaration rather than a type test, so `combat/Announcer.ts` decides
   * what a death is worth without importing `Turret` or `Monster` — and so a
   * pack's own epic monster is announced by setting its `tier`, with no core
   * change and no list of ids anywhere. `undefined` is the default and means
   * what it has always meant: a minion dying is not news.
   */
  announceAs?: ObjectiveKind;

  /**
   * Who a kill *by* this unit belongs to.
   *
   * The mirror of `killCredit` above: that one is asked of the victim, this
   * one of the killer. Itself for everything that fights on its own account,
   * which is nearly everything; `Pet` points at its owner.
   *
   * It exists because the crediting site paid whoever landed the blow, and a
   * `Pet` has no wallet by design — so `killer.wallet?.earn(bounty)` on a
   * clone's last hit swallowed the whole bounty and paid *nobody*, while the
   * farm count went onto a tally that dies with the summon. Using a clone to
   * clear a wave was a way of throwing gold away, in every pack that ships
   * one. A `Turret` deliberately keeps the base answer: it has no owner to
   * walk up to, so its last hit still denies the gold.
   */
  get killCreditedTo(): AttackableUnit {
    return this;
  }

  /**
   * What killing this unit pays whoever did it. `0` for anything that is not
   * worth money, which is the base case — a `Fountain`, a ward, a summoned pet.
   *
   * Asked of the **victim**, exactly like `killCredit` beside it, and for the
   * same reason: an `instanceof` at the crediting site is how a `Pet` (which
   * extends `Champion`) ends up paying out a champion bounty. That bug has
   * already shipped here once, on the kill-count side.
   */
  goldBounty = 0;

  /**
   * What this unit can spend, or `null` for one that never spends anything.
   *
   * Null is the base case and `Champion` is what fills it in — a minion that
   * last-hits another minion is not banking gold, and nothing at the crediting
   * site has to know that. `Pet` nulls it again on purpose; see `Wallet`.
   */
  wallet: Wallet | null = null;

  buffs: Buff[] = [];
  _buffEffectsToEnable = 0;
  _buffEffectsToDisable = 0;
  _statusBeforeApplyingBuffEfects = 0;
  status = 0;
  deathData: UnitDeathData | null = null;
  reviveTime = 5000;

  /**
   * What the ground underfoot does to this unit's speed — 1 unless the active
   * map's `TerrainTuning` says a region it is standing in is faster or slower.
   * Written each frame by `TerrainMap`, and only on a map that declares a
   * multiplier at all.
   *
   * A plain factor applied at the point of movement rather than a
   * `StatModifier` on `stats.speed`, deliberately. Modifiers are added and
   * removed by buffs with lifetimes, and terrain is a per-frame answer to
   * "where am I standing" — the add/remove churn would be a stat that changes
   * sixty times a second on a value `ClientSession.setComposedValue` has to
   * invert back to a base over the wire. This way `stats.speed.value` stays
   * the unit's real movement speed, which is what the HUD shows and what a
   * buff means, and what the terrain does is visible in the movement itself.
   */
  terrainSpeedFactor = 1;

  avatar: AssetHandle | undefined;
  destination: p5.Vector;
  movementRevision = 0;
  displacementRevision = 0;
  stats: Stats;
  isInsideBush = false;

  /**
   * Match time this unit stops being given away by its own attack. 0 = never
   * attacked out of the dark, which is every unit that has not.
   *
   * Match time, not wall clock: the config panel holds the match paused, and a
   * reveal that burned down behind a paused screen would expire before the
   * player who opened it ever saw the body.
   */
  private _revealedUntilMs = 0;

  /**
   * Gave itself away by unit-targeting somebody — see `combat/AttackReveal.ts`
   * for the rule and where League states it.
   *
   * Read by `combat/Vision.ts` (what may be targeted) and `FogOfWar` (what is
   * drawn), which is the same pair `isInsideBush` above is read by, and for the
   * same reason: the fog is only a promise while the two agree.
   */
  get isRevealed(): boolean {
    return this._revealedUntilMs > (this.game?.matchTimeMs ?? 0);
  }

  /**
   * Light this unit up for its enemies. Called by whoever performed the action.
   *
   * The duration is the *map's*, read at the moment of the swing rather than
   * captured at construction — the same live read `Champion.die` makes for a
   * respawn timer, and for the same reason: a map's numbers belong to the match,
   * not to the objects that happened to exist when it started. A map that sets
   * `attackRevealMs: 0` turns its brushes into real stealth, and this is the
   * line that makes that true rather than a number in a table nothing reads.
   */
  revealForAttack(): void {
    const ms = resolveVisionTuning(this.game?.mapTuning).attackRevealMs;
    if (ms <= 0) return;
    this._revealedUntilMs = (this.game?.matchTimeMs ?? 0) + ms;
  }

  /**
   * Bodies that push but never get pushed: turrets (anchored, and they rewrite
   * `position` after their buffs run) and camps that stand on their spot for
   * good. They hand their half of a separation to the other body.
   */
  isImmovable = false;

  /**
   * World units per second this unit's basic-attack bolt flies, when it is a
   * ranged unit. Undefined means `BasicAttackController.launch` falls back to
   * `RANGED_BOLT_UNITS_PER_SECOND` — the slow default a monster or a turretless
   * structure keeps. Champions always set it (`applyAttackTuning`), which is
   * where a pack's per-champion missile speeds land.
   */
  attackBoltUnitsPerSecond?: number;

  /** Frames left in which body separation skips this unit. See markDisplaced(). */
  _separationGrace = 0;

  /**
   * The last enemy to damage this unit, warm for `RECENT_ATTACKER_MS`. Read by
   * `Turret.findTarget` so a tower prioritises an enemy champion attacking an
   * ally standing under it. Written in `takeDamage`, aged out in `update`.
   */
  recentAttacker: AttackableUnit | null = null;
  private _recentAttackerTtl = 0;

  /**
   * How far this unit lights fog for the player team, independent of combat
   * `visionRadius`. Champions reveal their own (wall-aware) sight; minions and
   * turrets carry `visionRadius = 0` — no combat sight of their own — and
   * override this to light a cheap circle for their team instead, so an ally
   * swarm reveals the map without a raycast per body. 0 reveals nothing.
   */
  get fogRevealRadius(): number {
    return this.visionRadius;
  }

  /**
   * The route this unit is walking, when it has one. Built on first use, so a
   * unit that never takes a `navigateTo` — turrets, fountains, every unit in a
   * headless spell test — never allocates one.
   */
  pathAgent: PathAgent | null = null;

  animatedValues: {
    size: number;
    height: number;
    alpha: number;
    displaySize: number;
    visionRadius: number;
  };

  constructor({
    game,
    position,
    collisionRadius,
    visionRadius,
    teamId,
    id,
    avatar,
    stats,
  }: AttackableUnitOptions) {
    super({ game, position, collisionRadius, visionRadius, teamId, id });

    this.game = game;
    this.avatar = avatar;
    this.destination = (position ?? createVector()).copy();
    this.stats = stats || new Stats();
    this.setStatus(StatusFlags.CanCast | StatusFlags.CanMove | StatusFlags.Targetable, true);

    this.animatedValues = {
      size: 10,
      height: 0,
      alpha: 255,
      displaySize: 10,
      visionRadius: 0,
    };
  }

  /**
   * Ms of hit flash left on the body, and the length it started from, so the
   * disc fades over whatever `presentHit` chose rather than a fixed span.
   * Simulation clock, like `_recentAttackerTtl`: a paused match holds the
   * flash, which is the honest picture of a paused hit.
   */
  hitFlashMs = 0;
  hitFlashTotalMs = 0;

  update() {
    // ticked before the buffs run, so a displacement applied during this frame's
    // updateBuffs() still gets its full grace afterwards
    if (this._separationGrace > 0) this._separationGrace -= 1;
    if (this.hitFlashMs > 0) this.hitFlashMs -= deltaTime;

    if (this._recentAttackerTtl > 0) {
      this._recentAttackerTtl -= deltaTime;
      if (
        this._recentAttackerTtl <= 0 ||
        this.recentAttacker?.isDead ||
        this.recentAttacker?.toRemove
      ) {
        this.recentAttacker = null;
      }
    }

    this.updateBuffs();
    // The one caller that passes the wound down. Read *after* `updateBuffs`, so
    // a cut that expired this frame has already been swept and is not still
    // taxing a regeneration tick it no longer covers.
    this.stats.update(healingMultiplier(this));

    // The route picks this frame's destination before the step is taken, so a
    // unit rounding a corner turns on the frame it arrives rather than the one
    // after it.
    this.pathAgent?.update(deltaTime);
    if (this.canMove) this.move();

    if (this.deathData) {
      this.deathData.reviveAfter -= deltaTime;
      if (this.deathData.reviveAfter <= 0) {
        this.respawn();
      }
    }

    let isStealthed = hasFlag(this.stats.actionState, ActionState.STEALTHED);
    let alphaColor = this.isInsideBush ? 100 : isStealthed ? 20 : 255;

    // mutate in place to avoid allocating a new object every frame per unit
    const av = this.animatedValues;
    const { size, height, alpha, visionRadius } = av;
    av.displaySize = size + height; // PREVIOUS frame's size/height, keep this ordering
    av.size = lerp(size, this.stats.size.value, 0.1);
    av.height = lerp(height, this.stats.height.value, 0.3);
    av.visionRadius = lerp(visionRadius, this.stats.visionRadius.value, 0.1);
    av.alpha = alphaColor > alpha ? lerp(alpha || 0, alphaColor, 0.2) : alphaColor;
    this.visionRadius = av.visionRadius;
  }

  /**
   * Make this unit fight `attacker`, overruling whatever it had decided.
   *
   * The seam a taunt needs, and the reason it is here rather than inside the
   * `Taunt` buff: "who am I attacking" is stored somewhere different in every
   * subclass — a `Champion` has a `BasicAttackController` holding a standing
   * order, a `Minion` and a `Monster` each have a `targetLock` plus a phase.
   * A buff that reached into all three would have to know all three, and the
   * next unit type would silently be immune to taunts.
   *
   * The base does nothing: a unit with no notion of a target cannot be taunted,
   * and that is a fact about the unit rather than a failure.
   */
  forceAttackTarget(_attacker: AttackableUnit): void {}

  // hook called by TerrainMap when this unit hits a wall
  onCollideWall() {}

  // hook for units colliding with the map edge (old JS: super.onCollideMapEdge?.())
  onCollideMapEdge() {}

  draw({ compactUnits = false }: AttackableUnitRenderOptions = {}) {
    this.drawAvatar();
    if (!compactUnits) this.drawDir();
    this.drawBuffs(compactUnits);
    this.drawHealthBar(compactUnits);
  }

  drawAvatar() {
    let pos = this.position;
    let { displaySize: size, alpha } = this.animatedValues;

    push();
    noStroke();
    fill(240, alpha);

    this.drawBody(pos.x, pos.y, size, alpha);
    this.drawHitFlash(pos.x, pos.y, size);

    stroke(this.isAllied ? [0, 255, 0, alpha] : [255, 0, 0, alpha]);
    strokeWeight(2);
    noFill();
    circle(pos.x, pos.y, size);

    if (this.isDead) {
      noStroke();
      fill(0, 200);
      circle(pos.x, pos.y, size);
    }
    pop();
  }

  /**
   * This unit's own picture, inside the ring and the dead overlay that
   * `drawAvatar` paints around it.
   *
   * Its own method so a subclass can replace the *picture* without also
   * inheriting a copy of the team ring, the death shade and the `push`/`pop`
   * that hold them — `Monster` draws a procedural body here when its pack
   * declared one instead of a sprite.
   */
  protected drawBody(x: number, y: number, size: number, alpha: number) {
    // Avatars arrive in two shapes: pre-cut circles and raw square portraits from
    // the wiki importer. Clipping here makes every avatar round, so new art does
    // not have to be cut to a circle before it can be used.
    drawingContext.save();
    drawingContext.globalAlpha = alpha / 255;
    drawingContext.beginPath();
    drawingContext.arc(x, y, size / 2, 0, TWO_PI);
    drawingContext.clip();
    image(AssetManager.renderable(this.avatar), x, y, size, size);
    drawingContext.restore();
  }

  /**
   * The disc `presentHit` lit, fading over `hitFlashTotalMs`. Over the body
   * and under the team ring in `drawAvatar`; a subclass that paints its own
   * body in its own frame (`Minion`) calls it there. White on purpose — the
   * damage type has one colour channel and it is the number, never the body
   * (`VFX_STANDARD.md`, colour rule 1). Lives inside the unit's own `draw()`,
   * so it is culled and fogged exactly as the body is.
   */
  protected drawHitFlash(x: number, y: number, size: number): void {
    if (this.hitFlashMs <= 0 || this.hitFlashTotalMs <= 0 || this.isDead) return;
    const strength = Math.min(1, this.hitFlashMs / this.hitFlashTotalMs);
    noStroke();
    fill(255, 255, 255, HIT_FLASH_PEAK_ALPHA * strength);
    circle(x, y, size);
  }

  drawDir() {
    if (!this.isDead && this.game.worldMouse) {
      let pos = this.position;
      let { displaySize: size, alpha } = this.animatedValues;

      push();
      let mouseDir = p5.Vector.sub(this.game.worldMouse, pos).setMag(size / 2 + 2);
      stroke(255, Math.min(alpha, 125));
      strokeWeight(4);
      line(pos.x, pos.y, pos.x + mouseDir.x, pos.y + mouseDir.y);
      pop();
    }
  }

  drawBuffs(compact = false) {
    // `singleRepresentativeDraw` buffs (see `Buff.ts`) are a data count with
    // one shared visual, not one drawable per instance — so past the first
    // live stack of a given `stackId`, skip straight past `.draw()` with a
    // property read and a `Set` check instead of calling into it. A champion
    // cheated to hundreds of Feast stacks used to mean hundreds of function
    // calls a frame to paint one ring.
    let seenSingleDraw: Set<BuffStackId> | null = null;
    for (const buff of this.buffs) {
      if (buff.singleRepresentativeDraw) {
        seenSingleDraw ??= new Set();
        if (seenSingleDraw.has(buff.stackId)) continue;
        seenSingleDraw.add(buff.stackId);
      }
      if (!compact || (buff.statusFlagsToEnable | buff.statusFlagsToDisable) !== 0) {
        buff.draw?.();
      }
    }
  }

  drawHealthBar(_compact = false) {
    push();
    let pos = this.position;
    let { displaySize: size, alpha } = this.animatedValues;

    // Overlay, not world: see Camera.constantSize. The bar and its text
    // compensate together — 12px digits over a 39px bar is worse than either
    // extreme. `size` stays in world units: the bar hangs off a sprite that
    // really is that big.
    const k = this.game?.camera?.constantSize?.(1) ?? 1;

    let healthBarHeight = 6 * k;
    let healthBarWidth = 100 * k;
    let healthBarX = pos.x - healthBarWidth / 2;
    let healthBarY = pos.y - size / 2 - healthBarHeight - 15 * k;
    let healthBarColor = this.isAllied ? [67, 196, 29, alpha] : [196, 67, 29, alpha];
    let healthBarBgColor = [242, 242, 242, alpha];
    let healthBarValue = ~~this.stats.health.value;
    let healthBarMaxValue = ~~this.stats.maxHealth.value;
    let healthBarValuePercent = healthBarValue / healthBarMaxValue;

    noStroke();
    fill(healthBarBgColor);
    rect(healthBarX, healthBarY, healthBarWidth, healthBarHeight);

    fill(healthBarColor);
    rect(healthBarX, healthBarY, healthBarWidth * healthBarValuePercent, healthBarHeight);

    // Shields sit to the right of current health, since they are eaten first.
    // On a healthy unit there is no room there, so the segment slides left and
    // overlays the health instead — a shield must never be invisible.
    const shield = this.shieldAmount;
    if (shield > 0) {
      const filled = healthBarWidth * healthBarValuePercent;
      const shieldW = Math.min((shield / healthBarMaxValue) * healthBarWidth, healthBarWidth);
      const shieldX = Math.min(filled, healthBarWidth - shieldW);
      fill(225, 230, 238, alpha * 0.85);
      rect(healthBarX + shieldX, healthBarY, shieldW, healthBarHeight);
    }

    fill(180, alpha);
    textAlign(CENTER, CENTER);
    textSize(12 * k);
    text(`${healthBarValue} / ${healthBarMaxValue}`, pos.x, healthBarY - 10 * k);
    pop();
  }

  addBuff(buff: Buff): void {
    if (this.isDead || !buff) return;

    // Before anything else, including tenacity: a buff that is refused was
    // never applied, so there is nothing to shorten and no stack to join.
    // `Buff.blocksIncoming` is the hook; `Dash.unstoppable` is the one thing
    // that answers it today. Live buffs only — a buff on its way out has no
    // standing to turn anything away.
    for (let i = 0; i < this.buffs.length; i++) {
      const live = this.buffs[i];
      if (!live.toRemove && live.blocksIncoming?.(buff)) return;
    }

    // Tenacity is taken off here rather than where the buff was built: what a
    // stun *is* belongs to the caster, how long it survives contact belongs to
    // the body it lands on, and only this side knows the stat. `sourceUnit !==
    // this` for `cleanse`'s reason — `Stasis` wears the same `Stunned` bit and
    // is a way out of a fight, so an item must not shorten its owner's own
    // escape. A permanent effect (`duration === 0`) stays permanent: a share
    // of nothing is nothing, and the multiply would be a no-op anyway.
    if (buff.duration > 0 && buff.sourceUnit !== this) {
      const tenacity = this.stats.tenacity.value;
      const flags = buff.statusFlagsToEnable;
      if (
        tenacity > 0 &&
        (flags & CROWD_CONTROL_FLAGS) !== 0 &&
        (flags & TENACITY_EXEMPT_FLAGS) === 0
      ) {
        // The floor applies to what this *would* have become, not to the buff's
        // own length: a 200ms stun stays 200ms rather than being lengthened to
        // the floor by the thing that is supposed to shorten it.
        const shortened = buff.duration * (1 - tenacity);
        buff.duration = Math.max(shortened, Math.min(buff.duration, TENACITY_FLOOR_MS));
      }
    }

    // group by stackId when a buff declares one, so two spells applying the same
    // generic class (StatAmp, DamageOverTime) do not evict each other
    const stackKey = buff.stackId;
    const preBuffs = this.buffs.filter(_buff => _buff.stackId === stackKey);

    // A permanent, uniform stack (`Buff.countedStacks`) is one instance
    // carrying a counter, not one instance per stack: grow the existing
    // live instance's `stacks` instead of
    // pushing a new one. Short-circuits ahead of `buffAddType` entirely,
    // since representation (one instance vs. N) is a different axis from
    // that switch's semantics (replace/renew/stack), and every other buff in
    // the game leaves `countedStacks` at its default `false` and never
    // reaches this branch.
    if (buff.countedStacks) {
      const existing = preBuffs.find(_buff => !_buff.toRemove);
      if (existing) {
        // Capped going up, but never clawed back down: a cheat can set
        // `stacks` on a live instance straight past `maxStacks` (the
        // practice panel's write side, which a pack's spell implements), and a later
        // real-play stack must not silently erase that — it only ever adds
        // up to the cap from where the count already stood.
        const grown = Math.min(existing.stacks + buff.stacks, existing.maxStacks);
        existing.stacks = Math.max(existing.stacks, grown);
        existing.renewBuff();
        existing.onStacksChanged();
        return;
      }
      this.buffs.push(buff);
      buff.activateBuff();
      return;
    }

    switch (buff.buffAddType) {
      case BuffAddType.REPLACE_EXISTING:
        for (let b of preBuffs) b.deactivateBuff();
        this.buffs.push(buff);
        buff.activateBuff();
        break;

      case BuffAddType.RENEW_EXISTING:
        if (preBuffs.length > 0) {
          preBuffs[0].renewBuff();
        } else {
          this.buffs.push(buff);
          buff.activateBuff();
        }
        break;

      case BuffAddType.STACKS_AND_CONTINUE:
        if (preBuffs.length >= buff.maxStacks) {
          buff.timeElapsed = preBuffs[0].timeElapsed;
          preBuffs[0].deactivateBuff();
        }
        this.buffs.push(buff);
        buff.activateBuff();
        break;

      case BuffAddType.STACKS_AND_OVERLAPS:
        if (preBuffs.length >= buff.maxStacks) {
          preBuffs[0].deactivateBuff();
        }
        this.buffs.push(buff);
        buff.activateBuff();
        break;

      case BuffAddType.STACKS_AND_RENEWS:
        for (let b of preBuffs) b.renewBuff();
        if (preBuffs.length >= buff.maxStacks) {
          preBuffs[0].deactivateBuff();
        }
        this.buffs.push(buff);
        buff.activateBuff();
        break;

      default:
        break;
    }
  }

  updateBuffs(): void {
    // Compact in place, and only when something actually expired. This was a
    // `.filter`, which built a fresh array per unit per frame to almost always
    // hand back the same list — buffs expire on events, not on the clock.
    // Same two-pointer shape ObjectManager and MinionSpawner use, and it keeps
    // insertion order, which `modifyIncomingDamage` depends on.
    let removed = 0;
    for (let i = 0; i < this.buffs.length; i++) {
      if (this.buffs[i].toRemove) {
        removed++;
        continue;
      }
      if (removed > 0) this.buffs[i - removed] = this.buffs[i];
    }
    if (removed > 0) this.buffs.length -= removed;

    this._buffEffectsToEnable = 0;
    this._buffEffectsToDisable = 0;

    for (let buff of this.buffs) {
      // A buff already carries the display name the recap wants, so a tick that
      // deals damage without naming a source — `DamageOverTime`, an item's
      // reflect — files under the buff itself.
      const previous = beginAttribution(buff);
      try {
        buff.update();
      } finally {
        endAttribution(previous);
      }
      this._buffEffectsToEnable |= buff.statusFlagsToEnable;
      this._buffEffectsToDisable |= buff.statusFlagsToDisable;
    }

    this.setStatus(StatusFlags.None, true);
  }

  /**
   * Give mana back. `takeHeal`'s counterpart, and the seam a spell has to use.
   *
   * `tests/game/spells/mana-spend-seam.test.ts` forbids anything under
   * `spells/`, `spellObjects/` or `buffs/` from naming `stats.mana` at all,
   * because URF's `manaFree` has to be one flip rather than a per-spell edit.
   * That rule is about *billing* a caster, and it is right that a refill is not
   * subject to it — the seam test's own header says a refill must not be zeroed
   * by URF. So the granting side lives out here on the unit, next to the health
   * equivalent, where nothing about `MatchRules` applies.
   *
   * Clamped to the pool rather than allowed to overfill, and rounded to whole
   * points for the same reason `takeHeal` rounds.
   */
  restoreMana(amount: number): void {
    if (this.isDead) return;

    amount = Math.round(amount);
    if (amount <= 0) return;

    const max = this.stats.maxMana.value;
    if (max <= 0) return;

    this.stats.mana.baseValue = constrain(this.stats.mana.baseValue + amount, 0, max);
  }

  /**
   * Put health back. The seam every heal in the game goes through.
   *
   * ## Ability power reaches here too, and did not for a long time
   *
   * `Stats.abilityPower` was built as "one multiplier at the funnel every
   * ability already passes through", and only one of the three funnels was
   * wired up. Damage was amplified; heals and shields were not — so a support
   * with a full ability build healed for exactly what it healed for on the
   * first frame of the match, which is the complaint `Amplification.ts`'s own
   * header opens with, aimed at the half of the roster that does not deal
   * damage. Reported from a real match: "my ability power is huge and the
   * heals still restore almost nothing".
   *
   * The gate is the same `abilityPowerScales()` the damage funnel asks, so a
   * heal an ability cast is amplified and a heal an item's passive gave is not
   * — no pack names the stat, and nothing that was not already an ability
   * starts scaling.
   *
   * **`healer`, which used to be `_healer`.** The parameter has been in the
   * signature since heals existed and had never been read; every caller in
   * both packs already passes the caster, which is why this needed no pack
   * edit at all.
   */
  takeHeal(heal: number, healer?: HealSource): void {
    if (this.isDead) return;

    if (abilityPowerScales()) heal = amplifiedAbilityDamage(heal, healer as AmplificationSource);

    // A grievous wound is taken off last, on the amplified number: it cuts the
    // heal that *would have* arrived, not the one written in the spell file, so
    // a support's ability power and the wound on their ally both count exactly
    // once. `combat/Healing.ts` says what a cut reaches; the other half of that
    // answer is `Stats.update`, which regeneration goes through instead of here.
    heal *= healingMultiplier(this);

    // whole points, for the same reason takeDamage rounds
    heal = Math.round(heal);
    if (heal <= 0) return;

    // What lands is bounded by the room left in the pool, and the floating
    // number reports THAT — the landed heal, exactly as takeDamage's number is
    // the landed hit. It used to report the requested amount before the clamp,
    // so a Heart-style "regenerate out of combat" passive ticking on a
    // full-health champion floated a green number every second while healing
    // nothing. `ceil` on the room so a fraction of a point left still heals
    // (and prints the whole point it rounds to) rather than being dropped.
    const room = Math.ceil(this.stats.maxHealth.value - this.stats.health.baseValue);
    const landed = Math.min(heal, room);
    if (landed <= 0) return;

    CombatText.show(this, 'heal', landed, [0, 255, 0]);

    this.stats.health.baseValue = constrain(
      this.stats.health.baseValue + landed,
      0,
      this.stats.maxHealth.value
    );
  }

  /**
   * The rolling ledger behind the death recap: what has hurt this unit in the
   * last few seconds, each entry the *landed* number with who and, when the
   * caller says so, what. Pruned as it is written, snapshotted by `die()`
   * into `deathRecap`, and never read by gameplay — display only.
   */
  recentDamageLog: DamageLogEntry[] = [];

  /**
   * The same ledger, kept from the other side: what *this* unit dealt.
   *
   * It exists so the recap can print "you took 377, you dealt 512" with both
   * numbers meaning the same stretch of time. The first version read match
   * totals off `MatchTally` — correct, cheaper, and useless for the comparison
   * a player is actually making, because one number was the fight and the
   * other was the last twenty minutes.
   *
   * Same entry shape and the same prune, so the two windows are the same rule
   * rather than two rules that agree today. The one field that reads
   * differently: `attackerName`/`attackerId` name the **victim** here, since
   * "who was on the other end" is what an entry needs either way.
   */
  recentDamageDealtLog: DamageLogEntry[] = [];
  /** The last death's summary, for the HUD. Survives until the next death. */
  deathRecap: DeathRecap | null = null;
  private _deathSeq = 0;

  /**
   * Who has hurt this unit lately, and when — the assist ledger.
   *
   * Kept apart from `recentDamageLog` beside it, which looks like it would do:
   * that one holds *names and ids* for the death recap, is capped at
   * `DEATH_RECAP_MAX_ENTRIES` and so silently drops the earliest participant
   * in a long fight, and is cleared the moment `die()` snapshots it. An assist
   * needs the unit itself (to pay a wallet and bump a tally), needs everyone
   * who took part rather than the last N hits, and is read *by* `die()`. Two
   * different questions that happen to be written from the same line.
   *
   * One entry per attacker, holding the last time they landed anything, so a
   * champion who has been hitting for ten seconds costs one entry rather than
   * six hundred. Pruned on write, against the widest window a map could ask
   * for; `die()` applies the map's real window when it reads.
   */
  private _assistLedger = new Map<AttackableUnit, number>();

  /**
   * Whether finishing this unit off is something a *team* gets credit for.
   *
   * Asked of the **victim**, exactly like `killCredit` and `goldBounty`, and
   * carrying the same `Pet` trap: a pet *is* a `Champion` by
   * inheritance, so `Champion` turning this on means `Pet` has to turn it off
   * again. Turrets say yes despite `killCredit: 'none'` — "who helped take
   * that tower" is a real question and a scoreboard number, even though
   * nobody's kill count moves for it.
   */
  awardsAssists = false;

  /**
   * `type` is optional and defaults to `MAGIC` — see `combat/Mitigation.ts` for
   * why that default is the only one that could have been chosen. Every
   * ability in every published pack calls this with two arguments, and every
   * unit starts at zero of both resistances, so adding the parameter moved no
   * number in the game on the day it landed.
   *
   * `source` is display only — the ability's own name, for the death recap. A
   * caller that omits it (every spell today) still lands in the recap under
   * its attacker and damage type; core's own basic attack names itself.
   */
  takeDamage(
    damage: number,
    attacker?: AttackableUnit,
    type: DamageType = DEFAULT_DAMAGE_TYPE,
    source?: string,
    presentation?: HitPresentationOptions
  ): void {
    // A LAN client never simulates outcomes: health is snapshot truth
    // (`net/netRole.ts`, spec §4 of the LAN design). This being the one
    // funnel every damage source already goes through — a swing, a spell, a
    // poison tick — is what makes "the client's spells are visual-only" one
    // early return instead of an audit of 300 spell files.
    if (isNetClient()) return;
    if (this.isDead) return;

    // **The attacker's build, before anything else touches the number.**
    // `abilityPower` amplifies an ability the way `attackDamage` swells a
    // swing: at the source, so the victim's resistances then apply to the
    // amplified hit exactly as armour applies to an item-fed basic attack. Two
    // modules answer the two halves and neither guesses at the other's —
    // `combat/DamageAttribution.ts` says whether this is ability damage at all,
    // `combat/Amplification.ts` says what it is worth. Both are inert for a
    // unit nobody has bought anything for.
    if (abilityPowerScales()) damage = amplifiedAbilityDamage(damage, attacker, type);

    // Whole points, in and out. Damage is built from lerps, percentages and
    // unit-type multipliers, so it arrives as things like 23.799999999999997 —
    // which then landed in the floating combat text verbatim and left health
    // pools carrying a tail of binary noise. Rounded before the modifiers so
    // shields also deal in whole points, and again after, because a partial
    // absorb reintroduces a fraction.
    damage = Math.round(damage);
    if (damage <= 0) return;

    // **Resistance first, shields second, and the order is the rule.** Armour
    // is a property of the body being hit, so it makes the hit *smaller*; a
    // shield is a pool standing in front of the body, which eats a hit whose
    // size is already settled. Doing it the other way round has a shield
    // absorb the raw number and then mitigate the remainder, which prices a
    // shield differently depending on the victim's armour for no reason a
    // player could ever recover.
    //
    // It also settles what `swung` below means: a reflect answers the hit that
    // arrived, and 40 stopped to 20 by armour genuinely *was* a 20, whereas 40
    // eaten by a shield was still a 40.
    // `attacker` is here for penetration only — the share of this unit's
    // resistance the hitter ignores (`combat/Mitigation.ts`). Everything else
    // about the attacker was already settled before the hit arrived.
    damage = Math.round(effectiveDamage(damage, type, this, attacker));
    if (damage <= 0) return;

    // What was aimed at this unit, before anything ate it. Retaliation is
    // measured on this rather than on what got through: "he hit me for 50, he
    // takes 40" is the sentence, and a shield eating the 50 does not make the
    // swing smaller.
    const swung = damage;

    // Remember who is hitting us, for the turret's ally-protection aggro
    // (`recentAttacker`). An enemy swing counts even when a shield eats it — a
    // tower answers the attack, not the damage that gets through.
    if (attacker && attacker !== this && attacker.teamId !== this.teamId) {
      this.recentAttacker = attacker;
      this._recentAttackerTtl = RECENT_ATTACKER_MS;
      // Both sides of the exchange are "in a fight" from now — what the death
      // camera (`render/deathCamera.ts`) reads to pick which ally to watch.
      const now = this.game?.matchTimeMs ?? 0;
      this.lastCombatMs = now;
      attacker.lastCombatMs = now;
      // Written from `swung` rather than from what got through, for the same
      // reason the turret's aggro above is: a shield eating the whole hit does
      // not make it not a hit, and somebody who spent an ability on a target
      // took part in killing it whether or not a bubble was up at the time.
      this.rememberParticipant(attacker);
    }

    // shields and damage modifiers get first look; they may eat all of it
    for (const buff of this.buffs) {
      damage = buff.modifyIncomingDamage(damage, attacker, type);
      if (damage <= 0) break;
    }

    damage = Math.max(0, Math.round(damage));

    /**
     * What a shield or a damage-reduction buff just ate — `swung` is the hit
     * after armour and before that loop, so this is exactly the part of it
     * that never reached the body.
     *
     * Recorded because the death recap could not see it at all. A shield that
     * absorbed the whole hit took the early return below and wrote nothing, so
     * a player who died behind a big bubble read a recap listing only the
     * damage that got through — the bubble looked like it had done nothing.
     * Reported from a real match: a mage's shield absorbing "rất nhiều damage"
     * and a death detail that never mentioned it.
     */
    const blocked = Math.max(0, swung - damage);

    // Nothing reached health — but something was still swung, so the reaction
    // pass below still owes an answer. Only the health side is skipped.
    if (damage <= 0) {
      // The whole hit was eaten. It is still the most interesting kind of
      // entry for the recap, so it is written here rather than lost to the
      // early return: `landed` is zero and `blocked` carries the story.
      if (blocked > 0 && attacker !== this) {
        this.recordDamageForRecap(0, type, attacker, source ?? currentAttributionName(), blocked);
      }
      this.reactToDamage(swung, 0, attacker);
      this.reactToDamageDealt(swung, 0, attacker, type);
      return;
    }

    // Everything the hit *looks* like — the number, the flash, the camera —
    // goes through one door, because a LAN client has to reach the same door
    // from the wire (see `presentHit`).
    const crit = presentation?.crit === true;
    this.presentHit({ amount: damage, type, crit });
    // The same number, for anyone who cannot compute it: a LAN client's own
    // `takeDamage` is gated shut (the early return at the top), so the only
    // damage numbers it can ever float are the ones the host's sim announces.
    // `HostSession` is today's one listener; an offline match emits to nobody.
    this.game?.eventManager?.emit(EventType.ON_TAKE_DAMAGE, {
      unit: this,
      amount: damage,
      type,
      crit,
    } satisfies DamageNumberEvent);

    // What actually landed, for the scoreboard: capped at the pool that was
    // there to take it, so a 200-damage execute on a 12-health minion is 12
    // damage dealt rather than 200. Read before the subtraction, because after
    // it the pool is already negative.
    const landed = Math.min(damage, Math.max(0, this.stats.health.baseValue));
    this.tally.damageTaken += landed;
    if (attacker && attacker !== this) {
      attacker.tally.damageDealt += landed;
      // The same hit on the dealer's own ledger, so the recap can report what
      // they dealt over the window it already reports what they took over.
      // Deliberately *not* also a per-type running total on `MatchTally`: two
      // places keeping the same number is how the two drift.
      attacker.recordDamageInto(
        attacker.recentDamageDealtLog,
        landed,
        type,
        this,
        source ?? currentAttributionName(),
        blocked
      );
    }
    if ((landed > 0 || blocked > 0) && attacker !== this)
      // An explicit `source` always wins: five sites across the packs
      // deliberately name a sub-ability rather than their own spell. The
      // ambient only fills the silence — see `combat/DamageAttribution.ts`.
      this.recordDamageForRecap(
        landed,
        type,
        attacker,
        source ?? currentAttributionName(),
        blocked
      );

    this.stats.health.baseValue -= damage;

    // The vamp stats, and the only place they are paid. `takeDamage` is
    // the one funnel every source of damage already goes through — a swing, a
    // spell, a poison tick — so the stats cover all of them without a single
    // one of them knowing they exist. That is also why the three split by
    // damage *type* rather than by League's basic-attack/ability line: the
    // type is what arrives at this funnel, and what dealt the hit is not.
    //
    // Paid on the damage that actually landed, i.e. after shields ate their
    // share, and before the death check so the kill still heals. Self-damage
    // (a self-inflicted cost spell) is excluded: a cost that refunds itself
    // is not a cost.
    if (attacker && attacker !== this && !attacker.isDead) {
      // Which stat pays is the hit's own type's business — `combat/Vamp.ts`
      // owns that table and the clamp on the sum. This funnel stays the one
      // place all three are ever cashed in.
      const vamp = vampFraction(attacker, type);
      if (vamp > 0) {
        // Outside the attribution, deliberately. `damage` has *already* been
        // through `amplifiedAbilityDamage` a few lines up, so healing a share
        // of it under the same ambient would multiply this caster's ability
        // power into the same number twice. Draining life off an ability is
        // not a second ability effect; it is a fraction of the first one.
        const previous = beginAttribution(null);
        try {
          attacker.takeHeal(damage * vamp, attacker);
        } finally {
          endAttribution(previous);
        }
      }
    }

    // Before the death check, for the same reason omnivamp is: a hit that kills
    // still happened, and a reflect buff on the victim still returns it.
    this.reactToDamage(swung, damage, attacker);
    // And the same hit from the other side. After the vamp payout above,
    // deliberately: a wound this hit applies must not retroactively shrink the
    // drain the hit that applied it already paid.
    this.reactToDamageDealt(swung, landed, attacker, type);

    if (this.stats.health.baseValue <= 0) {
      this.die({ attacker, reviveAfter: this.reviveTime });
    }
  }

  /**
   * Show a hit landing on this body: the number, the flash, the crit spark,
   * and — when this body is the player's — the camera. Everything a hit
   * *looks* like and nothing of what it *does*.
   *
   * The one door for both ends of a LAN match. The host reaches it from
   * `takeDamage`; a client, whose `takeDamage` is gated shut, reaches it from
   * `ClientSession`'s `dmg` stream with the host's own numbers. Anything a
   * hit should look like belongs here and nowhere else, or the client will
   * not see it. The type's colour, not one red for all three: see
   * `DAMAGE_TEXT_COLOR`, whose colour is also half of the text's merge key.
   */
  presentHit(hit: HitPresentation): void {
    const crit = hit.crit === true;
    const fraction = hitFraction(hit.amount, this.stats.maxHealth.value);
    const color = DAMAGE_TEXT_COLOR[hit.type] ?? DAMAGE_TEXT_COLOR[DEFAULT_DAMAGE_TYPE];
    CombatText.show(this, 'damage', hit.amount, [...color], { crit });
    this.hitFlashTotalMs = this.hitFlashMs = hitFlashMs(fraction, crit);
    if (crit) showCritSpark(this);
    if (isLocalPlayer(this.game, this)) feel(this.game, 'hit', hitShakeTrauma(fraction, crit));
  }

  /**
   * One assist-ledger entry, and the prune in the same breath.
   *
   * The prune is against `MAX_ASSIST_WINDOW_MS` — a ceiling on what a map
   * may ask for — and not against the map's own window, because this runs on
   * every hit and reading the map's tuning per hit to throw the answer away is
   * work for nothing. The real window is applied once, by `die()`.
   */
  /**
   * Match time of this unit's last exchange of damage with an enemy, dealt or
   * taken; `-Infinity` for never. Stamped in `takeDamage` on both units, so
   * "is this ally fighting" is one subtraction rather than a ledger walk.
   */
  lastCombatMs = -Infinity;

  private rememberParticipant(attacker: AttackableUnit): void {
    const atMs = this.game?.matchTimeMs ?? 0;
    // Booked to whoever the attacker fights for, the same way `die()` books
    // the kill. Recorded against a summon instead, the entry earns nobody an
    // assist — a `Pet` has no wallet and its tally dies with it — and is then
    // pruned outright the moment the summon expires, because the sweep below
    // drops `toRemove` entries. A clone that chips somebody down and then
    // runs out of time would have helped nobody at all.
    this._assistLedger.set(creditFor(attacker), atMs);
    if (this._assistLedger.size <= ASSIST_LEDGER_PRUNE_AT) return;
    const cutoff = atMs - MAX_ASSIST_WINDOW_MS;
    for (const [unit, seen] of this._assistLedger) {
      if (seen < cutoff || unit.toRemove) this._assistLedger.delete(unit);
    }
  }

  /**
   * Everyone but the killer who had a hand in this death, and what it pays
   * them.
   *
   * The rules, and each of them is a decision:
   *
   *   - **the killer is not their own assister.** They already have the kill
   *     and the whole bounty;
   *   - **only the killer's own side.** A ledger holds anyone who hurt this
   *     unit, and in a three-way fight that includes the team that did not get
   *     the kill. Credit for a kill is a team fact;
   *   - **death is not disqualifying.** Somebody who committed to the fight
   *     and lost it still helped, and League agrees. They collect the gold
   *     when they respawn, since a wallet outlives a corpse;
   *   - **the gold is added, not divided.** See `ASSIST_GOLD_SHARE`.
   */
  private payAssists(killer: AttackableUnit): void {
    if (!this.awardsAssists) return;
    const economy = resolveEconomy(this.game?.mapTuning);
    if (economy.assistWindowMs <= 0) return;

    const cutoff = (this.game?.matchTimeMs ?? 0) - economy.assistWindowMs;
    const reward = Math.round(this.goldBounty * economy.assistGoldShare);

    for (const [helper, seen] of this._assistLedger) {
      if (helper === killer || helper === this) continue;
      if (seen < cutoff) continue;
      if (helper.teamId !== killer.teamId) continue;

      helper.tally.assists++;
      if (reward > 0 && helper.wallet) {
        helper.wallet.earn(reward);
        // Over the helper, like the killer's own bounty — see `GOLD_TEXT_COLOR`.
        CombatText.show(helper, 'gold', reward, [...GOLD_TEXT_COLOR]);
      }
    }
  }

  /**
   * Who this death is booked to, which is not always who landed the blow.
   *
   * Two corrections, applied in this order:
   *
   *   - **a summon's last hit belongs to whoever summoned it** — `creditFor`,
   *     walking `killCreditedTo`;
   *   - **a champion finished off by a turret, a minion or a camp was still
   *     killed by whoever drove them under it.** You burn every cooldown
   *     taking somebody to 40 health, the caster minion behind you lands the
   *     last 30, and the scoreboard says nobody killed anybody — the kill, the
   *     bounty and the spree all went to a unit with no wallet and no tally
   *     that survives the wave. League hands the kill to the last enemy
   *     champion who hurt the victim inside a window, and so does this.
   *
   * **Only a champion's death is ever taken off the last hitter.** Farm is the
   * opposite rule and has to stay the opposite rule: last-hitting a minion is
   * the skill the lane is made of, and a dragon stolen by the enemy's smite is
   * the play, not a bug. So the correction is gated on the *victim* saying
   * `killCredit === 'champion'`, which is the discriminator the rest of the
   * codebase already uses for "is this a champion".
   *
   * Falls back to `direct` when nobody qualifies: a champion who walks into a
   * turret with no enemy near them is still killed by the turret.
   */
  private creditForDeath(killer: AttackableUnit | undefined): AttackableUnit | undefined {
    const direct = killer ? creditFor(killer) : undefined;
    if (this.killCredit !== 'champion') return direct;
    // A champion (or their summon, already walked up to them) landed it —
    // there is nothing to correct, and a kill steal between champions is a
    // real thing that happened.
    if (direct && direct.killCredit === 'champion') return direct;
    return this.lastChampionAttacker() ?? direct;
  }

  /**
   * The enemy champion whose hit on this unit is the most recent one still
   * inside the map's `killCreditWindowMs`, or null when none is.
   *
   * Read off the same ledger `payAssists` uses, which already holds the right
   * thing: one entry per attacker, enemies only, and already booked through
   * `killCreditedTo` so a clone's chip damage names the player who summoned
   * it. `killCredit === 'champion'` is what filters the turrets and the
   * minions back out of it.
   *
   * Scanned for the maximum rather than taken from the end: a `Map` keeps
   * *insertion* order, and `rememberParticipant` re-`set`s an existing key
   * without moving it, so the last entry is the first attacker to arrive, not
   * the last one to swing.
   *
   * A dead candidate still counts, for `payAssists`' reason — somebody who
   * committed to the fight and lost it still fought it. One that has left the
   * world (`toRemove`) does not; there is nobody left to pay.
   */
  private lastChampionAttacker(): AttackableUnit | null {
    const windowMs = resolveEconomy(this.game?.mapTuning).killCreditWindowMs;
    if (windowMs <= 0) return null;
    const cutoff = (this.game?.matchTimeMs ?? 0) - windowMs;
    let best: AttackableUnit | null = null;
    let bestSeen = -Infinity;
    for (const [unit, seen] of this._assistLedger) {
      if (seen < cutoff || seen <= bestSeen) continue;
      if (unit === this || unit.toRemove) continue;
      if (unit.killCredit !== 'champion') continue;
      if (unit.teamId === this.teamId) continue;
      best = unit;
      bestSeen = seen;
    }
    return best;
  }

  /** One recap entry, and the prune in the same breath — see `recentDamageLog`. */
  private recordDamageForRecap(
    landed: number,
    type: DamageType,
    attacker?: AttackableUnit,
    source?: string,
    blocked = 0
  ): void {
    this.recordDamageInto(this.recentDamageLog, landed, type, attacker, source, blocked);
  }

  /**
   * One entry, into whichever of this unit's two ledgers is being written.
   *
   * Shared so the incoming and outgoing windows are the same rule rather than
   * two rules that agree today — see `recentDamageDealtLog`. `other` is the
   * unit at the far end of the hit: the attacker for an incoming entry, the
   * victim for an outgoing one.
   */
  private recordDamageInto(
    log: DamageLogEntry[],
    landed: number,
    type: DamageType,
    other?: AttackableUnit,
    source?: string,
    blocked = 0
  ): void {
    const atMs = this.game?.matchTimeMs ?? 0;
    const attacker = other;
    const attackerId = recapGroupOf(attacker);
    // `landed` is capped at the health pool, and regen leaves the pool
    // fractional — un-rounded, the recap printed 43.999999999999996.
    const amount = Math.round(landed);
    const eaten = Math.round(blocked);

    // Fold into a recent entry from the same attacker and ability, so a
    // damage-over-time is one line rather than forty — see
    // `DEATH_RECAP_MERGE_MS`. Walked backwards only as far as that window
    // reaches, which is at most a handful of entries.
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i];
      if (atMs - entry.atMs > DEATH_RECAP_MERGE_MS) break;
      if (entry.attackerId !== attackerId || entry.source !== source || entry.type !== type) {
        continue;
      }
      entry.amount += amount;
      entry.blocked = (entry.blocked ?? 0) + eaten;
      entry.hits += 1;
      // Dated by its latest hit, so a line still being added to is not
      // mistaken for the end of an engagement by the prune below.
      entry.atMs = atMs;
      this.pruneLog(log);
      return;
    }

    log.push({
      atMs,
      amount,
      hits: 1,
      type,
      attackerName: unitDisplayName(attacker),
      attackerId,
      source,
      blocked: eaten,
    });
    this.pruneLog(log);
  }

  /**
   * Drops everything before the fight the unit is currently in.
   *
   * The boundary is the newest gap of `DEATH_RECAP_ENGAGEMENT_GAP_MS` or more
   * between consecutive entries: everything after it is this engagement,
   * everything before it was a different one. Searched from the newest end so
   * a long skirmish of back-to-back exchanges stays whole.
   */
  /**
   * A rewound match pulls `matchTimeMs` backwards, and everything here that
   * remembers a moment remembers it as an absolute stamp on that clock. A
   * stamp from the erased future keeps telling its story after the rewind:
   * combat that "just happened" a minute from now, an assist toward a kill
   * that was unhappened, recap lines for damage nobody dealt, a reveal that
   * outlives its fog window by the whole rewound gap. Future stamps are
   * dropped or pulled back; a stamp already in the past is still true and
   * stays. Countdown fields need nothing — they never compare against the
   * clock.
   */
  rewindClocks(nowMs: number): void {
    if (this.lastCombatMs > nowMs) this.lastCombatMs = -Infinity;
    if (this._revealedUntilMs > nowMs) this._revealedUntilMs = 0;
    for (const [unit, seen] of this._assistLedger) {
      if (seen > nowMs) this._assistLedger.delete(unit);
    }
    rewindDamageLog(this.recentDamageLog, nowMs);
    rewindDamageLog(this.recentDamageDealtLog, nowMs);
  }

  private pruneLog(log: DamageLogEntry[]): void {
    for (let i = log.length - 1; i > 0; i--) {
      if (log[i].atMs - log[i - 1].atMs >= DEATH_RECAP_ENGAGEMENT_GAP_MS) {
        log.splice(0, i);
        break;
      }
    }
    // The ledger is still capped: a fight that genuinely runs long enough to
    // fill it keeps its most recent entries rather than growing for ever.
    while (log.length > DEATH_RECAP_MAX_ENTRIES) log.shift();
  }

  /**
   * Hands every live buff the hit that just resolved. Separate from the
   * mitigation loop above so a buff that only *reacts* is not sensitive to
   * where it sits in `buffs` — see `Buff.onDamageTaken`.
   *
   * Iterated over a copy: a reflect re-enters `takeDamage` on the attacker, and
   * a buff that expires during the pass would otherwise mutate the list being
   * walked.
   */
  /**
   * The same pass on the attacker's own buffs — see `Buff.onDamageDealt`.
   *
   * Its own loop rather than a branch inside `reactToDamage`, because the two
   * walk different units' buff lists and answer different questions; folding
   * them together would make every reflect on the victim read the attacker's
   * list to decide it had nothing to do.
   *
   * Silent for a unit hurting itself: a spell that charges its caster health is
   * a cost, not an attack on somebody, and an item passive that fired on it
   * would let a champion apply their own on-damage effects at will.
   */
  private reactToDamageDealt(
    swung: number,
    landed: number,
    attacker: AttackableUnit | undefined,
    type: DamageType
  ): void {
    if (!attacker || attacker === this) return;
    // Over a copy, for `reactToDamage`'s reason: an effect hung here may deal
    // damage of its own, which re-enters this funnel and can expire a buff
    // mid-pass.
    for (const buff of [...attacker.buffs]) {
      if (buff.toRemove) continue;
      // Under the buff's own name, so damage an item passive deals from in here
      // lands in the recap as that passive rather than nameless inside somebody
      // else's hit — the same bracket `reactToDamage` puts a reflect under.
      const previous = beginAttribution(buff);
      try {
        buff.onDamageDealt(swung, landed, this, type);
      } finally {
        endAttribution(previous);
      }
    }
  }

  private reactToDamage(swung: number, landed: number, attacker?: AttackableUnit): void {
    for (const buff of [...this.buffs]) {
      if (buff.toRemove) continue;
      // `DamageReflect` pays out from in here by re-entering `takeDamage` on
      // the attacker, so this bracket is what puts that hit under the reflect's
      // own name instead of leaving it nameless mid-way through someone else's
      // damage pass.
      const previous = beginAttribution(buff);
      try {
        buff.onDamageTaken(swung, landed, attacker);
      } finally {
        endAttribution(previous);
      }
    }
  }

  /**
   * Drops every crowd-control effect **somebody else** put on this unit, and
   * answers how many it took.
   *
   * The mechanic a Quicksilver-style item is, and the one an ally-cast cleanse
   * will be. It lives here rather than in whichever pack wants it first
   * because the definition of "this buff is crowd control" is core's — see
   * `CROWD_CONTROL_FLAGS`.
   *
   * **Only what someone else did to you.** `Stasis` locks a champion down with
   * the same `Stunned` bit a real stun uses, but it is self-cast and it is a
   * way *out* of a fight: one item cancelling another is a bug with two
   * buttons. The unit's own buffs are left alone, which is also the rule the
   * health bar's CC line already follows.
   *
   * Iterated over a copy, for the same reason `reactToDamage` is: deactivating
   * a buff calls out to listeners that must not mutate `buffs` under the loop.
   */
  cleanse(): number {
    let removed = 0;
    for (const buff of [...this.buffs]) {
      if (buff.toRemove) continue;
      if (buff.sourceUnit === this) continue;
      if ((buff.statusFlagsToEnable & CROWD_CONTROL_FLAGS) === 0) continue;
      buff.deactivateBuff();
      removed += 1;
    }
    return removed;
  }

  die(deathData: UnitDeathData): void {
    // `die` is reachable on a corpse — `Champion.die` runs cleanup that is safe
    // to repeat — so the ledger is only touched on the transition.
    const transition = !this.isDead;
    // Worked out once, up here, because both halves of the transition need the
    // same answer and the second half runs *after* the ledger it is read from
    // has been cleared. Asking twice was how the ON_DIE event and the payout
    // could have disagreed about who killed somebody.
    let credited: AttackableUnit | undefined;
    if (transition) {
      this.tally.deaths++;
      // Read here, at the top, because the recap headline below wants the same
      // answer the payout does — and because the ledger it comes off is
      // cleared at the bottom of this block.
      credited = this.creditForDeath(deathData.attacker);
      // The recap is the ledger as it stood at the killing blow (which
      // `takeDamage` has already written). Snapshot on the transition only, or
      // a stray second `die` would publish an empty recap over the real one.
      this._deathSeq += 1;
      this.deathRecap = {
        seq: this._deathSeq,
        // The headline names whoever the kill was booked to, so it agrees with
        // the kill feed rather than contradicting it: "Hạ gục bởi Trụ" over a
        // feed row saying a champion did it is two screens disagreeing about
        // the same death. What actually swung is still in `entries` below,
        // line by line — that is the part that is a damage log.
        killerName: unitDisplayName(credited ?? deathData.attacker),
        entries: this.recentDamageLog.slice(),
        // Snapshotted from the same window, so "you took this, you dealt
        // that" is one stretch of time read from both ends.
        dealt: this.recentDamageDealtLog.slice(),
      };
      this.recentDamageLog.length = 0;
      this.recentDamageDealtLog.length = 0;
      // The player's own death is the one hit that always lands hardest —
      // and it lands on a LAN client too, whose `die` comes from the snapshot.
      if (isLocalPlayer(this.game, this)) feel(this.game, 'death', DEATH_SHAKE_TRAUMA);
      // Who swung is not always who is paid: a summon's last hit is its
      // owner's farm, and a champion executed by a turret was killed by
      // whoever drove them under it. Everything below books to `credited` and
      // nothing to `deathData.attacker` — see `creditForDeath` for both
      // corrections.
      //
      // No attacker guard beside the `credited` one: a champion who dies with
      // nothing named as the attacker — a self-inflicted cost, a nameless tick
      // — still died to whoever was fighting them, and that is the same answer
      // for the same reason.
      if (credited && credited !== this) {
        if (this.killCredit === 'champion') {
          credited.tally.kills++;
          if (isLocalPlayer(this.game, credited)) feel(this.game, 'kill', KILL_SHAKE_TRAUMA);
        } else if (this.killCredit === 'minion') credited.tally.minionsKilled++;
        // Inside the same `!isDead` guard as the ledger and the bounty, and
        // before `clearBuffs` below touches anything: a second `die` on a
        // corpse must not pay a second set of assists.
        this.payAssists(credited);
        // Inside the same `!isDead` guard the ledger is: `die` is reachable on
        // a corpse (`Champion.die` runs cleanup that is safe to repeat), and a
        // bounty paid on every one of those calls is an unbounded gold press
        // pointed at anything that keeps hitting a body.
        credited.wallet?.earn(this.goldBounty);
        // Over the **killer**, which is the opposite of every other combat
        // text — see `GOLD_TEXT_COLOR`. Guarded on a wallet as well as on the
        // bounty, so a minion that last-hits another minion does not float a
        // number for money it cannot hold.
        if (credited.wallet && this.goldBounty > 0) {
          CombatText.show(credited, 'gold', this.goldBounty, [...GOLD_TEXT_COLOR]);
        }
      }
      // The ledger is this life's. Cleared after everything that reads it, so
      // a champion who respawns and dies again inside the window neither pays
      // a second set of assists to the same helpers nor hands the new death to
      // somebody who only ever fought the previous one.
      this._assistLedger.clear();
    }
    this.deathData = deathData;
    this.pathAgent?.clear();
    this.clearBuffs();
    // Last, so a listener sees a corpse (`isDead` true, buffs gone) with the
    // kill already counted. On the transition only, like everything above.
    if (transition) {
      const killer = deathData.attacker;
      const attributed = killer && killer !== this ? killer : undefined;
      this.game?.eventManager?.emit(EventType.ON_DIE, {
        unit: this,
        killer: attributed,
        creditedTo: credited !== this ? credited : undefined,
        credit: this.killCredit,
      } satisfies UnitDeathEvent);
    }
  }

  /**
   * Drops every buff on death instead of letting them ride the corpse (and
   * then respawn): each one is deactivated so `onDeactivate` hooks unwind
   * status flags and every spell-held reference (a stealth cloak,
   * a leashing shackle, a knock-up hold) sees `toRemove` flip. Iterate a
   * copy — `deactivateBuff()` calls out to listeners that must not mutate
   * `this.buffs` out from under this loop.
   */
  private clearBuffs(): void {
    // A permanent growth stack (`Buff.survivesDeath`) rides through — the
    // modern source game does not let death eat a Feast. Everything else is
    // unwound exactly as before.
    const surviving: Buff[] = [];
    for (const buff of this.buffs.slice()) {
      if (buff.survivesDeath && !buff.toRemove) surviving.push(buff);
      else buff.deactivateBuff();
    }
    this.buffs = surviving;
  }

  respawn() {
    this.stats.health.baseValue = this.stats.maxHealth.value;
    this.deathData = null;
    // A route planned from where the corpse fell means nothing at its team fountain.
    this.pathAgent?.clear();

    const spawnPoint = this.game.randomSpawnPoint(this.teamId);
    this.position.set(spawnPoint.x, spawnPoint.y);
    this.destination.set(spawnPoint.x, spawnPoint.y);
    // The corpse and the fountain are the whole map apart: draw the respawn at
    // the fountain, not sliding there. (The 150px net would catch it anyway;
    // this states it at the source.)
    this.snapRenderOrigin();
  }

  setStatus(status: number, enabled: boolean) {
    if (enabled) this._statusBeforeApplyingBuffEfects |= status;
    else this._statusBeforeApplyingBuffEfects &= ~status;

    // Disable wins. It used to be the other way round — enable was OR'd on last,
    // so a flag one buff turned on could not be turned off by another — which
    // made `TrueSight` unable to do the one thing it exists for: `Invisible`
    // enables `Stealthed`, `TrueSight` disables it, and the reveal simply lost.
    // Nobody noticed while stealth had no effect on anything; it does now.
    //
    // Safe in the other direction because nothing in the tree *enables* a
    // permission — `statusFlagsToEnable` is always a condition being applied
    // (Stealthed, Stunned, Suppressed, Ghosted) and `statusFlagsToDisable` is
    // always a permission being taken away (CanMove, CanCast, Targetable) or
    // this one reveal. So the two sets never met before, and this is what they
    // should do when they do.
    this.status =
      (this._statusBeforeApplyingBuffEfects | this._buffEffectsToEnable) &
      ~this._buffEffectsToDisable;

    this.stats.updateActionState(this.status);
  }

  move() {
    // Written out rather than as `p5.Vector.sub(...).normalize().mult(speed)`,
    // which allocated a vector per moving unit per frame. The arithmetic is
    // deliberately in p5's own order — normalize multiplies by `1 / len`, it
    // does not divide — so this is bit-identical to what it replaced, not
    // merely equivalent to within rounding.
    const dx = this.destination.x - this.position.x;
    const dy = this.destination.y - this.position.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const speed = this.stats.speed.value * this.terrainSpeedFactor;

    if (distance <= speed) {
      this.position.set(this.destination.x, this.destination.y);
    } else {
      // `distance > speed >= 0` here, so it is never zero and normalize's own
      // zero-length guard has nothing to protect.
      const inverseDistance = 1 / distance;
      this.position.x += dx * inverseDistance * speed;
      this.position.y += dy * inverseDistance * speed;
    }
    return true;
  }

  /**
   * Walk at a point in a straight line, ignoring terrain. Unchanged, and still
   * the right call for a dash, a hook, a displacement or a spell that writes a
   * destination — each of those means "go here now", not "plan a route". It
   * therefore *cancels* whatever route was running, so the two never fight.
   */
  moveTo(x: number, y: number) {
    this.pathAgent?.clear();
    if (this.destination.x !== x || this.destination.y !== y) this.movementRevision += 1;
    this.destination.set(x, y);
  }

  /**
   * Walk to a point, around terrain. This is the move *order*: what a right
   * click, a chase and a leash all want.
   *
   * With no navigation in the game context it is `moveTo` exactly, so a unit
   * built for a headless test behaves as it always did. `urgent` puts the
   * request at the front of the search queue — the local player's own orders
   * use it, because one frame of latency is invisible on a bot and is not on a
   * click.
   */
  navigateTo(x: number, y: number, urgent = false) {
    const navigation = this.game?.navigation;
    if (!navigation) {
      this.moveTo(x, y);
      return;
    }

    if (!this.pathAgent) this.pathAgent = new PathAgent(this, navigation);
    // A route is an order in its own right, so it bumps the same revision a
    // channelled spell watches for. Following the route does not — rounding a
    // corner is not a second order.
    if (this.destination.x !== x || this.destination.y !== y) this.movementRevision += 1;
    this.pathAgent.order(x, y, urgent);
  }

  teleportTo(x: number, y: number) {
    this.markDisplaced();
    this.pathAgent?.clear();
    this.position.set(x, y);
    this.destination.set(x, y);
    // Overrides GameObject.teleportTo, so the render-origin snap has to be
    // re-stated here — a blink must not be drawn as a slide across the map.
    this.snapRenderOrigin();
  }

  markDisplaced() {
    this.displacementRevision += 1;
    this._separationGrace = DISPLACEMENT_GRACE_FRAMES;
  }

  stopMovement() {
    this.pathAgent?.clear();
    this.destination.set(this.position.x, this.position.y);
  }

  /**
   * Speed in world units per frame. Read by the route follower.
   *
   * Carries `terrainSpeedFactor` for the same reason `move()` does: the
   * follower uses this to decide how far along a route one frame gets, so a
   * getter that disagreed with the step actually taken would make a unit in
   * slowed terrain overshoot or undershoot its own waypoints.
   */
  get moveSpeed(): number {
    return this.stats.speed.value * this.terrainSpeedFactor;
  }

  hasBuff(BuffClass: BuffConstructor): boolean {
    return this.buffs.some(buff => buff instanceof BuffClass);
  }

  /**
   * `GameObject` memoises both bounding boxes and explains why; these two
   * overrides used to allocate unconditionally, which quietly opted the most
   * numerous object on the board out of that cache. Units are the ones it
   * matters most for: each box is rebuilt for the quadtree every tick, again
   * by the draw cull, and again for every candidate of every targeting query
   * in the same frame.
   *
   * Keyed on the *computed* size rather than on `isAllied`/`visionRadius`
   * separately, because the box is fully determined by centre plus size — if
   * a team change flips which size applies, the key moves with it.
   */
  private _unitCollideBB: Circle | null = null;
  private _unitCollideBBX = NaN;
  private _unitCollideBBY = NaN;
  private _unitCollideBBSize = NaN;

  getCollideBoundingBox() {
    const size = this.animatedValues.size;
    if (
      this._unitCollideBB &&
      this._unitCollideBBX === this.position.x &&
      this._unitCollideBBY === this.position.y &&
      this._unitCollideBBSize === size
    ) {
      return this._unitCollideBB;
    }
    this._unitCollideBBX = this.position.x;
    this._unitCollideBBY = this.position.y;
    this._unitCollideBBSize = size;
    this._unitCollideBB = new Circle({
      x: this.position.x,
      y: this.position.y,
      r: size / 2,
      data: this,
    });
    return this._unitCollideBB;
  }

  getDisplayBoundingBox() {
    return this.squareDisplayBoundingBox(
      this.isAllied ? this.visionRadius * 2 : this.animatedValues.size
    );
  }

  get canCast() {
    return !this.isDead && hasFlag(this.stats.actionState, ActionState.CAN_CAST);
  }
  get canMove() {
    return !this.isDead && hasFlag(this.stats.actionState, ActionState.CAN_MOVE);
  }
  /** Gate for basic attacks. Disarm, and every crowd control that takes over a
   *  unit, clear ActionState.CAN_ATTACK through Stats.updateActionState. */
  get canAttack() {
    return !this.isDead && hasFlag(this.stats.actionState, ActionState.CAN_ATTACK);
  }
  /** Total damage every shield on this unit can still absorb. */
  get shieldAmount(): number {
    let total = 0;
    for (const buff of this.buffs) total += buff.shieldAmount || 0;
    return total;
  }

  /**
   * Body radius for unit-on-unit separation. Deliberately `stats.size`, the same
   * circle TerrainMap pushes out of walls, rather than the lerped
   * `animatedValues.size` — a body that grows and shrinks while a stacking
   * self-buff feeds
   * would make the separation it causes wobble too.
   */
  get bodyRadius(): number {
    return this.stats.size.value / 2;
  }

  /**
   * The radius *terrain* treats this body as — wall push-out
   * (`TerrainMap.pushOutOfWalls`) and route planning (`PathAgent`,
   * `NavGrid`), which have to agree or a route gets planned through a gap the
   * push-out then refuses.
   *
   * Capped at `NAV_MAX_TERRAIN_RADIUS`; see that constant for the measured
   * reason. Everything that is not terrain — the drawn body, the hitbox,
   * `combat/Reach.ts`, `UnitCollisionSystem`'s shove — deliberately keeps
   * reading `bodyRadius` and keeps scaling with the real size.
   */
  get terrainRadius(): number {
    return Math.min(this.bodyRadius, NAV_MAX_TERRAIN_RADIUS);
  }

  /**
   * Whether this unit takes part in body separation at all. Corpses do not, and
   * neither does a unit that is being displaced: a dash, a hook or a knockback
   * writes `position` directly and must win, so ghosted units are left out
   * entirely — they neither push nor get pushed. TerrainMap skips ghosted units
   * for walls on the same grounds.
   */
  get collidesWithUnits(): boolean {
    return (
      !this.isDead &&
      this._separationGrace <= 0 &&
      // Either phasing flag clears bodies. Only IS_GHOSTED clears terrain, and
      // that split lives in TerrainMap.pushOutOfWalls, not here.
      !hasFlag(this.stats.actionState, ActionState.IS_GHOSTED) &&
      !hasFlag(this.stats.actionState, ActionState.PHASES_UNITS)
    );
  }

  /** Grounded units keep walking but cannot use their own movement abilities. */
  get grounded() {
    return hasFlag(this.stats.actionState, ActionState.GROUNDED);
  }
  /**
   * Hidden by an active stealth. Nothing that picks targets on its own may
   * acquire one of these — see `PredefinedFilters.excludeStealthed`.
   *
   * There is no observer side to this: a reveal is `TrueSight`, which strips
   * `StatusFlags.Stealthed` from the hidden unit itself, so a revealed champion
   * is simply no longer stealthed.
   */
  get isStealthed() {
    return hasFlag(this.stats.actionState, ActionState.STEALTHED);
  }
  get targetable() {
    return !this.isDead && hasFlag(this.stats.actionState, ActionState.TARGETABLE);
  }
  get isDead() {
    return this.deathData !== null;
  }
  get isAllied() {
    return this.teamId === this.game.player.teamId;
  }
}

/**
 * The quiet the recap treats as the end of a fight.
 *
 * It replaces a flat twelve-second window, and the difference is the whole
 * point. That window was measured from the **most recent hit** and re-applied
 * on every new one, so a player who fought, disengaged, and was then picked
 * off watched the earlier fight get eaten a hit at a time: each blow from the
 * finisher pushed the cutoff forward until nothing but the finisher was left.
 * Reported exactly that way — "vừa combat xong, thoát combat chưa tới 3s, bị
 * một đứa ngoài combat đánh chết, chỉ thấy damage của đứa đó".
 *
 * A gap is what a player actually means by "the fight I was just in": the
 * story runs back to the last time nobody was hitting them. Eight seconds
 * because a disengage is not instant — walking out, a recall cancelled, a
 * finisher arriving — and a gap this long is already clearly a *separate*
 * fight rather than the same one.
 *
 * League's own recap is a short rolling window of about this size and is
 * long and widely criticised for exactly the failure above; matching it was
 * not worth doing.
 */
export const DEATH_RECAP_ENGAGEMENT_GAP_MS = 8_000;

/**
 * How close two hits from the same attacker and ability have to be to be
 * counted as one entry.
 *
 * Without this the gap rule above cannot deliver what it promises: a long
 * fight with a damage-over-time on it spends the ledger's whole budget on
 * tick entries, `DEATH_RECAP_MAX_ENTRIES` trims from the front, and the start
 * of the fight is gone again — the same complaint through a different door.
 *
 * Merged backwards through the window rather than only into the last entry:
 * two enemies trading blows alternate in the ledger, which is the common
 * shape and the one a last-entry-only merge would never collapse.
 */
export const DEATH_RECAP_MERGE_MS = 1_000;

/** A hard cap so a tick aura cannot grow the ledger without bound. */
export const DEATH_RECAP_MAX_ENTRIES = 60;

/** One landed hit, as the death recap will retell it. */
/**
 * `EventType.ON_TAKE_DAMAGE`'s payload: the post-mitigation number
 * `CombatText` floats over `unit`'s head, in the same breath it is shown.
 * Display truth, not combat truth — `amount` is the shown number, which the
 * health pool may then cap (see `landed` just below the emit site).
 */
export interface DamageNumberEvent {
  unit: AttackableUnit;
  amount: number;
  type: DamageType;
  /** The swing's crit roll, so a client can show the crit it cannot roll. */
  crit?: boolean;
}

/** Drops recap entries stamped after a rewind's target moment. */
const rewindDamageLog = (log: DamageLogEntry[], nowMs: number): void => {
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].atMs > nowMs) log.splice(i, 1);
  }
};

export interface DamageLogEntry {
  /** When the *latest* hit folded into this entry landed — see `DEATH_RECAP_MERGE_MS`. */
  atMs: number;
  amount: number;
  /** How many hits this entry stands for; more than one once ticks merge. */
  hits: number;
  type: DamageType;
  attackerName: string;
  attackerId: string;
  /** The ability's own name, when the damage call named one. */
  source?: string;
  /**
   * What a shield or a damage-reduction buff ate out of this hit before it
   * reached health. `0` for most entries; an entry with `amount: 0` and a
   * `blocked` is a hit that was absorbed whole.
   */
  blocked?: number;
}

/** What `die()` publishes for the HUD. */
export interface DeathRecap {
  /** Bumped per death, so the HUD can re-show a dismissed panel. */
  seq: number;
  killerName: string;
  entries: DamageLogEntry[];
  /** What the dying unit dealt over the same window — see `recentDamageDealtLog`. */
  dealt: DamageLogEntry[];
}

/** Every concrete unit type carries `name`; the base class does not declare
 *  it, so this reads it structurally and says "unknown" honestly otherwise. */
const unitDisplayName = (unit?: unknown): string =>
  (unit as { name?: string } | undefined)?.name ?? 'Không rõ';

/**
 * What the recap files a hit under — a *kind* for everything that is not a
 * champion, and the unit itself for one.
 *
 * A wave is six units with six ids, so a recap keyed on the id gave a death to
 * minions six rows of a dozen damage each, in a panel whose whole job is to
 * say what killed you at a glance. Grouping them by name answers the question
 * a player is actually asking — "how much was the wave" — and, because the
 * ledger merges entries sharing a key, it also stops a wave spending the
 * ledger's whole budget and pushing a real fight out of it.
 *
 * Champions keep their own id and are the reason this is not simply "group by
 * name": two bots can be the same champion, and folding two players into one
 * row would misreport who killed you.
 */
const recapGroupOf = (unit?: { id?: string; killCredit?: string; name?: string }): string => {
  if (!unit) return 'unknown';
  if (unit.killCredit !== 'champion') return unitDisplayName(unit);
  // **The body *and* who it currently is.** A bot re-rolls into another
  // champion every time it dies (`AIChampion._autoReroll`), so one unit id can
  // be a marksman for the first half of a skirmish and a tank for the second.
  // The recap keyed rows on the id alone and labelled each row from its
  // *first* entry, so everything that body ever did collected under whoever it
  // was first: a death screen naming a killer who has no row at all, with that
  // killer's abilities filed under the champion they used to be. Reported from
  // a real match, and it reads as nonsense because it is — two different
  // champions in one row.
  //
  // Splitting on the name is the honest answer rather than a workaround: they
  // *were* two champions, and the one that killed you is the one you want to
  // read about. `\u0000` because no display name contains it, so this can never
  // collide with a name that happens to look like an id.
  return `${unit.id ?? 'unknown'}\u0000${unitDisplayName(unit)}`;
};

/**
 * Is `unit` the champion this device is playing? Presentation asks this on
 * every hit and every death, so it must be safe to ask anywhere a unit can
 * live — including the headless test contexts, whose `player` getter throws
 * by design to catch *gameplay* that depends on one. A hit's look is not
 * gameplay, so here the honest answer to "no player" is simply "not the
 * player".
 */
function isLocalPlayer(game: GameObjectRuntimeContext | undefined, unit: AttackableUnit): boolean {
  if (!game) return false;
  try {
    return game.player === unit;
  } catch {
    return false;
  }
}

/**
 * Make the player *feel* something: the camera and the thumb, from one trauma
 * number so they always agree (`render/hitFeedback.ts` sets it,
 * `input/haptics.ts` shapes the buzz). The runtime context types its camera
 * by the two methods every context answers (`getBoundingBox`,
 * `constantSize?`); the headless test contexts and the spell suites' stub
 * cameras have no `shake`, and must not need one.
 */
function feel(game: GameObjectRuntimeContext, kind: FeedbackKind, trauma: number): void {
  const camera = game.camera as { shake?(trauma: number): void };
  camera.shake?.(trauma);
  feelHaptic(kind, trauma);
}

/**
 * A crit that looks like every other hit is not a crit. Owned by the victim,
 * not the attacker, because on a LAN client the attacker is not known — the
 * `dmg` stream names the body that was hit — and because that is where the
 * spark belongs anyway.
 */
function showCritSpark(victim: AttackableUnit): void {
  const spark = new AoePulse(victim);
  spark.radius = 55;
  spark.lifeTime = 300;
  spark.color = [255, 205, 90];
  spark.style = 'shards';
  spark.spokes = 8;
  spark.fillAlpha = 0;
  victim.game?.objectManager?.addObject?.(spark);
}
