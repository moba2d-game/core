/**
 * `TerrainMap` takes the world it draws and collides against from the active
 * `MapDefinition`, not from a hard-coded 6400 or a synchronous
 * `AssetManager.get('json_summoner_map')` read.
 *
 * The size assertion below is deliberately against a *derived* value — the
 * quadtree's own bounds, which every terrain query is built on top of — not
 * just `terrainMap.size` itself. A `TerrainMap` that stored the number but
 * kept building a 6400-wide quadtree would still pass a check that only read
 * the field back; see `CLAUDE.md`'s note on `botTrajectory.ts` for the same
 * shape of bug at a different layer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubGameGlobals } from '../fixtures';
import TerrainMap from '../../../src/game/gameObject/map/TerrainMap';
import TerrainType from '../../../src/game/enums/TerrainType';
import type { ActiveMap } from '../../../src/content/ContentPack';
import { Rectangle } from '../../../src/libs/quadtree';

const activeMap = (size: number): ActiveMap => ({
  id: 'test-map',
  name: 'Test Map',
  size,
  factions: [{ id: 'blue' }, { id: 'red' }],
  terrain: {
    wall: [
      [
        { x: 100, y: 100 },
        { x: 200, y: 100 },
        { x: 200, y: 200 },
        { x: 100, y: 200 },
      ],
    ],
    bush: [
      [
        { x: 300, y: 300 },
        { x: 340, y: 300 },
        { x: 340, y: 340 },
        { x: 300, y: 340 },
      ],
    ],
    water: [],
  },
  slots: { spawn: [], minion: [], structure: [], neutral: [] },
});

beforeEach(() => stubGameGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('TerrainMap', () => {
  it('takes its size from the map, not from a 6400 default — checked on a derived value', () => {
    const terrainMap = new TerrainMap({}, activeMap(3_200));
    expect(terrainMap.size).toBe(3_200);
    // The quadtree every terrain query is built on top of, not just the field.
    expect(terrainMap.quadtree.bounds).toEqual({ x: 0, y: 0, w: 3_200, h: 3_200 });
  });

  it('parses the wall/bush/water layers straight off the map, no asset manager involved', () => {
    const terrainMap = new TerrainMap({}, activeMap(6_400));
    const walls = terrainMap.obstacles.filter(o => o.type === TerrainType.WALL);
    const bushes = terrainMap.obstacles.filter(o => o.type === TerrainType.BUSH);
    const waters = terrainMap.obstacles.filter(o => o.type === TerrainType.WATER);
    expect(walls).toHaveLength(1);
    expect(bushes).toHaveLength(1);
    expect(waters).toHaveLength(0);
    expect(terrainMap.wallPolygons()).toEqual([
      [
        { x: 100, y: 100 },
        { x: 200, y: 100 },
        { x: 200, y: 200 },
        { x: 100, y: 200 },
      ],
    ]);
  });

  describe('containsPoint', () => {
    // The layers other than `wall` are regions, not obstacles — nothing
    // collides with a bush — and a camp that has to stay in the river is the
    // first caller that needs to ask about one by point. Before this, the only
    // way was to repeat the retrieve-then-`pointPolygon` pair `update()` does
    // inline for its champion pass.

    it('answers true inside a layer polygon and false outside it', () => {
      const terrainMap = new TerrainMap({}, activeMap(6_400));
      expect(terrainMap.containsPoint(320, 320, TerrainType.BUSH)).toBe(true);
      expect(terrainMap.containsPoint(500, 500, TerrainType.BUSH)).toBe(false);
    });

    it('answers for the layer asked for, not for whatever polygon is there', () => {
      // The point below is inside the *wall*. A `containsPoint` that only
      // checked "did the quadtree hand anything back" would call it bush.
      const terrainMap = new TerrainMap({}, activeMap(6_400));
      expect(terrainMap.containsPoint(150, 150, TerrainType.WALL)).toBe(true);
      expect(terrainMap.containsPoint(150, 150, TerrainType.BUSH)).toBe(false);
      expect(terrainMap.containsPoint(320, 320, TerrainType.WATER)).toBe(false);
    });

    it('is false for a layer the map does not have at all', () => {
      // `activeMap` ships no water. "No such layer" has to read as "not in
      // it", never as a throw — a camp asking is not a bug.
      const terrainMap = new TerrainMap({}, activeMap(6_400));
      expect(terrainMap.containsPoint(320, 320, TerrainType.WATER)).toBe(false);
    });

    it('does not report a point just outside a polygon edge as inside', () => {
      // The 1px query circle widens what the quadtree hands back, never what
      // counts as inside — `pointPolygon` on the real vertices decides.
      const terrainMap = new TerrainMap({}, activeMap(6_400));
      expect(terrainMap.containsPoint(299, 320, TerrainType.BUSH)).toBe(false);
      expect(terrainMap.containsPoint(301, 320, TerrainType.BUSH)).toBe(true);
    });
  });

  it('a second map with a different size and terrain builds an independent quadtree', () => {
    // Regression for a `TerrainMap` that quietly kept a module-level default:
    // two instances built back to back must not share state.
    const first = new TerrainMap({}, activeMap(1_600));
    const second = new TerrainMap({}, activeMap(8_000));
    expect(first.quadtree.bounds.w).toBe(1_600);
    expect(second.quadtree.bounds.w).toBe(8_000);
  });
});

describe('TerrainMap.draw and MapSummary.paintsOwnTerrain', () => {
  const drawCounting = (paintsOwnTerrain?: boolean): number => {
    let vertices = 0;
    for (const name of ['push', 'pop', 'fill', 'stroke', 'strokeWeight', 'noStroke', 'beginShape', 'endShape']) {
      vi.stubGlobal(name, vi.fn());
    }
    vi.stubGlobal('vertex', vi.fn(() => vertices++));
    const game = { camera: { getBoundingBox: () => new Rectangle({ x: 0, y: 0, w: 6_400, h: 6_400 }) } };
    const terrainMap = new TerrainMap(game, { ...activeMap(6_400), paintsOwnTerrain });
    terrainMap.rippleEffect = { draw: vi.fn() };
    terrainMap.draw();
    return vertices;
  };

  it('fills every obstacle in view by default', () => {
    expect(drawCounting()).toBe(8);
  });

  it('fills none of them when the pack paints its own terrain', () => {
    expect(drawCounting(true)).toBe(0);
  });
});
