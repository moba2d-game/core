import type { RandomEventId } from './randomEvents';

/**
 * Screen-space art for Sự Kiện Ngẫu Nhiên: the banner, the big title and the
 * ambience. Everything here is a bounded number of primitives, allocates
 * nothing per frame (the view object and the random table are made once), and
 * reads **match time** — a paused match freezes it with everything else.
 *
 * ## The stress tiers (`render/renderStress.ts`)
 *
 * Tier 0 draws everything. Tier 1 thins the ambience to a third of its count
 * and drops the only large translucent shape (the fog's edge bands). Tier 2
 * draws no ambience at all; the banner and title stay, because they are the
 * game telling the player a rule changed.
 */

export interface EventView {
  phase: 'warning' | 'active';
  id: RandomEventId;
  title: string;
  subtitle: string;
  color: readonly [number, number, number];
  /** Whole seconds left, ceiled. */
  secondsLeft: number;
  /** 0..1 of the current phase that has elapsed. */
  progress: number;
  /** Match ms since this banner appeared. */
  ageMs: number;
  /** Match ms since the event itself started; negative while only warned. */
  activeAgeMs: number;
  /** Match ms until the banner goes away. */
  leftMs: number;
  /** `${title}  ${secondsLeft}s`, rebuilt only when the second changes. */
  label: string;
  labelSecond: number;
}

export const freshEventView = (): EventView => ({
  phase: 'warning',
  id: 'goldRain',
  title: '',
  subtitle: '',
  color: [255, 255, 255],
  secondsLeft: 0,
  progress: 0,
  ageMs: 0,
  activeAgeMs: -1,
  leftMs: 0,
  label: '',
  labelSecond: -1,
});

export const TITLE_MS = 1_500;
const SLIDE_MS = 350;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const wrap01 = (v: number): number => v - Math.floor(v);

/** 64 numbers in [0,1), the same on every machine; the ambience's only randomness. */
const RND = new Float32Array(64);
{
  let h = 0x1234abcd;
  for (let i = 0; i < RND.length; i++) {
    h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0;
    RND[i] = (h % 10_000) / 10_000;
  }
}

