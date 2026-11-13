import { Circle, Quadtree, Rectangle } from '@/libs/quadtree';
import NavGrid from '@/game/nav/NavGrid';
import CollideUtils from '@/utils/collide.utils';
import { hasFlag } from '@/utils/index';
import ActionState from '@/game/enums/ActionState';
import TerrainType from '@/game/enums/TerrainType';
import { PredefinedFilters } from '@/game/managers/ObjectManager';
import AttackableUnit from '@/game/gameObject/attackableUnits/AttackableUnit';
import Champion from '@/game/gameObject/attackableUnits/Champion';
import Minion from '@/game/gameObject/attackableUnits/Minion';
import Monster from '@/game/gameObject/attackableUnits/Monster';
import { PredefinedParticleSystems } from '@/game/gameObject/helpers/ParticleSystem';
import type { ActiveMap, TerrainZone } from '@/content/ContentPack';
import {
  resolveIce,
  resolveTerrainTuning,
  type ResolvedIce,
  type ResolvedTerrainTuning,
} from '@/game/config/mapTuning';
import Obstacle from './Obstacle';
import TerrainField from './TerrainField';

/** The three layers `ActiveMap.terrain` may carry, in the order they are read. */
const TERRAIN_LAYERS: readonly { key: 'wall' | 'bush' | 'water'; type: string }[] = [
  { key: 'wall', type: TerrainType.WALL },
  { key: 'bush', type: TerrainType.BUSH },
  { key: 'water', type: TerrainType.WATER },
];

/**
 * One polygon of one zone, with the box the zone quadtree indexes it by.
 *
 * Flattened per polygon rather than per zone because that is the granularity
 * a quadtree can prune at: a zone whose two patches sit in opposite corners
 * of the map has a bounding box covering the whole map, and indexing it that
 * way makes every query retrieve it.
 */
interface ZoneRegion {
  zone: TerrainZone;
  vertices: { x: number; y: number }[];
}

/**
 * The zone seam a pack goes through — see `TerrainZone`.
 *
 * Free functions taking `game`, the same shape `wallOutlinesInArea` already
 * publishes on `api.terrain`, because a spell holds a `game` and must not
 * reach for `game.terrainMap` itself: that field is undefined on a
 * `SpellWorld` built by `testing/spell`, so every pack that reached through
 * it would break in its own tests. Answering "no zones here" for a world
 * without a map is the honest answer and keeps a spell's zone check writable
 * before a map exists to run it on.
 */
export function zoneIdsAt(game: { terrainMap?: TerrainMap }, x: number, y: number): string[] {
  return game.terrainMap?.zoneIdsAt?.(x, y) ?? [];
}

export function inZone(
  game: { terrainMap?: TerrainMap },
  x: number,
  y: number,
  id: string
): boolean {
  return game.terrainMap?.inZone?.(x, y, id) ?? false;
}

export default class TerrainMap {
  game: any;
  size: number;
  obstacles: Obstacle[];
  rippleEffect: any;
  quadtree: Quadtree;
  /**
   * What each region layer does to movement, resolved once from the map.
   * `affectsSpeed` is false for every map that declares nothing, which is
   * what keeps `updateTerrainSpeed` from running at all.
   */
  readonly terrainSpeed: ResolvedTerrainTuning;

  /**
   * The map's zones, and a quadtree over them that is **not** `quadtree`.
   *
   * Kept apart deliberately, and this is the single most load-bearing
   * decision about zones. `FogOfWar`, `NavigationSystem` (via
   * `wallPolygons`) and `DynamicTerrain.wallOutlinesInArea` all read
   * `quadtree`; a zone arriving in it is a patch of sand that blocks sight,
   * or that pathfinding refuses to cross. It is the same reasoning
   * `DynamicTerrain` states for staying out of `getObstaclesInArea`, one
   * layer down.
   */
  readonly zones: readonly TerrainZone[];
  /** `MapSummary.paintsOwnTerrain`: the pack's scenery covers the obstacles. */
  readonly paintsOwnTerrain: boolean;
  /** `MapSummary.ice` resolved. See `IceTuning`. */
  readonly ice: ResolvedIce;
  /**
   * Whether any ground is icy at all: false for every map that declares
   * nothing, which is what keeps `updateIce` from running a single query.
   */
  readonly hasIce: boolean;
  private readonly zoneQuadtree: Quadtree | null;

