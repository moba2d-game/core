import { seededRandom } from '../matchSeed';

/**
 * Vùng Độc Thu Hẹp — the numbers and the pure rules.
 *
 * No p5, no `Game`: everything here is a function of (map size, seed, match
 * clock), so a LAN client that shares the match seed draws the same circles the
 * host damages by, and the tests need no engine.
 *
 * ## The schedule
 *
 * Circle 0 covers the whole (square) map. The first shrink begins at
 * `ZONE_GRACE_MS` and each later one `ZONE_PERIOD_MS` after the last
 * (`zoneShrinkStartMs`); a shrink takes `ZONE_SHRINK_MS`, and for the
 * `ZONE_WARNING_MS` before it the next circle is shown so a player can walk
 * there. Circle 1 keeps the map's centre — on a lane map both fountains sit
 * near the inscribed circle, and a first circle drifted off-centre put one
 * team's fountain in the poison 30 s in, killing the player while shopping.
 * Later circles sit wholly inside the one before, at a seeded random point,
 * and the sequence stops at `ZONE_MIN_RADIUS`.
 */

/** Nothing shrinks before this: time to shop, walk out and meet the enemy. */
export const ZONE_GRACE_MS = 90_000;
export const ZONE_PERIOD_MS = 45_000;
export const ZONE_WARNING_MS = 10_000;
export const ZONE_SHRINK_MS = 8_000;
/** Each circle is this fraction of the radius before it. */
export const ZONE_SHRINK_FACTOR = 0.7;
export const ZONE_MIN_RADIUS = 350;
/**
 * True damage per second outside the zone, before it has shrunk at all.
 * Against a ~100 health pool: 6/s is a warning you can walk out of (16 s from
 * full), not a death sentence; by stage 4 it is 30/s and staying out is fatal.
 */
export const ZONE_DPS_BASE = 6;
/** Added per shrink that has begun, so staying out costs more every minute. */
export const ZONE_DPS_PER_STAGE = 6;
/** Damage is dealt in pulses, not every tick: `takeDamage` rounds to whole points. */
export const ZONE_PULSE_MS = 500;
/** Shown in the combat text and the recap. */
export const ZONE_DAMAGE_LABEL = 'Vùng Độc';
/** A champion in this mode stays down; finite because saved moments cannot store Infinity. */
export const ZONE_NO_REVIVE_MS = 3_600_000;
/**
 * Lives per champion. One life was a battle royale's rule on a 2v2: the first
 * fight sent half the match to spectate on a map built to be explored. The
 * shrinking circle still ends it — a revive comes back inside the zone.
 */
export const ZONE_LIVES = 3;
export const ZONE_REVIVE_BASE_MS = 6_000;
export const ZONE_REVIVE_STEP_MS = 3_000;

/** How long a champion stays down after its `deaths`-th death (1-based). */
export const zoneReviveAfter = (deaths: number): number =>
  deaths >= ZONE_LIVES ? ZONE_NO_REVIVE_MS : ZONE_REVIVE_BASE_MS + ZONE_REVIVE_STEP_MS * (deaths - 1);

/**
 * Where a revive lands: the team's spawn if it is safely inside the circle,
 * else pulled toward the centre to `ZONE_REVIVE_DEPTH` of the radius — a
 * fountain left outside the zone would kill on arrival.
 */
/** The player's lives, appended to the zone banner: ' · ❤ 2/3'. */
export const zoneLivesLabel = (player: { zoneLivesLeft?: number } | null | undefined): string =>
  player?.zoneLivesLeft === undefined ? '' : ` · Mạng ${player.zoneLivesLeft}/${ZONE_LIVES}`;

export const ZONE_REVIVE_DEPTH = 0.6;
export function zoneRevivePoint(
  spawn: { x: number; y: number },
  circle: { x: number; y: number; r: number }
): { x: number; y: number } {
  const dx = spawn.x - circle.x;
  const dy = spawn.y - circle.y;
  const d = Math.hypot(dx, dy);
  const limit = circle.r * ZONE_REVIVE_DEPTH;
  if (d <= limit) return { x: spawn.x, y: spawn.y };
  return { x: circle.x + (dx / d) * limit, y: circle.y + (dy / d) * limit };
}

