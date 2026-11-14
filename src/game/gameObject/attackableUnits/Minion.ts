import { Circle } from '@/libs/quadtree';
import { BASIC_ATTACK_SOURCE } from '@/game/combat/DamageAttribution';
import { BasicAttackBolt, stillInReach } from '@/game/combat/BasicAttack';
import { drawMeleeStrike, drawMeleeWindup } from '@/game/vfx/MeleeSwing';
import type { DamageType } from '@/game/combat/Mitigation';
import { dist, distSq, withinRadius } from '@/utils/math.utils';
import { MINION_BOUNTY } from '@/game/economy/Wallet';
import { MinionPresets } from '@/game/config/tuningDefaults';
import TeamId from '@/game/enums/TeamId';
import type { LaneWaypoint } from '@/game/lanes';
import { MINION_Z_INDEX, PredefinedFilters } from '@/game/managers/ObjectManager';
import MissileSpellObject, { STALLED_CHASE_MS } from '@/game/gameObject/MissileSpellObject';
import TrailSystem from '@/game/gameObject/helpers/TrailSystem';
import SpellObject from '@/game/gameObject/SpellObject';
import type GameObject from '@/game/gameObject/GameObject';
import { cssColor } from '@/game/render/cssColor';
import AttackableUnit from './AttackableUnit';
import type { HitPresentationOptions } from './AttackableUnit';
import type {
  AttackableUnitOptions,
  AttackableUnitRenderOptions,
  UnitDeathData,
} from './AttackableUnit';
import Champion from './Champion';
import Monster from './Monster';
import { pickAggroTarget, type AggroChoice, type AggroLadder } from '@/game/combat/AggroPriority';

/**
 * How a minion fights and draws — core's three built-in bodies, and the only
 * three there will be until someone writes a fourth *behaviour*.
 *
 * Split out of `MinionKind` because that one field was carrying two jobs. It
 * was the minion's **identity** (which preset is this) and also its
 * **behaviour and art**: `launchAttack` branches on `!== 'melee'` to decide
 * bolt or swing, and `draw` branches on `'cannon'`/`'ranged'` for the rings.
 * The moment a map may declare a type called `siege`, those branches would
 * silently give it melee behaviour and melee art — a new minion that fights
 * like the wrong one, with nothing anywhere saying so.
 */
export type MinionStyle = 'melee' | 'ranged' | 'cannon';

/**
 * Which preset a minion is. A free string, because a map may declare its own
 * roster (`MinionTuning.types`); core's own three are `melee`, `ranged` and
 * `cannon`, and `style` is what decides how any of them actually behaves.
 */
export type MinionKind = string;

/**
 * What a pack-drawn minion body is told about the minion it is drawing.
 *
 * Plain numbers and CSS strings, and nothing else on purpose: a body is art,
 * and art that could reach the unit could read state a LAN client does not
 * have, or write some. **One object is reused for every minion in a frame** —
 * read it inside the call and do not keep it.
 */
export interface MinionBodyView {
  /** The body's **diameter** in world units — `MinionTypeDef.size`. */
  readonly size: number;
  readonly style: MinionStyle;
  /** The team's three colours, as opaque CSS `rgb(...)` strings ready for `fillStyle`. */
  readonly colors: Readonly<{ body: string; trim: string; bar: string }>;
  /** 0 at rest and at the start of a wind-up, 1 at the moment the attack resolves. */
  readonly charge: number;
  /**
   * The swing, as a slide along `+x` in world units: negative while hauling
   * back, positive on the follow-through, 0 at rest. Melee only — a ranged
   * body reads `charge`.
   */
  readonly reach: number;
  /**
   * The machine is drowning (the deep stress rung, or an explicit Thấp): draw
   * the cheapest thing that still shows whose it is and which way it faces.
   */
  readonly thin: boolean;
  /** Match time, for idle motion. Stops with the match, unlike a wall clock. */
  readonly timeMs: number;
  /** A per-minion constant in `[0, 2π)`, so a wave does not bob in lockstep. */
  readonly seed: number;
}

/**
 * A minion type's own body. Called inside the frame core already translated to
 * the minion and rotated to its aim — the origin is its centre, `+x` is
 * forward — with the raw canvas context, not p5.
 *
 * Draw the body and nothing else: the hit flash, buffs and the health bar stay
 * core's. Leave the context as balanced as you found it (`save`/`restore` in
 * pairs); fill and stroke styles need no restoring. There can be eighty of
 * these a frame, so count your path operations.
 */
export type MinionBodyDraw = (ctx: CanvasRenderingContext2D, view: MinionBodyView) => void;

export interface MinionPresetData {
  name: string;
  kind: MinionKind;
  /** How it fights and draws. See `MinionStyle`. */
  style: MinionStyle;
  /** The type's own body, in place of the built-in one for its style. */
  draw?: MinionBodyDraw;
  /** Overrides `MINION_BOUNTY` for this type. */
  goldBounty?: number;
  speed: number;
  size: number;
  health: number;
  /** Per swing. */
  damage: number;
  /** ms between swings. */
  attackInterval: number;
  /** Surface-to-surface reach when swinging. */
  attackRange: number;
  /** Hostiles this close make it stop walking and fight. */
  aggroRange: number;
}

/**
 * Core's three bodies, defined in `game/config/tuningDefaults.ts` and
 * re-exported here, where every caller already looks for them.
 *
 * They moved because `config/mapTuning.ts` has to read them and that file is
 * pinned to the `pregame` chunk — importing this module for them put the
 * whole match chunk on the menu's first paint. See the defaults module's own
 * header for the rule, and its own doc comment for what the numbers are.
 */
export { MinionPresets } from '@/game/config/tuningDefaults';

/** World units from a waypoint that count as having reached it. */
export const WAYPOINT_TOLERANCE = 40;

/**
 * How far off its lane a minion will step to fight before giving the chase up.
 *
 * Without a leash a chase never ends: `findTarget` re-scans within `aggroRange`
 * of wherever the minion has got to, and chasing is precisely what keeps the
 * target inside that radius, so one champion could tow a whole wave across the
 * map. Measured from the lane itself (`distanceToLane`), not from the minion's
 * spawn or its current waypoint — waypoints are up to ~1500px apart, so
 * "distance to the next waypoint" is 750px in the middle of a normal segment
 * and cannot tell walking from wandering.
 *
 * 500 is comfortably past `aggroRange` (300 melee, 340 ranged), so a minion
 * still commits to anything it can legitimately see from its lane, and still
 * finishes a fight that drifts a little.
 */
export const MINION_LEASH_RANGE = 500;
/** ms between aggro scans. Re-querying the quadtree per minion per frame is the
 *  one thing on this class that would actually cost a full board its frame rate. */
export const AGGRO_SCAN_INTERVAL_MS = 200;

/**
 * Basic-attack visuals. Exported so the suite asserts the timing/speed the
 * objects are actually wired with, not a copy of the numbers — retuning one
 * should not mean editing a test.
 *
 * A champion is 55 units across and moves 180 units/sec; this is picked to
 * read as a slow, deliberate shot next to that, not a spell-speed one (a
 * long-range arrow ability and Turret's bolt both move at 780-1200 units/sec).
 */