  /**
   * @param map The active match's map, geometry already resolved. Required,
   *   not defaulted: `validate.ts` refuses a pack whose map has no size, so a
   *   `TerrainMap` built without one is a programming error to surface, not
   *   a `|| 6400` to paper over. See `GameScene.startGame()` for what
   *   guarantees the geometry is actually resolved by the time this runs.
   */
  constructor(game: any, map: ActiveMap) {
    this.game = game;
    this.size = map.size;
    this.paintsOwnTerrain = map.paintsOwnTerrain === true;
    this.obstacles = [];

    this.rippleEffect = PredefinedParticleSystems.ripple();

    this.quadtree = new Quadtree({
      x: 0,
      y: 0,
      w: this.size,
      h: this.size,
      maxObjects: 10,
      maxLevels: 6,
    });

    // The map's own vertices already arrive as `{x, y}` points — see
    // `MapGeometry.terrain` — so, unlike the old `AssetManager`-sourced
    // `number[][]` this replaced, they go straight into `Obstacle` with no
    // `arrayToVertices` conversion. Turret rows are not terrain and were
    // never read here — they arrive as `MapGeometry.slots.structure`
    // (Task 5), never mixed into this quadtree.
    for (const { key, type } of TERRAIN_LAYERS) {
      for (const vertices of map.terrain[key] ?? []) {
        const o = new Obstacle(0, 0, vertices, type);
        this.obstacles.push(o);
        this.quadtree.insert(o.getBoundingBox());
      }
    }

    this.zones = Object.freeze([...(map.zones ?? [])]);
    this.zoneQuadtree = this.zones.length === 0 ? null : this.buildZoneIndex();

    // Resolved *after* the zones, because a zone that changes speed has to
    // switch the per-frame pass on the same way a tuned river does — and
    // `resolveTerrainTuning` only ever sees `map.tuning`, which zones are
    // deliberately not part of (their multiplier lives on the zone itself).
    const tuned = resolveTerrainTuning(map.tuning);
    const zonesAffectSpeed = this.zones.some(
      zone => zone.speedMultiplier !== undefined && zone.speedMultiplier !== 1
    );
    this.terrainSpeed =
      zonesAffectSpeed && !tuned.affectsSpeed ? { ...tuned, affectsSpeed: true } : tuned;

    this.ice = resolveIce(map.ice);
    this.hasIce = this.ice.everywhere || this.zones.some(zone => zone.ice === true);
  }

  /** One quadtree over every polygon of every zone. See `zones`. */
  private buildZoneIndex(): Quadtree {
    const tree = new Quadtree({
      x: 0,
      y: 0,
      w: this.size,
      h: this.size,
      maxObjects: 10,
      maxLevels: 6,
    });
    for (const zone of this.zones) {
      for (const vertices of zone.polygons) {
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (const vertex of vertices) {
          if (vertex.x < minX) minX = vertex.x;
          if (vertex.x > maxX) maxX = vertex.x;
          if (vertex.y < minY) minY = vertex.y;
          if (vertex.y > maxY) maxY = vertex.y;
        }
        const region: ZoneRegion = { zone, vertices };
        tree.insert(
          new Rectangle({ x: minX, y: minY, w: maxX - minX, h: maxY - minY, data: region })
        );
      }
    }
    return tree;
  }

