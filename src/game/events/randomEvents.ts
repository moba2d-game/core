import { seededRandom } from '../matchSeed';
import type NavGrid from '../nav/NavGrid';

/**
 * Sự Kiện Ngẫu Nhiên: the schedule and the table, as pure data and pure
 * functions of the match seed.
 *
 * ## Why none of this touches `Math.random()` or `deltaTime`
 *
 * A LAN client builds the world itself (`matchSeed.ts` says why), so "which
 * event fires at 150 s" must be answerable by both ends from the seed alone.
 * `eventForIndex(seed, i)` is that answer. Every time below is *match time*
 * (`Game.matchTimeMs`), which only advances on a simulated, unpaused tick;
 * p5's `deltaTime` is the render clock and would make the schedule drift with
 * the frame rate.
 *
 * ## The schedule
 *
 * Event `i` starts at `EVENT_FIRST_AT_MS + i * EVENT_INTERVAL_MS` (15 s, 30 s,
 * 45 s ...) and is announced `EVENT_WARNING_MS` (4 s) before. Every event lasts
 * 8-10 s, so at least `EVENT_MIN_QUIET_MS` (5 s) of ordinary play separates
 * the end of one from the start of the next. The pace was 90 s, then 35 s; the
 * player asked for one every 15 s, so the events got shorter to keep a gap.
 */

export const EVENT_FIRST_AT_MS = 15_000;
export const EVENT_INTERVAL_MS = 15_000;
export const EVENT_WARNING_MS = 4_000;
export const EVENT_MIN_DURATION_MS = 8_000;
export const EVENT_MAX_DURATION_MS = 10_000;
/** The promise the pacing keeps: ordinary play between one event's end and the next start. */
export const EVENT_MIN_QUIET_MS = 5_000;

export type RandomEventId =
  | 'goldRain'
  | 'meteors'
  | 'gale'
  | 'quickRevive'
  | 'fog'
  | 'frenzy'
  | 'springs'
  | 'chest'
  | 'storm'
  | 'bounty';

/** Tuning. Exported because the tests pin behaviour against these, not against copies. */
export const GOLD_RAIN_DURATION_MS = 10_000;
export const GOLD_RAIN_COINS = 32;
export const GOLD_RAIN_COIN_VALUE = 20;
export const GOLD_RAIN_COIN_LIFETIME_MS = 10_000;
export const GOLD_RAIN_PICKUP_RADIUS = 70;

export const METEOR_DURATION_MS = 10_000;
export const METEOR_COUNT = 12;
export const METEOR_WARNING_MS = 2_000;
export const METEOR_RADIUS = 170;
export const METEOR_DAMAGE = 35;
export const METEOR_SOURCE = 'Thiên Thạch';
/** Every other meteor is aimed near a living champion, so the sky is not merely decorative. */
export const METEOR_AIM_JITTER = 220;

export const GALE_DURATION_MS = 8_000;
/** `Speedup.percent` is a fraction: 0.4 is +40% move speed. */
export const GALE_SPEED_PERCENT = 0.4;

export const QUICK_REVIVE_DURATION_MS = 10_000;
export const QUICK_REVIVE_FACTOR = 0.5;

export const FOG_DURATION_MS = 9_000;
/** Vision radius while the fog is down, as a share of the unit's own. */
export const FOG_VISION_FRACTION = 0.45;

export const FRENZY_DURATION_MS = 10_000;
/** `percentBaseBonus` on attack speed: a fraction, 0.4 is +40%. */
export const FRENZY_ATTACK_SPEED = 0.4;
/** Ability haste is *points*, not a fraction (`Stats.hasteCooldownMultiplier`). */
export const FRENZY_ABILITY_HASTE = 20;

export const SPRINGS_DURATION_MS = 10_000;
export const SPRING_COUNT = 3;
export const SPRING_RADIUS = 150;
/** Share of max health a champion inside heals per second, paid in `SPRING_PULSE_MS` instalments. */
export const SPRING_HEAL_FRACTION_PER_SEC = 0.04;
export const SPRING_MANA_FRACTION_PER_SEC = 0.04;
export const SPRING_PULSE_MS = 250;
/** Springs keep at least this far apart, so three of them are three places to go. */
export const SPRING_MIN_SEPARATION = 900;

