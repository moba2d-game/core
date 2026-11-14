import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { referenceMap } from '../../packs/reference/map';
import { data as referenceData } from '../../packs/reference/pack';
import { validatePack } from '../../src/content/validate';
import { PackRegistry } from '../../src/content/PackRegistry';
import NavigationSystem from '../../src/game/nav/NavigationSystem';
import { NAV_CELL_SIZE } from '../../src/game/nav/NavGrid';
import type { MapGeometry, StructureSlot } from '../../src/content/ContentPack';
import { coreSlotObjectFor } from '../../src/game/gameObject/structures/slotObjects';

/**
 * The reference pack's own map, and what it is for beyond being playable.
 *
 * It is core's second, independent map fixture: twelve nav/lane/muster tests
 * lean on one big pack map's polygon soup, and the `NavGrid` clearance bug this
 * project shipped once only ever surfaced because a jungle had 60-90px gaps. So
 * what is asserted here is not decoration — a corridor in that same hostile
 * band, walls on all four edges, and a route across the whole map for a body of
 * real radius.
 *
 * The map behind it changed (a hand-drawn ARAM replaced a hand-*written*
 * Proving Grounds), and the fixture value had to survive that, so the cases
 * below **measure** rather than restate numbers somebody chose:
 * `wallGapWidths` finds the narrowest corridors the rasteriser will actually
 * see, and the symmetry case carries a tolerance because a map drawn by hand is
 * near-symmetric, not exactly so. A case that asserted "the gap is 80" would
 * have been a case that could only ever be deleted.
 *
 * See `packs/reference/map.ts` and `packs/reference/aramGeometry.ts` for what
 * it is; this file is what proves it is that, rather than merely looking like
 * it on paper.
 */

/** `referenceMap.geometry` is a loader — resolve it once per test that needs it. */
const geometry = (): Promise<MapGeometry> => {
  const source = referenceMap.geometry;
  if (typeof source !== 'function') return Promise.resolve(source);
  return source();
};

type Point = { x: number; y: number };

/** Even-odd point-in-polygon, the same rule `NavGrid`'s own rasteriser uses. */
const pointInPolygon = (px: number, py: number, polygon: readonly Point[]): boolean => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
};

/**
 * `wallGapWidths` does not exist anywhere else — this is the "cheap honest
 * version" the plan asks for, not a general narrowest-corridor solver.
 *
 * Samples the map on the same grid `NavGrid.fromPolygons` rasterises at
 * (`NAV_CELL_SIZE`, one cell-centre sample per cell), marks a cell blocked
 * when its centre falls inside any wall polygon, and reports the run
 * lengths of consecutive free cells along every row and every column, in
 * pixels (`run length * cellSize`). That is what the pathfinder will
 * actually see — a corridor a hair narrower than the grid resolves would
 * report a run of 0 here exactly as it would refuse to route through it —
 * rather than the raw gap between two polygon edges, which is what the
 * `NavGrid` clearance bug this fixture exists to keep catching got wrong
 * (a conservative approximation whose error matched the feature size).
 */
function wallGapWidths(
  walls: readonly (readonly Point[])[],
  size: number,
  cellSize: number = NAV_CELL_SIZE
): number[] {
  const cols = Math.max(1, Math.ceil(size / cellSize));
  const rows = cols;
  const blocked = new Uint8Array(cols * rows);

  for (let cy = 0; cy < rows; cy++) {
    const y = (cy + 0.5) * cellSize;
    for (let cx = 0; cx < cols; cx++) {
      const x = (cx + 0.5) * cellSize;
      for (const wall of walls) {
        if (pointInPolygon(x, y, wall)) {
          blocked[cy * cols + cx] = 1;
          break;
        }
      }
    }
  }

  const gaps: number[] = [];

  for (let cy = 0; cy < rows; cy++) {
    let run = 0;
    for (let cx = 0; cx < cols; cx++) {
      if (blocked[cy * cols + cx] === 0) {
        run++;
      } else {
        if (run > 0) gaps.push(run * cellSize);
        run = 0;
      }
    }
    if (run > 0) gaps.push(run * cellSize);
  }

  for (let cx = 0; cx < cols; cx++) {
    let run = 0;
    for (let cy = 0; cy < rows; cy++) {
      if (blocked[cy * cols + cx] === 0) {
        run++;
      } else {
        if (run > 0) gaps.push(run * cellSize);
        run = 0;
      }
    }
    if (run > 0) gaps.push(run * cellSize);
  }

  return gaps;
}

/** Counts `items` by `key`, the same shape `Map<string, number>` a real `countBy` returns. */
function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

const spawnOf = (map: MapGeometry, faction: string): Point => {
  const slot = map.slots.spawn.find(s => s.faction === faction);
  if (!slot) throw new Error(`no spawn slot for faction ${faction}`);
  return { x: slot.x, y: slot.y };
};

