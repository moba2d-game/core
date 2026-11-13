import GameObject, { type GameObjectGameContext } from '@/game/gameObject/GameObject';
import { GROUND_Z_INDEX } from '@/game/managers/ObjectManager';
import CombatText, { GOLD_TEXT_COLOR } from '@/game/gameObject/helpers/CombatText';
import type Champion from '@/game/gameObject/attackableUnits/Champion';
import {
  CHEST_CAPTURE_MS,
  CHEST_GOLD,
  CHEST_RADIUS,
  GOLD_RAIN_COIN_LIFETIME_MS,
  GOLD_RAIN_COIN_VALUE,
  GOLD_RAIN_PICKUP_RADIUS,
  METEOR_DAMAGE,
  METEOR_RADIUS,
  METEOR_SOURCE,
  METEOR_WARNING_MS,
  SPRING_HEAL_FRACTION_PER_SEC,
  SPRING_MANA_FRACTION_PER_SEC,
  SPRING_PULSE_MS,
  SPRING_RADIUS,
  STORM_DAMAGE,
  STORM_RADIUS,
  STORM_SOURCE,
  STORM_WARNING_MS,
} from './randomEvents';

/**
 * The things a random event leaves lying on the map. All of them read **match
 * time** through `now()` (never `deltaTime`), so their timing is the
 * schedule's and survives a pause or a changed frame rate.
 *
 * ## Drawing budget
 *
 * Every `draw` here is a bounded handful of primitives (the busiest, the chest,
 * is about 25), allocates nothing per frame, never reads the camera, and sits on
 * the ground layer. Each one that paints past its own centre overrides
 * `getDisplayBoundingBox` with the real extent of its art, so the object manager
 * culls it exactly when none of it can be on screen. The pseudo-random look
 * (sparkle phases, bolt zigzags) comes from a tiny table or a number fixed in
 * the constructor, never from `random()` in a draw.
 */

/** How long the impact flash lingers after the damage has been dealt. */
export const METEOR_FLASH_MS = 700;
export const LIGHTNING_FLASH_MS = 380;
export const CHEST_BURST_MS = 900;
/** How far above the target a meteor / bolt starts, in world px. */
const METEOR_FALL_PX = 720;
const BOLT_HEIGHT_PX = 900;

const TAU = Math.PI * 2;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface EventObjectOptions {
  game: GameObjectGameContext;
  x: number;
  y: number;
  now: () => number;
  champions: () => readonly Champion[];
}

/** Four-point glint, the one sparkle shape every event reuses. */
function glint(x: number, y: number, size: number): void {
  const thin = size * 0.22;
  beginShape();
  vertex(x, y - size);
  vertex(x + thin, y - thin);
  vertex(x + size, y);
  vertex(x + thin, y + thin);
  vertex(x, y + size);
  vertex(x - thin, y + thin);
  vertex(x - size, y);
  vertex(x - thin, y - thin);
  endShape(CLOSE);
}

/** A coin on the floor. First living champion to stand within the pickup radius takes it. */
export class GoldCoin extends GameObject {
  readonly expiresAtMs: number;
  readonly value = GOLD_RAIN_COIN_VALUE;
  private readonly now: () => number;
  private readonly champions: () => readonly Champion[];

  constructor({ game, x, y, now, champions }: EventObjectOptions) {
    super({ game, position: createVector(x, y), collisionRadius: 12 });
    this.now = now;
    this.champions = champions;
    this.expiresAtMs = now() + GOLD_RAIN_COIN_LIFETIME_MS;
    this.zIndex = GROUND_Z_INDEX;
  }

  getDisplayBoundingBox() {
    return this.squareDisplayBoundingBox(90);
  }

