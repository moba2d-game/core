/**
 * The solid terrain's script cost was tracing: the full wall look walked every
 * vertex in view four times a frame, on a map whose geometry never changes.
 * `SkinPathCache` keeps each pass as a `Path2D`; these hold that it draws what
 * a fresh trace draws, that it is kept while the obstacles in view stay the
 * same, and that the camera is not what invalidates it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubGameGlobals } from '../fixtures';
import TerrainMap from '@/game/gameObject/map/TerrainMap';
import ParticleSystem from '@/game/gameObject/helpers/ParticleSystem';
import { Rectangle } from '@/libs/quadtree';
import type { ActiveMap } from '@/content/ContentPack';
import {
  BUSH_PASSES,
  SkinPathCache,
  WALL_PASSES,
  WATER_PASSES,
  paintBushes,
  paintWalls,
  paintWater,
} from '@/game/render/terrainSkin';

type Point = { x: number; y: number };

/** Stands in for `Path2D`: remembers its subpaths, and counts every one built. */
class FakePath {
  static built = 0;
  static vertices = 0;
  subpaths: Point[][] = [];
  constructor() {
    FakePath.built++;
  }
  moveTo(x: number, y: number) {
    FakePath.vertices++;
    this.subpaths.push([{ x, y }]);
  }
  lineTo(x: number, y: number) {
    FakePath.vertices++;
    this.subpaths[this.subpaths.length - 1].push({ x, y });
  }
  closePath() {}
}

/**
 * A context that records each `fill`/`stroke` with the geometry and the style
 * it would draw — the current path for a bare call, the `Path2D` for a kept one
 * — so the two routes can be compared as pictures rather than as call lists.
 */
function canvas() {
  const drawn: { op: string; style: unknown; lineWidth: unknown; lineJoin: unknown; shape: Point[][] }[] = [];
  let current: Point[][] = [];
  let traced = 0;
  const ctx: any = {
    lineWidth: 1,
    lineJoin: 'miter',
    fillStyle: '',
    strokeStyle: '',
    save() {},
    restore() {},
    fillRect() {},
    createPattern: () => null,
    beginPath: () => (current = []),
    moveTo: (x: number, y: number) => (traced++, current.push([{ x, y }])),
    lineTo: (x: number, y: number) => (traced++, current[current.length - 1].push({ x, y })),
    closePath() {},
    fill(path?: FakePath) {
      drawn.push({ op: 'fill', style: ctx.fillStyle, lineWidth: null, lineJoin: null, shape: structuredClone(path ? path.subpaths : current) });
    },
    stroke(path?: FakePath) {
      drawn.push({ op: 'stroke', style: ctx.strokeStyle, lineWidth: ctx.lineWidth, lineJoin: ctx.lineJoin, shape: structuredClone(path ? path.subpaths : current) });
    },
  };
  return { ctx, drawn, traced: () => traced };
}

const poly = (x: number, y: number, clockwise = true) => ({
  position: { x: 0, y: 0 },
  vertices: clockwise
    ? [{ x, y }, { x: x + 40.5, y }, { x: x + 40.5, y: y + 30.25 }, { x, y: y + 30.25 }]
    : [{ x, y }, { x, y: y + 30.25 }, { x: x + 40.5, y: y + 30.25 }, { x: x + 40.5, y }],
});

beforeEach(() => {
  FakePath.built = 0;
  FakePath.vertices = 0;
  vi.stubGlobal('Path2D', FakePath);
});
afterEach(() => vi.unstubAllGlobals());

const painters = [
  ['walls', paintWalls, WALL_PASSES],
  ['bushes', paintBushes, BUSH_PASSES],
  ['water', paintWater, WATER_PASSES],
] as const;

