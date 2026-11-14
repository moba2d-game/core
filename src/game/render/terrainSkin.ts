import AssetManager from '@/managers/AssetManager';
/**
 * How a map with no art of its own is painted: a textured floor, stone walls
 * that stand up off it (a cast shadow, a dark outline, a lit rim), leafy bushes
 * and rippled water. Before this every such map (the reference ARAM, every
 * editor map, any pack map without `paintsOwnTerrain`) was a flat #777 polygon
 * on a flat grey floor.
 *
 * Cheap on purpose:
 * - every texture is a small tile drawn **once** into an offscreen canvas and
 *   used as a `CanvasPattern`, so a textured polygon costs one `fill()`, the
 *   same as a flat one;
 * - paths go straight to the 2D context (no p5 colour parsing per obstacle);
 * - under render stress (`Game.renderStressed`, auto quality) the floor, the
 *   shadow and the rim passes are skipped, leaving one textured fill and one
 *   outline per kind — close to what the flat look cost. Measured interleaved
 *   at CPU x6 on ARAM, frames per 8 s: flat 307, light 284 (floor still on),
 *   full 192. At x1 all four sat at the 60 fps cap.
 *
 * The light look is the flat look's exact cost: solid colours, a 7px mitred
 * outline (what `Obstacle.applyStyle` drew). Patterned fills were tried there
 * first and measured on a live 4-bot match, CPU x6, ARAM: 22 fps against the
 * flat 40 with the light tier on 91% of the time — a pattern over a
 * screen-sized wall costs far more to rasterise than a colour.
 *
 * Patterns live in world space (they are filled inside the camera transform),
 * so the floor scrolls with the world rather than sliding under it.
 */

export type Rgb = readonly [number, number, number];

/** The floor's base colour. Kept as dark as the old `MAP_BACKGROUND_GREY` floor, so sprites tuned against it still read. */
export const FLOOR_RGB: Rgb = [36, 44, 41];
export const WALL_RGB: Rgb = [104, 108, 118];
export const WALL_GAP_RGB: Rgb = [70, 73, 82];
export const WALL_OUTLINE = 'rgb(38, 40, 48)';
export const WALL_RIM = 'rgba(200, 206, 220, 0.55)';
export const WALL_SHADOW = 'rgba(0, 0, 0, 0.38)';
/** Where a wall's shadow falls, world px: down and a little right, a light from the north-west. */
export const WALL_SHADOW_OFFSET = { x: 9, y: 13 } as const;
export const BUSH_RGB: Rgb = [28, 94, 54];
export const BUSH_OUTLINE = 'rgb(15, 58, 33)';
export const BUSH_RIM = 'rgba(130, 210, 140, 0.35)';
export const WATER_RGB: Rgb = [11, 50, 80];
export const WATER_OUTLINE = 'rgb(7, 33, 56)';
export const WATER_SHORE = 'rgba(150, 210, 232, 0.35)';

/** The light tier's outline: `Obstacle.applyStyle`'s strokeWeight. */
export const LIGHT_OUTLINE_PX = 7;

const css = (c: Rgb, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
const shade = (c: Rgb, d: number): Rgb => [c[0] + d, c[1] + d, c[2] + d];

/** A tiny seeded generator, so the tiles look the same on every load. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Painter = (g: CanvasRenderingContext2D, size: number, r: () => number) => void;

/**
 * Paints `paint` into a `size` tile, and wraps every stroke three times in each
 * axis so a mark crossing the tile's edge comes back on the other side —
 * otherwise the seam shows as a grid.
 */
function tile(size: number, seed: number, base: Rgb, paint: Painter): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = css(base);
  g.fillRect(0, 0, size, size);
  for (const dx of [-size, 0, size])
    for (const dy of [-size, 0, size]) {
      g.save();
      g.translate(dx, dy);
      paint(g, size, rng(seed));
      g.restore();
    }
  return canvas;
}

