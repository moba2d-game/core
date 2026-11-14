import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/managers/AssetManager', () => ({
  default: { get: (key: string) => ({ key, path: key, status: 'ready', data: null }) },
}));

import { buildContentApi } from '../../src/content/ContentApi';
import type { MapGeometry } from '../../src/content/ContentPack';
import { referenceMap } from '../../packs/reference/map';
import makeReferencePack from '../../packs/reference/pack';
import { LaneArt, type LaneGeometry } from '../../packs/reference/art/laneArt';
import {
  SCENERY_ROLE,
  bakeWithin,
  sceneryZIndex,
  withScenerySlot,
} from '../../packs/reference/art/scenery';
import { TILE, TileCache } from '../../packs/reference/art/tiles';
import { createGame, stubGameGlobals } from '../game/fixtures';

/**
 * ARAM used to be drawn with core's grey terrain fills while a content pack's
 * lane maps had painted ground. It paints its own now, through the same seam
 * any pack would use: a neutral `kind: 'object'` slot, a `slotObjects` factory,
 * and `paintsOwnTerrain`. What a machine can hold about a picture is held
 * here; what it looks like is a screenshot's job.
 */

const geometry = (): Promise<MapGeometry> => {
  const source = referenceMap.geometry;
  return typeof source === 'function' ? source() : Promise.resolve(source);
};