  /**
   * The ids of every zone covering a point, in the map's own declared order.
   *
   * Declared order rather than retrieval order because the quadtree's is an
   * implementation detail that changes with the tree's shape, and a pack
   * reading `zoneIdsAt(...)[0]` would silently depend on it.
   */
  zoneIdsAt(x: number, y: number): string[] {
    const found = this.zoneRegionsAt(x, y);
    if (found.length === 0) return [];
    const ids = new Set(found.map(region => region.zone.id));
    return this.zones.filter(zone => ids.has(zone.id)).map(zone => zone.id);
  }

  /** Whether a point is inside the named zone. An unknown id is simply a miss. */
  inZone(x: number, y: number, id: string): boolean {
    for (const region of this.zoneRegionsAt(x, y)) {
      if (region.zone.id === id) return true;
    }
    return false;
  }

  private zoneRegionsAt(x: number, y: number): ZoneRegion[] {
    if (!this.zoneQuadtree) return [];
    const found: ZoneRegion[] = [];
    for (const box of this.zoneQuadtree.retrieve(new Circle({ x, y, r: 1 }))) {
      const region = box.data as ZoneRegion;
      if (CollideUtils.pointPolygon(x, y, region.vertices)) found.push(region);
    }
    return found;
  }

  /**
   * The wall layer as world-space polygons, for the navigation grid to
   * rasterize. Obstacles are built at the origin with their vertices already in
   * world coordinates, so this is a view of the same objects the wall push-out
   * uses rather than a second parse of the map file — the two can never drift.
   */
  wallPolygons(): { x: number; y: number }[][] {
    const polygons: { x: number; y: number }[][] = [];
    for (const obstacle of this.obstacles) {
      if (obstacle.type !== TerrainType.WALL) continue;
      polygons.push(
        obstacle.vertices.map(vertex => ({
          x: obstacle.position.x + vertex.x,
          y: obstacle.position.y + vertex.y,
        }))
      );
    }
    return polygons;
  }

  /**
   * The same wall layer, straight off the map, with no `TerrainMap` to hold it.
   *
   * Every obstacle here is built at `(0, 0)` from `map.terrain` (see the
   * constructor), so the wall polygons are the map's own vertices and nothing
   * more — which is what lets the pregame screen build a navigation grid for a
   * map it has not started a match on. Written beside the instance method
   * rather than somewhere else, so the two cannot drift apart unnoticed.
   */
  static wallPolygonsOf(map: ActiveMap): { x: number; y: number }[][] {
    const wallKey = TERRAIN_LAYERS.find(layer => layer.type === TerrainType.WALL)?.key;
    if (!wallKey) return [];
    return (map.terrain[wallKey] ?? []).map(vertices =>
      vertices.map(vertex => ({ x: vertex.x, y: vertex.y }))
    );
  }