describe('the terrain skin, painting from kept paths', () => {
  it('draws exactly what a fresh trace draws: same passes, order, styles and coordinates', () => {
    // Both windings, and an overlap: the pieces an editor map is made of.
    const polys = [poly(10.3, 20.7), poly(30, 35, false), poly(400, 90)];
    for (const [name, paint, passes] of painters) {
      for (const light of [false, true]) {
        const traced = canvas();
        paint(traced.ctx, polys, light);
        const kept = canvas();
        paint(kept.ctx, polys, light, new SkinPathCache(passes));
        expect(kept.drawn, `${name} light=${light}`).toEqual(traced.drawn);
        expect(kept.drawn.length).toBeGreaterThan(1);
      }
    }
  });

  it('walks the vertices once per pass, not once per pass per frame', () => {
    const polys = [poly(0, 0), poly(100, 0), poly(200, 0)];
    const cache = new SkinPathCache(WALL_PASSES);
    const { ctx, traced } = canvas();
    for (let frame = 0; frame < 60; frame++) paintWalls(ctx, polys, false, cache);
    expect(traced()).toBe(0);
    expect(FakePath.built).toBe(WALL_PASSES.length);
    expect(FakePath.vertices).toBe(WALL_PASSES.length * 3 * 4);
    expect(cache.rebuilds).toBe(1);
  });

  it('never builds a shadow or a rim for the light look', () => {
    const cache = new SkinPathCache(WALL_PASSES);
    paintWalls(canvas().ctx, [poly(0, 0)], true, cache);
    expect(FakePath.built).toBe(1);
  });

  it('is keyed on which polygons are in view, so a new array of the same ones keeps the paths', () => {
    const a = poly(0, 0);
    const b = poly(100, 0);
    const c = poly(200, 0);
    const cache = new SkinPathCache(WATER_PASSES);
    const { ctx, drawn } = canvas();
    paintWater(ctx, [a, b], true, cache);
    // What a walking camera does every frame: the same obstacles, a fresh list.
    paintWater(ctx, [a, b], true, cache);
    expect(cache.rebuilds).toBe(1);
    // What it does now and then: one obstacle leaves the view, another enters.
    paintWater(ctx, [b, c], true, cache);
    expect(cache.rebuilds).toBe(2);
    expect(drawn[drawn.length - 1].shape.map(s => s[0].x)).toEqual([100, 200]);
    // The same polygon handed a new outline is a new shape.
    b.vertices = poly(100, 50).vertices;
    paintWater(ctx, [b, c], true, cache);
    expect(cache.rebuilds).toBe(3);
    expect(drawn[drawn.length - 1].shape[0][0]).toEqual({ x: 100, y: 50 });
  });

  it('traces as before where there is no Path2D', () => {
    vi.stubGlobal('Path2D', undefined);
    const { ctx, drawn, traced } = canvas();
    paintBushes(ctx, [poly(0, 0)], false, new SkinPathCache(BUSH_PASSES));
    expect(traced()).toBeGreaterThan(0);
    expect(drawn.map(d => d.op)).toEqual(['stroke', 'stroke', 'fill']);
  });
});

describe('TerrainMap.draw on a map that does not paint its own terrain', () => {
  const map = (): ActiveMap =>
    ({
      id: 'test-map',
      name: 'Test Map',
      size: 3_200,
      factions: [{ id: 'blue' }, { id: 'red' }],
      terrain: {
        wall: [poly(100, 100).vertices, poly(300, 100).vertices],
        bush: [poly(500, 300).vertices],
        water: [poly(700, 500).vertices],
      },
      slots: { spawn: [], minion: [], structure: [], neutral: [] },
    }) as ActiveMap;

  function world() {
    stubGameGlobals();
    vi.stubGlobal('Path2D', FakePath);
    const { ctx, drawn, traced } = canvas();
    vi.stubGlobal('drawingContext', ctx);
    const p5State = { push: 0, pop: 0 };
    vi.stubGlobal('push', () => p5State.push++);
    vi.stubGlobal('pop', () => p5State.pop++);
    const view = { x: 0, y: 0 };
    const game = {
      renderQuality: 'high',
      camera: { getBoundingBox: () => new Rectangle({ x: view.x, y: view.y, w: 1_000, h: 800 }) },
    };
    return { terrain: new TerrainMap(game, map()), drawn, traced, p5State, view };
  }

  it('re-traces nothing while the camera moves over the same obstacles', () => {
    const { terrain, drawn, traced, view } = world();
    terrain.draw();
    const first = drawn.length;
    const built = FakePath.built;
    expect(first).toBeGreaterThan(0);
    for (let frame = 1; frame <= 30; frame++) {
      view.x = frame * 1.5;
      view.y = frame * 0.5;
      terrain.draw();
    }
    expect(drawn.length).toBe(first * 31);
    expect(FakePath.built).toBe(built);
    expect(traced()).toBe(0);
  });

  it('pays for no p5 push/pop when there is nothing p5 draws: no ripples, no zones, no rotated obstacle', () => {
    const { terrain, p5State } = world();
    terrain.draw();
    expect(p5State).toEqual({ push: 0, pop: 0 });
  });

  it('still draws the ripples when a champion is wading', () => {
    const { terrain, p5State } = world();
    const circles: number[] = [];
    vi.stubGlobal('map', () => 100);
    vi.stubGlobal('noStroke', () => {});
    vi.stubGlobal('fill', () => {});
    vi.stubGlobal('circle', (x: number) => circles.push(x));
    terrain.rippleEffect.addParticle({ x: 710, y: 510, r: 1, maxr: 20 });
    terrain.draw();
    expect(circles).toEqual([710]);
    expect(p5State).toEqual({ push: 1, pop: 1 });
  });
});

describe('ParticleSystem.draw with nothing in it', () => {
  it('runs its hooks even when empty, since a hook may paint', () => {
    stubGameGlobals();
    let pushes = 0;
    vi.stubGlobal('push', () => pushes++);
    vi.stubGlobal('pop', () => {});
    const preDrawFn = vi.fn();
    new ParticleSystem({ isDeadFn: () => false, preDrawFn }).draw();
    expect(preDrawFn).toHaveBeenCalledTimes(1);
    expect(pushes).toBe(1);
    new ParticleSystem({ isDeadFn: () => false, drawFn: () => {} }).draw();
    expect(pushes).toBe(1);
  });
});