  update(): void {
    if (this.toRemove) return;
    const now = this.now();
    if (now >= this.expiresAtMs) {
      this.toRemove = true;
      return;
    }
    let best: Champion | null = null;
    let bestD = GOLD_RAIN_PICKUP_RADIUS * GOLD_RAIN_PICKUP_RADIUS;
    for (const champion of this.champions()) {
      if (champion.isDead || !champion.wallet) continue;
      const dx = champion.position.x - this.position.x;
      const dy = champion.position.y - this.position.y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = champion;
      }
    }
    if (!best) return;
    best.wallet?.earn(this.value);
    CombatText.show(best, 'gold', this.value, [...GOLD_TEXT_COLOR]);
    this.toRemove = true;
  }

  draw(): void {
    const now = this.now();
    const left = this.expiresAtMs - now;
    // Blink in the last 2 s so a coin about to vanish says so.
    if (left < 2_000 && Math.floor(left / 150) % 2 === 0) return;
    const age = now - (this.expiresAtMs - GOLD_RAIN_COIN_LIFETIME_MS);
    // Drops in from above over the first 350 ms, then bobs.
    const fall = age < 350 ? (1 - age / 350) * (1 - age / 350) * 160 : 0;
    const bob = Math.sin(now / 180 + this.position.x) * 3;
    const { x, y } = this.position;
    const spin = Math.abs(Math.cos(now / 420 + this.position.y)); // coin turning edge-on
    push();
    noStroke();
    fill(0, 0, 0, 55);
    ellipse(x, y + 12, 22 - fall * 0.05, 8);
    fill(255, 196, 40);
    ellipse(x, y + bob - fall, 24 * (0.35 + 0.65 * spin), 24);
    fill(255, 238, 150);
    ellipse(x, y + bob - fall, 14 * (0.35 + 0.65 * spin), 14);
    // A glint that flashes once every ~1.3 s, each coin out of step.
    const phase = ((now + this.position.x * 7) % 1300) / 1300;
    if (phase < 0.3 && fall === 0) {
      const k = Math.sin((phase / 0.3) * Math.PI);
      fill(255, 255, 230, 230 * k);
      glint(x + 7, y + bob - 8, 4 + 9 * k);
    }
    pop();
  }
}

/**
 * A telegraphed impact: a red ring and a growing shadow for `METEOR_WARNING_MS`
 * while the rock falls in, then one hit of MAGIC damage labelled 'Thiên Thạch'
 * to every living champion inside, a shockwave and a scorch mark.
 */
export class MeteorStrike extends GameObject {
  readonly impactAtMs: number;
  landed = false;
  private readonly now: () => number;
  private readonly champions: () => readonly Champion[];

  constructor({ game, x, y, now, champions }: EventObjectOptions) {
    super({ game, position: createVector(x, y), collisionRadius: 1 });
    this.now = now;
    this.champions = champions;
    this.impactAtMs = now() + METEOR_WARNING_MS;
    this.zIndex = GROUND_Z_INDEX;
  }

  /** The ring, and the sky above it the rock falls through. */
  getDisplayBoundingBox() {
    return this.squareDisplayBoundingBox((METEOR_RADIUS * 1.3 + METEOR_FALL_PX) * 2);
  }

  update(): void {
    if (this.toRemove) return;
    const now = this.now();
    if (!this.landed && now >= this.impactAtMs) {
      this.landed = true;
      this.strike();
    }
    if (this.landed && now >= this.impactAtMs + METEOR_FLASH_MS) this.toRemove = true;
  }

  private strike(): void {
    const r2 = METEOR_RADIUS * METEOR_RADIUS;
    for (const champion of this.champions()) {
      if (champion.isDead) continue;
      const dx = champion.position.x - this.position.x;
      const dy = champion.position.y - this.position.y;
      if (dx * dx + dy * dy <= r2) {
        champion.takeDamage(METEOR_DAMAGE, undefined, 'MAGIC', METEOR_SOURCE);
      }
    }
  }

  draw(): void {
    const { x, y } = this.position;
    const R = METEOR_RADIUS;
    push();
    if (!this.landed) {
      const t = clamp01(1 - (this.impactAtMs - this.now()) / METEOR_WARNING_MS);
      noStroke();
      // The shadow grows as the rock nears; the fill is the same disc the old ring had.
      fill(255, 60, 40, 30 + 55 * t);
      circle(x, y, R * 2 * t);
      fill(0, 0, 0, 40 * t);
      circle(x, y, R * 1.2 * t * t);
      noFill();
      stroke(255, 80, 50, 150 + 80 * Math.abs(Math.sin(t * 9)));
      strokeWeight(4);
      circle(x, y, R * 2);
      // Falling rock: visible for the last 45% of the warning, fast and accelerating.
      if (t > 0.55) {
        const f = (t - 0.55) / 0.45;
        const h = (1 - f * f) * METEOR_FALL_PX;
        const hx = x + h * 0.28;
        const hy = y - h;
        stroke(255, 120, 40, 120);
        strokeWeight(26);
        line(hx, hy, hx + 0.28 * 130, hy - 130);
        stroke(255, 200, 90, 200);
        strokeWeight(12);
        line(hx, hy, hx + 0.28 * 90, hy - 90);
        noStroke();
        fill(255, 110, 40);
        circle(hx, hy, 46);
        fill(255, 245, 190);
        circle(hx, hy, 24);
      }
    } else {
      const f = clamp01((this.now() - this.impactAtMs) / METEOR_FLASH_MS); // 0 -> 1
      noStroke();
      // Scorch mark that outlives the flash a little.
      fill(30, 12, 8, 110 * (1 - f));
      circle(x, y, R * 1.1);
      fill(255, 170, 60, 210 * (1 - f) * (1 - f));
      circle(x, y, R * 2 * (0.6 + 0.4 * f));
      noFill();
      stroke(255, 225, 150, 255 * (1 - f));
      strokeWeight(10 * (1 - f) + 2);
      circle(x, y, R * 2.5 * (0.25 + 0.75 * f)); // shockwave
      stroke(255, 140, 60, 220 * (1 - f));
      strokeWeight(3);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + 0.3;
        const r0 = R * 0.3 + f * R * 0.8;
        line(x + Math.cos(a) * r0, y + Math.sin(a) * r0, x + Math.cos(a) * (r0 + 40), y + Math.sin(a) * (r0 + 40));
      }
    }
    pop();
  }
}