  update(): void {
    this.rippleEffect.update();

    const players = this.game.objectManager.queryObjects({
      queryByDisplayBoundingBox: true,
      filters: [PredefinedFilters.type(Champion)],
    });

    for (const p of players) {
      const obstacles = this.getObstaclesCollideChampion(p, [
        TerrainType.WALL,
        TerrainType.BUSH,
        TerrainType.WATER,
      ]);

      // Collide with bushes
      const bushes = obstacles.filter((o: Obstacle) => o.type === TerrainType.BUSH);
      let isInsideBush = false;
      for (const b of bushes) {
        const collided = CollideUtils.pointPolygon(p.position.x, p.position.y, b.vertices);
        if (collided) {
          isInsideBush = true;
          break;
        }
      }
      p.isInsideBush = isInsideBush;

      // Collide with waters => add ripple effect
      if (!p.isDead && frameCount % 45 === 0 && p.position.dist(p.destination) > 0) {
        const waters = obstacles.filter((o: Obstacle) => o.type === TerrainType.WATER);
        let isInsideWater = false;
        for (const w of waters) {
          const collided = CollideUtils.pointPolygon(p.position.x, p.position.y, w.vertices);
          if (collided) {
            isInsideWater = true;
            break;
          }
        }
        if (isInsideWater) {
          const vel = p.destination.copy().sub(p.position).setMag(0.9);
          this.rippleEffect.addParticle({
            x: p.position.x,
            y: p.position.y,
            vx: vel.x,
            vy: vel.y,
            r: random(5, 10),
            maxr: random(40, 80),
          });
        }
      }

      // Collide with walls
      this.pushOutOfWalls(p);
    }

    // Lane minions and jungle camps get the wall pass too, but nothing else in
    // the champion loop: no bush stealth, no water ripples, no vision.
    //
    // A minion's waypoints already keep it ~70px clear of every wall, so for
    // one of those this only matters when it steps off the lane to reach
    // something it aggroed — without it, that minion embeds itself in a wall
    // and never comes out.
    //
    // **A monster has no waypoints at all, and that is how it was missed.** A
    // camp walks a roam region the nav grid already keeps out of the rock, so
    // under its own power it never needs this — but it does not move only
    // under its own power. A hook, a knock-back or a kick puts it wherever the
    // displacement ends, and until this query included it, that could be
    // *inside* the wall: the body stopped there, the pass that would have
    // ejected it was for champions and minions, and it stood in the rock for
    // the rest of the match. Reported exactly that way.
    const walkers = this.game.objectManager.queryObjects({
      queryByDisplayBoundingBox: true,
      filters: [
        PredefinedFilters.includeTypes([Minion, Monster]),
        PredefinedFilters.excludeDead,
        // Scenery is left alone. A legless anchored boss re-pins itself to
        // `home` every tick (`Monster.update`), so pushing it is at best a
        // frame of disagreement with that and at worst two rules shoving one
        // body in opposite directions for the whole match. It also cannot be
        // displaced into a wall in the first place, which is the only way a
        // camp gets into one.
        (unit: AttackableUnit) =>
          !(unit instanceof Monster) || unit.hasLegs || !unit.isImmovable,
      ],
    });
    for (const m of walkers) this.pushOutOfWalls(m);

    this.updateTerrainSpeed();
    this.updateIce();
  }

  /**
   * Writes `terrainSpeedFactor` on every unit that can be slowed or hurried
   * by the ground it is standing on.
   *
   * **Returns immediately unless the map asked for it.** Terrain that changes
   * movement speed is a new mechanic, not an exposed constant: before it,
   * nothing on the map affected how fast anything moved. So a map that
   * declares no multiplier — every map written before this — pays one boolean
   * per frame and runs no query at all.
   *
   * Deliberately a *second* pass rather than folded into the champion loop
   * above. That loop owns `isInsideBush`, which is a vision flag read from
   * the player's eyes; widening it to minions and monsters to save a query
   * would put 160 lane minions into brush stealth as a side effect of a
   * movement feature.
   *
   * Units with no speed are skipped because there is nothing to modify — a
   * turret, or a boss that is scenery. Deliberately **not** `isImmovable`,
   * which it used to read: that flag means "nothing else may move this", and
   * a body can hold its ground against a hook while still walking under its
   * own power. Such a body does have a speed, and the river has to slow it.
   */
  updateTerrainSpeed(): void {
    if (!this.terrainSpeed.affectsSpeed) return;

    const units = this.game.objectManager.queryObjects({
      queryByDisplayBoundingBox: true,
      filters: [PredefinedFilters.type(AttackableUnit), PredefinedFilters.excludeDead],
    });
    for (const unit of units) {
      if (unit.stats.speed.value <= 0) continue;
      unit.terrainSpeedFactor = this.speedFactorAt(unit.position.x, unit.position.y);
    }
  }