describe('ARAM paints its own ground', () => {
  beforeEach(() => stubGameGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('declares it, so core stops drawing grey fills underneath', () => {
    expect(referenceMap.paintsOwnTerrain).toBe(true);
  });

  it('carries exactly one scenery slot, an object, at the centre of the map', async () => {
    const g = await geometry();
    const slots = g.slots.neutral.filter(slot => slot.role === SCENERY_ROLE);
    expect(slots).toHaveLength(1);
    expect(slots[0].kind).toBe('object');
    expect([slots[0].x, slots[0].y]).toEqual([referenceMap.size / 2, referenceMap.size / 2]);
    // Handing the same geometry through again does not add a second.
    withScenerySlot(referenceMap.id, referenceMap.size, g);
    expect(g.slots.neutral.filter(slot => slot.role === SCENERY_ROLE)).toHaveLength(1);
  });

  it('answers that slot with an object drawn under everything core stands on the ground', async () => {
    const api = buildContentApi();
    const factory = makeReferencePack(api).slotObjects?.[SCENERY_ROLE];
    expect(factory, 'the reference pack does not answer its own scenery role').toBeTypeOf(
      'function'
    );

    const g = await geometry();
    const slot = g.slots.neutral.find(candidate => candidate.role === SCENERY_ROLE)!;
    const made = factory!(slot, createGame() as never) as unknown as {
      zIndex: number;
      alwaysVisible: boolean;
    } | null;
    expect(made).not.toBeNull();
    expect(made!.zIndex).toBe(sceneryZIndex(api.layers));
    // The ground itself: under the fountain's ring, trails, particles and decals.
    expect(made!.zIndex).toBeLessThan(api.layers.FOUNTAIN_Z_INDEX);
    expect(made!.zIndex).toBeLessThan(api.layers.GROUND_Z_INDEX);
    // Never culled by the fog or the view: it is the floor.
    expect(made!.alwaysVisible).toBe(true);
  });

  it('declines a scenery slot that names no loaded map', () => {
    const factory = makeReferencePack(buildContentApi()).slotObjects![SCENERY_ROLE];
    const stranger = { role: SCENERY_ROLE, kind: 'object', x: 0, y: 0, r: 0, art: 'nowhere' };
    expect(factory(stranger as never, createGame() as never)).toBeNull();
  });

  it('paints nothing once the player asks for the plain ground, and again when they change back', async () => {
    const factory = makeReferencePack(buildContentApi()).slotObjects![SCENERY_ROLE];
    const g = await geometry();
    const slot = g.slots.neutral.find(candidate => candidate.role === SCENERY_ROLE)!;
    const game = createGame() as unknown as { mapGround?: string };
    const made = factory(slot, game as never) as unknown as { tiles: TileCache; draw(): void };
    const blit = vi.spyOn(made.tiles, 'draw').mockImplementation(() => {});
    vi.stubGlobal('drawingContext', {});

    game.mapGround = 'plain';
    made.draw();
    expect(blit).not.toHaveBeenCalled();

    // The same object, the next frame: nothing was torn down to get here.
    game.mapGround = 'detailed';
    made.draw();
    expect(blit).toHaveBeenCalledTimes(1);
  });

  it('lets its tiles go when the object is removed', async () => {
    const factory = makeReferencePack(buildContentApi()).slotObjects![SCENERY_ROLE];
    const g = await geometry();
    const slot = g.slots.neutral.find(candidate => candidate.role === SCENERY_ROLE)!;
    const made = factory(slot, createGame() as never) as unknown as {
      tiles: TileCache;
      onRemoved(): void;
    };
    const destroy = vi.spyOn(made.tiles, 'destroy');
    made.onRemoved();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('paints from the map’s own polygons: forest, two boulders, one lane clear of the trees', async () => {
    const art = new LaneArt((await geometry()) as unknown as LaneGeometry, { boulderArea: 15_000 });
    expect(art.walls.length).toBeGreaterThan(0);
    expect(art.bushes).toHaveLength(8);
    expect(art.lanes).toHaveLength(1);
    expect(art.plazas).toHaveLength(2);
    expect(art.plazas[0].ink).not.toEqual(art.plazas[1].ink);
    // A lane drawn through trees would be a lie about where a unit can walk.
    for (const point of art.lanes[0]) expect(art.inForest(point, art.walls)).toBe(false);
    // A small wall touching the forest is part of it, never a boulder of its own.
    const touching = art.boulders.filter(b => b.points.some(p => art.nearForest(p, 12)));
    expect(touching).toEqual([]);
  });

  it('paints nothing past the map’s own edge, where the last row of tiles overhangs it', () => {
    // 4000 is not a multiple of the tile size: the last tile runs to 4096, and
    // unclipped that was a 96px strip of grass outside the boundary wall.
    const calls: string[] = [];
    const ctx = {
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      beginPath: () => calls.push('beginPath'),
      rect: (...box: number[]) => calls.push(`rect(${box.join(',')})`),
      clip: () => calls.push('clip'),
    } as unknown as CanvasRenderingContext2D;
    const bake = bakeWithin(4000, () => calls.push('paint'));
    bake(ctx, { x: TILE * 7, y: TILE * 7, w: TILE, h: TILE });
    expect(calls).toEqual(['save', 'beginPath', 'rect(0,0,4000,4000)', 'clip', 'paint', 'restore']);
  });

  it('paints the same tile the same way twice', async () => {
    const art = new LaneArt((await geometry()) as unknown as LaneGeometry);
    const record = () => {
      const calls: string[] = [];
      const ctx = new Proxy({} as Record<string, unknown>, {
        get(target, key) {
          if (key in target) return target[key as string];
          return (...args: unknown[]) => {
            calls.push(
              `${String(key)}(${args.map(a => (typeof a === 'number' ? Math.round(a * 10) / 10 : String(a))).join(',')})`
            );
          };
        },
        set(target, key, value) {
          target[key as string] = value;
          return true;
        },
      });
      art.bake(ctx as unknown as CanvasRenderingContext2D, {
        x: TILE * 3,
        y: TILE * 3,
        w: TILE,
        h: TILE,
      });
      return calls;
    };
    const first = record();
    expect(first.length).toBeGreaterThan(100);
    expect(record()).toEqual(first);
  });
});

/**
 * A backgrounded phone purges offscreen canvases, these tiles among them, and
 * the player came back to a black map. Every return from hidden repaints what
 * is on screen.
 */
describe('the ground’s tile cache', () => {
  class FakePage extends EventTarget {
    hidden = false;
    flip(hidden: boolean) {
      this.hidden = hidden;
      this.dispatchEvent(new Event('visibilitychange'));
    }
  }
  const ctx = {
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    setTransform: () => undefined,
    drawImage: () => undefined,
  } as unknown as CanvasRenderingContext2D;
  const canvas = () =>
    ({
      width: 0,
      height: 0,
      getContext: () => ({ setTransform: () => undefined }),
    }) as unknown as HTMLCanvasElement;
  const cacheWith = (page: FakePage) => new TileCache(4000, () => undefined, canvas, page as never);
  // Chosen so a 30px diagonal walk stays inside the tiles it starts on.
  const view = { x: 600, y: 560, w: 900, h: 400 };

  it('repaints the visible tiles on the first frame after coming back from hidden', () => {
    const page = new FakePage();
    const cache = cacheWith(page);
    cache.draw(ctx, view, 1);
    const first = cache.bakes;
    cache.draw(ctx, view, 1);
    const steady = cache.bakes;
    page.flip(true);
    page.flip(false);
    cache.draw(ctx, view, 1);
    expect(first).toBeGreaterThan(1);
    expect(cache.bakes - steady).toBeGreaterThanOrEqual(first - 1);
    // Once. A resume that kept repainting would be a bake per tile per frame.
    for (let frame = 0; frame < 40; frame++) cache.draw(ctx, view, 1);
    const settled = cache.bakes;
    cache.draw(ctx, view, 1);
    expect(cache.bakes).toBe(settled);
  });

  it('bakes nothing new when the camera walks inside tiles it already holds', () => {
    // "Never key a render cache on the camera": a step the player takes must
    // be a blit, not a repaint.
    const cache = cacheWith(new FakePage());
    for (let frame = 0; frame < 40; frame++) cache.draw(ctx, view, 1); // prefetch settles
    const settled = cache.bakes;
    for (let step = 1; step <= 30; step++) {
      cache.draw(ctx, { ...view, x: view.x + step, y: view.y + step }, 1);
    }
    expect(cache.bakes).toBe(settled);
  });

  it('stops listening to the page once destroyed', () => {
    const page = new FakePage();
    const cache = cacheWith(page);
    for (let frame = 0; frame < 40; frame++) cache.draw(ctx, view, 1);
    cache.destroy();
    expect(cache.size).toBe(0);
    for (let frame = 0; frame < 40; frame++) cache.draw(ctx, view, 1);
    const rebuilt = cache.bakes;
    page.flip(true);
    page.flip(false);
    cache.draw(ctx, view, 1);
    expect(cache.bakes).toBe(rebuilt);
  });
});