/**
 * Bão Sét: a small ring for `STORM_WARNING_MS`, then a zigzag bolt, a flash and
 * one hit of MAGIC damage to every living champion inside the ring.
 */
export class LightningStrike extends GameObject {
  readonly strikeAtMs: number;
  struck = false;
  /** Horizontal offsets of the bolt's 7 joints, fixed at construction. */
  private readonly zig = new Float32Array(7);
  private readonly now: () => number;
  private readonly champions: () => readonly Champion[];

  constructor({ game, x, y, now, champions }: EventObjectOptions) {
    super({ game, position: createVector(x, y), collisionRadius: 1 });
    this.now = now;
    this.champions = champions;
    this.strikeAtMs = now() + STORM_WARNING_MS;
    this.zIndex = GROUND_Z_INDEX;
    // Derived from the position, so two ends that agree on where agree on the bolt.
    let h = (Math.imul(Math.round(x), 73856093) ^ Math.imul(Math.round(y), 19349663)) >>> 0;
    for (let i = 0; i < this.zig.length; i++) {
      h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0;
      this.zig[i] = ((h % 1000) / 1000 - 0.5) * 120;
    }
    this.zig[this.zig.length - 1] = 0;
  }

  getDisplayBoundingBox() {
    return this.squareDisplayBoundingBox((BOLT_HEIGHT_PX + STORM_RADIUS) * 2);
  }

  update(): void {
    if (this.toRemove) return;
    const now = this.now();
    if (!this.struck && now >= this.strikeAtMs) {
      this.struck = true;
      const r2 = STORM_RADIUS * STORM_RADIUS;
      for (const champion of this.champions()) {
        if (champion.isDead) continue;
        const dx = champion.position.x - this.position.x;
        const dy = champion.position.y - this.position.y;
        if (dx * dx + dy * dy <= r2) {
          champion.takeDamage(STORM_DAMAGE, undefined, 'MAGIC', STORM_SOURCE);
        }
      }
    }
    if (this.struck && now >= this.strikeAtMs + LIGHTNING_FLASH_MS) this.toRemove = true;
  }

  draw(): void {
    const { x, y } = this.position;
    const R = STORM_RADIUS;
    push();
    if (!this.struck) {
      const t = clamp01(1 - (this.strikeAtMs - this.now()) / STORM_WARNING_MS);
      noStroke();
      fill(190, 150, 255, 35 + 45 * t);
      circle(x, y, R * 2);
      noFill();
      stroke(215, 190, 255, 160 + 90 * t);
      strokeWeight(3);
      circle(x, y, R * 2 * (1 - 0.35 * t));
      stroke(255, 255, 255, 120 * t);
      strokeWeight(2);
      line(x - 10, y, x + 10, y);
      line(x, y - 10, x, y + 10);
    } else {
      const f = clamp01((this.now() - this.strikeAtMs) / LIGHTNING_FLASH_MS);
      const a = 1 - f;
      const step = BOLT_HEIGHT_PX / this.zig.length;
      noFill();
      stroke(170, 120, 255, 190 * a);
      strokeWeight(14 * a + 2);
      this.bolt(x, y, step);
      stroke(255, 255, 255, 255 * a);
      strokeWeight(4 * a + 1);
      this.bolt(x, y, step);
      noStroke();
      fill(210, 190, 255, 170 * a * a);
      circle(x, y, R * 2.1);
      fill(255, 255, 255, 220 * a * a);
      circle(x, y, R * 0.9);
    }
    pop();
  }

