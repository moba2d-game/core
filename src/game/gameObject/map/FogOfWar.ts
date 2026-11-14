import PolyVisibility from '@/libs/poly-visibility';
import TerrainType from '@/game/enums/TerrainType';
import CollideUtils from '@/utils/collide.utils';
import AttackableUnit from '@/game/gameObject/attackableUnits/AttackableUnit';
import { PredefinedFilters } from '@/game/managers/ObjectManager';
import { Circle } from '@/libs/quadtree';
import { removeGraphics } from '@/utils/graphics.utils';
import { hasLineOfSight } from '@/game/combat/Vision';
import { stressTier } from '@/game/render/renderStress';
import { revealedTo } from '@/game/combat/AttackReveal';
import { resolveVisionTuning } from '@/game/config/mapTuning';
import { prepareSight, sightContains } from './sightContainment';

// The fog polygon is recomputed at the unit's live position every frame — no
// throttle, no interpolation — so the gradient (drawn every frame at the
// unit's live screen position, see drawVisions/prepareRadialGradient) and the
// polygon never drift apart. That's affordable because computeSightPoly's
// cost splits cleanly in two:
//   1. which obstacles are in vision range, and the broken (non-intersecting)
//      segment list built from them — this is the O(n^2) part
//      (PolyVisibility.breakIntersections) — only changes when the unit
//      crosses into a new neighbourhood of walls/bushes, so it's cached per
//      unit (see SightCacheEntry.segments/obstacleSignature) and reused
//      across frames until that set turns over;
//   2. the radial sweep against the exact source point
//      (PolyVisibility.computeViewport) depends on the unit's live position
//      and must run every frame for the fog to track it smoothly — it's the
//      O(n) part, and it's what actually runs unconditionally below.
// A unit that hasn't moved at all since last frame (exact position/radius
// equality) skips both and returns last frame's polygon outright, so a
// standing unit — every turret, all match long — still costs nothing.
//
// Every revealer casts one of these polygons, champion or not. Minions and
// turrets were painted as plain discs for a long time on the grounds that an
// ally swarm should cost a fill each rather than a raycast each — and the disc
// reached straight through walls and bushes, so a lane's fog looked as if the
// wave could see into the jungle while `combat/Vision.ts` had already decided
// it could not. Two things pay for the polygons instead: only revealers *near
// the camera* get one at all (see calculateSight), and a granted revealer's
// "hasn't moved" test carries a tolerance rather than demanding exact equality
// (GRANTED_SIGHT_TOLERANCE_PX), because nobody is steering a minion's fog.
type SightSegment = [number, number][];

/**
 * Soft-edge width, in world px, of the fade at the rim of a revealer's hole.
 *
 * A champion's own sight ends sharply; a granted circle — what a minion or a
 * turret lends the team — fades over twice the distance, which is what has
 * always made an ally swarm read as a soft wash rather than as a row of discs.
 * Both numbers predate the polygons and are kept exactly as they were.
 */
const OWN_SIGHT_RING_PX = 50;
const GRANTED_SIGHT_RING_PX = 100;

/**
 * How far a *granted* revealer may drift from the position its polygon was
 * cast at before the polygon is recast.
 *
 * The player's own champions recast every frame (tolerance 0) because the fog
 * has to track the thing the player is steering. A minion's circle is
 * peripheral: it walks ~2.6px per frame, so 12px is one recast every five
 * frames and cuts the sweep cost of a full wave by the same factor. Nothing
 * shows, because the drift lands inside a 100px fade — but only as long as
 * `computeSightPoly` widens its clip box by the same amount, or the box's
 * straight edge would slide in under the gradient and draw a faint seam. It
 * does; see the `boxRadius` line there.
 */
const GRANTED_SIGHT_TOLERANCE_PX = 12;

/**
 * How many simulation ticks one sight pass is allowed to stand for.
 *
 * `ObjectManager.revision` is bumped once per tick, so the pass used to run
 * once per tick — and since a machine draws at roughly its tick rate, that
 * meant once per frame. Measured at 10x CPU throttle with 200 minions on the
 * board, `calculateSight` was 2.1ms of an 8.0ms frame: after the fog's own
 * painting, the most expensive thing the renderer did.
 *
 * Two, i.e. 30Hz, is the whole change. It is not a guess about what is
 * imperceptible — the *painting* still runs every frame, and the polygons it
 * paints are in world space, so nothing on screen goes stale when the camera
 * moves. What is held for one extra tick is where the revealers were, and one
 * tick of champion movement is under 8px on a 6400px map, drawn through a
 * gradient rim over a hundred pixels wide.
 *
 * Raising it further is not free in the way this step was: past about four
 * ticks a dash starts to visibly drag its own fog behind it.
 */
export const FOG_SIGHT_TICK_INTERVAL = 2;

/**
 * **Raising this under stress was tried, measured, and reverted.** Four ticks
 * on the deep stress rung is the obvious next move — the note above even names
 * four as where the wall is — and the arithmetic for it is sound: the sight
 * pass caches on `ObjectManager.revision`, a drowning machine runs about 1.6
 * ticks per drawn frame, so doubling the interval should take the recompute
 * rate from roughly 0.64 per frame to 0.24.
 *
 * It did not measure that way. Same board, same throttle: `calculateSight`'s
 * total went **4.6ms -> 8.6ms per frame** and `computeSightPoly` ran *more*
 * often per frame, not less. The likely reason is that the count is dominated
 * by the ungated `getSightPoly` calls that granted sight makes when a turret or
 * a minion attacks (`GRANTED_SIGHT_TOLERANCE_PX` below), which the tick
 * interval does not gate at all — so the interval is simply not the lever it
 * looks like, and holding sight staler made the per-unit position cache miss
 * more.
 *
 * Do not re-try it without first measuring where `computeSightPoly` is called
 * from. Left as a comment rather than as code, because this is the second most
 * expensive subsystem in the frame and it will look like an easy win again.
 */