/** A simple drawn icon, `s` px from its centre to its edge. */
export function drawEventIcon(
  id: RandomEventId,
  cx: number,
  cy: number,
  s: number,
  r: number,
  g: number,
  b: number
): void {
  push();
  noFill();
  stroke(r, g, b);
  strokeWeight(Math.max(2, s * 0.16));
  strokeCap(ROUND);
  switch (id) {
    case 'goldRain':
      circle(cx, cy, s * 1.6);
      noStroke();
      fill(r, g, b);
      circle(cx, cy, s * 0.7);
      break;
    case 'meteors':
      line(cx - s * 0.9, cy - s * 0.9, cx + s * 0.1, cy + s * 0.1);
      noStroke();
      fill(r, g, b);
      circle(cx + s * 0.35, cy + s * 0.35, s * 1.0);
      break;
    case 'gale':
      line(cx - s, cy - s * 0.5, cx + s * 0.6, cy - s * 0.5);
      line(cx - s * 0.6, cy, cx + s, cy);
      line(cx - s, cy + s * 0.5, cx + s * 0.3, cy + s * 0.5);
      break;
    case 'quickRevive':
      line(cx, cy - s * 0.9, cx, cy + s * 0.9);
      line(cx - s * 0.9, cy, cx + s * 0.9, cy);
      break;
    case 'fog':
      line(cx - s, cy - s * 0.45, cx + s, cy - s * 0.45);
      line(cx - s * 0.7, cy, cx + s * 0.7, cy);
      line(cx - s, cy + s * 0.45, cx + s, cy + s * 0.45);
      break;
    case 'frenzy':
      noStroke();
      fill(r, g, b);
      triangle(cx, cy - s, cx + s * 0.8, cy + s * 0.8, cx - s * 0.8, cy + s * 0.8);
      fill(0, 0, 0, 120);
      triangle(cx, cy - s * 0.1, cx + s * 0.4, cy + s * 0.8, cx - s * 0.4, cy + s * 0.8);
      break;
    case 'springs':
      noStroke();
      fill(r, g, b);
      triangle(cx, cy - s, cx + s * 0.6, cy + s * 0.1, cx - s * 0.6, cy + s * 0.1);
      circle(cx, cy + s * 0.3, s * 1.2);
      break;
    case 'chest':
      noStroke();
      fill(r, g, b);
      rect(cx - s * 0.9, cy - s * 0.1, s * 1.8, s * 0.9, 2);
      rect(cx - s * 0.9, cy - s * 0.8, s * 1.8, s * 0.6, 4);
      fill(0, 0, 0, 140);
      rect(cx - s * 0.12, cy - s * 0.15, s * 0.24, s * 0.35);
      break;
    case 'storm':
      line(cx + s * 0.3, cy - s, cx - s * 0.3, cy);
      line(cx - s * 0.3, cy, cx + s * 0.3, cy);
      line(cx + s * 0.3, cy, cx - s * 0.3, cy + s);
      break;
    case 'bounty':
      circle(cx, cy, s * 1.7);
      line(cx - s * 1.1, cy, cx + s * 1.1, cy);
      line(cx, cy - s * 1.1, cx, cy + s * 1.1);
      break;
    case 'bloodMoon':
      noStroke();
      fill(r, g, b);
      circle(cx, cy, s * 1.8);
      fill(0, 0, 0, 150);
      circle(cx + s * 0.45, cy - s * 0.3, s * 1.4);
      break;
    case 'giants':
      // A small figure beside a big one.
      noStroke();
      fill(r, g, b);
      circle(cx - s * 0.6, cy + s * 0.3, s * 0.6);
      circle(cx + s * 0.3, cy - s * 0.1, s * 1.4);
      break;
    case 'aegis':
      beginShape();
      vertex(cx, cy - s);
      vertex(cx + s * 0.85, cy - s * 0.55);
      vertex(cx + s * 0.6, cy + s * 0.5);
      vertex(cx, cy + s);
      vertex(cx - s * 0.6, cy + s * 0.5);
      vertex(cx - s * 0.85, cy - s * 0.55);
      endShape(CLOSE);
      break;
    case 'poison':
      noStroke();
      fill(r, g, b);
      circle(cx - s * 0.45, cy + s * 0.15, s * 1.0);
      circle(cx + s * 0.45, cy + s * 0.15, s * 1.0);
      circle(cx, cy - s * 0.3, s * 1.2);
      break;
    case 'manaSurge':
      noStroke();
      fill(r, g, b);
      quad(cx, cy - s, cx + s * 0.6, cy, cx, cy + s, cx - s * 0.6, cy);
      break;
  }
  pop();
}

/**
 * Below this many CSS px tall the screen is a landscape phone: there is no
 * spare band under the HUD's top row, so the banner becomes one slim line at
 * the top edge and the start title shrinks into the top quarter. On a phone the
 * full panel sat across 25-40% of the height — over the fight.
 */
export const COMPACT_EVENT_HEIGHT = 560;