export interface ZoneCircle {
  x: number;
  y: number;
  r: number;
}

/** Circles in order; index 0 is the whole map. Deterministic in `seed`. */
export function zoneCircles(mapSize: number, seed: number): ZoneCircle[] {
  const random = seededRandom(seed ^ 0x2b0ed);
  const circles: ZoneCircle[] = [
    // Half the diagonal: the circumscribed circle, so nothing starts outside.
    { x: mapSize / 2, y: mapSize / 2, r: (mapSize / 2) * Math.SQRT2 },
  ];
  // The loop ends: each step shrinks by a fixed factor down to the floor.
  while (circles[circles.length - 1].r > ZONE_MIN_RADIUS) {
    const prev = circles[circles.length - 1];
    const r = Math.max(ZONE_MIN_RADIUS, prev.r * ZONE_SHRINK_FACTOR);
    // Uniform over the disc of centres that keep the new circle inside the old.
    // Always draw both numbers so the seeded sequence is the same either way.
    const roll = Math.sqrt(random());
    const angle = random() * Math.PI * 2;
    const reach = circles.length === 1 ? 0 : (prev.r - r) * roll;
    circles.push({ x: prev.x + Math.cos(angle) * reach, y: prev.y + Math.sin(angle) * reach, r });
  }
  return circles;
}

export interface ZoneState {
  /** The circle in force right now (interpolated while shrinking). */
  current: ZoneCircle;
  /** The circle to be shown as a warning, or null. */
  next: ZoneCircle | null;
  /** Shrinks that have begun. 0 until the first one. */
  stage: number;
  /** Ms until the next shrink begins, or null once the zone is at its end. */
  msToNextShrink: number | null;
}

/** The zone at match time `timeMs`. */
/** Match time at which shrink `k` (1-based) begins. */
export const zoneShrinkStartMs = (k: number): number => ZONE_GRACE_MS + (k - 1) * ZONE_PERIOD_MS;

export function zoneAt(circles: readonly ZoneCircle[], timeMs: number): ZoneState {
  const last = circles.length - 1;
  const begun =
    timeMs < ZONE_GRACE_MS
      ? 0
      : Math.min(last, 1 + Math.floor((timeMs - ZONE_GRACE_MS) / ZONE_PERIOD_MS));
  const sinceBoundary = begun > 0 ? timeMs - zoneShrinkStartMs(begun) : 0;
  let current = circles[begun];
  if (begun > 0 && sinceBoundary < ZONE_SHRINK_MS) {
    const from = circles[begun - 1];
    const to = circles[begun];
    const k = sinceBoundary / ZONE_SHRINK_MS;
    current = {
      x: from.x + (to.x - from.x) * k,
      y: from.y + (to.y - from.y) * k,
      r: from.r + (to.r - from.r) * k,
    };
  }
  // The shrink that has begun is count `begun`; the next one is begun + 1.
  const msToNext = begun >= last ? null : zoneShrinkStartMs(begun + 1) - timeMs;
  const warning = msToNext !== null && msToNext <= ZONE_WARNING_MS;
  return {
    current,
    next: warning ? circles[begun + 1] : null,
    stage: begun,
    msToNextShrink: msToNext,
  };
}

export const isOutsideZone = (p: { x: number; y: number }, c: ZoneCircle): boolean =>
  Math.hypot(p.x - c.x, p.y - c.y) > c.r;

/** True damage per second for a stage. */
export const zoneDps = (stage: number): number => ZONE_DPS_BASE + ZONE_DPS_PER_STAGE * stage;

export interface Fighter {
  teamId: string;
  isDead: boolean;
}

export type ZoneResult = { winner: string } | { draw: true } | null;

/**
 * The last team with a living champion wins. `null` while two or more are
 * still standing; a draw if the last of them fell together. A match that began
 * with fewer than two teams never ends.
 */
export function zoneResult(champions: readonly Fighter[]): ZoneResult {
  const all = new Set(champions.map(c => c.teamId));
  if (all.size < 2) return null;
  const alive = new Set(champions.filter(c => !c.isDead).map(c => c.teamId));
  if (alive.size >= 2) return null;
  if (alive.size === 1) return { winner: [...alive][0] };
  return { draw: true };
}