// A champion's body radius (`AttackableUnit.bodyRadius` defaults to half a
// 55px size), the same figure `tests/game/nav/NavigationSystem.test.ts`
// uses for the same reason: the fixture's corridor is only hostile if the
// body trying to cross it is a real one.
const CHAMPION_RADIUS = 27.5;

/**
 * How far a slot may sit from its own mirror image, in pixels. See the
 * symmetry case for why this is a tolerance and not zero.
 */
const MIRROR_TOLERANCE = 120;

describe('ARAM, the reference pack’s own map', () => {
  it('has a corridor between 60 and 90 px, which is what exercises NavGrid clearance', async () => {
    const { terrain } = await geometry();
    const gaps = wallGapWidths(terrain.wall, referenceMap.size);
    expect(gaps.some(g => g >= 60 && g <= 90)).toBe(true);
  });

  /**
   * `mirror(p) = (size - x, size - y)` — the 180° rotation about the map's
   * centre that makes the two sides a fair fight, the symmetry a real MOBA map
   * has across its diagonal.
   *
   * **Within a tolerance, and the tolerance is the honest part.** The map this
   * replaced was written out by hand and mirrored to the pixel; this one was
   * drawn with a mouse and lands within 85px of its own mirror on a 4000px map,
   * a shade over 2%. `MIRROR_TOLERANCE` is set just above that — wide enough
   * that nudging a turret does not fail the build, and nowhere near wide enough
   * to accept the thing this case exists to catch: a side with a structure the
   * other does not have, which misses by thousands.
   */
  it('is near point-symmetric: every slot mirrors onto one of the other faction', async () => {
    const { slots, lanes } = await geometry();
    const size = referenceMap.size;
    const nearest = (x: number, y: number, list: readonly { x: number; y: number }[]) =>
      Math.min(...list.map(s => Math.hypot(s.x - (size - x), s.y - (size - y))));

    for (const group of ['structure', 'spawn', 'minion', 'neutral'] as const) {
      for (const s of slots[group]) {
        expect(nearest(s.x, s.y, slots[group]), `${group} at ${s.x},${s.y}`).toBeLessThanOrEqual(
          MIRROR_TOLERANCE
        );
      }
    }
    // The lane both teams walk is the same path: the waypoint list is a
    // palindrome under the mirror, to the same tolerance.
    for (const lane of lanes ?? []) {
      const points = lane.waypoints;
      for (let i = 0; i < points.length; i++) {
        const other = points[points.length - 1 - i];
        const off = Math.hypot(other.x - (size - points[i].x), other.y - (size - points[i].y));
        expect(off, `lane waypoint ${i}`).toBeLessThanOrEqual(MIRROR_TOLERANCE);
      }
    }
  });

  it('is walled on all four edges — the arena has an outer boundary', async () => {
    // Rasterised the same way `wallGapWidths` samples, so "walled" means what
    // the pathfinder and the renderer will actually see: every cell whose
    // centre lies on the outermost ring is inside some wall polygon.
    const { terrain } = await geometry();
    const size = referenceMap.size;
    const cells = Math.ceil(size / NAV_CELL_SIZE);
    const blockedAt = (x: number, y: number) =>
      terrain.wall.some(wall => pointInPolygon(x, y, wall));
    for (let c = 0; c < cells; c++) {
      const mid = (c + 0.5) * NAV_CELL_SIZE;
      const edge = 0.5 * NAV_CELL_SIZE;
      const far = size - 0.5 * NAV_CELL_SIZE;
      expect(blockedAt(mid, edge), `top edge open at x=${mid}`).toBe(true);
      expect(blockedAt(mid, far), `bottom edge open at x=${mid}`).toBe(true);
      expect(blockedAt(edge, mid), `left edge open at y=${mid}`).toBe(true);
      expect(blockedAt(far, mid), `right edge open at y=${mid}`).toBe(true);
    }
  });

  it('is navigable end to end despite that', async () => {
    const map = await geometry();
    const nav = new NavigationSystem(map.terrain.wall, referenceMap.size);
    const from = spawnOf(map, 'amber');
    const to = spawnOf(map, 'jade');
    const result = nav.runSearch(from.x, from.y, to.x, to.y, CHAMPION_RADIUS);
    expect(result.ok).toBe(true);
    expect(result.waypoints.length).toBeGreaterThan(0);
  });

  it('is a summary only — no terrain or slots on the object itself', () => {
    expect(referenceMap).not.toHaveProperty('terrain');
    expect(referenceMap).not.toHaveProperty('slots');
    expect(referenceMap).not.toHaveProperty('lanes');
    expect(typeof referenceMap.geometry).toBe('function');
  });

  it('gives both factions the same number of structures', async () => {
    const { slots } = await geometry();
    const perFaction = countBy(slots.structure, (s: StructureSlot) => s.faction);
    const amber = perFaction.get('amber') ?? 0;
    const jade = perFaction.get('jade') ?? 0;
    expect(amber).toBeGreaterThan(0);
    expect(amber).toBe(jade);
  });

  it('gives every lane a muster point for both of its factions', async () => {
    const { lanes, slots } = await geometry();
    expect(lanes?.length ?? 0).toBeGreaterThan(0);
    for (const lane of lanes ?? []) {
      for (const end of [lane.from, lane.to]) {
        const musters = slots.minion.some(slot => slot.faction === end && slot.lane === lane.id);
        expect(musters).toBe(true);
      }
    }
  });

  /**
   * Its two neutral points are answered from two different places, on purpose,
   * and between them they are the whole of what a neutral slot can mean.
   *
   * `relic` is **furniture**: core answers it with no pack installed at all
   * (`gameObject/structures/slotObjects.ts`), which is why the map can draw the
   * pad and count on something being on it. `dragon` is **content**: this pack
   * ships no monster that fills it, so the pit is empty in a checkout with only
   * core and holds whatever a content pack answers `dragon` with when one is
   * installed. That is `MonsterDef.fills`' cross-pack match seen from the map's
   * side, and asserting the *absence* is what keeps it a real seam rather than
   * something the bundled pack quietly does to its own slots.
   */
  it('draws one neutral point core answers and one only a pack can', async () => {
    const { slots } = await geometry();
    const roles = slots.neutral.map(slot => slot.role).sort();
    // `scenery` is the pack's own painted ground, added by `aramGeometry.ts`
    // rather than drawn in the editor — see `referenceScenery.test.ts`.
    expect(roles).toEqual(['dragon', 'relic', 'scenery']);

    const relic = slots.neutral.find(slot => slot.role === 'relic')!;
    expect(coreSlotObjectFor(relic.role), 'core stopped answering the relic').toBeTypeOf(
      'function'
    );
    // And the map drew it as an object, which is the only way to say "never a
    // camp here" — see `NeutralSlot.kind`.
    expect(relic.kind).toBe('object');

    const monsters = Object.values(referenceData.monsters ?? {});
    expect(
      monsters.some(monster => monster.fills.includes('dragon')),
      'this pack started filling its own pit, which deletes the cross-pack case'
    ).toBe(false);
  });

  it('passes validation as part of a pack, geometry included', async () => {
    const result = validatePack({
      manifest: { id: 'p', version: '1.0.0', coreRange: '^1' },
      maps: [referenceMap],
    });
    expect(result.ok).toBe(true);
    if (result.ok === false) expect(result.errors).toEqual([]);

    // `referenceMap.geometry` is a loader too — see `summonersRift.test.ts`'s
    // matching test for why `validatePack` above cannot see past its summary,
    // and why `PackRegistry.loadMapGeometry` (which validates the resolved
    // geometry) is what actually has to run for this to mean anything.
    const registry = new PackRegistry();
    registry.installData({
      manifest: { id: 'p', version: '1.0.0', coreRange: '^1' },
      maps: [referenceMap],
    });
    await expect(registry.loadMapGeometry('p:aram')).resolves.toBeTruthy();
  });

  it('is carried in the reference pack’s own data', () => {
    expect(referenceData.maps).toContain(referenceMap);
  });

  /**
   * The summary and the geometry are the same map, and the editor's own
   * bookkeeping is not shipped as gameplay.
   *
   * There is only one copy of the geometry to check — `aramGeometry.ts` reads
   * `maps/aram.json` with `?raw` rather than transcribing it — so what is left
   * worth asserting is the seam between the two halves of a `MapDefinition`:
   * the summary's numbers are hand-written in `map.ts` and could drift from the
   * export, and `authoring` must not reach the runtime.
   *
   * `id` is deliberately *not* compared. It is the one field a re-export must
   * never be able to change: it becomes `Game.activeMapId` and the `mapId` in a
   * LAN hello, and an editor's working name reaching that made a host
   * unjoinable once already.
   */
  it('ships the summary the editor export declares, and none of its bookkeeping', async () => {
    const source = JSON.parse(
      readFileSync(resolve(__dirname, '../../packs/reference/maps/aram.json'), 'utf8')
    ) as Record<string, unknown>;

    expect(referenceMap.size).toBe(source.size);
    expect(referenceMap.name).toBe(source.name);
    expect(referenceMap.factions).toEqual(source.factions);

    const shipped = await geometry();
    expect(shipped).not.toHaveProperty('authoring');
    expect(
      source,
      'the export lost its authoring block — the map is now uneditable'
    ).toHaveProperty('authoring');
  });
});