export const RANGED_BOLT_SPEED = 360 / 60;
/** How far a minion lights fog for its team — a cheap circle, no wall raycast. */
export const MINION_FOG_REVEAL_RADIUS = 300;
/** ms of wind-up before a melee swing's damage resolves. */
export const MELEE_WINDUP_MS = 130;
/** Total ms a melee swing's visual lives, wind-up through fade. */
export const MELEE_SWING_TOTAL_MS = 300;

/**
 * A ranged minion's wind-up: this share of its own beat, up to this ceiling.
 *
 * Its own numbers rather than the champion controller's, for the same reason
 * `MELEE_WINDUP_MS` above is 130 where `BasicAttack.ts`'s is 180 — a wave is
 * forty bodies swinging at once, and a beat long enough to read on one
 * champion is a wave that looks permanently mid-animation. The share matters
 * more than the cap: a cannon's slow beat earns a long, heavy wind-up, and a
 * caster's quick one stays quick.
 */
export const RANGED_WINDUP_FRACTION = 0.25;
export const RANGED_WINDUP_MAX_MS = 240;

/** ms the cart's muzzle flash lives after the shell leaves. */
export const CANNON_FLASH_MS = 110;

/** ms a soldier's blade spends driving through after the wind-up resolves. */
export const MELEE_FOLLOW_THROUGH_MS = 120;

const TEAM_COLORS: Record<string, { body: number[]; trim: number[]; bar: number[] }> = {
  [TeamId.BLUE]: { body: [64, 142, 232], trim: [16, 44, 82], bar: [96, 186, 255] },
  [TeamId.RED]: { body: [226, 84, 68], trim: [86, 22, 18], bar: [255, 126, 106] },
};
const NEUTRAL_COLORS = { body: [150, 150, 160], trim: [40, 40, 48], bar: [200, 200, 210] };

/**
 * The minion bodies and health bar paint through the native context — a wave
 * is fifty bodies a frame and p5 charges 6-10x the raw canvas call for every
 * primitive in them (`drawHealthBar` proved the move at ~2.6x). Same geometry,
 * same colors — and the frame p5 rotated for `draw()` carries over, because
 * p5 and `drawingContext` are one canvas sharing one transform. Fill style is
 * set by the caller; these helpers only trace and fill.
 */
const ctxCircle = (ctx: CanvasRenderingContext2D, x: number, y: number, d: number): void => {
  ctx.beginPath();
  ctx.arc(x, y, d / 2, 0, Math.PI * 2);
  ctx.fill();
};
// prettier-ignore
const ctxEllipse = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void => {
  ctx.beginPath();
  ctx.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.fill();
};
// prettier-ignore
const ctxTriangle = (ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void => {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x3, y3);
  ctx.closePath();
  ctx.fill();
};

/** The soldier's blade and the thin body's — the one non-team fill both share. */
const BLADE_CSS = 'rgba(238, 242, 250, 0.922)';
/** The caster's staff stroke. */
const STAFF_CSS = 'rgba(228, 220, 200, 0.824)';

/**
 * The stable per-team fills as CSS strings, built once per array.
 *
 * The native context wants a string, and building it per call would hand back
 * the allocation the bypass exists to avoid — there are only a handful of
 * these, keyed on palette arrays that never change. One-off tints with an
 * animated alpha go through `cssColor`, which caches by value instead.
 */
const BAR_BACKING_CSS = 'rgba(10, 12, 16, 0.824)';
const barCssFor = (bar: number[]): string => `rgb(${bar[0]}, ${bar[1]}, ${bar[2]})`;
const BAR_CSS = new WeakMap<number[], string>();
const cachedBarCss = (bar: number[]): string => {
  let css = BAR_CSS.get(bar);
  if (css === undefined) {
    css = barCssFor(bar);
    BAR_CSS.set(bar, css);
  }
  return css;
};

/**
 * The full team palette (body/trim/bar), for anything that has to agree with a
 * minion about what a team looks like — the minimap's dots and the turret rows.
 * Exported rather than copied so a colour means the same thing everywhere.
 */
const rgbCss = (c: number[]): string => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
type BodyColors = MinionBodyView['colors'];
const BODY_COLORS = new WeakMap<object, BodyColors>();
const bodyColorsFor = (colors: { body: number[]; trim: number[]; bar: number[] }): BodyColors => {
  let css = BODY_COLORS.get(colors);
  if (css === undefined) {
    css = Object.freeze({
      body: rgbCss(colors.body),
      trim: rgbCss(colors.trim),
      bar: rgbCss(colors.bar),
    });
    BODY_COLORS.set(colors, css);
  }
  return css;
};

/** The one view every pack-drawn body is handed, refilled per minion. See `MinionBodyView`. */
const BODY_VIEW: { -readonly [K in keyof MinionBodyView]: MinionBodyView[K] } = {
  size: 0,
  style: 'melee',
  colors: bodyColorsFor(NEUTRAL_COLORS),
  charge: 0,
  reach: 0,
  thin: false,
  timeMs: 0,
  seed: 0,
};

/**
 * Body hooks that have thrown. A hook that throws once is not asked again for
 * the rest of the session: it would throw for every minion of its type every
 * frame, and the built-in body is a better picture than eighty warnings.
 */
const BROKEN_BODY_DRAWS = new WeakSet<MinionBodyDraw>();

export const teamColors = (teamId: string): { body: number[]; trim: number[]; bar: number[] } =>
  TEAM_COLORS[teamId] ?? NEUTRAL_COLORS;

/** The body colour alone — the minimap's case. */
export const teamBodyColor = (teamId: string): number[] => teamColors(teamId).body;

export interface MinionOptions {
  game: AttackableUnitOptions['game'];
  position?: p5.Vector;
  teamId: string;
  /** Blue-base-first for blue, already reversed for red — see getLaneWaypoints. */
  waypoints: LaneWaypoint[];
  /** Which lane it belongs to, for debugging and for the spawner's bookkeeping. */
  lane?: string;
  preset?: MinionPresetData;
  /** Spawners hand in 1: waypoint 0 is the fountain the minion is standing on. */
  startWaypointIndex?: number;
}

export type MinionPhase = (typeof Minion.PHASES)[keyof typeof Minion.PHASES];

/**
 * A lane minion. A sibling of Monster rather than a rewrite of it: same
 * scan-on-an-interval, same swing-on-a-cooldown, same "read the phase before
 * super.update() so Stats.update() sees the right regen" ordering. What differs
 * is that a minion has somewhere to be — it walks a fixed waypoint list from its
 * own base to the enemy one, fighting whatever is in the way — and that it never
 * comes back once killed.
 */
export default class Minion extends AttackableUnit {
  /** The last hit is the whole skill, and this is what it pays. See `Wallet`. */
  goldBounty = MINION_BOUNTY;

  static PHASES = {
    WALK: 'WALK',
    ATTACK: 'ATTACK',
  };

  /**
   * Above a bare AttackableUnit, below jungle camps, turrets and champions.
   * A wave should never paint over the units the player is actually reading.
   */
  static displayZIndex = MINION_Z_INDEX;

  /** Read by spell damage multipliers (a wave-clear ability) to soften hits on a wave. */
  readonly unitType = 'minion';

