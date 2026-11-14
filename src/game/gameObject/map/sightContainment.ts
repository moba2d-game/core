import SAT from '@/libs/SAT';
import CollideUtils from '@/utils/collide.utils';

type Point = { x: number; y: number };

interface SightPart {
  polygon: SAT.Polygon;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** A sight polygon, decomposed and built once, ready for many point tests. */
export type PreparedSight = readonly SightPart[];

/**
 * How far outside a part's bounding box a point must be before the box alone
 * answers "no". SAT's own probe is a 0.000001px square whose edge normals are
 * the x and y axes, so the first axes it tries *are* this box test and it
 * returns false on them — the margin only has to cover float rounding in SAT's
 * projections, which is many orders of magnitude under a pixel.
 */
const BOX_MARGIN_PX = 1;

const prepared = new WeakMap<readonly Point[], PreparedSight>();
const probe = new SAT.Vector(0, 0);

/**
 * `CollideUtils.prepareConcave` plus the half it leaves undone, held for as
 * long as the polygon itself is.
 *
 * `pointPreparedConcave` hands each convex part to `pointPolygon`, which builds
 * a `SAT.Polygon` — a vector per vertex, then an edge and a normal per vertex
 * in `setPoints` — **per candidate, per part**. The polygon is the same for
 * every candidate in a scan, so the build belongs with the decomposition, not
 * with the point. Measured interleaved inside one page (a 10-champion fight, 6x
 * CPU throttle, old and new path swapped every 20 ticks, four runs) the
 * per-candidate build plus the SAT run on parts the candidate was nowhere near
 * was 43% of `calculateSight` — the median of the paired ratios was 0.57.
 *
 * Keyed on the array's identity: `FogOfWar.getSightPoly` hands back the same
 * array for a unit that has not moved, so a standing champion's polygon is
 * decomposed once rather than once per sight pass. Nothing writes to a sight
 * polygon after it is cast, which is what makes identity a sound key.
 *
 * Not on `CollideUtils`, deliberately: every name there is published pack
 * contract (`tests/content/apiSurface.snapshot.json`), and no pack has a use
 * for this.
 */
export function prepareSight(sightPoly: readonly Point[]): PreparedSight {
  const known = prepared.get(sightPoly);
  if (known) return known;

  const parts: SightPart[] = [];
  for (const part of CollideUtils.prepareConcave(sightPoly as Point[])) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const v of part) {
      if (v.x < minX) minX = v.x;
      if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
    }
    parts.push({
      // Built exactly as `CollideUtils.pointPolygon` builds it, so the SAT run
      // below sees the same numbers that one does.
      polygon: new SAT.Polygon(
        new SAT.Vector(0, 0),
        part.map(v => new SAT.Vector(v.x, v.y))
      ),
      minX: minX - BOX_MARGIN_PX,
      maxX: maxX + BOX_MARGIN_PX,
      minY: minY - BOX_MARGIN_PX,
      maxY: maxY + BOX_MARGIN_PX,
    });
  }
  prepared.set(sightPoly, parts);
  return parts;
}

/**
 * Whether the point is inside the prepared polygon. The same answer as
 * `CollideUtils.pointPreparedConcave` for every input —
 * `tests/game/map/sightContainment.test.ts` holds the two together.
 */
export function sightContains(x: number, y: number, sight: PreparedSight): boolean {
  for (let i = 0; i < sight.length; i++) {
    const part = sight[i];
    if (x < part.minX || x > part.maxX || y < part.minY || y > part.maxY) continue;
    probe.x = x;
    probe.y = y;
    if (SAT.pointInPolygon(probe, part.polygon)) return true;
  }
  return false;
}
