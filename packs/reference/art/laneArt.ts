import type { Box, Ctx } from './tiles';

/**
 * The painted ground of a lane map: a highland glade. Original art, drawn
 * with nothing but canvas calls — no image is loaded. It is drawn from the map's *geometry* — the same wall,
 * bush and water polygons the collision uses — and nothing else, so the
 * picture can never disagree with where a unit can walk.
 *
 * - **Walls** are forest: a stony rim (painted under the fill, so where two
 *   wall polygons overlap the shared edge disappears), a shaded forest floor,
 *   and tree canopies clipped to the wall so the edge reads as a hedge-cut
 *   tree line. A small wall is a boulder instead of three squashed trees.
 * - **Water** is a river: a shallow bank band painted *under* the deep fill,
 *   for the same reason, then ripples clipped inside.
 * - **Lanes** are trodden dirt along each lane's waypoints, with gravel.
 * - **Bases** stand on a paved plaza, each side its own stone; every turret on
 *   a stone pad.
 * - **Bushes** are leaf clusters over a dark base, rimmed so a player can see
 *   where cover ends.
 *
 * Every decoration is placed by a hash of its *world* grid cell, so two tiles
 * painting the same cell paint the same thing and seams never show.
 */

export interface Pt {
  x: number;
  y: number;
}

export type Rgb = readonly [number, number, number];

export interface LaneGeometry {
  terrain: { wall?: Pt[][]; bush?: Pt[][]; water?: Pt[][] };
  slots: {
    spawn?: (Pt & { faction?: string })[];
    structure?: (Pt & { faction?: string; kind?: string })[];
  };
  lanes?: { waypoints: Pt[] }[];
}

export const INK = {
  GRASS: [62, 88, 54] as Rgb,
  GRASS_DARK: [46, 70, 44] as Rgb,
  GRASS_LIGHT: [86, 114, 66] as Rgb,
  BLADE: [104, 136, 76] as Rgb,
  FLOWER: [214, 200, 120] as Rgb,
  DIRT: [124, 104, 74] as Rgb,
  DIRT_EDGE: [96, 96, 62] as Rgb,
  GRAVEL: [158, 140, 108] as Rgb,
  RUT: [100, 82, 58] as Rgb,
  BANK: [96, 112, 84] as Rgb,
  SHALLOW: [58, 118, 128] as Rgb,
  DEEP: [30, 72, 98] as Rgb,
  RIPPLE: [150, 200, 204] as Rgb,
  CLIFF: [70, 72, 66] as Rgb,
  CLIFF_LIGHT: [118, 120, 106] as Rgb,
  FOREST_FLOOR: [34, 50, 34] as Rgb,
  CANOPY: [36, 74, 46] as Rgb,
  CANOPY_MID: [50, 96, 56] as Rgb,
  CANOPY_LIGHT: [92, 140, 80] as Rgb,
  ROCK: [104, 106, 98] as Rgb,
  ROCK_TOP: [148, 150, 136] as Rgb,
  BUSH: [30, 82, 46] as Rgb,
  LEAF: [56, 122, 62] as Rgb,
  LEAF_LIGHT: [96, 160, 84] as Rgb,
  BUSH_RIM: [18, 52, 30] as Rgb,
  PAD: [112, 112, 104] as Rgb,
  /** Base paving: the map's first faction, then its second. */
  PLAZA_FIRST: [92, 106, 122] as Rgb,
  PLAZA_SECOND: [126, 102, 88] as Rgb,
} as const;

export const rgba = (c: Rgb, a = 1): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** A cheap, stable pseudo-random in 0..1 from two integers. */
export const hash = (a: number, b: number): number => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * The sizes that depend on how big a map was drawn. The defaults suit a
 * three-lane map some 6400 across; a small single-lane map passes its own.
 */
export interface LaneArtScale {
  /** Width of the trodden dirt along a lane. */
  laneWidth: number;
  /** Radius of the paved plaza under each base. */
  plazaRadius: number;
  /** Radius of the stone pad under each structure. */
  padRadius: number;
  /** A wall polygon under this area is a boulder, not a stand of trees. */
  boulderArea: number;
}

export const DEFAULT_SCALE: LaneArtScale = {
  laneWidth: 190,
  plazaRadius: 620,
  padRadius: 92,
  boulderArea: 18_000,
};
/** World units within which a small wall counts as touching the forest. */
const TOUCH = 12;
const RIM_PX = 18;
const BANK_PX = 30;
const CANOPY_STEP = 64;
const LEAF_STEP = 20;

interface Shape {
  points: Pt[];
  box: Box;
  area: number;
}