  name: string;
  kind: MinionKind;
  /** How this body fights and draws — never `kind`. See `MinionStyle`. */
  style: MinionStyle;
  lane: string;
  phase: MinionPhase = Minion.PHASES.WALK;
  waypoints: LaneWaypoint[];
  waypointIndex: number;
  damage: number;
  attackInterval: number;
  attackRange: number;
  aggroRange: number;
  targetLock: AttackableUnit | null = null;

  /**
   * The rung `targetLock` was taken on, carried from one scan to the next.
   *
   * Not a cache of something re-derivable: the rung is read off the victim's
   * `recentAttacker`, which is one slot per unit and is overwritten by whoever
   * swung last, so re-deriving it says "on no rung" for a target that is still
   * hitting an ally. `combat/AggroPriority`'s header has the whole account —
   * this field is what made the wave stop swapping targets every scan.
   */
  private _lockRank = Infinity;

  /**
   * Whether this minion has stood on a lane waypoint yet.
   *
   * A wave does not start on its lane: it musters between the two turrets
   * nearest its own fountain — a point the active map declares
   * (`MinionSpawner.musterPoint`) — and is handed the first waypoint *ahead*
   * of that (`nextWaypointIndexFrom`), which on TOP is 955px away across the
   * corner of the base wall. The lane itself is built to
   * be walked in straight lines — see the header of `lanes.ts` — but the join
   * onto it is not part of the lane and is not built to be anything. Measured
   * against the wall polygons that opening leg ran 42px *inside* a wall on TOP
   * and 19px from a turret centre on BOT, and it did so on the previous paths
   * as well: it is the one step a minion takes that has to be routed.
   */
  joinedLane = false;

  /** ms left before the next swing. */
  _attackCooldown = 0;
  /**
   * ms left of this minion's wind-up — the beat between committing to a swing
   * and the swing landing, which every champion has had and no minion did.
   *
   * Damage already resolved late (`MinionSwing` waits `MELEE_WINDUP_MS`, and a
   * bolt has to fly), but the *body* did not know: a minion snapped from
   * standing to having attacked, with the swing object as the only sign. The
   * timer is here so the art can lean into the swing the way a champion's does,
   * and so the two ranged styles stop looking identical.
   */
  _windupMs = 0;
  /**
   * ms left of the beat *after* the swing — a blade following through, a
   * barrel still flashing. Armed at launch as `windup + RECOVER_MS` rather
   * than when the wind-up ends, because `update` is the only thing that counts
   * either of them down and nothing fires on the boundary between them.
   */
  _recoverMs = 0;
  /** ms left before the next aggro scan, jittered so a wave does not scan in lockstep. */
  _scanCooldown: number;
  /** Last angle `aimAngle` had an answer for. See there. */
  _heading = 0;
  /** The type's own body, when its map declared one. See `MinionBodyDraw`. */
  bodyDraw?: MinionBodyDraw;
  /** Phase offset handed to `bodyDraw`, fixed for this minion's life. */
  _bodySeed = Math.random() * Math.PI * 2;

  constructor({
    game,
    position,
    teamId,
    waypoints,
    lane = '',
    preset = MinionPresets.melee,
    startWaypointIndex = 0,
  }: MinionOptions) {
    super({
      game,
      position: position ?? createVector(waypoints[0]?.x ?? 0, waypoints[0]?.y ?? 0),
      teamId,
      visionRadius: 0,
    });

    this.name = preset.name;
    this.kind = preset.kind;
    this.style = preset.style;
    this.bodyDraw = preset.draw;
    if (preset.goldBounty !== undefined) this.goldBounty = preset.goldBounty;
    this.lane = lane;
    this.waypoints = waypoints;
    this.waypointIndex = Math.min(startWaypointIndex, Math.max(0, waypoints.length - 1));

    this.stats.size.baseValue = preset.size;
    this.stats.speed.baseValue = preset.speed;
    this.stats.maxHealth.baseValue = preset.health;
    this.stats.health.baseValue = preset.health;
    this.stats.healthRegen.baseValue = 0;
    this.stats.manaRegen.baseValue = 0;
    // no vision: FogOfWar only queries the player's own team for sight sources,
    // so this would be dead weight in the quadtree's display boxes
    this.stats.visionRadius.baseValue = 0;

    this.damage = preset.damage;
    this.attackInterval = preset.attackInterval;
    this.attackRange = preset.attackRange;
    this.aggroRange = preset.aggroRange;
    this._scanCooldown = Math.random() * AGGRO_SCAN_INTERVAL_MS;

    // animatedValues start at 10 and lerp; a wave popping in from a dot looks
    // like a bug when four of them spawn at once
    this.animatedValues.size = preset.size;
    this.animatedValues.displaySize = preset.size;
  }

  update() {
    super.update();
    if (this.isDead) return;

    if (this._attackCooldown > 0) this._attackCooldown -= deltaTime;
    if (this._windupMs > 0) this._windupMs -= deltaTime;
    if (this._recoverMs > 0) this._recoverMs -= deltaTime;

    this._scanCooldown -= deltaTime;
    if (this._scanCooldown <= 0) {
      this._scanCooldown = AGGRO_SCAN_INTERVAL_MS;
      const wasAttacking = this.phase === Minion.PHASES.ATTACK;
      // Leashed: too far off the lane to still be fighting, whatever is in
      // range. Checked before the scan so a minion already out of position
      // cannot re-acquire the target that dragged it there.
      const leashed = this.distanceToLane() > MINION_LEASH_RANGE;
      // The lock is *carried into* the scan rather than thrown away by it, so
      // a minion finishes what it started and only a better rung of the ladder
      // takes it off — `combat/AggroPriority`. `updateAttack` drops a stale
      // lock every frame, which is what makes "am I still holding one" a fair
      // question to ask here once every scan.
      const picked = leashed ? null : this.findTarget(this.targetLock, this._lockRank);
      this.targetLock = picked?.unit ?? null;
      this._lockRank = picked?.rank ?? Infinity;
      this.phase = this.targetLock ? Minion.PHASES.ATTACK : Minion.PHASES.WALK;
      if (wasAttacking && this.phase === Minion.PHASES.WALK) this.resyncWaypoint();
    }

    if (this.phase === Minion.PHASES.ATTACK) this.updateAttack();
    else this.updateWalk();
  }