/**
 * Slack on the "is this revealer worth painting" camera test, in world px.
 *
 * The pass used to re-run whenever the camera box changed by any amount, so
 * "on camera" could be answered exactly. It no longer does, so the answer has
 * to hold for `FOG_SIGHT_TICK_INTERVAL` ticks of panning.
 *
 * Sized to what a camera can actually travel in that time and no further. The
 * first attempt at this used 256px on the reasoning that slack is cheap, and it
 * measured the whole point of the change away: minions queue in lanes just off
 * screen, so a margin that generous nearly tripled the polygons cast per pass —
 * from about ten to about twenty-eight — and the fog cost exactly what it had
 * before. A camera follows a champion, the fastest of whom covers well under
 * 10px in a tick, so 48 is already several times the worst case.
 */
const SIGHT_CAMERA_MARGIN_PX = 48;

/**
 * How far an object lights fog. AttackableUnits carry the `fogRevealRadius`
 * getter (minions and turrets have no combat sight — visionRadius 0 — but
 * still light a circle for the team). A spell-made eye — a pack's ward, a
 * plain SpellObject with a bare `visionRadius` — carries no such getter, and
 * `undefined > 0` silently dropped it from the whole sight pass: the one seam
 * `combat/Vision.ts` promises works for wards lit nothing on screen.
 */
const fogRevealOf = (o: any): number =>
  typeof o.fogRevealRadius === 'number' ? o.fogRevealRadius : (o.visionRadius ?? 0);

interface SightCacheEntry {
  sightPoly: { x: number; y: number }[];
  x: number;
  y: number;
  /** The reveal radius the polygon was cast at — not necessarily combat sight. */
  radius: number;
  // Broken segment list for the obstacles currently in range. Obstacle
  // vertices are static world coordinates, so this depends only on *which*
  // obstacles are selected, never on the unit's exact position — see
  // buildSegments/obstacleSignature.
  segments: SightSegment[];
  // Fingerprint of the obstacle set `segments` was built from: sorted
  // obstacle ids, after the "bush I'm standing in" filter. A bush
  // entering/leaving containment changes which ids survive that filter, so
  // it doesn't need its own field here — it already changes this string.
  obstacleSignature: string;
}

/** One lit disc for the minimap. Structurally `Minimap`'s own `VisionCircle`. */
export type MinimapVisionCircle = { x: number; y: number; r: number };

type SightResult = {
  object: any;
  sightPoly: { x: number; y: number }[];
  /** What the gradient is sized to: the reveal radius, never combat sight. */
  radius: number;
  /** Width of the soft rim, in world px. */
  ring: number;
};

/** A granted eye — a minion, a turret — and the circle it lends the team. */
type RevealCircle = { source: any; x: number; y: number; r: number };

export default class FogOfWar {
  game: any;
  overlay: any;
  outOfViewColor: string;
  colorStops: { stop: number; color: string }[];

  // Keyed by the unit object itself (position is mutated in place, never
  // reassigned, so identity is a stable cache key). A WeakMap means dead units
  // that get dereferenced elsewhere (removed from ObjectManager.objects) fall
  // out of this cache for free once GC'd — nothing here can leak.
  sightCache: WeakMap<any, SightCacheEntry>;
  // CanvasGradient objects are reused across units/frames by bucketing on the
  // (innerR, radius) pair that defines their stops; screen position is applied
  // separately via context translate (see prepareRadialGradient).
  gradientCache: Map<string, CanvasGradient>;
  lastSightCalculation?: {
    /** The tick this answer was computed on — see `FOG_SIGHT_TICK_INTERVAL`. */
    revision: number;
    result: SightResult[];
  };

  /** See `visionCircles()`. Rebuilt by every sight pass, read by the minimap. */
  private mapVisionCircles: MinimapVisionCircle[] = [];

  constructor(game: any) {
    this.game = game;
    this.overlay = createGraphics(windowWidth, windowHeight);
    // Pinned, not inherited. The overlay is a full-viewport buffer that is
    // cleared and repainted every frame, so its backing store is the single
    // largest per-frame cost in the fog. p5.Graphics takes its density from the
    // sketch, and the sketch's own `pixelDensity(1)` is set in GameScene.enter
    // — one line away from here, in another file, and nothing fails loudly if
    // it moves. On a 3x phone an inherited density would be a 9x buffer: a
    // 900x400 viewport becomes 2700x1200, ten million pixels cleared and
    // composited per frame for a translucent black shape with soft edges that
    // nobody can see the resolution of.
    // 1 is also the floor, which is not obvious: going *below* screen
    // resolution is slower, not faster. A CPU profile charges 82% of every
    // drawImage in the game to the `image()` call at the end of draw(), so a
    // quarter-area buffer looks like an easy win — but it turns that blit from
    // a 1:1 copy into a scaled resample of every destination pixel, and a
    // 422x195 overlay measured 4.61ms per frame against 2.09ms at 844x390.
    // (Measured under software rasterisation; a GPU-composited canvas may
    // trade differently, so re-measure on a device before revisiting.)
    this.overlay.pixelDensity(1);
    // `rgba()` và **không** phải `#0007`.
    //
    // Cả hai nhánh fog gán chuỗi này thẳng vào `drawingContext.fillStyle`, tức
    // là bộ phân tích màu của canvas chứ không phải của p5. Hex bốn chữ số
    // (`#RGBA`) là cú pháp mới hơn hẳn `rgba()`, và theo spec một giá trị
    // `fillStyle` không phân tích được **không báo lỗi**: phép gán bị bỏ qua
    // và fillStyle giữ nguyên giá trị *trước đó* — trong một vòng lặp game đó
    // là màu của thứ vừa vẽ xong, thường là màu sáng. Fog sẽ được tô sáng thay
    // vì tối, đổi theo từng khung hình, ở cả nhánh mềm lẫn nhánh cứng.
    //
    // Không có gì đánh đổi ở đây: `rgba()` được mọi bản canvas từng phân tích
    // đúng, và đây là một chuỗi hằng viết một lần.
    this.outOfViewColor = 'rgba(0, 0, 0, 0.47)';

    this.colorStops = [
      { stop: 0, color: '#fff' },
      { stop: 1, color: '#0000' },
    ];

    this.sightCache = new WeakMap();
    this.gradientCache = new Map();
  }