  private bolt(x: number, y: number, step: number): void {
    let px = x + this.zig[0];
    let py = y - BOLT_HEIGHT_PX;
    for (let i = 1; i < this.zig.length; i++) {
      const nx = x + this.zig[i];
      const ny = y - BOLT_HEIGHT_PX + i * step;
      line(px, py, nx, ny);
      px = nx;
      py = ny;
    }
    line(px, py, x, y);
  }
}

/** Fades an event object in and out of the first and last `ms` of its life. */
const lifeFade = (now: number, startMs: number, endMs: number, ms = 500): number =>
  clamp01(Math.min((now - startMs) / ms, (endMs - now) / ms));

export interface TimedEventObjectOptions extends EventObjectOptions {
  endsAtMs: number;
}

/**
 * Suối Hồi Sinh: living champions inside the ring heal and regain mana in
 * `SPRING_PULSE_MS` instalments (a heal is rounded to whole points, so a 4%/s
 * trickle paid per 60 Hz tick would round away to nothing).
 */
export class HealingSpring extends GameObject {
  readonly startedAtMs: number;
  readonly endsAtMs: number;
  private nextPulseMs: number;
  private readonly now: () => number;
  private readonly champions: () => readonly Champion[];

  constructor({ game, x, y, now, champions, endsAtMs }: TimedEventObjectOptions) {
    super({ game, position: createVector(x, y), collisionRadius: 1 });
    this.now = now;
    this.champions = champions;
    this.startedAtMs = now();
    this.nextPulseMs = this.startedAtMs + SPRING_PULSE_MS;
    this.endsAtMs = endsAtMs;
    this.zIndex = GROUND_Z_INDEX;
  }

  getDisplayBoundingBox() {
    return this.squareDisplayBoundingBox(SPRING_RADIUS * 2.4);
  }

  /** Whether `champion` stands in the pool. */
  contains(champion: Champion): boolean {
    const dx = champion.position.x - this.position.x;
    const dy = champion.position.y - this.position.y;
    return dx * dx + dy * dy <= SPRING_RADIUS * SPRING_RADIUS;
  }

  update(): void {
    if (this.toRemove) return;
    const now = this.now();
    if (now >= this.endsAtMs) {
      this.toRemove = true;
      return;
    }
    if (now < this.nextPulseMs) return;
    this.nextPulseMs = now + SPRING_PULSE_MS;
    const share = SPRING_PULSE_MS / 1000;
    for (const champion of this.champions()) {
      if (champion.isDead || !this.contains(champion)) continue;
      champion.takeHeal(champion.stats.maxHealth.value * SPRING_HEAL_FRACTION_PER_SEC * share);
      champion.restoreMana(champion.stats.maxMana.value * SPRING_MANA_FRACTION_PER_SEC * share);
    }
  }

  draw(): void {
    const now = this.now();
    const fade = lifeFade(now, this.startedAtMs, this.endsAtMs);
    if (fade <= 0) return;
    const { x, y } = this.position;
    const R = SPRING_RADIUS;
    push();
    noStroke();
    fill(40, 150, 220, 55 * fade);
    circle(x, y, R * 2);
    fill(120, 220, 255, 45 * fade);
    circle(x, y, R * 1.25);
    noFill();
    stroke(150, 230, 255, 190 * fade);
    strokeWeight(3);
    circle(x, y, R * 2);
    // Three ripples spreading out of the centre, each a third of a cycle behind.
    strokeWeight(2);
    for (let i = 0; i < 3; i++) {
      const k = ((now / 1900 + i / 3) % 1 + 1) % 1;
      stroke(200, 245, 255, 190 * (1 - k) * fade);
      circle(x, y, R * 2 * k);
    }
    // Bubbles rising out of the pool.
    noStroke();
    for (let i = 0; i < 5; i++) {
      const k = (now / 1500 + i * 0.37) % 1;
      const bx = x + Math.sin(i * 2.4 + 1) * R * 0.55;
      fill(220, 250, 255, 200 * Math.sin(k * Math.PI) * fade);
      circle(bx, y + 14 - k * 70, 6 + (i % 3) * 2);
    }
    pop();
  }
}

/** The colour a team's progress ring is drawn in. */
const teamRgb = (teamId: string): [number, number, number] =>
  teamId === 'team-red' ? [255, 90, 90] : [90, 160, 255];