export const CHEST_DURATION_MS = 10_000;
export const CHEST_RADIUS = 170;
/** Match-time seconds of uncontested standing it takes to open it. */
export const CHEST_CAPTURE_MS = 6_000;
/** Paid to every member of the team that opens it, in or out of the ring. */
export const CHEST_GOLD = 200;

export const STORM_DURATION_MS = 9_000;
export const STORM_STRIKE_INTERVAL_MS = 450;
export const STORM_WARNING_MS = 1_000;
export const STORM_RADIUS = 85;
export const STORM_DAMAGE = 22;
export const STORM_SOURCE = 'Bão Sét';
export const STORM_AIM_JITTER = 160;

export const BOUNTY_DURATION_MS = 10_000;
/** Extra gold to the champion a kill is booked to, on top of the normal bounty. */
export const BOUNTY_BONUS_GOLD = 150;

export interface RandomEventDef {
  readonly id: RandomEventId;
  /** Vietnamese, on the banner. */
  readonly name: string;
  readonly blurb: string;
  readonly durationMs: number;
  readonly color: readonly [number, number, number];
}

export const RANDOM_EVENTS: readonly RandomEventDef[] = Object.freeze([
  {
    id: 'goldRain',
    name: 'Mưa Vàng',
    blurb: 'Đồng vàng rơi khắp bản đồ. Chạy tới nhặt!',
    durationMs: GOLD_RAIN_DURATION_MS,
    color: [255, 205, 70],
  },
  {
    id: 'meteors',
    name: 'Thiên Thạch',
    blurb: 'Vòng đỏ dưới đất: 2 giây nữa thạch rơi. Chạy ra!',
    durationMs: METEOR_DURATION_MS,
    color: [255, 110, 60],
  },
  {
    id: 'gale',
    name: 'Gió Lốc',
    blurb: 'Mọi tướng chạy nhanh hơn 40%.',
    durationMs: GALE_DURATION_MS,
    color: [130, 220, 255],
  },
  {
    id: 'quickRevive',
    name: 'Hồi Sinh Nhanh',
    blurb: 'Thời gian chờ hồi sinh giảm một nửa.',
    durationMs: QUICK_REVIVE_DURATION_MS,
    color: [150, 255, 160],
  },
  {
    id: 'frenzy',
    name: 'Cuồng Nộ',
    blurb: 'Đánh nhanh hơn 40%, hồi chiêu nhanh hơn.',
    durationMs: FRENZY_DURATION_MS,
    color: [255, 85, 85],
  },
  {
    id: 'springs',
    name: 'Suối Hồi Sinh',
    blurb: 'Đứng trong vòng suối để hồi máu và mana.',
    durationMs: SPRINGS_DURATION_MS,
    color: [90, 200, 255],
  },
  {
    id: 'chest',
    name: 'Rương Báu',
    blurb: 'Giữ vòng 6 giây không có địch: cả đội nhận vàng.',
    durationMs: CHEST_DURATION_MS,
    color: [255, 190, 60],
  },
  {
    id: 'storm',
    name: 'Bão Sét',
    blurb: 'Sét đánh nhanh, báo trước 1 giây. Đừng đứng yên!',
    durationMs: STORM_DURATION_MS,
    color: [185, 150, 255],
  },
  {
    id: 'bounty',
    name: 'Truy Nã',
    blurb: 'Hạ tướng địch nhận thêm 150 vàng.',
    durationMs: BOUNTY_DURATION_MS,
    color: [255, 120, 160],
  },
  {
    id: 'fog',
    name: 'Sương Mù',
    blurb: 'Tầm nhìn của mọi tướng bị thu hẹp.',
    durationMs: FOG_DURATION_MS,
    color: [190, 190, 215],
  },
]);

export const randomEventFor = (id: RandomEventId): RandomEventDef =>
  RANDOM_EVENTS.find(event => event.id === id) ?? RANDOM_EVENTS[0];

/** When event `index` starts, in match time. */
export const eventStartMs = (index: number): number =>
  EVENT_FIRST_AT_MS + index * EVENT_INTERVAL_MS;