  draw(): void {
    // The Cài đặt tab's "hiện bản đồ", answered before either painting path
    // because it is the same answer for both.
    //
    // The sight pass still runs, and that is the whole subtlety: it is the
    // only writer of `visibleToPlayerTeam` (see `calculateSight`), so a bare
    // `return` here would freeze every unit at whatever the last painted frame
    // decided — the cheat would lift the veil and leave the units under it
    // hidden, which is the opposite of what it is for. Skipping the *painting*
    // is strictly less work than doing it: a full-viewport fill on this tier,
    // three viewport passes and the blit on the other.
    if (this.revealsEverything()) {
      this.calculateSight();
      return;
    }
    // The stressed tier's fog: one pass on the main canvas, no overlay at all.
    if (this.hardEdged()) {
      this.drawDirect();
      return;
    }
    // clear() (clearRect) followed by background() (a normal-blend fillRect)
    // is two full-canvas passes to reach the same result as one: painting with
    // 'copy' compositing discards the destination outright, same as clearing
    // to transparent first — but in a single fillRect.
    const ctx = this.overlay.drawingContext;
    ctx.save();
    this.overlay.resetMatrix();
    ctx.globalCompositeOperation = 'copy';
    ctx.fillStyle = this.outOfViewColor;
    ctx.fillRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.restore();

    this.overlay.erase();
    this.overlay.noStroke();
    this.drawVisions();
    this.overlay.noErase();

    image(this.overlay, width / 2, height / 2, width, height);
  }

  /**
   * Whether the fog gives up its soft edge for a cheaper frame: the player
   * chose Thấp, or `auto` has found the machine not keeping up
   * (`render/renderStress.ts`). Read per frame, so the picture recovers the
   * moment the stress does.
   */
  hardEdged(): boolean {
    return this.stressTier() >= 1;
  }

  /**
   * How much this fog may give up — the player's choice and the measurement
   * together. See `render/renderStress.ts`; the rule lives there so that the
   * fog, the draw pass, the minimap and the combat text cannot drift apart on
   * what Cao and Thấp mean.
   */
  private stressTier(): 0 | 1 | 2 {
    return stressTier(this.game.renderQuality, this.game.renderStressed, this.game.deeplyStressed);
  }

  /**
   * Whether this match is being played with the fog off — the practice panel's
   * `revealMap`.
   *
   * `Game.minimapBlips` and `minimapHost.visionCircles` have honoured it since
   * it existed and the main view never did, so the cheat used to lift the veil
   * off the *minimap* and leave the screen it is a map of fogged. Read per
   * frame, like `hardEdged`, so the picture follows the switch.
   *
   * Optional chaining because `game` is a structural surface here: the sight
   * suites build one by hand and none of them has a director.
   */
  revealsEverything(): boolean {
    return this.game.director?.revealMap === true;
  }

