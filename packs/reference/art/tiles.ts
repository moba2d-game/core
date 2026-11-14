/**
 * The still half of a map, baked once per world tile into an offscreen canvas
 * at the camera's scale, then blitted:
 *
 * - tiles are keyed on the *world* grid and the zoom level, never on the camera
 *   (core's `FogOfWar.performance.test.ts`: a camera-keyed cache misses on every
 *   step the player takes);
 * - a tile is painted at the camera's own scale, so the blit is a 1:1 copy at a
 *   whole-pixel offset — the fast path. A scaled `drawImage` filters every pixel;
 * - a zoom change waits `SETTLE_FRAMES` before repainting, and repaints at most
 *   two visible tiles a frame;
 * - `MAX_PIXELS` bounds the memory, and only tiles not drawn this frame go.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Ctx = CanvasRenderingContext2D;

/** World units per tile edge. 512 at zoom 1 is a 1 MB canvas. */
export const TILE = 512;
/** Seam guard: each tile is painted this many pixels past its edge. */
const BLEED_PX = 2;
/** Above this the tiles stop growing and scale up. */
export const MAX_LEVEL = 2;
/** Frames the zoom must hold still before tiles are repainted at it. */
export const SETTLE_FRAMES = 12;
/** Canvas pixels held at once, ~64 MB. */
const MAX_PIXELS = 16_000_000;
/** Off-screen tiles painted ahead of the camera per frame. */
const PREFETCH_PER_FRAME = 1;

interface Tile {
  canvas: HTMLCanvasElement;
  level: number;
  bleed: number;
  usedAt: number;
}

/** Paints everything that never moves, for one world tile. `ctx` is already in world space. */
export type TileBaker = (ctx: Ctx, tile: Box) => void;

/** The slice of `document` the cache listens to; injectable for tests. */
export interface PageVisibility {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}
const thePage = (): PageVisibility | null =>
  typeof document !== 'undefined' && typeof document.addEventListener === 'function'
    ? document
    : null;

export class TileCache {
  private readonly tiles = new Map<number, Tile>();
  private readonly perRow: number;
  private frame = 0;
  private level = 0;
  private lastScale = 0;
  private stillFor = 0;
  /** Paints done, for tests. */
  bakes = 0;
  /**
   * A backgrounded phone purges offscreen canvases — these tiles among them —
   * and comes back to a black map ("Back ra app khác xong quay lại game là nó
   * đen hết luôn"). Nothing reliable says *which* canvases went, so every
   * return from hidden repaints: the visible tiles, once, on a resume.
   */
  private stale = false;
  private wasHidden = false;
  private readonly onVisibility = () => {
    if (!this.page) return;
    if (this.page.hidden) this.wasHidden = true;
    else if (this.wasHidden) {
      this.wasHidden = false;
      this.stale = true;
    }
  };

  constructor(
    mapSize: number,
    private readonly bakeTile: TileBaker,
    private readonly makeCanvas: () => HTMLCanvasElement = () => document.createElement('canvas'),
    private readonly page: PageVisibility | null = thePage()
  ) {
    this.perRow = Math.ceil(mapSize / TILE);
    page?.addEventListener('visibilitychange', this.onVisibility);
  }

  private bake(tx: number, ty: number, level: number): Tile {
    const key = ty * this.perRow + tx;
    const canvas = this.tiles.get(key)?.canvas ?? this.makeCanvas();
    const bleed = BLEED_PX / level;
    const px = Math.ceil((TILE + bleed * 2) * level);
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d')!;
    const box = { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE };
    ctx.setTransform(level, 0, 0, level, (bleed - box.x) * level, (bleed - box.y) * level);
    this.bakeTile(ctx, box);
    const tile = { canvas, level, bleed, usedAt: this.frame };
    this.tiles.set(key, tile);
    this.bakes++;
    return tile;
  }

  private evict(): void {
    let pixels = 0;
    for (const tile of this.tiles.values()) pixels += tile.canvas.width * tile.canvas.height;
    if (pixels <= MAX_PIXELS) return;
    const idle = [...this.tiles.entries()]
      .filter(([, t]) => t.usedAt < this.frame)
      .sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [key, tile] of idle) {
      if (pixels <= MAX_PIXELS) break;
      pixels -= tile.canvas.width * tile.canvas.height;
      tile.canvas.width = 0; // let the backing store go now, not at GC
      this.tiles.delete(key);
    }
  }

  get size(): number {
    return this.tiles.size;
  }

  /** Blit the still half of the map for `view`, painting what is missing. */
  draw(ctx: Ctx, view: Box, scale: number): void {
    if (this.stale) {
      this.stale = false;
      this.dispose();
    }
    const perRow = this.perRow;
    this.frame++;
    this.stillFor = scale === this.lastScale ? this.stillFor + 1 : 0;
    this.lastScale = scale;
    const wanted = Math.max(0.25, Math.min(MAX_LEVEL, scale));
    if (this.level === 0 || (this.stillFor >= SETTLE_FRAMES && this.level !== wanted))
      this.level = wanted;
    const level = this.level;
    const m = ctx.getTransform();
    const square = m.b === 0 && m.c === 0 && m.a === m.d;
    const tx0 = Math.max(0, Math.floor(view.x / TILE));
    const ty0 = Math.max(0, Math.floor(view.y / TILE));
    const tx1 = Math.min(perRow - 1, Math.floor((view.x + view.w) / TILE));
    const ty1 = Math.min(perRow - 1, Math.floor((view.y + view.h) / TILE));
    let rezoom = 2;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        let tile = this.tiles.get(ty * perRow + tx);
        if (!tile) tile = this.bake(tx, ty, level);
        else if (tile.level !== level && rezoom-- > 0) tile = this.bake(tx, ty, level);
        tile.usedAt = this.frame;
        const wx = tx * TILE - tile.bleed;
        const wy = ty * TILE - tile.bleed;
        if (square && tile.level === m.a) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(tile.canvas, Math.round(m.a * wx + m.e), Math.round(m.d * wy + m.f));
          ctx.setTransform(m);
        } else {
          const size = tile.canvas.width / tile.level;
          ctx.drawImage(tile.canvas, wx, wy, size, size);
        }
      }
    }
    let budget = PREFETCH_PER_FRAME;
    for (let ty = ty0 - 1; ty <= ty1 + 1 && budget > 0; ty++) {
      for (let tx = tx0 - 1; tx <= tx1 + 1 && budget > 0; tx++) {
        if (tx < 0 || ty < 0 || tx >= perRow || ty >= perRow) continue;
        if (this.tiles.has(ty * perRow + tx)) continue;
        this.bake(tx, ty, level).usedAt = this.frame;
        budget--;
      }
    }
    this.evict();
  }

  dispose(): void {
    for (const tile of this.tiles.values()) tile.canvas.width = 0;
    this.tiles.clear();
  }

  /** For good: also stops listening to the page. */
  destroy(): void {
    this.dispose();
    this.page?.removeEventListener('visibilitychange', this.onVisibility);
  }
}