  /**
   * Shortest distance from this minion to the lane polyline it walks — the
   * segments between consecutive waypoints, not the waypoints themselves. See
   * `MINION_LEASH_RANGE` for why the distinction matters.
   */
  distanceToLane(): number {
    const path = this.waypoints;
    if (path.length === 0) return 0;
    if (path.length === 1) return dist(this.position.x, this.position.y, path[0].x, path[0].y);

    const { x, y } = this.position;
    let best = Infinity;
    for (let i = 0; i + 1 < path.length; i++) {
      const ax = path[i].x;
      const ay = path[i].y;
      const dx = path[i + 1].x - ax;
      const dy = path[i + 1].y - ay;
      const lengthSq = dx * dx + dy * dy;
      const t =
        lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq));
      const d = dist(x, y, ax + t * dx, ay + t * dy);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * Re-aims at the nearest waypoint *ahead of* the one already reached, after
   * a chase has moved the minion somewhere its stored index no longer
   * describes.
   *
   * `waypointIndex` only advances when the minion gets within
   * `WAYPOINT_TOLERANCE` of a waypoint, so a minion pulled off its lane at
   * index 1 comes back still aiming at index 1 — which, for a minion dragged
   * to mid, means walking all the way back past its own fountain before
   * setting off again. That is the reported bug, reproduced: a minion parked
   * at (3100,3400) headed for (350,4710), 3046px behind it, while waypoint 3
   * sat 2472px ahead.
   *
   * Never searches backwards from the current index: the lane is a route from
   * one base to the other, and a minion that has passed a waypoint has passed
   * it. Picking the global nearest would let a minion shoved back down its own
   * lane un-walk progress it had already made.
   */
  resyncWaypoint(): void {
    const { x, y } = this.position;
    let best = this.waypointIndex;
    let bestDistSq = Infinity;
    for (let i = this.waypointIndex; i < this.waypoints.length; i++) {
      const dSq = distSq(x, y, this.waypoints[i].x, this.waypoints[i].y);
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        best = i;
      }
    }
    this.waypointIndex = best;
  }

  updateWalk() {
    const waypoint = this.currentWaypoint;
    if (!waypoint) {
      this.stopMovement();
      return;
    }

    const reached = withinRadius(this.position, waypoint, WAYPOINT_TOLERANCE);
    if (reached) {
      this.joinedLane = true;
      if (this.waypointIndex < this.waypoints.length - 1) this.waypointIndex += 1;
    }

    const next = this.currentWaypoint;
    if (!next) return;
    // Routed until it is standing on the lane, straight-line after — see
    // `joinedLane`. `navigateTo` only bumps `movementRevision` when the
    // destination actually changes, so asking every frame is free, and it
    // degrades to `moveTo` in a context with no navigation at all.
    if (this.joinedLane) this.moveTo(next.x, next.y);
    else this.navigateTo(next.x, next.y);
  }

  updateAttack() {
    const target = this.targetLock;
    // a lock can go stale between scans: the target dies, gets removed, or is
    // made untargetable by a buff. Monster hit exactly this and threw on the
    // next frame reading target.position off a corpse.
    // `isStealthed` alongside the stale-lock checks, not only in the scan: the
    // scan runs every AGGRO_SCAN_INTERVAL_MS, so vanishing in front of a wave
    // still bought a fifth of a second of being hit by something that could no
    // longer see you.
    if (!target || target.toRemove || target.isDead || !target.position || target.isStealthed) {
      this.targetLock = null;
      this._lockRank = Infinity;
      this.phase = Minion.PHASES.WALK;
      return;
    }

    // surface to surface, otherwise a 40px reach can never satisfy its own check
    // against two 34px bodies standing next to each other
    const reach = this.reachTo(target);
    const distance = p5.Vector.dist(this.position, target.position);

    if (distance > reach) {
      // close the gap, but only inside the radius that made us stop: a minion
      // that chases past it would leave the lane and its wall clearance behind
      this.moveTo(target.position.x, target.position.y);
    } else {
      this.stopMovement();
      // `canAttack` because a minion swings on its own timer instead of through
      // `BasicAttackController`, which is where champions get this gate. Without
      // it a wave lifted by a knock-up or held by a slowing zone kept swinging on the
      // beat all the way up — the buff and its status flags applied correctly,
      // so the crowd control simply read as doing nothing. The cooldown is only
      // spent on a swing that actually happens, so the wave resumes the frame it
      // lands rather than firing a banked volley.
      if (this.canAttack && this._attackCooldown <= 0) {
        this._attackCooldown = this.attackInterval;
        this.launchAttack(target, reach);
      }
    }
  }

  /** Surface-to-surface reach: this minion's own radius plus the target's. */
  reachTo(target: AttackableUnit): number {
    return this.attackRange + this.stats.size.value / 2 + (target.stats?.size?.value ?? 0) / 2;
  }

  /**
   * Damage used to land the instant the cooldown allowed a swing, which made a
   * whole wave fighting unreadable — a dozen simultaneous instant hits with only
   * a 160-220ms flash to show for them. Now it lands on arrival: a slow homing
   * bolt for the caster line, a wind-up-then-strike swing for the front line.
   * Both objects re-validate the target (and this minion) right before damage
   * actually applies, so a target that dies or leaves takes nothing phantom.
   */
  launchAttack(target: AttackableUnit, reach: number): void {
    this._windupMs = this.windupFor();

    if (this.style !== 'melee') {
      const bolt = new MinionBolt(this);
      bolt.style = this.style;
      bolt.target = target;
      bolt.damage = this.damage;
      bolt.color = this.colors.bar;
      bolt.position.set(this.position.x, this.position.y);
      bolt.destination.set(target.position.x, target.position.y);
      // Nocked for the wind-up, exactly as `BasicAttackController` nocks a
      // champion's: it rides the body and brightens, and flies on the beat.
      bolt.arm(this._windupMs);
      this.game.objectManager.addObject(bolt);
      // The cart answers its own shot with a flash at the barrel.
      if (this.style === 'cannon') this._recoverMs = this._windupMs + CANNON_FLASH_MS;
    } else {
      this._recoverMs = this._windupMs + MELEE_FOLLOW_THROUGH_MS;
      const swing = new MinionSwing(this, target);
      swing.damage = this.damage;
      swing.reach = reach;
      swing.color = this.colors.bar;
      this.game.objectManager.addObject(swing);
    }
  }

  /**
   * How long this minion's wind-up is.
   *
   * Melee reads `MELEE_WINDUP_MS`, which is the same number `MinionSwing`
   * resolves its damage on — a body that wound up on a different clock from
   * the swing it spawned would be art that lies. Ranged is a share of this
   * minion's own beat, so a cannon's slow shot winds up visibly longer than a
   * caster's.
   */
  windupFor(): number {
    if (this.style === 'melee') return MELEE_WINDUP_MS;
    return Math.min(RANGED_WINDUP_MAX_MS, this.attackInterval * RANGED_WINDUP_FRACTION);
  }

  /** 0 at the start of the wind-up, 1 at the moment it resolves. */
  windupCharge(): number {
    const total = this.windupFor();
    if (total <= 0 || this._windupMs <= 0) return 0;
    return constrain(1 - this._windupMs / total, 0, 1);
  }

  /**
   * A wave's ladder, in the source game's own order.
   *
   * The floor is what this method used to be in its entirety — nearest minion,
   * else nearest of anything else hostile — and that ordering is still what
   * makes a wave fight the other wave instead of peeling off after whichever
   * champion wandered past. What is above the floor is new, and it is the
   * thing players mean by "the minions turned on me": hit an enemy champion
   * while their wave is in range and their wave answers, whatever it was doing.
   *
   * Rung 4 is written as "anything else already in the candidate set" rather
   * than as `instanceof Turret`, and cannot be written the other way: `Turret`
   * imports this module, so this module cannot import `Turret`. A tower
   * shelling the wave is the case it exists for; a hostile `Pet` doing the
   * same also satisfies it, which is the right answer for the same reason.
   * `Monster` never reaches it — the query below excludes the whole class.
   */
  private static readonly LADDER: AggroLadder<AttackableUnit> = {
    defend: [
      { attacker: unit => unit instanceof Champion, victim: ally => ally instanceof Champion },
      { attacker: unit => unit instanceof Minion, victim: ally => ally instanceof Champion },
      { attacker: unit => unit instanceof Minion, victim: ally => ally instanceof Minion },
      {
        attacker: unit => !(unit instanceof Champion) && !(unit instanceof Minion),
        victim: ally => ally instanceof Minion,
      },
      { attacker: unit => unit instanceof Champion, victim: ally => ally instanceof Minion },
    ],
    nearest: [unit => unit instanceof Minion, () => true],
  };

  /**
   * What this minion should be hitting.
   *
   * Jungle camps are excluded outright: a lane minion has no business clearing
   * the jungle, and the camps leash anyway so it would be a fight nobody wins.
   *
   * @param current The lock being carried in, or null. Only a better rung of
   *   the ladder takes it away — see `combat/AggroPriority`.
   * @param currentRank The rung `current` was taken on. Passed back in rather
   *   than recomputed, which is the whole of the fix for a wave that re-aimed
   *   five times a second; the module's header says why.
   */
  findTarget(
    current: AttackableUnit | null = null,
    currentRank = Infinity
  ): AggroChoice<AttackableUnit> | null {
    // One walk of the tree for both sides of the question. The hostile scan
    // and the ally scan used to be two `queryObjects` calls over the *same*
    // circle — identical area, different filters — so a wave in combat paid
    // the tree retrieval twice per scan, and lane aggro is already the top
    // consumer of `queryObjects` in a teamfight (~55% of ~30 calls/tick).
    // One query takes everything the circle holds that either side wants; the
    // partition below is the two old filter lists verbatim.
    //
    // The vision gate deliberately is NOT in the query filter any more. It is
    // the expensive predicate here — `canSee` raycasts walls, and on a miss
    // walks the team's borrowed eyes — and inside the filter list it ran
    // before the bounding-box and true-distance checks, i.e. it was paid for
    // corner hits the circle then threw away. It gates the same acquisition,
    // after the cheap geometry has said the unit is actually in range.
    const enemyGate = PredefinedFilters.canTakeDamageFromTeam(this.teamId);
    const allyGate = (o: GameObject): boolean =>
      (o instanceof Champion || o instanceof Minion) && o.teamId === this.teamId && !o.isDead;
    const found = this.game.objectManager.queryObjects({
      area: new Circle({
        x: this.position.x,
        y: this.position.y,
        r: this.aggroRange,
      }),
      filters: [
        (o: GameObject) =>
          allyGate(o) ||
          (enemyGate(o) &&
            !(o instanceof Monster) &&
            // a champion in a bush is not a target a minion can pick — see the
            // filter's own comment for the rule and its one deliberate looseness
            PredefinedFilters.excludeStealthed(o)),
      ],
    }) as AttackableUnit[];

    // The allied champions and minions near enough for this one to answer for.
    //
    // No vision gate on this half: you always see your own team, and an ally
    // taking hits from something *this* minion cannot see is still an ally
    // taking hits — the ladder refuses that attacker anyway, because a rung
    // only counts when the attacker is in the candidate set. And no distance
    // re-check either, exactly as the old ally query had none.
    const allies: AttackableUnit[] = [];
    // The quadtree answers by bounding box, so the circle is re-checked here.
    const candidates: AttackableUnit[] = [];
    const seenBy = PredefinedFilters.visibleTo(this);
    for (const unit of found) {
      if (unit.teamId === this.teamId) {
        allies.push(unit);
        continue;
      }
      if (p5.Vector.dist(this.position, unit.position) > this.aggroRange) continue;
      if (!seenBy(unit)) continue;
      candidates.push(unit);
    }

    // Nothing in range is the state a minion spends most of its walk in, and
    // it means there is nothing to defend either.
    if (candidates.length === 0) return null;

    const held = !!current && candidates.includes(current);

    return pickAggroTarget<AttackableUnit>({
      origin: this.position,
      current: held ? current : null,
      held,
      currentRank,
      candidates,
      allies,
      ladder: Minion.LADDER,
    });
  }

  /**
   * A minion fights whatever `targetLock` names, and `update` re-picks that
   * every retarget tick — so a taunt has to keep writing it, which `Taunt` does.
   */
  forceAttackTarget(attacker: AttackableUnit): void {
    if (this.isDead || attacker.isDead) return;
    this.targetLock = attacker;
    // Taken by force rather than off a rung, so it holds nothing against the
    // ladder — a taunt keeps its grip by being re-issued, not by outranking.
    this._lockRank = Infinity;
    this.phase = Minion.PHASES.ATTACK;
  }

  /**
   * The full signature, and it has to be the full signature: TypeScript lets
   * an override take *fewer* parameters than the method it replaces, so a
   * two-argument version of this compiles perfectly and silently drops `type`
   * and `source` on the floor — every typed hit on one of these bodies fell
   * back to `DEFAULT_DAMAGE_TYPE`. All four subclasses that override this had
   * that shape, which is how a basic attack against a bot came to be mitigated
   * by magic resist while the same swing against a human was mitigated by
   * armour. `takeDamageSignature.test.ts` is the guard.
   */
  takeDamage(
    damage: number,
    attacker?: AttackableUnit,
    type?: DamageType,
    source?: string,
    presentation?: HitPresentationOptions
  ) {
    if (this.isDead) return;
    super.takeDamage(damage, attacker, type, source, presentation);
    // super.takeDamage may have killed us; a corpse must not pick a fight. Only
    // swap targets when we have none — otherwise a wave under turret fire would
    // drop the minion it was killing every time a bolt landed.
    if (this.isDead || this.targetLock) return;
    if (!attacker || attacker instanceof Monster) return;
    if (attacker.teamId === this.teamId || attacker.isDead) return;
    this.targetLock = attacker;
    this._lockRank = Infinity;
    this.phase = Minion.PHASES.ATTACK;
  }

  /**
   * Minions are spent, not benched. AttackableUnit.update() runs a respawn timer
   * off `deathData`, so retiring the object outright is the only way to stay off
   * that path — a minion that respawned would come back at the enemy fountain
   * (randomSpawnPoint picks either one) with a lane it had already walked.
   */
  die(deathData: UnitDeathData) {
    super.die(deathData);
    this.targetLock = null;
    this._lockRank = Infinity;
    this.stopMovement();
    this.toRemove = true;
  }

  /** Belt and braces: nothing should reach this, and if it does it must not revive. */
  respawn() {
    this.toRemove = true;
  }

  // ---------------------------------------------------------------- rendering

  get currentWaypoint(): LaneWaypoint | undefined {
    return this.waypoints[this.waypointIndex];
  }

  get colors() {
    return TEAM_COLORS[this.teamId] ?? NEUTRAL_COLORS;
  }

  /**
   * Which way this body is pointing.
   *
   * Nothing on `AttackableUnit` answers this for a minion: `drawDir` is the
   * champion's mouse heading and this class overrides it to nothing, and
   * `moveTo` leaves no facing behind it. Two of the three silhouettes below
   * are asymmetric and need one, so it is derived rather than stored — what
   * it is hitting if it is hitting anything, else the waypoint it is walking
   * at.
   *
   * The last answer is kept and reused when there is no aim at all, so a
   * minion standing on its final waypoint with nothing in range holds the
   * heading it arrived on instead of snapping east.
   */
  aimAngle(): number {
    const lock = this.targetLock;
    const aim = lock && !lock.isDead && lock.position ? lock.position : this.currentWaypoint;
    if (aim) {
      const dx = aim.x - this.position.x;
      const dy = aim.y - this.position.y;
      if (dx !== 0 || dy !== 0) this._heading = Math.atan2(dy, dx);
    }
    return this._heading;
  }

  /**
   * Team colour directly rather than `isAllied`, so both sides keep their own
   * stable map identity regardless of which team the local player belongs to.
   *
   * Hand-drawn on purpose — no avatar, no particle system, no trail. There can
   * be dozens of these on screen and each one has to stay a handful of
   * draw calls.
   *
   * ## Three silhouettes, not three decorations on one silhouette
   *
   * All three used to be the same disc wearing a different ring: a caster was
   * a disc with one ring, a cannon a disc with two. At the zoom a lane is
   * actually played at, one ring against two is not a difference anybody reads
   * — and the cannon is the body a player most needs to pick out of a wave,
   * being the one worth three times the gold and the one that shells a turret.
   *
   * So each style now has its own *shape*, which survives being small: the
   * front line is a round body with a blade out front, the back line is a
   * smaller body carrying a lit orb, and the siege body is a wheeled cart with
   * a barrel. Everything is drawn in a frame rotated to `aimAngle`, which is
   * what makes the last two read as facing something rather than as ornaments.
   *
   * The cart costs about nine calls against the other two's four. It is at
   * most one per wave per lane — three on the board in an ordinary minute
   * against forty of the others — so it is the one body that can afford them.
   */
  draw({ compactUnits = false, thinCrowd = false }: AttackableUnitRenderOptions = {}) {
    if (this.isDead) return;

    const size = this.stats.size.value;

    push();
    translate(this.position.x, this.position.y);
    rotate(this.aimAngle());
    noStroke();

    if (this.drawOwnBody(size, thinCrowd)) {
      // the type drew itself
    } else if (thinCrowd) this.drawThinBody(size);
    else if (this.style === 'cannon') this.drawCart(size);
    else if (this.style === 'ranged') this.drawCaster(size);
    else this.drawSoldier(size);
    // In the rotated frame, over the body: the base's `drawAvatar` is not
    // used here, so the flash it would have painted is painted by hand.
    this.drawHitFlash(0, 0, size * 1.12);

    pop();

    // the swing/bolt objects spawned by launchAttack() draw themselves as
    // separate objects now, so there is nothing left to flash here
    // buffs land on minions like they do on anyone else — a stunned minion with
    // no visual reads as a stuck one. Free when the list is empty, which it
    // usually is
    this.drawBuffs(compactUnits);
    this.drawHealthBar();
  }

  /**
   * The type's own body, if its map gave it one. Answers whether it drew.
   *
   * Pack code on the render path, so it is fenced: a throw is caught, reported
   * once, and the hook is retired — the caller falls through to the built-in
   * body for this frame and every later one. The `save`/`restore` pair puts
   * back whatever transform or alpha a half-finished hook left behind.
   */
  private drawOwnBody(size: number, thin: boolean): boolean {
    const hook = this.bodyDraw;
    if (!hook || BROKEN_BODY_DRAWS.has(hook)) return false;

    const view = BODY_VIEW;
    view.size = size;
    view.style = this.style;
    view.colors = bodyColorsFor(this.colors);
    view.charge = this.windupCharge();
    view.reach = this.style === 'melee' ? this.windupReach(size) : 0;
    view.thin = thin;
    view.timeMs = this.game.matchTimeMs ?? 0;
    view.seed = this._bodySeed;

    const ctx = drawingContext;
    ctx.save();
    try {
      hook(ctx, view);
      return true;
    } catch (error) {
      BROKEN_BODY_DRAWS.add(hook);
      console.warn(`[minion] "${this.kind}" body draw threw; using the built-in body`, error);
      return false;
    } finally {
      ctx.restore();
    }
  }

  /**
   * The front line: a round body, a shield plate across the leading edge and a
   * short blade past it. The disc is what every minion used to be, kept here
   * because this is the body a player reads as "the ordinary one".
   *
   * Drawn in the rotated frame, so `+x` is forward.
   */
  /**
   * The same minion with the detail taken out, for a machine that is drowning.
   *
   * Only reached through `thinCrowd` — the deep stress rung, or an explicit
   * Thấp. Fifty-three minion bodies are on screen in a teamfight and each full
   * one is eight or nine p5 calls; this is four, and p5 charges 6-10x the raw
   * canvas call underneath every one of them.
   *
   * What it keeps is what a minion is *for*: the team colour, so you know whose
   * it is, and the blade out front, so you know which way it faces. Those two
   * facts are the whole of what a player reads off a body in a wave. What goes
   * is the trim ring, the shield boss and the caster's orb — decoration that
   * distinguishes one anonymous body from another anonymous body.
   *
   * The three styles collapse into one shape here on purpose. Telling a caster
   * from a soldier matters at a glance in an ordinary frame and it is *not*
   * what a player is deciding on at fifteen frames a second; the cannon keeps
   * its own size (`stats.size`) so the body worth three times the gold is still
   * the biggest thing in the wave.
   */
  private drawThinBody(size: number): void {
    const ctx = drawingContext;
    const { body } = this.colors;
    ctx.fillStyle = cachedBarCss(body);
    ctxCircle(ctx, 0, 0, size);
    // the blade, unanimated: `windupReach` is the swing, and a swing is motion
    // nobody can see at this frame rate
    ctx.fillStyle = BLADE_CSS;
    ctxTriangle(ctx, size * 0.34, -size * 0.11, size * 0.34, size * 0.11, size * 0.82, 0);
  }

  private drawSoldier(size: number): void {
    const ctx = drawingContext;
    const { body, trim } = this.colors;

    ctx.fillStyle = cssColor(trim[0], trim[1], trim[2], 200);
    ctxCircle(ctx, 0, 0, size * 1.12);
    ctx.fillStyle = cachedBarCss(body);
    ctxCircle(ctx, 0, 0, size);

    // blade — a bright wedge past the front, the one thing that says which way
    // this is facing, and the one thing that moves when it swings.
    //
    // The wind-up hauls it back and the release drives it through: the same
    // shape, slid along the facing axis by `windupReach`. A rotation would read
    // better still and cannot be had here — the whole body is already drawn in
    // a frame rotated to `aimAngle`, so turning the blade turns it away from
    // what it is swinging at.
    const reach = this.windupReach(size);
    ctx.fillStyle = BLADE_CSS;
    // prettier-ignore
    ctxTriangle(ctx, size * 0.34 + reach, -size * 0.11, size * 0.34 + reach, size * 0.11, size * 0.82 + reach, 0);

    // shield boss, offset off the axis so the blade is not drawn through it
    ctx.fillStyle = cssColor(trim[0], trim[1], trim[2], 245);
    ctxCircle(ctx, size * 0.2, size * 0.24, size * 0.34);
  }

  /**
   * The back line: a smaller body with a lit orb held out in front of it, on a
   * staff. Smaller *and* a different shape — a caster that was only smaller
   * would be a melee minion at range, which is what the old ring amounted to.
   *
   * The orb breathes on `frameCount` rather than on any state of this minion,
   * so a whole back line does not pulse in lockstep only by accident: each
   * body offsets the phase by its own attack cooldown, which is already
   * jittered per minion.
   */
  private drawCaster(size: number): void {
    const ctx = drawingContext;
    const { body, trim } = this.colors;
    const orbX = size * 0.5;
    const orbY = -size * 0.26;
    const breath = 1 + 0.12 * Math.sin(frameCount * 0.08 + this._scanCooldown);

    ctx.fillStyle = cssColor(trim[0], trim[1], trim[2], 200);
    ctxCircle(ctx, 0, 0, size * 1.02);
    ctx.fillStyle = cachedBarCss(body);
    ctxCircle(ctx, 0, 0, size * 0.88);

    ctx.strokeStyle = STAFF_CSS;
    ctx.lineWidth = Math.max(1.5, size * 0.07);
    ctx.beginPath();
    ctx.moveTo(size * 0.06, size * 0.1);
    ctx.lineTo(orbX, orbY);
    ctx.stroke();

    // The orb swells through the wind-up and drops back the moment the bolt
    // leaves — which is what makes a caster read as *casting* rather than as
    // standing beside a bolt that appeared.
    const gather = this.windupCharge();
    ctx.fillStyle = cssColor(255, 235, 190, 110 + 90 * gather);
    ctxCircle(ctx, orbX, orbY, size * 0.44 * breath * (1 + 0.5 * gather));
    ctx.fillStyle = cssColor(255, 255, 255, 235);
    ctxCircle(ctx, orbX, orbY, size * (0.2 + 0.16 * gather));
  }

  /**
   * How far the blade is slid along the facing axis this frame.
   *
   * Negative through the wind-up (hauled back), positive on the follow-through,
   * zero at rest. `MinionSwing` owns the *damage* and its own arc; this is the
   * body that throws it, which is the half that was missing — damage already
   * resolved late while the soldier snapped from standing to having attacked.
   */
  private windupReach(size: number): number {
    if (this._windupMs > 0) return -size * 0.3 * this.windupCharge();
    if (this._recoverMs <= 0) return 0;
    // Driving through, then easing back: `_recoverMs` runs from
    // MELEE_FOLLOW_THROUGH_MS down to zero once the wind-up has cleared.
    return size * 0.26 * constrain(this._recoverMs / MELEE_FOLLOW_THROUGH_MS, 0, 1);
  }

  /**
   * The siege body: an armoured wagon with a barrel out front.
   *
   * Curves rather than corners, and that is the whole of the second pass at
   * it. The first drew the chassis as two `quad`s, which at a lane's zoom is a
   * grey oblong with a stick on it — a shape that reads as *unfinished* beside
   * the round bodies it walks with rather than as a different kind of unit.
   * An ellipse hull, round wheels, a capped barrel and a lit muzzle are the
   * same nine draw calls and the same silhouette, with nothing square left in
   * it to catch the eye.
   *
   * Order matters twice: the wheels go down first so the hull sits over their
   * tops, and the barrel before the hull so it reads as emerging from the body
   * rather than as glued to the front of it.
   *
   * This is the one body that can afford nine calls — at most one per wave per
   * lane, three on the board in an ordinary minute, against forty of the
   * others.
   */
  private drawCart(size: number): void {
    const ctx = drawingContext;
    const { body, trim } = this.colors;
    const axle = size * 0.42;
    const wheel = size * 0.36;
    const muzzle = size * 0.86;

    ctx.fillStyle = cssColor(22, 24, 32, 242);
    ctxCircle(ctx, -size * 0.08, -axle, wheel);
    ctxCircle(ctx, -size * 0.08, axle, wheel);
    ctx.fillStyle = cssColor(trim[0], trim[1], trim[2], 210);
    ctxCircle(ctx, -size * 0.08, -axle, wheel * 0.4);
    ctxCircle(ctx, -size * 0.08, axle, wheel * 0.4);

    ctx.save();
    ctx.strokeStyle = cssColor(56, 60, 74, 245);
    ctx.lineWidth = size * 0.26;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(size * 0.1, 0);
    ctx.lineTo(muzzle, 0);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = cssColor(trim[0], trim[1], trim[2], 235);
    ctxEllipse(ctx, 0, 0, size * 1.16, size * 0.98);
    ctx.fillStyle = cachedBarCss(body);
    ctxEllipse(ctx, 0, 0, size * 1.0, size * 0.82);
    // a soft highlight along the top-left, so the hull reads as rounded metal
    // rather than as a flat disc with a gun on it
    ctx.fillStyle = cssColor(255, 255, 255, 55);
    ctxEllipse(ctx, -size * 0.1, -size * 0.16, size * 0.52, size * 0.24);

    // The muzzle: banked while the shell is being loaded, then blown out.
    //
    // A cart used to fire with no sign it had — the shell simply appeared and
    // left, which for the one body in a wave worth three times the gold is the
    // wrong body to have the least to look at. The charge is the same
    // `windupCharge` the caster's orb swells on; the flash is `_recoverMs`
    // running out afterwards.
    const charge = this.windupCharge();
    const flash = this._windupMs > 0 ? 0 : constrain(this._recoverMs / CANNON_FLASH_MS, 0, 1);

    if (flash > 0) {
      // A short cone off the barrel, brightest at the lip.
      ctx.fillStyle = cssColor(255, 236, 190, 210 * flash);
      // prettier-ignore
      ctxTriangle(ctx, muzzle, -size * 0.2 * flash, muzzle, size * 0.2 * flash, muzzle + size * 0.62 * flash, 0);
      ctx.fillStyle = cssColor(255, 255, 255, 230 * flash);
      ctxCircle(ctx, muzzle + size * 0.12 * flash, 0, size * 0.3 * flash);
    }

    ctx.fillStyle = cssColor(255, 214, 128, 240);
    ctxCircle(ctx, muzzle, 0, size * (0.2 + 0.22 * charge + 0.3 * flash));
  }

  /** Lights a cheap circle for the player team; minions carry no combat sight. */
  get fogRevealRadius(): number {
    return MINION_FOG_REVEAL_RADIUS;
  }

  /** Points at whatever it is hitting. The base class points at the mouse. */
  drawDir() {}

  /** Tiny, and no readout — champion-sized bars across a full board are a wall of text. */
  /**
   * Two rectangles, painted through the native context instead of p5.
   *
   * **The most-called draw in the game.** A lane's worth of minions is fifty-odd
   * of these a frame, every frame, and they are the one body a fight always has
   * more of. Measured against the raw canvas doing the identical work, p5's
   * wrapper costs 6–10x: `rect()` with a `fill()` is ~0.80us where
   * `fillStyle` + `fillRect` is ~0.08, and `push`/`pop` is ~0.87us where
   * `save`/`restore` is ~0.26. Almost all of that is p5 normalising arguments
   * and re-applying style state, not the browser drawing anything — so this bar
   * was very nearly all wrapper.
   *
   * `save`/`restore` around it because the fill is the only state touched and
   * p5's own must come back untouched: p5 caches what it last applied, and a
   * `fillStyle` written behind its back would make its next `fill()` a no-op.
   * The transform is p5's own, already on the context, so world coordinates
   * mean here exactly what they mean above. `fillRect` needs no `noStroke()` —
   * it has no stroke to turn off.
   *
   * The same trade is available in every hot draw path and is deliberately not
   * taken in the cold ones: p5 is what every pack writes its spells against,
   * and readable art is worth more than a microsecond nobody can measure.
   */
  drawHealthBar() {
    const pos = this.position;
    const size = this.stats.size.value;
    const w = 30;
    const h = 4;
    const x = pos.x - w / 2;
    const y = pos.y - size * 0.72 - h;
    const percent = Math.max(0, Math.min(1, this.stats.health.value / this.stats.maxHealth.value));

    const ctx = drawingContext;
    ctx.save();
    ctx.fillStyle = BAR_BACKING_CSS;
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = cachedBarCss(this.colors.bar);
    ctx.fillRect(x, y, w * percent, h);
    ctx.restore();
  }

  getDisplayBoundingBox() {
    // the base sizes an allied unit's box by its vision radius; a minion grants
    // no vision, so its box is just its body — except the cart, whose barrel
    // reaches nearly a full body length past its centre and would be culled at
    // the screen edge a beat before the rest of it (`drawCart`).
    const spread = this.style === 'cannon' ? 2.3 : 1.4;
    return this.squareDisplayBoundingBox(this.stats.size.value * spread);
  }
}