  /**
   * Writes `onIce` on every unit that can walk. Returns at once on a map with
   * no ice (one boolean, no query), and `onIce` then stays false forever, so
   * `AttackableUnit.move()` never leaves its old code path.
   */
  updateIce(): void {
    if (!this.hasIce) return;
    const units = this.game.objectManager.queryObjects({
      queryByDisplayBoundingBox: true,
      filters: [PredefinedFilters.type(AttackableUnit), PredefinedFilters.excludeDead],
    });
    for (const unit of units) {
      if (unit.stats.speed.value <= 0) continue;
      unit.onIce = this.isIceAt(unit.position.x, unit.position.y);
    }
  }

  /** Whether a point is icy: the whole map, or inside any `ice: true` zone. */
  isIceAt(x: number, y: number): boolean {
    if (this.ice.everywhere) return true;
    for (const region of this.zoneRegionsAt(x, y)) {
      if (region.zone.ice === true) return true;
    }
    return false;
  }

  /**
   * The combined multiplier for a point.
   *
   * Overlapping layers **multiply**: a map that drew a bush in the river and
   * slowed both has said two things about that ground, and taking only one of
   * them would make which layer wins depend on the order they happen to be
   * read in. Each layer is only queried when its own multiplier is not 1, so
   * a map that tunes just the water never tests a bush polygon.
   */
  speedFactorAt(x: number, y: number): number {
    let factor = 1;
    if (this.terrainSpeed.bush !== 1 && this.containsPoint(x, y, TerrainType.BUSH)) {
      factor *= this.terrainSpeed.bush;
    }
    if (this.terrainSpeed.water !== 1 && this.containsPoint(x, y, TerrainType.WATER)) {
      factor *= this.terrainSpeed.water;
    }
    // Zones multiply in on the same terms, and a zone is queried at most once
    // per point: `zoneRegionsAt` is one retrieve, where the two layers above
    // are one each.
    if (this.zoneQuadtree) {
      const seen = new Set<string>();
      for (const region of this.zoneRegionsAt(x, y)) {
        const multiplier = region.zone.speedMultiplier;
        if (multiplier === undefined || multiplier === 1) continue;
        // A zone drawn as two overlapping patches is still one zone, and must
        // not slow twice where they meet.
        if (seen.has(region.zone.id)) continue;
        seen.add(region.zone.id);
        factor *= multiplier;
      }
    }
    return factor;
  }

  private _field: TerrainField | null = null;

  /**
   * The signed distance field over this map's walls — the seam anything that
   * reasons about terrain goes through. See `TerrainField` for why the
   * polygons themselves stopped being the answer.
   *
   * Built lazily so a `TerrainMap` standing on its own still works; in a real
   * match `Game` hands over the grid navigation has already built, through
   * `useNavGrid`, and this never fires.
   */
  get field(): TerrainField {
    if (!this._field) {
      this._field = new TerrainField(
        this.game,
        NavGrid.fromPolygons(this.wallPolygons(), { size: this.size })
      );
    }
    return this._field;
  }

  /**
   * Adopts the navigation grid as the terrain field, so a match holds one and
   * not two.
   *
   * They would be identical anyway — same polygons, same cell size — but "would
   * be identical" is what the old arrangement claimed, where routes were
   * planned against the grid and enforced against the SAT polygons.
   */
  useNavGrid(grid: NavGrid): void {
    this._field = new TerrainField(this.game, grid);
  }

  /**
   * Moves `unit` out of any static wall it overlaps. Shared by champions and
   * minions.
   *
   * One field read and one gradient. This used to ask every convex piece of
   * every nearby wall for its own minimum translation vector and average them,
   * which is why a body could end up welded into a wall: the pieces of a split
   * slab push in opposing directions and the average is zero. `TerrainField`
   * carries the measurement.
   */
  pushOutOfWalls(unit: AttackableUnit): void {
    if (hasFlag(unit.stats.actionState, ActionState.IS_GHOSTED)) return;

    // `terrainRadius`, not the drawn body: it is capped for a grown unit so a
    // giant keeps fitting through the map's gaps, and it must be the same
    // radius `PathAgent` planned the route with — a route planned at one radius
    // and enforced at a larger one is a unit walking into a wall it was told it
    // could pass. See NAV_MAX_TERRAIN_RADIUS.
    const resolved = this.field.resolveStatic(unit.position.x, unit.position.y, unit.terrainRadius);
    if (!resolved) return;

    unit.position.x = resolved.x;
    unit.position.y = resolved.y;
    unit.onCollideWall?.();
  }