const boxOf = (points: Pt[]): Box => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

const areaOf = (points: Pt[]): number => {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += (points[j].x + points[i].x) * (points[j].y - points[i].y);
  }
  return Math.abs(a / 2);
};

export const overlaps = (a: Box, b: Box, pad = 0): boolean =>
  a.x - pad < b.x + b.w && a.x + a.w + pad > b.x && a.y - pad < b.y + b.h && a.y + a.h + pad > b.y;

const segmentDistance = (p: Pt, a: Pt, b: Pt): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))
  );
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};

export const inside = (p: Pt, points: Pt[]): boolean => {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      hit = !hit;
  }
  return hit;
};

const shapes = (list: Pt[][] | undefined): Shape[] =>
  (list ?? [])
    .filter(p => p.length >= 3)
    .map(points => ({ points, box: boxOf(points), area: areaOf(points) }));

const path = (ctx: Ctx, list: Shape[], dx = 0, dy = 0): void => {
  ctx.beginPath();
  for (const s of list) {
    const pts = s.points;
    ctx.moveTo(pts[0].x + dx, pts[0].y + dy);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x + dx, pts[i].y + dy);
    ctx.closePath();
  }
};

const disc = (ctx: Ctx, x: number, y: number, r: number): void => {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2);
};

export class LaneArt {
  readonly walls: Shape[];
  readonly boulders: Shape[];
  readonly bushes: Shape[];
  readonly waters: Shape[];
  readonly lanes: Pt[][];
  readonly plazas: { x: number; y: number; ink: Rgb }[];
  readonly pads: Pt[];
  readonly scale: LaneArtScale;

  constructor(geometry: LaneGeometry, scale: Partial<LaneArtScale> = {}) {
    this.scale = { ...DEFAULT_SCALE, ...scale };
    const BOULDER_AREA = this.scale.boulderArea;
    const walls = shapes(geometry.terrain.wall);
    // A small wall is a boulder only if it stands alone. Walls are often a
    // big polygon plus small wedges along its edge; a wedge drawn as a boulder
    // splits one mass into many outlined pieces. So a small wall touching the
    // forest joins it — repeatedly, as wedges chain onto wedges.
    this.walls = walls.filter(s => s.area >= BOULDER_AREA);
    let loose = walls.filter(s => s.area < BOULDER_AREA);
    for (let grew = true; grew;) {
      const joined = loose.filter(s => s.points.some(p => this.nearForest(p, TOUCH)));
      grew = joined.length > 0;
      this.walls.push(...joined);
      loose = loose.filter(s => !joined.includes(s));
    }
    this.boulders = loose;
    this.bushes = shapes(geometry.terrain.bush);
    this.waters = shapes(geometry.terrain.water);
    this.lanes = (geometry.lanes ?? []).map(l => l.waypoints).filter(w => w.length >= 2);
    const spawns = geometry.slots.spawn ?? [];
    // One stone per side: the faction of the first spawn listed, then the other.
    const first = spawns[0]?.faction;
    this.plazas = spawns.map((s, i) => ({
      x: s.x,
      y: s.y,
      ink: (s.faction ? s.faction === first : i === 0) ? INK.PLAZA_FIRST : INK.PLAZA_SECOND,
    }));
    this.pads = (geometry.slots.structure ?? []).map(s => ({ x: s.x, y: s.y }));
  }