/**
 * A ranged minion's basic attack: a small bolt that homes on its target and
 * damages it on arrival — nothing on the way, nothing if the target is gone
 * by the time it gets there. Mirrors TurretBolt (Turret.ts): `maxHitCount = 0`
 * switches MissileSpellObject's in-flight collision off entirely, so this can
 * only ever hit the one unit it was fired at, and only once, at the end.
 *
 * No trail, no particle system — up to two dozen of these can be in flight at
 * once during a big wave fight.
 */
/**
 * A ranged minion's shot, nocked for the body's wind-up and then flying.
 *
 * Extends the champion's bolt rather than `MissileSpellObject` directly, for
 * one thing it has and this did not: `arm(ms)`, which keeps the shot riding
 * the attacker while the wind-up runs and releases it on the beat. Writing a
 * second copy of that was the alternative, and the two would have drifted.
 *
 * What it does **not** inherit is `onArrive`. A champion's bolt lands through
 * `landBasicAttack` — crit, on-hit, lifesteal, the whole shelf — and a minion's
 * has never gone through any of it. That difference is deliberate and is the
 * reason this class still exists at all.
 */
export class MinionBolt extends BasicAttackBolt {
  size = 14;
  /**
   * Which body fired it, so the shell and the orb do not look the same.
   *
   * The two ranged styles were one object in two colours: a caster's bolt and
   * a cannon's shell were the same circle, which is exactly backwards for the
   * one body in a wave a player most needs to pick out.
   */
  style: MinionStyle = 'ranged';

