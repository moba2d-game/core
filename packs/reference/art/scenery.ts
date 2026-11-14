import type { ContentApi } from '@moba2d/core/content/ContentApi';
import type { MapGeometry, NeutralSlot, SlotObjectFactory } from '@moba2d/core/content/ContentPack';
import { LaneArt, type LaneArtScale, type LaneGeometry } from './laneArt';
import { TileCache, type TileBaker } from './tiles';

/**
 * Puts the painted ground under a lane map of this pack.
 *
 * Core has no "a map's scenery" hook, and does not need one: a neutral slot
 * with `kind: 'object'` is built at match start whatever the jungle switch
 * says (`Game.spawnSlotObjects`), and the object it builds may be anything.
 * The map's geometry gains one such slot (`withScenerySlot`), the pack's
 * `slotObjects` answers its role with the object below, and the map declares
 * `paintsOwnTerrain` so core stops drawing its grey fills underneath.
 *
 * It is the same mechanism any content pack would use, on purpose: this pack
 * is the worked example an author reads.
 */

export const SCENERY_ROLE = 'scenery';

/**
 * The painted ground's layer: one under the fountain, the lowest thing core
 * itself stands on the ground.
 *
 * Not `layers.GROUND_Z_INDEX`. That layer is for a decal a cast leaves *on*
 * the ground — above the fountain's ring, trails and particles — and the
 * ground itself drawn there would cover all three. Derived from a named layer
 * rather than written as a number, so it follows the fountain if that moves.
 */
export const sceneryZIndex = (layers: ContentApi['layers']): number => layers.FOUNTAIN_Z_INDEX - 1;

interface Scene {
  size: number;
  geometry: LaneGeometry;
  scale: Partial<LaneArtScale>;
}

/** The geometry each map's loader parsed, by the key its scenery slot carries. */
const scenes = new Map<string, Scene>();

/** A neutral slot, plus which map's art it stands for. Read back by the slot factory. */
type ScenerySlot = NeutralSlot & { art?: string };

/**
 * Adds the scenery slot to a map's geometry and remembers the geometry under
 * `key`. Idempotent: the same object may be handed through twice.
 */
export function withScenerySlot<G extends MapGeometry>(
  key: string,
  size: number,
  geometry: G,
  scale: Partial<LaneArtScale> = {}
): G {
  scenes.set(key, { size, geometry: geometry as unknown as LaneGeometry, scale });
  const neutral = geometry.slots.neutral as ScenerySlot[];
  if (!neutral.some(slot => slot.role === SCENERY_ROLE)) {
    // At the map's centre: a point every map rule accepts, and its own mirror
    // image. Nowhere a player will notice — the object draws the whole map.
    neutral.push({
      role: SCENERY_ROLE,
      kind: 'object',
      x: size / 2,
      y: size / 2,
      r: 0,
      art: key,
    });
  }
  return geometry;
}

/**
 * Keeps a painter inside the map. The tile grid is laid over the world in
 * whole tiles, so unless the map's size is a multiple of one the last row and
 * column overhang its edge — and whatever is painted there shows as a strip
 * of ground outside the boundary wall.
 */
export const bakeWithin =
  (size: number, paint: TileBaker): TileBaker =>
  (ctx, tile) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, size, size);
    ctx.clip();
    paint(ctx, tile);
    ctx.restore();
  };

function build(api: ContentApi) {
  return class LaneScenery extends api.GameObject {
    zIndex = sceneryZIndex(api.layers);
    alwaysVisible = true;
    readonly tiles: TileCache;
    readonly size: number;

    constructor(game: Parameters<SlotObjectFactory>[1], scene: Scene) {
      super({ game, position: createVector(scene.size / 2, scene.size / 2) });
      this.size = scene.size;
      const art = new LaneArt(scene.geometry, scene.scale);
      this.tiles = new TileCache(
        scene.size,
        bakeWithin(scene.size, (ctx, tile) => art.bake(ctx, tile))
      );
    }

    draw(): void {
      // "Nền bản đồ: Đơn giản": core is drawing its solid walls, bushes and
      // water again, and all of this is decoration. Asked every frame, so the
      // setting changes the very next one; the tiles stay baked for the way back.
      if (api.render.plainGround(this.game)) return;
      const camera = (this.game as { camera?: unknown } | undefined)?.camera as
        | {
            getBoundingBox?: () => { x: number; y: number; w: number; h: number };
            currentScale?: number;
          }
        | undefined;
      // The camera only chooses *which* world tiles to blit. Nothing is baked
      // per camera position — `TileCache` keys on the world grid.
      const view = camera?.getBoundingBox?.() ?? { x: 0, y: 0, w: this.size, h: this.size };
      this.tiles.draw(drawingContext as CanvasRenderingContext2D, view, camera?.currentScale ?? 1);
    }

    /** Lets the tile canvases go, and stops listening to the page. */
    onRemoved(): void {
      this.tiles.destroy();
    }

    getDisplayBoundingBox() {
      return this.squareDisplayBoundingBox(this.size * 2);
    }
  };
}

/**
 * The slot factory: the painted ground for the map the slot names, or `null`
 * for a slot that names no map this pack has loaded.
 */
export default function makeScenery(api: ContentApi): SlotObjectFactory {
  const Scenery = build(api);
  return (slot, game) => {
    const key = (slot as ScenerySlot).art;
    const scene = key ? scenes.get(key) : undefined;
    return scene ? new Scenery(game, scene) : null;
  };
}