export interface BannerLayout {
  compact: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function eventBannerLayout(viewW: number, viewH: number): BannerLayout {
  if (viewH < COMPACT_EVENT_HEIGHT) {
    // Under the clock pill (top centre, ~34px), clear of minimap and shop buttons.
    const w = Math.min(viewW * 0.38, 320);
    return { compact: true, x: viewW / 2 - w / 2, y: 38, h: 26, w };
  }
  const w = Math.min(viewW - 24, 440);
  // Below the match clock pill and the kill feed, both top centre.
  return { compact: false, x: viewW / 2 - w / 2, y: 100, h: 62, w };
}

export function eventTitleLayout(viewW: number, viewH: number): { size: number; cy: number } {
  if (viewH < COMPACT_EVENT_HEIGHT) return { size: Math.min(30, viewW * 0.06), cy: viewH * 0.2 };
  return { size: Math.min(58, viewW * 0.11), cy: viewH * 0.3 };
}

/** The slim panel under the top edge: accent strip, icon, title, blurb, time bar. */
export function drawEventBanner(view: EventView): void {
  const [r, g, b] = view.color;
  const slide = clamp01(view.ageMs / SLIDE_MS);
  const ease = 1 - (1 - slide) * (1 - slide);
  const out = clamp01(view.leftMs / 250);
  const a = ease * out;
  if (a <= 0) return;
  const box = eventBannerLayout(width, height);
  if (box.compact) return drawCompactBanner(view, box, ease, a);
  const { w, h, x } = box;
  const y = box.y - (1 - ease) * 110;
  push();
  noStroke();
  fill(0, 0, 0, 40 * a);
  rect(x + 2, y + 4, w, h, 12);
  fill(14, 16, 24, 205 * a);
  rect(x, y, w, h, 12);
  fill(r, g, b, 255 * a);
  rect(x, y + 8, 5, h - 16, 3);
  fill(r, g, b, 40 * a);
  circle(x + 38, y + 29, 40);
  drawEventIcon(view.id, x + 38, y + 29, 12, r, g, b);
  textAlign(LEFT, CENTER);
  fill(r, g, b, 255 * a);
  textSize(19);
  text(view.label, x + 68, y + 20);
  fill(230, 235, 245, 235 * a);
  textSize(12);
  text(view.subtitle, x + 68, y + 41);
  // Time bar: drains while active, fills towards the start while warned.
  const barW = w - 28;
  fill(255, 255, 255, 30 * a);
  rect(x + 14, y + h - 9, barW, 4, 2);
  const share = view.phase === 'active' ? 1 - view.progress : view.progress;
  fill(r, g, b, 230 * a);
  rect(x + 14, y + h - 9, Math.max(2, barW * clamp01(share)), 4, 2);
  pop();
}

/** One line: icon, "label  Ns", and the time bar along its bottom edge. No blurb — the start title carries it. */
function drawCompactBanner(view: EventView, box: BannerLayout, ease: number, a: number): void {
  const [r, g, b] = view.color;
  const { x, w, h } = box;
  const y = box.y - (1 - ease) * (box.y + h);
  push();
  noStroke();
  fill(14, 16, 24, 190 * a);
  rect(x, y, w, h, h / 2);
  drawEventIcon(view.id, x + h / 2 + 2, y + h / 2, 7, r, g, b);
  textAlign(LEFT, CENTER);
  fill(r, g, b, 255 * a);
  textSize(13);
  text(view.label, x + h + 4, y + h / 2 - 1);
  const share = view.phase === 'active' ? 1 - view.progress : view.progress;
  fill(255, 255, 255, 30 * a);
  rect(x + h / 2, y + h - 4, w - h, 2, 1);
  fill(r, g, b, 230 * a);
  rect(x + h / 2, y + h - 4, Math.max(2, (w - h) * clamp01(share)), 2, 1);
  pop();
}

/** The big centre title when an event starts. */
export function drawEventTitle(view: EventView): void {
  if (view.phase !== 'active' || view.activeAgeMs < 0 || view.activeAgeMs > TITLE_MS) return;
  const t = view.activeAgeMs;
  const a = Math.min(t / 180, (TITLE_MS - t) / 450, 1);
  if (a <= 0) return;
  const [r, g, b] = view.color;
  const { size, cy } = eventTitleLayout(width, height);
  const grow = 0.9 + 0.1 * clamp01(t / 250);
  push();
  textAlign(CENTER, CENTER);
  noStroke();
  textSize(size * grow);
  fill(0, 0, 0, 170 * a);
  text(view.title, width / 2 + 3, cy + 3);
  fill(r, g, b, 255 * a);
  text(view.title, width / 2, cy);
  textSize(Math.min(size * 0.36, 20, width * 0.045));
  fill(0, 0, 0, 150 * a);
  text(view.subtitle, width / 2 + 2, cy + size * 0.8 + 2);
  fill(255, 255, 255, 240 * a);
  text(view.subtitle, width / 2, cy + size * 0.8);
  pop();
}

type Style = 'glint' | 'dot' | 'streak';
interface Ambience {
  style: Style;
  count: number;
  /** Screen widths / heights travelled per cycle. */
  vx: number;
  vy: number;
  /** Cycles per second. */
  rate: number;
  size: number;
  color: readonly [number, number, number];
}

const AMBIENCE: Partial<Record<RandomEventId, Ambience>> = {
  goldRain: { style: 'glint', count: 18, vx: 0.05, vy: 1, rate: 0.35, size: 6, color: [255, 220, 100] },
  meteors: { style: 'dot', count: 12, vx: -0.1, vy: -1, rate: 0.25, size: 3, color: [255, 140, 60] },
  gale: { style: 'streak', count: 16, vx: 1, vy: 0.1, rate: 0.9, size: 90, color: [200, 240, 255] },
  quickRevive: { style: 'dot', count: 12, vx: 0.05, vy: -1, rate: 0.22, size: 4, color: [150, 255, 170] },
  frenzy: { style: 'streak', count: 10, vx: 0.05, vy: -1, rate: 0.7, size: 34, color: [255, 110, 80] },
  springs: { style: 'dot', count: 12, vx: 0.04, vy: -1, rate: 0.2, size: 4, color: [150, 225, 255] },
  chest: { style: 'glint', count: 10, vx: 0.03, vy: -0.6, rate: 0.18, size: 6, color: [255, 215, 110] },
  storm: { style: 'streak', count: 20, vx: -0.25, vy: 1, rate: 1.4, size: 46, color: [200, 190, 255] },
  bounty: { style: 'glint', count: 10, vx: 0.04, vy: 1, rate: 0.28, size: 5, color: [255, 150, 180] },
  bloodMoon: { style: 'dot', count: 14, vx: 0.02, vy: 1, rate: 0.3, size: 5, color: [220, 40, 60] },
  giants: { style: 'dot', count: 8, vx: 0, vy: -1, rate: 0.12, size: 7, color: [255, 170, 100] },
  aegis: { style: 'glint', count: 12, vx: 0.02, vy: -0.8, rate: 0.25, size: 6, color: [255, 230, 140] },
  poison: { style: 'dot', count: 14, vx: 0.15, vy: -0.6, rate: 0.18, size: 6, color: [150, 230, 90] },
  manaSurge: { style: 'streak', count: 14, vx: 0, vy: -1, rate: 0.8, size: 40, color: [130, 170, 255] },
};

/**
 * Light ambience across the whole view. `k` is the event's fade (0..1);
 * `tier` is `stressTier(...)`.
 */
export function drawEventAmbience(
  id: RandomEventId,
  now: number,
  k: number,
  tier: 0 | 1 | 2
): void {
  if (tier >= 2 || k <= 0) return;
  const cfg = AMBIENCE[id];
  const w = width;
  const h = height;
  push();
  if (id === 'fog' && tier === 0) {
    // Soft edge fog: two stacked bands per edge, nothing over the middle.
    noStroke();
    const breath = 0.8 + 0.2 * Math.sin(now / 900);
    for (let layer = 0; layer < 2; layer++) {
      const f = 1 - layer * 0.5;
      fill(205, 210, 230, 38 * k * breath * (layer === 0 ? 1 : 1.2));
      rect(0, 0, w, h * 0.14 * f);
      rect(0, h - h * 0.14 * f, w, h * 0.14 * f);
      rect(0, h * 0.14 * f, w * 0.1 * f, h - h * 0.28 * f);
      rect(w - w * 0.1 * f, h * 0.14 * f, w * 0.1 * f, h - h * 0.28 * f);
    }
  }
  if (cfg) {
    const n = tier === 1 ? Math.ceil(cfg.count / 3) : cfg.count;
    const [r, g, b] = cfg.color;
    const len = Math.hypot(cfg.vx * w, cfg.vy * h) || 1;
    noFill();
    for (let i = 0; i < n; i++) {
      const p = wrap01(now * 0.001 * cfg.rate + RND[i * 3 + 1]);
      const x = wrap01(RND[i * 3] + cfg.vx * p) * w;
      const y = wrap01(RND[i * 3 + 2] + cfg.vy * p) * h;
      const fade = Math.sin(p * Math.PI) * k;
      if (cfg.style === 'streak') {
        stroke(r, g, b, 120 * fade);
        strokeWeight(1.5 + (i % 3) * 0.5);
        line(x, y, x - (cfg.vx * w * cfg.size) / len, y - (cfg.vy * h * cfg.size) / len);
      } else {
        noStroke();
        fill(r, g, b, 210 * fade);
        if (cfg.style === 'dot') {
          circle(x, y, cfg.size * (0.7 + RND[i * 3] * 0.8));
        } else {
          const sz = cfg.size * (0.6 + RND[i * 3 + 2] * 0.7);
          quad(x, y - sz, x + sz * 0.45, y, x, y + sz, x - sz * 0.45, y);
        }
        noFill();
      }
    }
  }
  pop();
}