/**
 * Rương Báu. One chest, one progress meter per team. A team with a living
 * champion inside the ring and none of the other team's builds progress;
 * both present pauses everyone; opening pays every member of the opening team,
 * wherever they are standing.
 */
export class TreasureChest extends GameObject {
  readonly startedAtMs: number;
  readonly endsAtMs: number;
  opened = false;
  openedAtMs = 0;
  openedBy: string | null = null;
  contested = false;
  /** Teams that have shown up so far and their progress in ms, as parallel arrays so the draw never allocates. */
  readonly teamIds: string[] = [];
  readonly progressMs: number[] = [];
  private lastMs: number;
  private readonly now: () => number;
  private readonly champions: () => readonly Champion[];

  constructor({ game, x, y, now, champions, endsAtMs }: TimedEventObjectOptions) {
    super({ game, position: createVector(x, y), collisionRadius: 1 });
    this.now = now;
    this.champions = champions;
    this.startedAtMs = now();
    this.lastMs = this.startedAtMs;
    this.endsAtMs = endsAtMs;
    this.zIndex = GROUND_Z_INDEX;
  }

  getDisplayBoundingBox() {
    return this.squareDisplayBoundingBox(CHEST_RADIUS * 2.6);
  }

  progressOf(teamId: string): number {
    const at = this.teamIds.indexOf(teamId);
    return at < 0 ? 0 : this.progressMs[at];
  }

  private slotFor(teamId: string): number {
    let at = this.teamIds.indexOf(teamId);
    if (at < 0) {
      at = this.teamIds.length;
      this.teamIds.push(teamId);
      this.progressMs.push(0);
    }
    return at;
  }

  update(): void {
    if (this.toRemove) return;
    const now = this.now();
    const dt = Math.min(Math.max(0, now - this.lastMs), 100);
    this.lastMs = now;
    if (this.opened) {
      if (now >= this.openedAtMs + CHEST_BURST_MS) this.toRemove = true;
      return;
    }
    if (now >= this.endsAtMs) {
      this.toRemove = true;
      return;
    }
    const r2 = CHEST_RADIUS * CHEST_RADIUS;
    let only: string | null = null;
    this.contested = false;
    for (const champion of this.champions()) {
      if (champion.isDead || champion.killCredit !== 'champion') continue;
      const dx = champion.position.x - this.position.x;
      const dy = champion.position.y - this.position.y;
      if (dx * dx + dy * dy > r2) continue;
      if (only === null) only = champion.teamId;
      else if (only !== champion.teamId) this.contested = true;
    }
    if (only === null || this.contested) return;
    const at = this.slotFor(only);
    this.progressMs[at] += dt;
    if (this.progressMs[at] >= CHEST_CAPTURE_MS) this.open(only, now);
  }

  private open(teamId: string, now: number): void {
    this.opened = true;
    this.openedAtMs = now;
    this.openedBy = teamId;
    for (const champion of this.champions()) {
      if (champion.teamId !== teamId || champion.killCredit !== 'champion' || !champion.wallet) {
        continue;
      }
      champion.wallet.earn(CHEST_GOLD);
      CombatText.show(champion, 'gold', CHEST_GOLD, [...GOLD_TEXT_COLOR]);
    }
  }