  /**
   * No trail on a caster. Forty of them in a lane is forty trail systems, and
   * the shot is short enough that nobody reads one; the cart's shell keeps its
   * own, being one body per wave and the one worth watching.
   */
  trailSystem: TrailSystem | null = null;

  onArrive(): void {
    const target = this.target;
    if (target && !target.isDead && !target.toRemove && target.targetable && !this.owner.isDead) {
      target.takeDamage(this.damage, this.owner, 'PHYSICAL', BASIC_ATTACK_SOURCE);
    }
  }

  draw() {
    const pos = this.position;
    const [r, g, b] = this.color;
    const nocked = this.armMs > 0;
    const charge = this.nockCharge();

    push();
    noStroke();

    if (this.style === 'cannon') {
      // A shell: dark, solid, and clearly heavier than the caster's light.
      const grown = this.size * (nocked ? 0.5 + 0.7 * charge : 1.25);
      fill(r, g, b, nocked ? 60 + 90 * charge : 120);
      circle(pos.x, pos.y, grown * 1.7);
      fill(38, 34, 30, nocked ? 120 + 120 * charge : 245);
      circle(pos.x, pos.y, grown);
      // The lit fuse, which is the whole reason a shell reads as a shell.
      fill(255, 190, 90, nocked ? 140 + 110 * charge : 220);
      circle(pos.x, pos.y - grown * 0.42, grown * 0.34);
    } else if (nocked) {
      // Gathering in the caster's hand: small and dim to full and bright.
      fill(r, g, b, 40 + 60 * charge);
      circle(pos.x, pos.y, this.size * (0.7 + 1.2 * charge));
      fill(255, 255, 255, 90 + 140 * charge);
      circle(pos.x, pos.y, this.size * (0.2 + 0.4 * charge));
    } else {
      fill(r, g, b, 90);
      circle(pos.x, pos.y, this.size * 1.8);
      fill(255, 255, 255, 220);
      circle(pos.x, pos.y, this.size * 0.55);
    }

    pop();
  }
}