  /**
   * Reused across frames: the three buckets below are rebuilt every frame at
   * 60fps and their contents never outlive the call.
   */
  private _waters: Obstacle[] = [];
  private _walls: Obstacle[] = [];
  private _bushes: Obstacle[] = [];

  draw(): void {
    if (this.paintsOwnTerrain) {
      // The pack paints the obstacles; zones are still core's to draw.
      this.drawZones();
      return;
    }
    push();
    const obstacles = this.getObstaclesInView();

    // One pass into three reused buckets, rather than three `filter` calls
    // walking the whole list and allocating a fresh array each. Order within a
    // bucket is the order they came out of the quadtree, exactly as before.
    const waters = this._waters;
    const walls = this._walls;
    const bushes = this._bushes;
    waters.length = 0;
    walls.length = 0;
    bushes.length = 0;
    for (const o of obstacles) {
      if (o.type === TerrainType.WATER) waters.push(o);
      else if (o.type === TerrainType.WALL) walls.push(o);
      else if (o.type === TerrainType.BUSH) bushes.push(o);
    }

    // Zones go down first, underneath everything. They are ground, not
    // objects standing on it: a river drawn over a desert should read as a
    // river, and a bush inside a mist bank must still look like a bush.
    this.drawZones();

    // The paint order — water, ripples, bushes, walls — is what it always was;
    // only the style setting moved out of the loop. Each group keeps its own
    // push/pop so `rippleEffect.draw()` still runs in the environment it used
    // to, rather than inheriting whatever colour the water left behind.
    this.drawObstacleGroup(waters, TerrainType.WATER);
    this.rippleEffect.draw();

    this.drawObstacleGroup(bushes, TerrainType.BUSH);
    this.drawObstacleGroup(walls, TerrainType.WALL);
    pop();
  }

  /**
   * Paints every zone polygon in view, one style per zone.
   *
   * Grouped by zone for the same reason `Obstacle.applyStyle` was lifted out
   * of the per-obstacle loop: `fill('#d9c08a')` is not an assignment but a
   * `p5.Color` construction — it parses the CSS string, allocates the level
   * arrays and serialises back to `rgba(...)` — and a profile of a worst-case
   * mobile frame named that path as ~3% of the whole frame. A zone's colours
   * never change, so setting them once per zone rather than once per polygon
   * is free.
   */
  private drawZones(): void {
    if (!this.zoneQuadtree) return;
    const area = this.game.camera.getBoundingBox();
    const byZone = new Map<string, ZoneRegion[]>();
    for (const box of this.zoneQuadtree.retrieve(area)) {
      const region = box.data as ZoneRegion;
      const bucket = byZone.get(region.zone.id);
      if (bucket) bucket.push(region);
      else byZone.set(region.zone.id, [region]);
    }
    if (byZone.size === 0) return;

    // Declared order, not retrieval order — two overlapping zones must stack
    // the way the map drew them rather than the way the tree happened to
    // return them, which changes with the tree's shape.
    for (const zone of this.zones) {
      const regions = byZone.get(zone.id);
      if (!regions) continue;
      push();
      noStroke();
      if (zone.render.stroke) {
        stroke(zone.render.stroke);
        strokeWeight(4);
      }
      fill(zone.render.fill);
      for (const region of regions) {
        beginShape();
        // `point`, not `vertex`: the loop variable would shadow p5's global
        // `vertex()` — the very function this line has to call.
        for (const point of region.vertices) vertex(point.x, point.y);
        endShape(CLOSE);
      }
      pop();
    }
  }