  draw(): void {
    const now = this.now();
    const { x, y } = this.position;
    const R = CHEST_RADIUS;
    const fade = lifeFade(now, this.startedAtMs, this.endsAtMs);
    if (!this.opened && fade <= 0) return;
    push();
    if (!this.opened) {
      noFill();
      const flash = this.contested ? 120 + 120 * Math.abs(Math.sin(now / 120)) : 90;
      stroke(255, this.contested ? 120 : 210, this.contested ? 120 : 90, flash * fade);
      strokeWeight(3);
      circle(x, y, R * 2);
      // One arc per team that has started: sweep = share of the capture time.
      strokeWeight(9);
      for (let i = 0; i < this.teamIds.length; i++) {
        const frac = clamp01(this.progressMs[i] / CHEST_CAPTURE_MS);
        if (frac <= 0) continue;
        const c = teamRgb(this.teamIds[i]);
        stroke(c[0], c[1], c[2], 230 * fade);
        arc(x, y, R * 2 - 16 - i * 12, R * 2 - 16 - i * 12, -Math.PI / 2, -Math.PI / 2 + TAU * frac);
      }
      noStroke();
      fill(255, 210, 90, 28 * fade);
      circle(x, y, R * 2);
    }
    // Chest: shadow, body, gold band, lid (lifts when open), lock.
    const open = this.opened ? clamp01((now - this.openedAtMs) / 250) : 0;
    const bob = this.opened ? 0 : Math.sin(now / 400) * 1.5;
    noStroke();
    fill(0, 0, 0, 70);
    ellipse(x, y + 24, 64, 14);
    fill(125, 72, 34);
    rect(x - 28, y - 14 + bob, 56, 34, 4);
    fill(255, 196, 60);
    rect(x - 28, y - 2 + bob, 56, 6);
    fill(150, 88, 40);
    rect(x - 30, y - 28 + bob - open * 22, 60, 16, 5);
    fill(255, 196, 60);
    rect(x - 30, y - 22 + bob - open * 22, 60, 4);
    fill(255, 240, 170);
    circle(x, y + 1 + bob, 9);
    if (this.opened) {
      const f = clamp01((now - this.openedAtMs) / CHEST_BURST_MS);
      noFill();
      stroke(255, 225, 120, 255 * (1 - f));
      strokeWeight(8 * (1 - f) + 1);
      circle(x, y, R * 2 * (0.2 + 0.8 * f));
      strokeWeight(3);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU;
        const r0 = 30 + f * 150;
        line(x + Math.cos(a) * r0, y + Math.sin(a) * r0, x + Math.cos(a) * (r0 + 26), y + Math.sin(a) * (r0 + 26));
      }
      noStroke();
      fill(255, 250, 200, 220 * (1 - f));
      for (let i = 0; i < 5; i++) {
        glint(x + Math.sin(i * 2.1) * 80 * f, y - 20 - f * (60 + i * 18), 5 + (i % 2) * 4);
      }
    } else {
      // Idle glint over the lock.
      const phase = (now % 1600) / 1600;
      if (phase < 0.25) {
        fill(255, 255, 220, 230 * Math.sin((phase / 0.25) * Math.PI));
        noStroke();
        glint(x + 14, y - 24, 12);
      }
    }
    pop();
  }
}

/**
 * Cuồng Nộ's one piece of art: a flame ring under every champion, drawn by a
 * single object for the whole match instead of one per unit. It paints only
 * the units the player's team can see, so it cannot out a bush.
 */
export class FrenzyAura extends GameObject {
  readonly startedAtMs: number;
  readonly endsAtMs: number;
  private readonly now: () => number;
  private readonly champions: () => readonly Champion[];
  private readonly extent: number;

  constructor({
    game,
    now,
    champions,
    endsAtMs,
    extent,
  }: Omit<TimedEventObjectOptions, 'x' | 'y'> & { extent: number }) {
    super({ game, position: createVector(extent / 2, extent / 2), collisionRadius: 1 });
    this.now = now;
    this.champions = champions;
    this.startedAtMs = now();
    this.endsAtMs = endsAtMs;
    this.extent = extent;
    this.zIndex = GROUND_Z_INDEX;
  }

  /** The whole map: the rings are wherever the champions are. */
  getDisplayBoundingBox() {
    return this.squareDisplayBoundingBox(this.extent * 1.1);
  }

  update(): void {
    if (!this.toRemove && this.now() >= this.endsAtMs) this.toRemove = true;
  }

  draw(): void {
    const now = this.now();
    const fade = lifeFade(now, this.startedAtMs, this.endsAtMs);
    if (fade <= 0) return;
    const pulse = 0.5 + 0.5 * Math.sin(now / 140);
    push();
    noFill();
    for (const champion of this.champions()) {
      if (champion.isDead || !champion.visibleToPlayerTeam || champion.killCredit !== 'champion') {
        continue;
      }
      const x = champion.position.x;
      const y = champion.position.y + 24;
      stroke(255, 80, 60, (110 + 90 * pulse) * fade);
      strokeWeight(4);
      ellipse(x, y, 78 + pulse * 8, 30 + pulse * 3);
      stroke(255, 190, 80, 170 * fade);
      strokeWeight(2);
      ellipse(x, y, 58, 22);
      // Three flame ticks licking up off the ring.
      stroke(255, 150, 60, 200 * fade);
      strokeWeight(3);
      for (let i = 0; i < 3; i++) {
        const k = (now / 600 + i / 3 + champion.position.x * 0.01) % 1;
        const fx = x + (i - 1) * 24;
        line(fx, y - 4, fx, y - 4 - 20 * Math.sin(k * Math.PI));
      }
    }
    pop();
  }
}