/** When its banner goes up. */
export const eventWarnMs = (index: number): number => eventStartMs(index) - EVENT_WARNING_MS;

/** Mixes the seed with an index (and a salt) into a fresh 32-bit seed. */
export function mixSeed(seed: number, index: number, salt = 0): number {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Which event fires as number `index`. A pure function of `(seed, index)`;
 * never the same event twice in a row, so a quiet draw cannot read as a bug.
 */
export function eventForIndex(seed: number, index: number): RandomEventDef {
  let previous = -1;
  let pick = 0;
  for (let i = 0; i <= index; i++) {
    pick = Math.floor(seededRandom(mixSeed(seed, i))() * RANDOM_EVENTS.length);
    if (pick === previous) pick = (pick + 1) % RANDOM_EVENTS.length;
    previous = pick;
  }
  return RANDOM_EVENTS[pick];
}

export interface Point {
  x: number;
  y: number;
}

/** Standing room a coin needs: a champion-sized body. */
export const REACHABLE_BODY_RADIUS = 30;
/** Keep every Nth cell, so the list stays a few thousand points on the shipped map. */
export const REACHABLE_STRIDE = 6;

/**
 * Centres of cells a champion could actually walk to from `from`.
 *
 * A flood fill over the nav grid rather than "any point not in a wall": a map
 * with a sealed vault or an island across a river has plenty of open floor
 * nobody can get to, and a coin dropped there is a coin nobody can pick up.
 * Sorted by scan order, so the list is the same on every machine.
 */
export function reachablePoints(
  grid: NavGrid,
  from: Point,
  radius = REACHABLE_BODY_RADIUS,
  stride = REACHABLE_STRIDE
): Point[] {
  const required = grid.requiredClearance(radius);
  const { cols, rows } = grid;
  let sx = grid.cellX(from.x);
  let sy = grid.cellY(from.y);
  if (!grid.cellIsWalkable(sx, sy, required)) {
    const near = grid.nearestWalkable(from.x, from.y, radius, 600);
    if (!near) return [];
    sx = grid.cellX(near.x);
    sy = grid.cellY(near.y);
  }
  const seen = new Uint8Array(cols * rows);
  const queue = new Int32Array(cols * rows);
  let head = 0;
  let tail = 0;
  queue[tail++] = sy * cols + sx;
  seen[sy * cols + sx] = 1;
  while (head < tail) {
    const at = queue[head++];
    const cx = at % cols;
    const cy = (at - cx) / cols;
    const next = [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ];
    for (const [nx, ny] of next) {
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const id = ny * cols + nx;
      if (seen[id] || !grid.cellIsWalkable(nx, ny, required)) continue;
      seen[id] = 1;
      queue[tail++] = id;
    }
  }
  const out: Point[] = [];
  for (let cy = 0; cy < rows; cy += stride) {
    for (let cx = 0; cx < cols; cx += stride) {
      if (seen[cy * cols + cx]) out.push({ x: grid.centreX(cx), y: grid.centreY(cy) });
    }
  }
  return out;
}

/** Greedy seeded pick of `count` points at least `separation` apart (relaxed if the map is too small). */
export function pickSeparated(
  points: readonly Point[],
  rng: () => number,
  count: number,
  separation: number
): Point[] {
  const out: Point[] = [];
  if (points.length === 0) return out;
  for (let k = 0; k < count; k++) {
    let chosen: Point | null = null;
    for (let attempt = 0; attempt < 60 && !chosen; attempt++) {
      const p = points[Math.floor(rng() * points.length)];
      if (out.every(o => Math.hypot(o.x - p.x, o.y - p.y) >= separation)) chosen = p;
    }
    out.push(chosen ?? points[Math.floor(rng() * points.length)]);
  }
  return out;
}

/** The reachable point nearest `target` (the chest's spot near the map centre). */
export function nearestPoint(points: readonly Point[], target: Point): Point | null {
  let best: Point | null = null;
  let bestD = Infinity;
  for (const p of points) {
    const d = (p.x - target.x) ** 2 + (p.y - target.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}
