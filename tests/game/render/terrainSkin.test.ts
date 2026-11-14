/**
 * "Rồi sẵn làm đẹp mấy map có sẵn luôn đc ko": every map without its own art
 * was flat #777 polygons on a flat floor. `render/terrainSkin.ts` paints them
 * now; these hold the three things a screenshot found wrong on the way there.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  SKIN_HOLD_MAX_MS,
  SKIN_HOLD_MS,
  initialSkinHold,
  nextSkinHold,
  paintBushes,
  paintWalls,
  paintWater,
  signedArea2,
  trace,
} from '@/game/render/terrainSkin';

/** A 2D context that only records what was called, in order. */
function recorder() {
  const calls: string[] = [];
  const moves: { x: number; y: number }[][] = [];
  const ctx: any = {
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    beginPath: () => (calls.push('beginPath'), moves.push([])),
    moveTo: (x: number, y: number) => moves[moves.length - 1].push({ x, y }),
    lineTo: (x: number, y: number) => moves[moves.length - 1].push({ x, y }),
    closePath: () => {},
    fill: () => calls.push('fill'),
    stroke: () => calls.push('stroke'),
    fillRect: () => calls.push('fillRect'),
    createPattern: () => null,
  };
  return { ctx, calls, moves };
}

const square = (cw: boolean) => ({
  position: { x: 0, y: 0 },
  vertices: cw
    ? [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
    : [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }],
});

describe('terrain skin', () => {
  it('traces every polygon the same way round, so overlapping pieces cannot cancel to a hole', () => {
    const { ctx, moves } = recorder();
    trace(ctx, [square(true), square(false)]);
    const path = moves[0];
    const first = path.slice(0, 4);
    const second = path.slice(4, 8);
    expect(Math.sign(signedArea2(first))).toBe(Math.sign(signedArea2(second)));
  });

  it('strokes each outline before filling, so the seam between two touching pieces is covered', () => {
    for (const paint of [paintWalls, paintBushes, paintWater]) {
      for (const light of [false, true]) {
        const { ctx, calls } = recorder();
        paint(ctx, [square(true)], light);
        const lastStroke = calls.lastIndexOf('stroke');
        const lastFill = calls.lastIndexOf('fill');
        expect(lastFill, `${paint.name} light=${light}`).toBeGreaterThan(lastStroke);
      }
    }
  });

  it('drops the shadow and rim passes under render stress', () => {
    const full = recorder();
    paintWalls(full.ctx, [square(true)], false);
    const light = recorder();
    paintWalls(light.ctx, [square(true)], true);
    expect(light.calls.filter(c => c === 'beginPath').length).toBe(1);
    expect(full.calls.filter(c => c === 'beginPath').length).toBeGreaterThan(1);
  });

  it('fills with plain colours under render stress, never a pattern (the flat look\'s cost)', () => {
    for (const paint of [paintWalls, paintBushes, paintWater]) {
      const fills: unknown[] = [];
      const { ctx } = recorder();
      // A real tile needs a canvas: hand `document` one whose context is a
      // no-op for every call, so `terrainPatterns` does build patterns here.
      const noopCtx = new Proxy({}, { get: () => () => {} , set: () => true });
      vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => noopCtx }) });
      const pattern = { kind: 'pattern' };
      ctx.createPattern = () => pattern;
      ctx.fill = () => fills.push(ctx.fillStyle);
      paint(ctx, [square(true)], true);
      expect(fills.length, paint.name).toBeGreaterThan(0);
      for (const f of fills) expect(typeof f, paint.name).toBe('string');
      // And the full look does use one, or this test could not tell the two apart.
      const full: unknown[] = [];
      ctx.fill = () => full.push(ctx.fillStyle);
      paint(ctx, [square(true)], false);
      expect(full, paint.name).toContain(pattern);
      vi.unstubAllGlobals();
    }
  });

  it('is what TerrainMap paints with, and the floor is skipped under stress', () => {
    const src = readFileSync(resolve(__dirname, '../../../src/game/gameObject/map/TerrainMap.ts'), 'utf8').replace(
      /\/\/.*$|\/\*[\s\S]*?\*\//gm,
      ''
    );
    const draw = src.slice(src.indexOf('  draw(): void {'), src.indexOf('private drawZones'));
    for (const fn of ['paintWalls', 'paintBushes', 'paintWater']) expect(draw).toContain(fn);
    expect(draw).toMatch(/if \(!light\) paintFloor\(/);
  });

  it('holds the light look after stress instead of flipping back on the next good frame', () => {
    // Stressed at 0, fine from 100 on: still light until the hold runs out.
    let st = initialSkinHold();
    st = nextSkinHold(st, true, 0).state;
    expect(nextSkinHold(st, false, 100).light).toBe(true);
    expect(nextSkinHold(st, false, SKIN_HOLD_MS - 1).light).toBe(true);
    expect(nextSkinHold(st, false, SKIN_HOLD_MS).light).toBe(false);
  });

  it('doubles the hold each time the full look brings stress straight back, up to the cap, and resets after a good spell', () => {
    let st = initialSkinHold();
    let t = 0;
    const holds: number[] = [];
    for (let i = 0; i < 6; i++) {
      st = nextSkinHold(st, true, t).state;
      holds.push(st.holdMs);
      t = st.lightUntilMs;
      st = nextSkinHold(st, false, t).state; // full comes back
      t += 1_000; // and stress returns a second later
    }
    expect(holds).toEqual([SKIN_HOLD_MS, SKIN_HOLD_MS * 2, SKIN_HOLD_MS * 4, 60_000, 60_000, 60_000].map(h => Math.min(h, SKIN_HOLD_MAX_MS)));
    // A full look that lasted is forgiven.
    st = nextSkinHold(st, true, t).state;
    t = st.lightUntilMs;
    st = nextSkinHold(st, false, t).state;
    t += 30_000;
    expect(nextSkinHold(st, true, t).state.holdMs).toBe(SKIN_HOLD_MS);
  });

  it('TerrainMap reads the held look, not the raw tier', () => {
    const src = readFileSync(resolve(__dirname, '../../../src/game/gameObject/map/TerrainMap.ts'), 'utf8').replace(
      /\/\/.*$|\/\*[\s\S]*?\*\//gm,
      ''
    );
    expect(src).toMatch(/nextSkinHold\(this\.skinHold, stressed, performance\.now\(\)\)/);
  });
});

describe('the terrain patterns after a background purge', () => {
  it('are rebuilt once an asset restore completes, not kept as blanks', async () => {
    const { terrainPatterns } = await import('@/game/render/terrainSkin');
    const AssetManager = (await import('@/managers/AssetManager')).default;
    const ctx = { createPattern: () => ({}) } as unknown as CanvasRenderingContext2D;
    const first = terrainPatterns(ctx);
    expect(terrainPatterns(ctx)).toBe(first);
    AssetManager.purgeEpoch++;
    expect(terrainPatterns(ctx)).not.toBe(first);
  });
});
