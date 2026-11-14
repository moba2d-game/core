/**
 * The soft fog erases one polygon per revealer near the camera, and it did so
 * through p5: a renderer-state copy (`push`/`pop`) per polygon and a
 * `p5.Vector` per vertex. `drawVisions` now issues the same path on the
 * overlay's own context. These hold both halves: nothing p5 is paid for, and
 * the path is the one p5 would have drawn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FogOfWar from '@/game/gameObject/map/FogOfWar';
import { createGame, stubGameGlobals } from '../fixtures';

type Pt = { x: number; y: number };

describe('FogOfWar.drawVisions', () => {
  const W = 800;
  const H = 400;
  const SCALE = 0.5;
  const CAMERA = { x: 1000, y: 600 };
  let ops: [string, ...unknown[]][];
  let p5Calls: string[];
  let vectors: number;

  beforeEach(() => {
    stubGameGlobals();
    vi.stubGlobal('width', W);
    vi.stubGlobal('height', H);
    vi.stubGlobal('windowWidth', W);
    vi.stubGlobal('windowHeight', H);
    ops = [];
    p5Calls = [];
    vectors = 0;
    const ctx: Record<string, unknown> = { fillStyle: '' };
    for (const name of ['save', 'restore', 'translate', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'fillRect']) {
      ctx[name] = (...args: unknown[]) => ops.push([name, ...args]);
    }
    ctx.fill = () => ops.push(['fill', ctx.fillStyle]);
    ctx.createRadialGradient = (...args: number[]) => ({ gradient: args, addColorStop() {} });
    const p5 = (name: string) => () => p5Calls.push(name);
    vi.stubGlobal('createGraphics', () => ({
      pixelDensity: () => {},
      drawingContext: ctx,
      width: W,
      height: H,
      resetMatrix() {},
      erase() {},
      noErase() {},
      noStroke() {},
      push: p5('push'),
      pop: p5('pop'),
      translate: p5('translate'),
      beginShape: p5('beginShape'),
      vertex: p5('vertex'),
      endShape: p5('endShape'),
      CLOSE: 'close',
      resizeCanvas() {},
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const toScreen = (x: number, y: number): Pt => ({
    x: (x - CAMERA.x) * SCALE + W / 2,
    y: (y - CAMERA.y) * SCALE + H / 2,
  });

  const fogWith = (sights: { sightPoly: Pt[]; at: Pt }[]) => {
    const game = createGame() as unknown as Record<string, unknown>;
    game.camera = {
      position: CAMERA,
      currentScale: SCALE,
      getBoundingBox: () => ({ x: 0, y: 0, w: W / SCALE, h: H / SCALE }),
      worldToScreen: (x: number, y: number) => (vectors++, toScreen(x, y)),
      worldToScreenInto: (x: number, y: number, out: Pt) => Object.assign(out, toScreen(x, y)),
    };
    const fog = new FogOfWar(game);
    fog.calculateSight = () =>
      sights.map(({ sightPoly, at }) => ({ sightPoly, radius: 300, ring: 40, object: { position: at } })) as never;
    return fog;
  };

  const triangle = (x: number, y: number): Pt[] => [{ x, y }, { x: x + 120.5, y }, { x, y: y + 80.25 }];

  it('issues, per polygon, the closed path p5 drew: translate to the revealer, trace relative to it, one fill', () => {
    const at = { x: 1010, y: 620 };
    const sightPoly = triangle(990, 600);
    fogWith([{ sightPoly, at }]).drawVisions();

    const origin = toScreen(at.x, at.y);
    const rel = sightPoly.map(v => {
      const s = toScreen(v.x, v.y);
      return [s.x - origin.x, s.y - origin.y];
    });
    expect(ops.map(op => op[0])).toEqual(['save', 'translate', 'beginPath', 'moveTo', 'lineTo', 'lineTo', 'closePath', 'fill', 'restore']);
    expect(ops[1]).toEqual(['translate', origin.x, origin.y]);
    expect(ops.slice(3, 6).map(op => op.slice(1))).toEqual(rel);
    // Filled with the revealer's gradient, set after the save so it does not leak.
    expect(ops[7][1]).toMatchObject({ gradient: [0, 0, (300 - 40) * SCALE, 0, 0, 300 * SCALE] });
  });

  it('pays for no p5 state copy per polygon and no vector per vertex', () => {
    const sights = Array.from({ length: 10 }, (_, i) => ({
      sightPoly: triangle(900 + i * 20, 600),
      at: { x: 900 + i * 20, y: 610 },
    }));
    fogWith(sights).drawVisions();
    expect(ops.filter(op => op[0] === 'fill').length).toBe(10);
    expect(p5Calls).toEqual([]);
    // One per revealer for the gradient's centre; none per vertex.
    expect(vectors).toBe(10);
  });

  it('draws nothing for a revealer whose polygon is empty, as p5 did', () => {
    fogWith([{ sightPoly: [], at: { x: 1000, y: 600 } }]).drawVisions();
    expect(ops).toEqual([]);
  });
});