/**
 * The melee minion's basic attack: a short wind-up, then a fan-shaped swipe
 * that lands on contact. Not a MissileSpellObject — nothing travels — but the
 * same discipline applies: damage resolves exactly once, at the strike
 * instant, and only if the target (and this minion) are still valid then.
 */
export class MinionSwing extends SpellObject {
  target: AttackableUnit | null;
  damage = 0;
  /** Surface-to-surface reach, re-checked at the strike instant. */
  reach = 40;
  color: number[] = [255, 220, 160];
  age = 0;
  struck = false;

  constructor(owner: AttackableUnit, target: AttackableUnit) {
    super(owner);
    this.target = target;
  }

  update() {
    this.age += deltaTime;
    this.position.set(this.owner.position.x, this.owner.position.y);

    if (!this.struck && this.age >= MELEE_WINDUP_MS) {
      this.struck = true;
      this.strike();
    }
    if (this.age >= MELEE_SWING_TOTAL_MS) this.toRemove = true;
  }

  strike(): void {
    const target = this.target;
    if (!target || target.isDead || target.toRemove || !target.targetable || this.owner.isDead) {
      return;
    }
    // The target may have drifted during the wind-up — but not by walking. See
    // `stillInReach`: a swing that a target can stroll out of is a swing that
    // never lands on anything retreating, which is most of a lane fight.
    if (!stillInReach(this.owner, target, this.reach, MELEE_WINDUP_MS)) return;
    target.takeDamage(this.damage, this.owner, 'PHYSICAL', BASIC_ATTACK_SOURCE);
  }

  draw() {
    const target = this.target;
    const pos = this.owner.position;
    let dirX = 1;
    let dirY = 0;
    if (target) {
      const dx = target.position.x - pos.x;
      const dy = target.position.y - pos.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) {
        dirX = dx / len;
        dirY = dy / len;
      }
    }
    const angle = Math.atan2(dirY, dirX);
    const style = {
      bodyRadius: this.owner.stats.size.value / 2,
      reach: this.reach,
      color: this.color,
    };

    push();
    translate(pos.x, pos.y);
    rotate(angle);

    if (this.age < MELEE_WINDUP_MS) {
      drawMeleeWindup(style, this.age / MELEE_WINDUP_MS);
    } else {
      drawMeleeStrike(
        style,
        constrain((this.age - MELEE_WINDUP_MS) / (MELEE_SWING_TOTAL_MS - MELEE_WINDUP_MS), 0, 1)
      );
    }

    pop();
  }

  getDisplayBoundingBox() {
    return this.squareDisplayBoundingBox((this.reach + 20) * 2);
  }
}