  /** Is this world point inside a forest wall, or within `d` of one's edge? */
  nearForest(p: Pt, d: number, among: Shape[] = this.walls): boolean {
    for (const s of among) {
      const b = s.box;
      if (p.x < b.x - d || p.x > b.x + b.w + d || p.y < b.y - d || p.y > b.y + b.h + d) continue;
      if (inside(p, s.points)) return true;
      const pts = s.points;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        if (segmentDistance(p, pts[j], pts[i]) <= d) return true;
      }
    }
    return false;
  }

  /** Is this world point inside any forest wall? */
  inForest(p: Pt, near: Shape[]): boolean {
    for (const s of near) {
      if (p.x < s.box.x || p.x > s.box.x + s.box.w || p.y < s.box.y || p.y > s.box.y + s.box.h)
        continue;
      if (inside(p, s.points)) return true;
    }
    return false;
  }

  bake(ctx: Ctx, tile: Box): void {
    const near = (list: Shape[], pad: number) => list.filter(s => overlaps(s.box, tile, pad));
    this.floor(ctx, tile);
    this.paving(ctx, tile);
    this.paths(ctx, tile);
    this.river(ctx, near(this.waters, BANK_PX + 40), tile);
    this.thickets(ctx, near(this.bushes, LEAF_STEP * 2), tile);
    this.forest(ctx, near(this.walls, 120), tile);
    this.rocks(ctx, near(this.boulders, 40));
  }

  // ---- ground ----------------------------------------------------------------

  private floor(ctx: Ctx, tile: Box): void {
    ctx.fillStyle = rgba(INK.GRASS);
    ctx.fillRect(tile.x - 4, tile.y - 4, tile.w + 8, tile.h + 8);
    // Soft mottling: big low-contrast patches, light and dark.
    const step = 128;
    const x0 = Math.floor((tile.x - 160) / step);
    const y0 = Math.floor((tile.y - 160) / step);
    const x1 = Math.ceil((tile.x + tile.w + 160) / step);
    const y1 = Math.ceil((tile.y + tile.h + 160) / step);
    for (const [ink, salt] of [
      [INK.GRASS_DARK, 1],
      [INK.GRASS_LIGHT, 2],
    ] as const) {
      ctx.fillStyle = rgba(ink, 0.32);
      ctx.beginPath();
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const h = hash(gx * 3 + salt, gy * 7 - salt);
          if (h > 0.45) continue;
          const r = 50 + 90 * hash(gx + salt * 13, gy);
          ctx.moveTo(gx * step + h * step + r, gy * step);
          ctx.ellipse(
            gx * step + h * step,
            gy * step + hash(gy, gx + salt) * step,
            r,
            r * 0.7,
            h * 3,
            0,
            Math.PI * 2
          );
        }
      }
      ctx.fill();
    }
    // Grass blades and the odd flower: small, rooted at the bottom, all leaning one way.
    const blade = 36;
    const bx0 = Math.floor(tile.x / blade) - 1;
    const by0 = Math.floor(tile.y / blade) - 1;
    const bx1 = Math.ceil((tile.x + tile.w) / blade) + 1;
    const by1 = Math.ceil((tile.y + tile.h) / blade) + 1;
    ctx.strokeStyle = rgba(INK.BLADE, 0.55);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    const flowers: Pt[] = [];
    for (let gy = by0; gy <= by1; gy++) {
      for (let gx = bx0; gx <= bx1; gx++) {
        const h = hash(gx, gy);
        if (h > 0.55) continue;
        const x = gx * blade + hash(gy, gx) * blade;
        const y = gy * blade + h * blade;
        ctx.moveTo(x, y);
        ctx.lineTo(x + 3, y - 9);
        ctx.moveTo(x + 5, y);
        ctx.lineTo(x + 9, y - 7);
        if (h < 0.012) flowers.push({ x, y });
      }
    }
    ctx.stroke();
    ctx.fillStyle = rgba(INK.FLOWER, 0.85);
    ctx.beginPath();
    for (const f of flowers) {
      disc(ctx, f.x - 4, f.y - 12, 3);
      disc(ctx, f.x + 4, f.y - 10, 2.5);
    }
    ctx.fill();
  }

  private paving(ctx: Ctx, tile: Box): void {
    const { plazaRadius: PLAZA_RADIUS, padRadius: PAD_RADIUS } = this.scale;
    for (const p of this.plazas) {
      if (
        !overlaps(
          {
            x: p.x - PLAZA_RADIUS,
            y: p.y - PLAZA_RADIUS,
            w: PLAZA_RADIUS * 2,
            h: PLAZA_RADIUS * 2,
          },
          tile,
          20
        )
      )
        continue;
      ctx.fillStyle = rgba(INK.DIRT_EDGE, 0.6);
      ctx.beginPath();
      disc(ctx, p.x, p.y, PLAZA_RADIUS + 24);
      ctx.fill();
      ctx.fillStyle = rgba(p.ink);
      ctx.beginPath();
      disc(ctx, p.x, p.y, PLAZA_RADIUS);
      ctx.fill();
      // Courses of slabs: rings, and joints staggered between rings.
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let r = 90, ring = 0; r < PLAZA_RADIUS; r += 90, ring++) {
        disc(ctx, p.x, p.y, r);
        const n = Math.round((r * Math.PI * 2) / 110);
        const r0 = r - 90;
        for (let k = 0; k < n; k++) {
          const a = ((k + (ring % 2) * 0.5) / n) * Math.PI * 2;
          ctx.moveTo(p.x + Math.cos(a) * r0, p.y + Math.sin(a) * r0);
          ctx.lineTo(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r);
        }
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      disc(ctx, p.x, p.y, PLAZA_RADIUS - 8);
      ctx.stroke();
    }
    for (const p of this.pads) {
      if (
        !overlaps(
          { x: p.x - PAD_RADIUS, y: p.y - PAD_RADIUS, w: PAD_RADIUS * 2, h: PAD_RADIUS * 2 },
          tile,
          20
        )
      )
        continue;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      disc(ctx, p.x + 6, p.y + 9, PAD_RADIUS);
      ctx.fill();
      ctx.fillStyle = rgba(INK.PAD);
      ctx.beginPath();
      // An octagon of dressed stone.
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
        const x = p.x + Math.cos(a) * PAD_RADIUS;
        const y = p.y + Math.sin(a) * PAD_RADIUS;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }

  private paths(ctx: Ctx, tile: Box): void {
    if (this.lanes.length === 0) return;
    const LANE_WIDTH = this.scale.laneWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const trace = () => {
      ctx.beginPath();
      for (const lane of this.lanes) {
        ctx.moveTo(lane[0].x, lane[0].y);
        for (let i = 1; i < lane.length; i++) ctx.lineTo(lane[i].x, lane[i].y);
      }
    };
    trace();
    ctx.strokeStyle = rgba(INK.DIRT_EDGE, 0.55);
    ctx.lineWidth = LANE_WIDTH + 40;
    ctx.stroke();
    ctx.strokeStyle = rgba(INK.DIRT);
    ctx.lineWidth = LANE_WIDTH;
    ctx.stroke();
    // Two worn ruts along the middle, broken, so it reads as use rather than paint.
    ctx.setLineDash([140, 60]);
    ctx.strokeStyle = rgba(INK.RUT, 0.45);
    ctx.lineWidth = 60;
    ctx.stroke();
    ctx.setLineDash([]);
    // Gravel, on a world grid, only where a lane runs.
    const step = 26;
    ctx.fillStyle = rgba(INK.GRAVEL, 0.7);
    ctx.beginPath();
    for (const lane of this.lanes) {
      for (let i = 1; i < lane.length; i++) {
        const a = lane[i - 1];
        const b = lane[i];
        const seg: Box = boxOf([a, b]);
        if (!overlaps(seg, tile, LANE_WIDTH)) continue;
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const nx = -(b.y - a.y) / len;
        const ny = (b.x - a.x) / len;
        for (let d = 0; d < len; d += step) {
          const k = Math.round((a.x + a.y) / 7) + Math.round(d / step);
          const off = (hash(k, i) - 0.5) * LANE_WIDTH * 0.85;
          if (hash(i, k) > 0.6) continue;
          const x = a.x + ((b.x - a.x) * d) / len + nx * off;
          const y = a.y + ((b.y - a.y) * d) / len + ny * off;
          disc(ctx, x, y, 2 + 3 * hash(k + 1, i));
        }
      }
    }
    ctx.fill();
  }

  private river(ctx: Ctx, waters: Shape[], tile: Box): void {
    if (waters.length === 0) return;
    ctx.lineJoin = 'round';
    path(ctx, waters);
    // Bank, then shallows, both *under* the deep fill: only the outer band shows.
    ctx.strokeStyle = rgba(INK.BANK);
    ctx.lineWidth = BANK_PX * 2;
    ctx.stroke();
    ctx.strokeStyle = rgba(INK.SHALLOW);
    ctx.lineWidth = BANK_PX;
    ctx.stroke();
    ctx.fillStyle = rgba(INK.DEEP);
    ctx.fill();
    ctx.save();
    ctx.clip();
    // No stroke of the outline from here on: the river is many polygons, and
    // their shared edges run through open water — any line along them shows
    // as a seam. The shallows are the band painted under the fill, above.
    // Ripples: short arcs, all facing the same way, like a slow current.
    const step = 70;
    ctx.strokeStyle = rgba(INK.RIPPLE, 0.35);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (
      let gy = Math.floor(tile.y / step) - 1;
      gy <= Math.ceil((tile.y + tile.h) / step) + 1;
      gy++
    ) {
      for (
        let gx = Math.floor(tile.x / step) - 1;
        gx <= Math.ceil((tile.x + tile.w) / step) + 1;
        gx++
      ) {
        const h = hash(gx * 5, gy * 3);
        if (h > 0.5) continue;
        const x = gx * step + h * step;
        const y = gy * step + hash(gy, gx * 2) * step;
        ctx.moveTo(x - 16, y);
        ctx.quadraticCurveTo(x, y - 7, x + 16, y);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  private thickets(ctx: Ctx, bushes: Shape[], tile: Box): void {
    if (bushes.length === 0) return;
    path(ctx, bushes);
    ctx.strokeStyle = rgba(INK.BUSH_RIM);
    ctx.lineWidth = 8;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fillStyle = rgba(INK.BUSH);
    ctx.fill();
    ctx.save();
    ctx.clip();
    for (const [ink, salt, r] of [
      [INK.LEAF, 0, 11],
      [INK.LEAF_LIGHT, 1, 6],
    ] as const) {
      ctx.fillStyle = rgba(ink, salt ? 0.8 : 1);
      ctx.beginPath();
      for (const s of bushes) {
        const b = s.box;
        for (let y = Math.floor(b.y / LEAF_STEP) * LEAF_STEP; y <= b.y + b.h; y += LEAF_STEP) {
          for (let x = Math.floor(b.x / LEAF_STEP) * LEAF_STEP; x <= b.x + b.w; x += LEAF_STEP) {
            if (
              x < tile.x - 30 ||
              x > tile.x + tile.w + 30 ||
              y < tile.y - 30 ||
              y > tile.y + tile.h + 30
            )
              continue;
            const h = hash(x + salt * 17, y);
            const px = x + (h - 0.5) * LEAF_STEP - salt * 4;
            const py = y + (hash(y, x) - 0.5) * LEAF_STEP - salt * 5;
            ctx.moveTo(px + r, py);
            ctx.ellipse(px, py, r, r * 0.62, h * Math.PI, 0, Math.PI * 2);
          }
        }
      }
      ctx.fill();
    }
    ctx.restore();
  }

  private forest(ctx: Ctx, walls: Shape[], tile: Box): void {
    if (walls.length === 0) return;
    ctx.lineJoin = 'round';
    // Drop shadow, south-east.
    path(ctx, walls, 12, 16);
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.fill();
    // Stony rim under the fill: the outer half is all that shows.
    path(ctx, walls);
    ctx.strokeStyle = rgba(INK.CLIFF);
    ctx.lineWidth = RIM_PX * 2;
    ctx.stroke();
    ctx.strokeStyle = rgba(INK.CLIFF_LIGHT);
    ctx.lineWidth = RIM_PX;
    ctx.stroke();
    ctx.fillStyle = rgba(INK.FOREST_FLOOR);
    ctx.fill();
    ctx.save();
    ctx.clip();
    // Canopies on a jittered world grid, kept to points inside a wall.
    const crowns: { x: number; y: number; r: number }[] = [];
    const x0 = Math.floor((tile.x - 80) / CANOPY_STEP);
    const y0 = Math.floor((tile.y - 80) / CANOPY_STEP);
    const x1 = Math.ceil((tile.x + tile.w + 80) / CANOPY_STEP);
    const y1 = Math.ceil((tile.y + tile.h + 80) / CANOPY_STEP);
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const x = gx * CANOPY_STEP + (hash(gx, gy) - 0.5) * CANOPY_STEP * 0.8;
        const y = gy * CANOPY_STEP + (hash(gy * 3, gx) - 0.5) * CANOPY_STEP * 0.8;
        if (!this.inForest({ x, y }, walls)) continue;
        crowns.push({ x, y, r: 34 + 18 * hash(gx * 7, gy * 5) });
      }
    }
    // Paint back to front (by y) so a lower crown overlaps the one above it.
    crowns.sort((a, b) => a.y - b.y);
    for (const c of crowns) {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      disc(ctx, c.x + 7, c.y + 10, c.r);
      ctx.fill();
      ctx.fillStyle = rgba(INK.CANOPY);
      ctx.beginPath();
      disc(ctx, c.x, c.y, c.r);
      ctx.fill();
      ctx.fillStyle = rgba(INK.CANOPY_MID);
      ctx.beginPath();
      disc(ctx, c.x - c.r * 0.18, c.y - c.r * 0.22, c.r * 0.7);
      ctx.fill();
      ctx.fillStyle = rgba(INK.CANOPY_LIGHT, 0.7);
      ctx.beginPath();
      disc(ctx, c.x - c.r * 0.35, c.y - c.r * 0.4, c.r * 0.3);
      ctx.fill();
    }
    ctx.restore();
  }

  private rocks(ctx: Ctx, boulders: Shape[]): void {
    for (const s of boulders) {
      path(ctx, [s], 8, 11);
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.fill();
      path(ctx, [s]);
      ctx.fillStyle = rgba(INK.ROCK);
      ctx.fill();
      ctx.strokeStyle = rgba(INK.CLIFF);
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.stroke();
      // Lit top face: the shape pulled toward its centre and up-left.
      const cx = s.box.x + s.box.w / 2;
      const cy = s.box.y + s.box.h / 2;
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = cx + (p.x - cx) * 0.62 - 4;
        const y = cy + (p.y - cy) * 0.62 - 6;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = rgba(INK.ROCK_TOP);
      ctx.fill();
    }
  }
}