const floorTile: Painter = (g, size, r) => {
  // Specks of grit, lighter and darker.
  for (let i = 0; i < 260; i++) {
    const light = r() < 0.5;
    g.fillStyle = css(shade(FLOOR_RGB, light ? 10 : -8), 0.5 + r() * 0.4);
    g.beginPath();
    g.arc(r() * size, r() * size, 0.8 + r() * 1.6, 0, Math.PI * 2);
    g.fill();
  }
  // Flat pebbles.
  for (let i = 0; i < 7; i++) {
    g.fillStyle = css(shade(FLOOR_RGB, 7), 0.8);
    g.beginPath();
    g.ellipse(r() * size, r() * size, 3 + r() * 4, 2 + r() * 3, r() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  // Grass tufts: three short blades each.
  g.lineCap = 'round';
  for (let i = 0; i < 16; i++) {
    const x = r() * size;
    const y = r() * size;
    g.strokeStyle = css([52, 74, 58], 0.85);
    g.lineWidth = 1.6;
    for (const lean of [-0.5, 0, 0.5]) {
      g.beginPath();
      g.moveTo(x + lean * 4, y);
      g.lineTo(x + lean * 7, y - 6 - r() * 4);
      g.stroke();
    }
  }
};

const wallTile: Painter = (g, size, r) => {
  // Cobbles on a dark mortar: a jittered grid of rounded stones.
  g.fillStyle = css(WALL_GAP_RGB);
  g.fillRect(0, 0, size, size);
  const n = 4;
  const cell = size / n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const off = j % 2 ? cell / 2 : 0;
      const x = i * cell + off + (r() - 0.5) * 5;
      const y = j * cell + cell / 2 + (r() - 0.5) * 5;
      const tone = shade(WALL_RGB, Math.round((r() - 0.5) * 22));
      g.fillStyle = css(tone);
      g.beginPath();
      g.ellipse(x + cell / 2, y, cell * 0.47, cell * 0.42, (r() - 0.5) * 0.5, 0, Math.PI * 2);
      g.fill();
      // A lit top edge on each stone.
      g.strokeStyle = css(shade(tone, 22), 0.6);
      g.lineWidth = 2;
      g.beginPath();
      g.ellipse(x + cell / 2, y, cell * 0.4, cell * 0.34, 0, Math.PI * 1.1, Math.PI * 1.9);
      g.stroke();
    }
};

const bushTile: Painter = (g, size, r) => {
  const tones: Rgb[] = [
    [22, 78, 44],
    [36, 116, 64],
    [46, 136, 74],
    [30, 100, 58],
  ];
  for (let i = 0; i < 70; i++) {
    g.fillStyle = css(tones[Math.floor(r() * tones.length)], 0.9);
    g.save();
    g.translate(r() * size, r() * size);
    g.rotate(r() * Math.PI * 2);
    g.beginPath();
    g.ellipse(0, 0, 7 + r() * 5, 3 + r() * 2, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
};

const waterTile: Painter = (g, size, r) => {
  g.lineCap = 'round';
  for (let i = 0; i < 14; i++) {
    const x = r() * size;
    const y = r() * size;
    const w = 14 + r() * 22;
    g.strokeStyle = css([90, 170, 210], 0.12 + r() * 0.12);
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + w / 4, y - 4, x + w / 2, y);
    g.quadraticCurveTo(x + (w * 3) / 4, y + 4, x + w, y);
    g.stroke();
  }
};

export interface TerrainPatterns {
  floor: CanvasPattern | null;
  wall: CanvasPattern | null;
  bush: CanvasPattern | null;
  water: CanvasPattern | null;
}

let cached: { ctx: CanvasRenderingContext2D; patterns: TerrainPatterns; epoch: number } | null = null;

/** Built once per drawing context. Null members (no DOM, no canvas) fall back to the flat colour. */
export function terrainPatterns(ctx: CanvasRenderingContext2D): TerrainPatterns {
  // The pattern tiles are offscreen canvases, which a backgrounded phone purges
  // with the rest; a completed asset restore bumps the epoch, and we repaint.
  if (cached && cached.ctx === ctx && cached.epoch === AssetManager.purgeEpoch) return cached.patterns;
  const make = (canvas: HTMLCanvasElement | null) => (canvas && ctx.createPattern ? ctx.createPattern(canvas, 'repeat') : null);
  const patterns: TerrainPatterns = {
    floor: make(tile(192, 11, FLOOR_RGB, floorTile)),
    wall: make(tile(128, 23, WALL_RGB, wallTile)),
    bush: make(tile(112, 37, BUSH_RGB, bushTile)),
    water: make(tile(160, 51, WATER_RGB, waterTile)),
  };
  cached = { ctx, patterns, epoch: AssetManager.purgeEpoch };
  return patterns;
}

/** Anything with world-space vertices: an `Obstacle` at angle 0, or a plain polygon. */
export interface SkinPolygon {
  position: { x: number; y: number };
  vertices: readonly { x: number; y: number }[];
}

/** Twice the signed area: > 0 one way round, < 0 the other. */
export function signedArea2(v: readonly { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0, j = v.length - 1; i < v.length; j = i++) a += (v[j].x - v[i].x) * (v[j].y + v[i].y);
  return a;
}

const clockwise = new WeakMap<object, boolean>();

/**
 * Every polygon into one path, each traced the **same way round**. The path
 * is filled with the nonzero rule, and two overlapping walls wound opposite
 * ways would sum to zero where they overlap — a hole punched through the
 * stone exactly where two pieces meet. Editor maps wind both ways.
 */
export function trace(ctx: CanvasRenderingContext2D, polys: readonly SkinPolygon[], dx = 0, dy = 0): void {
  ctx.beginPath();
  for (const p of polys) {
    const v = p.vertices;
    if (v.length < 3) continue;
    let cw = clockwise.get(v);
    if (cw === undefined) {
      cw = signedArea2(v) > 0;
      clockwise.set(v, cw);
    }
    const ox = p.position.x + dx;
    const oy = p.position.y + dy;
    const n = v.length;
    const at = (i: number) => v[cw ? i : n - 1 - i];
    ctx.moveTo(ox + at(0).x, oy + at(0).y);
    for (let i = 1; i < n; i++) ctx.lineTo(ox + at(i).x, oy + at(i).y);
    ctx.closePath();
  }
}

/** The floor under the part of the map in view. */
/** How long the terrain keeps the light look after a stressed frame, at first. */
export const SKIN_HOLD_MS = 8_000;
/** The longest that hold grows to. */
export const SKIN_HOLD_MAX_MS = 60_000;
/** A return to the full look that brings stress back within this was a mistake: hold longer next time. */
export const SKIN_RELAPSE_MS = 5_000;

export interface SkinHold {
  /** Render clock until which the light look is held. */
  lightUntilMs: number;
  /** The current hold, doubled on every relapse. */
  holdMs: number;
  /** When the full look last came back, or -Infinity. */
  fullSinceMs: number;
}

export const initialSkinHold = (): SkinHold => ({
  lightUntilMs: Number.NEGATIVE_INFINITY,
  holdMs: SKIN_HOLD_MS,
  fullSinceMs: Number.NEGATIVE_INFINITY,
});

/**
 * Whether the terrain draws light this frame, and the state for the next.
 *
 * The full skin costs ~12x the light one (`terrainbench.mjs`, CPU x6: ARAM
 * 27.8 vs 2.3 ms a draw), so following `renderStress` frame by frame
 * oscillates: light lifts the frame rate over the leave threshold, the full
 * look comes back, and the frame rate drops again. Measured on a phone at x6:
 * 12 stress flips in 32 s against 4 with the old flat terrain. So a stressed
 * frame holds the light look for `holdMs`, and a full look that brings stress
 * back within `SKIN_RELAPSE_MS` doubles the hold (to `SKIN_HOLD_MAX_MS`). A
 * full look that survives `SKIN_RELAPSE_MS` resets it.
 */
export function nextSkinHold(state: SkinHold, stressed: boolean, nowMs: number): { light: boolean; state: SkinHold } {
  let { lightUntilMs, holdMs, fullSinceMs } = state;
  const wasFull = nowMs >= lightUntilMs;
  if (stressed) {
    if (wasFull) {
      // Back under stress: a relapse if the full look had only just returned.
      holdMs = nowMs - fullSinceMs < SKIN_RELAPSE_MS ? Math.min(holdMs * 2, SKIN_HOLD_MAX_MS) : SKIN_HOLD_MS;
    }
    lightUntilMs = nowMs + holdMs;
    return { light: true, state: { lightUntilMs, holdMs, fullSinceMs } };
  }
  if (nowMs < lightUntilMs) return { light: true, state };
  if (fullSinceMs < lightUntilMs) fullSinceMs = nowMs;
  return { light: false, state: { lightUntilMs, holdMs, fullSinceMs } };
}

export function paintFloor(
  ctx: CanvasRenderingContext2D,
  view: { x: number; y: number; w: number; h: number },
  mapSize: number
): void {
  const x0 = Math.max(0, view.x);
  const y0 = Math.max(0, view.y);
  const x1 = Math.min(mapSize, view.x + view.w);
  const y1 = Math.min(mapSize, view.y + view.h);
  if (x1 <= x0 || y1 <= y0) return;
  ctx.save();
  ctx.fillStyle = terrainPatterns(ctx).floor ?? css(FLOOR_RGB);
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.restore();
}

/**
 * Walls in view. All of them in one path per pass, so a pass is one
 * `fill`/`stroke` call however many walls there are: the shadows first (so
 * no wall's shadow falls across a neighbour's top), then the stone, then the
 * outline and the rim.
 */
export function paintWalls(ctx: CanvasRenderingContext2D, walls: readonly SkinPolygon[], light: boolean): void {
  if (!walls.length) return;
  const patterns = terrainPatterns(ctx);
  ctx.save();
  if (!light) ctx.lineJoin = 'round';
  if (!light) {
    trace(ctx, walls, WALL_SHADOW_OFFSET.x, WALL_SHADOW_OFFSET.y);
    ctx.fillStyle = WALL_SHADOW;
    ctx.fill();
  }
  // Outline under the stone, not over it: stroked over the fill, a seam
  // between two touching wall pieces would show as a line across solid rock.
  // Filled on top, the inner seams vanish and only the outer half survives.
  trace(ctx, walls);
  ctx.strokeStyle = WALL_OUTLINE;
  ctx.lineWidth = light ? LIGHT_OUTLINE_PX : 10;
  ctx.stroke();
  if (!light) {
    // The lit rim: the same outline nudged up-left, so it peeks out only along
    // the north-west faces, under the stone like the outline.
    trace(ctx, walls, -3, -4);
    ctx.strokeStyle = WALL_RIM;
    ctx.lineWidth = 4;
    ctx.stroke();
    trace(ctx, walls);
  }
  ctx.fillStyle = (!light && patterns.wall) || css(WALL_RGB);
  ctx.fill();
  ctx.restore();
}

export function paintBushes(ctx: CanvasRenderingContext2D, bushes: readonly SkinPolygon[], light: boolean): void {
  if (!bushes.length) return;
  ctx.save();
  if (!light) ctx.lineJoin = 'round';
  trace(ctx, bushes);
  ctx.strokeStyle = BUSH_OUTLINE;
  ctx.lineWidth = light ? LIGHT_OUTLINE_PX : 8;
  ctx.stroke();
  if (!light) {
    trace(ctx, bushes, -2, -3);
    ctx.strokeStyle = BUSH_RIM;
    ctx.lineWidth = 3;
    ctx.stroke();
    trace(ctx, bushes);
  }
  ctx.fillStyle = (!light && terrainPatterns(ctx).bush) || css(BUSH_RGB);
  ctx.fill();
  ctx.restore();
}

export function paintWater(ctx: CanvasRenderingContext2D, waters: readonly SkinPolygon[], light: boolean): void {
  if (!waters.length) return;
  ctx.save();
  if (!light) ctx.lineJoin = 'round';
  trace(ctx, waters);
  if (!light) {
    ctx.strokeStyle = WATER_SHORE;
    ctx.lineWidth = 14;
    ctx.stroke();
  }
  ctx.strokeStyle = WATER_OUTLINE;
  ctx.lineWidth = light ? LIGHT_OUTLINE_PX : 8;
  ctx.stroke();
  ctx.fillStyle = (!light && terrainPatterns(ctx).water) || css(WATER_RGB);
  ctx.fill();
  ctx.restore();
}