  private drawObstacleGroup(group: Obstacle[], type: string): void {
    if (group.length === 0) return;
    push();
    Obstacle.applyStyle(type);
    for (const o of group) o.drawShape();
    pop();
  }

  drawEdges(): void {
    push();
    stroke('white');
    strokeWeight(3);
    line(0, 0, this.size, 0);
    line(this.size, 0, this.size, this.size);
    line(this.size, this.size, 0, this.size);
    line(0, this.size, 0, 0);
    pop();
  }

  /**
   * Hand-rolled rather than `retrieve().map().filter()`, for the reason
   * `ObjectManager.queryObjects` gives for the same shape: the chain allocated
   * two whole arrays per call to hand back a list the caller almost always just
   * iterates, and this is called around seventy-seven times a *frame* — every
   * fog observer, every champion's wall check, every line-of-sight test. Same
   * result, same order, one array.
   */
  getObstaclesInArea(area: Rectangle | Circle, terrainTypes: string[] = []): Obstacle[] {
    const regions = this.quadtree.retrieve(area);
    const filtered = terrainTypes.length > 0;
    const obstacles: Obstacle[] = [];
    for (let i = 0; i < regions.length; i++) {
      const obstacle = regions[i].data as Obstacle;
      if (!filtered || terrainTypes.includes(obstacle.type)) obstacles.push(obstacle);
    }
    return obstacles;
  }

  getObstaclesInView(terrainTypes?: string[]): Obstacle[] {
    const area = this.game.camera.getBoundingBox();
    return this.getObstaclesInArea(area, terrainTypes ?? []);
  }

  getObstaclesCollideChampion(champion: Champion, terrainTypes: string[]): Obstacle[] {
    const area = champion.getCollideBoundingBox();
    return this.getObstaclesInArea(area, terrainTypes);
  }

  /**
   * Whether a world point is inside a given terrain layer.
   *
   * The layers other than `wall` are *regions*, not obstacles — nothing
   * collides with a bush — and until now the only way to ask about one was to
   * repeat the retrieve-then-`pointPolygon` pair that `update()` does inline
   * for the champion pass. A camp that has to stay in the river is the second
   * caller, so the pair becomes a method rather than a second copy.
   *
   * A 1px query circle rather than the bare point: `Quadtree.retrieve` takes
   * an area, and a zero-sized one sits exactly on cell boundaries, where which
   * cell it lands in is a rounding question. One pixel of slop costs nothing —
   * the answer is decided by `pointPolygon` on the real vertices afterwards,
   * not by which cells came back.
   *
   * Obstacle vertices are already in world space (see the constructor: every
   * `Obstacle` is built at the origin), which is why there is no position
   * offset here and none in `update()` either.
   */
  containsPoint(x: number, y: number, terrainType: string): boolean {
    const area = new Circle({ x, y, r: 1 });
    for (const obstacle of this.getObstaclesInArea(area, [terrainType])) {
      if (CollideUtils.pointPolygon(x, y, obstacle.vertices)) return true;
    }
    return false;
  }

  /**
   * `radius` overrides what the unit sees for itself. A minion or a turret has
   * `visionRadius = 0` on purpose — no combat sight — yet still grants the team
   * a circle through `fogRevealRadius`, and the fog casts a polygon inside that
   * circle. Without the override this query would come back empty for exactly
   * those units, so their fog would ignore every wall on the map.
   */
  getObstaclesInChampionSight(champion: any, terrainTypes?: string[], radius?: number): Obstacle[] {
    const area = new Circle({
      x: champion.position.x,
      y: champion.position.y,
      r: radius ?? (champion.animatedValues?.visionRadius || champion.visionRadius),
    });
    return this.getObstaclesInArea(area, terrainTypes ?? []);
  }
}