  /**
   * The fog without the buffer: one fill on the main canvas, the viewport
   * with every sight polygon cut out of it, hard-edged.
   *
   * The soft path is three full-viewport passes — a `copy` fill of the
   * overlay, an `erase` of every polygon, and the `image()` blit back — and a
   * CPU profile charged 82% of every `drawImage` in the game to that blit.
   * The constructor records why a smaller overlay is not the answer (a
   * resample is slower than a copy). This is: no overlay at all, so one pass
   * where there were three, at the price of the gradient rim — which is why
   * it is the stressed tier's picture and not everyone's.
   *
   * ## One clip per hole, not one path with every hole in it
   *
   * This used to build a single path — the viewport rectangle, then every
   * sight polygon wound the other way — and fill it `nonzero`, on the written
   * argument that the rule "leaves the union of the holes clear however many
   * of them overlap". **That argument is wrong, and it is the bug this path
   * shipped with.** A winding number is arithmetic, not a union: a point
   * inside the rectangle and inside *one* hole scores `+1 - 1 = 0` and is
   * left clear, and a point inside *two* scores `+1 - 1 - 1 = -1`, which is
   * not zero, so it is painted. Wherever two allies' vision overlapped — a
   * champion beside its own turret, anything at all near the fountain — the
   * fog came back, hard-edged, in the exact shape of the intersection.
   * Even-odd does the same thing one crossing later; no fill rule turns N
   * overlapping subpaths into their union.
   *
   * So the subtraction happens in the clip stack instead, where intersection
   * is what the operation *means*. Holes are grouped so that nothing in a
   * group overlaps anything else in it — the winding argument *is* sound for
   * disjoint holes — and each group clips to "the viewport minus these holes".
   * `ctx.clip` intersects those regions for us, and the intersection of every
   * complement is the complement of the union, which is the region the fog
   * belongs in. A frame whose revealers are spread out is one group: one
   * rectangle, one clip, one fill, the same work the broken version did. Only
   * a cluster standing on top of itself pays a clip per hole.
   *
   * `PolyVisibility`'s sweep does not promise an orientation, so each
   * polygon's is measured (`signedArea`) and reversed when it matches the
   * rectangle's.
   *
   * ## Why the polygon is cut to a circle first
   *
   * `computeSightPoly` clips its sweep to a **square** box reaching `radius`
   * out on every side (see `boxRadius` there), so the polygon it returns runs
   * to `1.41 × radius` in its own corners. The soft path never shows that: its gradient is
   * fully transparent past `radius`, so the corners erase nothing. This path
   * has no gradient — it would cut the corners out at full strength, and every
   * revealer's hole would be a square with straight edges slicing across its
   * neighbours. `clipPolygonToCircle` puts the rim back where the soft path
   * draws it. Done here rather than in `computeSightPoly` so the soft path's
   * geometry is untouched — it pays no vertices for a rim it already fades.
   */
  drawDirect(): void {
    const ctx = drawingContext as CanvasRenderingContext2D;
    const camera = this.game.camera;
    const sights = this.calculateSight();

    ctx.save();

    const rectSign = Math.sign(
      signedArea([
        { x: 0, y: 0 },
        { x: width, y: 0 },
        { x: width, y: height },
        { x: 0, y: height },
      ])
    );

    const viewport: Bounds = { minX: 0, minY: 0, maxX: width, maxY: height };
    const cuts: { points: { x: number; y: number }[]; box: Bounds }[] = [];

    for (const { object, sightPoly, radius } of sights) {
      if (sightPoly.length < 3) continue;
      const screen: { x: number; y: number }[] = [];
      for (const v of sightPoly) {
        const p = camera.worldToScreen(v.x, v.y);
        screen.push({ x: p.x, y: p.y });
      }
      // Wound against the rectangle before the cut, so the rim the cut inserts
      // runs the same way the edges around it do.
      if (Math.sign(signedArea(screen)) === rectSign) screen.reverse();

      // The live position and `currentScale`, exactly as `prepareRadialGradient`
      // reads them — the hole has to land where the soft path would have drawn
      // its rim, not where the polygon happened to be cast.
      const centre = camera.worldToScreen(object.position.x, object.position.y);
      const points = clipPolygonToCircle(screen, centre.x, centre.y, radius * camera.currentScale);
      if (points.length < 3) continue;
      const box = boundsOf(points);
      // A hole with nothing on screen would clip the viewport to itself: no
      // change, one clip's worth of work. The sight pass is already camera
      // limited, but its margin is world px and this is the cheap exact test.
      if (!boundsOverlap(box, viewport)) continue;
      cuts.push({ points, box });
    }

    // Only holes that actually overlap each other need clips of their own.
    //
    // The winding rule states "the viewport minus these holes" correctly for
    // any number of holes that are pairwise **disjoint** — every point is
    // inside at most one of them, so the arithmetic cancels exactly once. It
    // is only the overlap that breaks it. So holes are packed greedily into
    // groups nobody in the group touches, and each group is one clip: the
    // ordinary frame — revealers spread across a lane — is back to one
    // rectangle, one clip and one fill, and only a cluster standing on top of
    // itself pays per hole. Bounding boxes, not the polygons: a box overlap
    // that is not a real one costs one extra clip, while a missed one would
    // cost the bug.
    const groups: { points: { x: number; y: number }[]; box: Bounds }[][] = [];
    for (const cut of cuts) {
      const room = groups.find(group => group.every(other => !boundsOverlap(other.box, cut.box)));
      if (room) room.push(cut);
      else groups.push([cut]);
    }

    for (const group of groups) {
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      for (const { points } of group) {
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.closePath();
      }
      ctx.clip('nonzero');
    }

    ctx.fillStyle = this.outOfViewColor;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  calculateSight(): SightResult[] {
    const { x, y, w, h } = this.game.camera.getBoundingBox();
    const revision = this.game.objectManager.revision;
    const cached = this.lastSightCalculation;
    // Held for a fixed number of ticks (`FOG_SIGHT_TICK_INTERVAL`), never for a
    // camera that happens not to have moved. The camera used to be half the
    // key, which sounds right and measured at a 19% hit rate: a player who is
    // walking moves the camera every frame, and a player who is walking is
    // exactly when the fog costs the most. `>= 0` so a new match — whose
    // revision counts from zero again — does not read the old one's answer.
    if (
      typeof revision === 'number' &&
      cached !== undefined &&
      revision - cached.revision >= 0 &&
      revision - cached.revision < FOG_SIGHT_TICK_INTERVAL
    ) {
      return cached.result;
    }

    // Deliberately NOT narrowed to the camera.
    //
    // What the team can see and what is worth painting are two questions, and
    // this pass answers both. The overlay only ever needs revealers near the
    // camera — there is no point erasing fog off screen — but this is also the
    // only writer of `visibleToPlayerTeam`, which `Game.minimapBlips` reads to
    // decide whether a unit gets a dot, and the minimap draws the whole map. So
    // the camera test used to delete allied minions, wards and champions from
    // the minimap the moment the player walked away from them, along with
    // everything they were lighting: the team held the vision and the map would
    // not show it. Turrets and fountains hid the bug, being structures that
    // `minimapBlips` draws without consulting the flag at all.
    //
    // The narrowing moved down to the two lists below, where it belongs.
    const allyObjects = this.game.objectManager.queryObjects({
      queryByDisplayBoundingBox: true,
      filters: [
        PredefinedFilters.teamId(this.game.player.teamId),
        (o: any) => {
          if (o === this.game.player) return true;
          if (PredefinedFilters.includeDead(o)) return false;
          return fogRevealOf(o) > 0;
        },
      ],
    });

    const allSightPoly: SightResult[] = [];
    const visiblePlayers: any[] = [];
    /**
     * Every allied lit disc on the map, champions included — the minimap's
     * copy of the fog. Built here rather than by a second walk of its own: this
     * pass already holds the ally list, and it is the only thing on the frame
     * that knows what a revealer's radius currently is.
     *
     * Deliberately *not* `allSightPoly`: that is narrowed to the camera, and a
     * map whose whole point is showing the other side of the map cannot be
     * drawn from a list of what is on screen.
     */
    const mapVision: MinimapVisionCircle[] = [];
    /** Every allied granted circle on the map — what `visibleToPlayerTeam` is computed from. */
    const revealCircles: RevealCircle[] = [];
    // Widened: this answer now stands for more than one tick. See
    // `SIGHT_CAMERA_MARGIN_PX`.
    const nearCamera = (ox: number, oy: number, r: number) =>
      CollideUtils.circleRect(
        ox,
        oy,
        r,
        x - SIGHT_CAMERA_MARGIN_PX,
        y - SIGHT_CAMERA_MARGIN_PX,
        w + SIGHT_CAMERA_MARGIN_PX * 2,
        h + SIGHT_CAMERA_MARGIN_PX * 2
      );

    allyObjects.forEach((obj: any) => {
      const radius = fogRevealOf(obj);
      if (radius > 0) {
        mapVision.push({ x: obj.position.x, y: obj.position.y, r: radius });
      }
      if (obj.visionRadius > 0) {
        // Player and allied champions: the real, wall-aware sight polygon. Run
        // for all of them rather than the on-camera ones — a team fields at most
        // a handful of champions, and an ally's sight has to keep revealing for
        // the minimap while the player is looking somewhere else.
        const { sightPoly, playersInSight } = this.calculateSightForObject(obj);
        visiblePlayers.push(...playersInSight);
        if (nearCamera(obj.position.x, obj.position.y, radius)) {
          allSightPoly.push({ object: obj, sightPoly, radius, ring: OWN_SIGHT_RING_PX });
        }
      } else {
        // A minion or turret. Its circle is *granted* sight — the unit has no
        // combat sight of its own — but it obeys the same walls a champion's
        // does. It was painted as a plain disc for a long time, and the disc
        // reached straight through walls and bushes: the fog on a lane read as
        // if the wave could see into the jungle, while `combat/Vision.ts` had
        // already decided (correctly) that it could not, so an enemy sitting
        // in that lit-through wall was on screen and unclickable.
        //
        // `revealer`, not `circle`: `circle` is a p5 global. See CLAUDE.md.
        const revealer: RevealCircle = {
          source: obj,
          x: obj.position.x,
          y: obj.position.y,
          r: radius,
        };
        revealCircles.push(revealer);
        // The polygon is what costs, so only what is on screen pays for one.
        // Off camera there is no fog to erase, and the visibility half below
        // answers walls with a line-of-sight test that needs no polygon.
        //
        // `radius > 0` is not redundant with the ally filter: the player is
        // force-included there whatever it lights, and its `visionRadius` is
        // the *animated* one — 0 until `draw()` has lerped it up, and 0 for
        // every champion in a headless test. A zero-radius revealer paints
        // nothing, so casting a polygon for it is pure cost.
        if (radius > 0 && nearCamera(revealer.x, revealer.y, revealer.r)) {
          allSightPoly.push({
            object: obj,
            sightPoly: this.getSightPoly(obj, radius, GRANTED_SIGHT_TOLERANCE_PX),
            radius,
            ring: GRANTED_SIGHT_RING_PX,
          });
        }
      }
    });

    // Reset the player's-eye visibility flag on every AttackableUnit, then
    // re-light the ones in sight. Structures opt out — once built they stay on
    // the map, and the update loop is not in lockstep with draw, so re-enabling
    // them from their own update() would flicker.
    //
    // This flag is the *only* thing the sight pass writes outside itself, and
    // it feeds rendering alone — see `AttackableUnit.visibleToPlayerTeam`. That
    // is what keeps the painting side of the fog separable from the game: what
    // a unit may target is `combat/Vision.ts`'s answer, per observer, never
    // this one.
    //
    // The reset is not to `false` but to "unless it just gave itself away".
    // An enemy who unit-targeted somebody out of a brush is lit for two
    // seconds wherever they are standing — that is the whole of the reported
    // bug ("đứng trong bụi, đánh vào kẻ địch, expect là phải bị lộ"), and
    // folding it into the reset that already walks every object is what keeps
    // it from being a third full pass. `combat/AttackReveal.ts` has the rule.
    const viewer = { teamId: this.game.player?.teamId };
    // `revealMap` folded into the reset rather than given a walk of its own,
    // for the same reason the reveal-on-attack rule above is: this loop already
    // touches every object, and the cheat is one more thing that can light one.
    // It must not reach `revealedEnemies` — that list is what *lends a circle*
    // to the enemy team, and a cheat that is only about what this player sees
    // has no business granting vision on the other side.
    const reveal = this.revealsEverything();
    /** Attackers lit this frame — each one lights a circle around itself too. */
    const revealedEnemies: any[] = [];
    this.game.objectManager.objects.forEach((o: any) => {
      if (!(o instanceof AttackableUnit) || o.alwaysVisible) return;
      const gaveItselfAway = revealedTo(viewer, o);
      o.visibleToPlayerTeam = reveal || gaveItselfAway;
      if (gaveItselfAway) revealedEnemies.push(o);
    });
    visiblePlayers.forEach((p: any) => (p.visibleToPlayerTeam = true));

    // A revealed attacker is a *revealer*, on the enemy's behalf.
    //
    // Two things follow from that and both are needed. League reveals a
    // **radius**, not a body, and that is the half that matters in a brush
    // fight: two enemies waiting in one bush, one swings, and both are seen —
    // revealing only the swinger leaves their partner invisible beside a body
    // you can see. And the fog is *painted after the world*, so a unit flagged
    // visible with no hole burned around it is a unit drawn and then covered
    // over: targetable, on the minimap, and not on screen. Pushing a sight
    // polygon here is what makes the reveal something a player can see.
    //
    // Wall-aware, like every other granted circle in this pass and for the
    // reason recorded there: a plain disc reaches through walls, and then what
    // is drawn and what may be targeted stop agreeing.
    if (revealedEnemies.length) {
      const reach = resolveVisionTuning(this.game.mapTuning).attackRevealRadius;
      for (const attacker of revealedEnemies) {
        revealCircles.push({
          source: attacker,
          x: attacker.position.x,
          y: attacker.position.y,
          r: reach,
        });
        if (nearCamera(attacker.position.x, attacker.position.y, reach)) {
          allSightPoly.push({
            object: attacker,
            sightPoly: this.getSightPoly(attacker, reach, GRANTED_SIGHT_TOLERANCE_PX),
            radius: reach,
            ring: GRANTED_SIGHT_RING_PX,
          });
        }
      }
    }

    // Granted circles light any body standing in them — distance first, because
    // it rejects almost everything for two multiplies, then the wall test.
    //
    // This flag decides what is *drawn*; `combat/Vision.ts`'s `canSee` decides
    // what may be *targeted*, and the whole reason both exist is that they have
    // to give the same answer. The distance test used to be the whole rule
    // here, so an enemy behind a wall from an allied minion was drawn on the
    // player's screen and refused as a target in the same frame.
    //
    // The raycast only runs for a pair that already passed the distance test,
    // and the loop breaks on the first eye that sees — so a unit standing in
    // its own wave pays one, and a unit nothing is lighting pays none.
    if (revealCircles.length) {
      this.game.objectManager.objects.forEach((o: any) => {
        if (!(o instanceof AttackableUnit) || o.visibleToPlayerTeam || o.alwaysVisible) return;
        const { x: ox, y: oy } = o.position;
        for (const c of revealCircles) {
          const dx = ox - c.x;
          const dy = oy - c.y;
          if (dx * dx + dy * dy > c.r * c.r) continue;
          if (!this.grantedEyeSees(c.source, o)) continue;
          o.visibleToPlayerTeam = true;
          break;
        }
      });
    }

    this.mapVisionCircles = mapVision;

    if (typeof revision === 'number') {
      this.lastSightCalculation = { revision, result: allSightPoly };
    }
    return allSightPoly;
  }

  /**
   * What the player's team lights up, over the whole map — the minimap's fog.
   *
   * Held from the last `calculateSight`, which is the pass that already
   * decided it: a second walk would be a second answer, and two answers to
   * "what can we see" is exactly the drift `visibleToPlayerTeam` exists to
   * avoid. Empty until the first pass has run, which is one frame in which the
   * minimap is fully fogged — `Game.draw` runs the fog before the minimap.
   */
  visionCircles(): readonly MinimapVisionCircle[] {
    return this.mapVisionCircles;
  }

  /**
   * Whether a granted eye — an allied minion or turret — actually has `target`
   * in view, distance already established by the caller.
   *
   * **This is `combat/Vision.ts`'s `viewIsClear`, line for line, and must stay
   * that way**: that module answers what may be *targeted*, this answers what
   * is *drawn*, and the fog is only a promise while the two agree. It is
   * copied rather than imported because `ContentApi` re-exports the whole of
   * `Vision` (`import * as Vision`), so a fourth exported name there widens the
   * published pack contract — a `contract:bump` and a core minor — for a
   * three-line predicate no pack has any use for. The geometry itself is *not*
   * copied: both call the same public `hasLineOfSight`.
   *
   * The `revealedTo` line is the newer of the two non-geometry rules and
   * outranks everything under it: a unit that unit-targeted somebody is lit for
   * its enemies through a wall as readily as out of a brush
   * (`combat/AttackReveal.ts`).
   *
   * The `isInsideBush` line is the half that is not geometry. `TerrainMap`
   * maintains that boolean for champions only, so for a minion eye it reads
   * false always, and the rule it states is "a champion in a bush is not lit by
   * a wave standing in the same bush" — which is what `borrowedEyeSees` already
   * decides on the targeting side. Dropping it here would light a body the
   * player then could not click.
   */
  grantedEyeSees(eye: any, target: any): boolean {
    if (!eye?.position || !target?.position) return false;
    if (revealedTo(eye, target)) return true;
    if (target.isInsideBush && !eye.isInsideBush) return false;
    return hasLineOfSight(this.game, eye.position, target.position);
  }

  calculateSightForObject(obj: any): {
    sightPoly: { x: number; y: number }[];
    playersInSight: any[];
  } {
    // getSightPoly recomputes the polygon at obj's live position every frame
    // (reusing the cached segment list whenever it can — see the file header
    // and computeSightPoly), so it's always frame-accurate. playersInSight is
    // a separate, cheap-enough-to-always-run quadtree lookup that gates
    // visibility (visibleToPlayerTeam); it was already frame-accurate and stays so.
    const sightPoly = this.getSightPoly(obj);

    // Decomposed once for the whole scan rather than inside the predicate: the
    // polygon is the same for every candidate, and `pointPolygonConcave` would
    // otherwise re-run the full convex decomposition per candidate, per
    // observer, per frame. `prepareSight` also builds each part's SAT polygon
    // here instead of per candidate, and holds the lot for as long as
    // `getSightPoly` keeps handing back this same array — a champion standing
    // still decomposes nothing. See `sightContainment.ts`.
    const sightParts = prepareSight(sightPoly);

    const playersInSight = this.game.objectManager.queryObjects({
      area: new Circle({
        x: obj.position.x,
        y: obj.position.y,
        r: obj.visionRadius,
      }),
      filters: [
        PredefinedFilters.type(AttackableUnit),
        (o: any) => sightContains(o.position.x, o.position.y, sightParts),
      ],
    });

    return {
      sightPoly,
      playersInSight,
    };
  }

  // Returns the sight polygon for `obj`, always at its current position. A
  // unit whose position and radius are bit-for-bit identical to last frame's
  // (i.e. it hasn't moved) casts the exact same polygon, so this
  // short-circuits straight to the cached result without even querying
  // obstacles. Anything else — the unit moved, its radius changed, or this is
  // the first time we've seen it — goes through computeSightPoly.
  //
  // `radius` defaults to whatever the object lights, which for a champion is
  // its own sight and for a minion or turret the circle it grants; pass it
  // explicitly only to override. `tolerancePx` widens the "hasn't moved" test
  // for revealers whose fog nobody is steering — see
  // GRANTED_SIGHT_TOLERANCE_PX. At the default 0 the test is exact equality,
  // which is what it has always been.
  getSightPoly(
    obj: any,
    radius: number = fogRevealOf(obj),
    tolerancePx = 0
  ): { x: number; y: number }[] {
    const entry = this.sightCache.get(obj);

    if (entry && entry.radius === radius) {
      const dx = obj.position.x - entry.x;
      const dy = obj.position.y - entry.y;
      if (dx * dx + dy * dy <= tolerancePx * tolerancePx) return entry.sightPoly;
    }

    return this.computeSightPoly(obj, radius, entry, tolerancePx);
  }

  // The actual visibility-polygon computation, run every frame a unit moves.
  // The obstacle lookup and the "bush I'm standing in" filter are
  // position-dependent and cheap, so they always run; segment breaking (the
  // O(n^2) part) only reruns when the obstacle set they produce differs from
  // what `entry` was built from (see buildObstacleSignature); the viewport
  // sweep always runs against obj's live position/radius so the returned
  // polygon is frame-accurate.
  computeSightPoly(
    obj: any,
    radius: number = fogRevealOf(obj),
    entry?: SightCacheEntry,
    tolerancePx = 0
  ): { x: number; y: number }[] {
    let obstaclesInSight = this.game.terrainMap.getObstaclesInChampionSight(
      obj,
      [TerrainType.WALL, TerrainType.BUSH],
      radius
    );

    // remove bushes that player is inside => player can see through that bush
    obstaclesInSight = obstaclesInSight.filter(
      (o: any) => !CollideUtils.pointPolygon(obj.position.x, obj.position.y, o.vertices)
    );

    const obstacleSignature = this.buildObstacleSignature(obstaclesInSight);
    const segments =
      entry && entry.obstacleSignature === obstacleSignature
        ? entry.segments
        : this.buildSegments(obstaclesInSight);

    // The clip box carries the move tolerance as slack. The gradient is drawn
    // at the unit's *live* position while a tolerated polygon was cast up to
    // `tolerancePx` away, so a box of exactly `radius` would sit that far
    // inside the gradient on one side — and the box's edge is straight while
    // the gradient's rim is round, so it would show as a faint straight cut
    // through the fade. Widening puts the whole box back outside the rim,
    // where the gradient is already fully transparent and nothing is drawn.
    const boxRadius = radius + tolerancePx;
    const sightPoly = PolyVisibility.computeViewport(
      [obj.position.x, obj.position.y],
      segments,
      [obj.position.x - boxRadius, obj.position.y - boxRadius],
      [obj.position.x + boxRadius, obj.position.y + boxRadius]
    ).map((v: number[]) => ({ x: v[0], y: v[1] }));

    this.sightCache.set(obj, {
      sightPoly,
      x: obj.position.x,
      y: obj.position.y,
      radius,
      segments,
      obstacleSignature,
    });

    return sightPoly;
  }

  // Converts obstacle polygons into a broken (non-self-intersecting) segment
  // list — the O(n^2) step (PolyVisibility.breakIntersections) that
  // computeSightPoly caches by obstacleSignature instead of paying every frame.
  buildSegments(obstacles: { vertices: { x: number; y: number }[] }[]): SightSegment[] {
    const polygons = obstacles.map(o => o.vertices.map(v => [v.x, v.y] as [number, number]));
    const segments = PolyVisibility.convertToSegments(polygons);
    return PolyVisibility.breakIntersections(segments);
  }

  // Cheap fingerprint for "which obstacles are in range right now": sorted
  // obstacle ids. The radius is deliberately absent: the range query already
  // expresses a radius change by returning a different obstacle set, while the
  // same set always produces the same static segments. Obstacle
  // counts in range are small (a handful of walls/bushes at most), so
  // sorting/joining every frame is far cheaper than the segment break it
  // guards, and a plain string compare is enough to detect any change in the
  // obstacle set — new obstacle entering range, one leaving, or a bush
  // flipping in/out of the containment filter.
  buildObstacleSignature(obstacles: { id: string }[]): string {
    const ids = obstacles.map(o => o.id).sort();
    return ids.join(',');
  }

  /** Reused by `drawVisions` for each vertex's screen position. */
  private readonly _screenScratch = { x: 0, y: 0 };

  /**
   * Erases every sight polygon out of the overlay, each through its own
   * radial gradient.
   *
   * Straight onto the overlay's 2D context, issuing exactly what p5's
   * `push / translate / beginShape / vertex / endShape(CLOSE) / pop` issued
   * for the same polygon — the overlay is in `erase()` with no stroke, so that
   * was always one `fill()` of one closed path. What is gone is p5's share: a
   * renderer-state copy per polygon, and a `p5.Vector` per vertex from
   * `worldToScreen`, on the one path in the frame whose vertex count grows with
   * the size of the fight.
   */
  drawVisions(): void {
    const allSightPoly = this.calculateSight();
    const ctx = this.overlay.drawingContext as CanvasRenderingContext2D;
    const camera = this.game.camera;
    const scratch = this._screenScratch;

    for (let i = 0; i < allSightPoly.length; i++) {
      const { object, sightPoly, radius, ring } = allSightPoly[i];
      const { x, y, gradient } = this.prepareRadialGradient(
        object.position.x,
        object.position.y,
        radius,
        ring
      );
      const count = sightPoly.length;
      // p5's `endShape` draws nothing for an empty shape.
      if (count === 0) continue;

      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      for (let k = 0; k < count; k++) {
        const v = sightPoly[k];
        // `worldToScreen`'s own arithmetic, minus the vector it allocates.
        const pos = camera.worldToScreenInto
          ? camera.worldToScreenInto(v.x, v.y, scratch)
          : camera.worldToScreen(v.x, v.y);
        if (k === 0) ctx.moveTo(pos.x - x, pos.y - y);
        else ctx.lineTo(pos.x - x, pos.y - y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  prepareRadialGradient(
    x: number,
    y: number,
    r: number,
    rRing: number
  ): { x: number; y: number; r: number; gradient: CanvasGradient } {
    const pos = this.game.camera.worldToScreen(x, y);
    // `currentScale`, not `scale`: the latter is the target the camera is
    // lerping toward, so reading it makes the fog snap to a new zoom while the
    // world is still sliding into it.
    const radius = r * this.game.camera.currentScale;
    const innerR = max(0, radius - rRing * this.game.camera.currentScale);
    const gradient = this.getRadialGradient(innerR, radius);

    return { x: pos.x, y: pos.y, r: radius, gradient };
  }

  // createRadialGradient() is a relatively costly context call and was being made
  // once per visible ally per frame; a gradient only depends on its stop radii, so
  // bucket-cache by (innerR, radius) — rounded to the pixel, since sub-pixel radius
  // differences are visually meaningless — and reuse across units and frames.
  getRadialGradient(innerR: number, radius: number): CanvasGradient {
    const key = `${Math.round(innerR)}:${Math.round(radius)}`;
    let gradient = this.gradientCache.get(key);
    if (!gradient) {
      gradient = this.overlay.drawingContext.createRadialGradient(0, 0, innerR, 0, 0, radius);
      this.colorStops.forEach(cs => gradient!.addColorStop(cs.stop, cs.color));
      this.gradientCache.set(key, gradient!);
    }
    return gradient!;
  }

  resize(w: number, h: number): void {
    this.overlay.resizeCanvas(w, h, true);
    // **The gradients do not survive this call, so the cache must not either.**
    //
    // `resizeCanvas` writes `canvas.width`/`canvas.height`, and that resets the
    // 2D context outright — p5 knows it, which is why it snapshots the context
    // and writes it back afterwards. Read what it snapshots: `for (o in
    // drawingContext) if (typeof a !== 'object' && typeof a !== 'function')` —
    // strings and numbers only. Every `CanvasGradient` this class handed to
    // `fillStyle` is an object, created against the context that just went
    // away, and `getRadialGradient` would go on serving those objects for the
    // rest of the match because it buckets by `(innerR, radius)` and nothing
    // ever evicted them.
    //
    // A stale gradient assigned to `fillStyle` is not an error anybody sees: a
    // rejected assignment leaves the previous fill standing, and inside
    // `erase()` the previous fill is p5's own opaque erase colour. So the
    // polygon erases at **full strength with a hard edge** instead of fading
    // out through `#fff → #0000`, i.e. it clears ground that should still be
    // fogged — and only for the radii that were cached before the resize,
    // which is why it would be some circles and not others.
    //
    // Why this shows up on an iPad and not on a desktop: it needs a resize.
    // Safari on iOS fires them constantly — the URL bar collapsing on scroll,
    // rotation, Split View, Stage Manager — where a desktop window sits still
    // for a whole session. The bug was always here; only one platform pulls
    // the trigger. Correct regardless of which engine is strict about it: a
    // cache of context-bound objects has no business outliving its context.
    this.gradientCache.clear();
  }

  destroy(): void {
    // Never `overlay.remove()` — p5 1.11's own Graphics.remove throws on a 2D
    // buffer, and this is the second line of Game.destroy(). See
    // `utils/graphics.utils.ts`.
    removeGraphics(this.overlay);
  }
}

/**
 * How many segments a whole turn of a cut rim is drawn with.
 *
 * The rim this inserts stands in for the soft path's gradient edge, and the
 * error that shows is the sag of a chord: `r * (1 - cos(pi / segments))`, which
 * at 32 is under half a percent of the radius — about 2px on the widest vision
 * in the shipped maps, under a fill that is 47% black against black. Doubling
 * it would double the vertices this tier exists to avoid paying for.
 */
export const SIGHT_CIRCLE_SEGMENTS = 32;

/** A screen-space bounding box, which is all the grouping below needs of a hole. */
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

function boundsOf(points: readonly { x: number; y: number }[]): Bounds {
  const box: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of points) {
    if (p.x < box.minX) box.minX = p.x;
    if (p.x > box.maxX) box.maxX = p.x;
    if (p.y < box.minY) box.minY = p.y;
    if (p.y > box.maxY) box.maxY = p.y;
  }
  return box;
}

const boundsOverlap = (a: Bounds, b: Bounds): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

/**
 * A polygon cut down to what fits inside a circle, with the circle's own rim
 * standing in for the parts that did not.
 *
 * ## What it is for
 *
 * `computeSightPoly` sweeps against a **square** clip box, so a revealer's
 * polygon reaches `1.41 x radius` into its corners. The soft path hides that
 * behind a gradient that is already transparent by `radius`; `drawDirect` has
 * no gradient and would cut the square out at full strength. This is the cut
 * that puts the boundary back on the circle.
 *
 * ## The shape of the walk
 *
 * Every edge is one of four cases — both ends in, leaving, entering, or a
 * chord straight across the disc from outside — and the only interesting one
 * is what happens *between* leaving and entering again: the boundary follows
 * the circle, so the rim is emitted there, in the direction the polygon itself
 * is wound. `atan2` increases along a positively-signed loop in screen
 * coordinates (y down), so that direction is one sign read off `signedArea`.
 *
 * The walk starts at a vertex **inside** the circle, which is what makes it
 * close itself: every run outside is then bracketed by an exit and an entry
 * within one lap, including the run that wraps past the end of the array.
 * Nothing inside at all is not a failure — the polygon is cast from this very
 * centre and is star-shaped about it, so it means the disc sits wholly inside
 * the polygon and the answer is the whole disc.
 */
export function clipPolygonToCircle(
  poly: readonly { x: number; y: number }[],
  cx: number,
  cy: number,
  r: number,
  segments: number = SIGHT_CIRCLE_SEGMENTS
): { x: number; y: number }[] {
  const count = poly.length;
  if (count < 3 || !(r > 0)) return [];

  const r2 = r * r;
  const isInside = (p: { x: number; y: number }): boolean => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return dx * dx + dy * dy <= r2;
  };

  const winding = signedArea(poly) >= 0 ? 1 : -1;
  const step = (2 * Math.PI) / Math.max(3, segments);
  const out: { x: number; y: number }[] = [];

  const angleOf = (p: { x: number; y: number }): number => Math.atan2(p.y - cy, p.x - cx);
  const pointAt = (angle: number) => ({
    x: cx + r * Math.cos(angle),
    y: cy + r * Math.sin(angle),
  });

  /** The rim between two angles already on the circle, exclusive of both. */
  const rim = (from: number, to: number): void => {
    const turn = 2 * Math.PI;
    // Measured the way the polygon runs, so the two angles need no ordering.
    const sweep = ((((to - from) * winding) % turn) + turn) % turn;
    const points = Math.max(0, Math.ceil(sweep / step) - 1);
    for (let i = 1; i <= points; i++)
      out.push(pointAt(from + winding * i * (sweep / (points + 1))));
  };

  let start = -1;
  for (let i = 0; i < count; i++) {
    if (isInside(poly[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    const whole = Math.max(3, Math.round(segments));
    for (let i = 0; i < whole; i++) out.push(pointAt((winding * i * 2 * Math.PI) / whole));
    return out;
  }

  let pendingExit: number | null = null;
  for (let k = 0; k < count; k++) {
    const a = poly[(start + k) % count];
    const b = poly[(start + k + 1) % count];
    const aIn = isInside(a);
    const bIn = isInside(b);

    if (aIn) out.push(a);
    if (aIn && bIn) continue;

    // Where this edge meets the circle, as parameters along a -> b.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const fx = a.x - cx;
    const fy = a.y - cy;
    const qa = dx * dx + dy * dy;
    if (qa === 0) continue;
    const qb = 2 * (fx * dx + fy * dy);
    const qc = fx * fx + fy * fy - r2;
    const discriminant = qb * qb - 4 * qa * qc;
    if (discriminant < 0) continue;
    const root = Math.sqrt(discriminant);
    const near = (-qb - root) / (2 * qa);
    const far = (-qb + root) / (2 * qa);
    const at = (t: number) => ({ x: a.x + dx * t, y: a.y + dy * t });

    if (aIn) {
      // Leaving: `a` is inside, so the far root is the one on the segment.
      const exit = at(far);
      out.push(exit);
      pendingExit = angleOf(exit);
    } else if (bIn) {
      const entry = at(near);
      if (pendingExit !== null) rim(pendingExit, angleOf(entry));
      out.push(entry);
      pendingExit = null;
    } else {
      // Both ends outside — but the edge can still cut a chord across the disc.
      if (near < 0 || near > 1 || far < 0 || far > 1) continue;
      const entry = at(near);
      const exit = at(far);
      if (pendingExit !== null) rim(pendingExit, angleOf(entry));
      out.push(entry, exit);
      pendingExit = angleOf(exit);
    }
  }

  return out;
}

/** Shoelace area with sign: a polygon's orientation, which is all `drawDirect` needs of it. */
export function signedArea(points: readonly { x: number; y: number }[]): number {
  let twice = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    twice += a.x * b.y - b.x * a.y;
  }
  return twice / 2;
}
