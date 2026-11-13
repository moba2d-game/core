import { describe, expect, it } from 'vitest';
import { activeMapOf } from '@/content/activeMap';
import type { MapGeometry, MapSummary } from '@/content/ContentPack';

/**
 * A pack's geometry data may not overwrite core's record of what a map is.
 *
 * Found in the field, on a published pack, and it cost the whole map:
 * `@moba2d/content-riot`'s Twisted Treeline chunk begins `{"id":
 * "map-nhap-vao", "name": "Twisted Treeline", …}` — the id it was drawn under
 * in the editor, left in the export. Both call sites built the active map as
 * `{ ...summary, ...geometry }`, so that id won, `Game.activeMapId` became a
 * name nothing else in the system knows, and a client sent that name in the
 * hello could not find it in a catalogue holding `lol:twisted-treeline`. A
 * host on that map could not be joined at all.
 *
 * The type system cannot see any of this — `id` is not a field of
 * `MapGeometry`, so the spread was well-typed — which is exactly why the check
 * is a test and the guard is the construction.
 */
const summary = (): MapSummary =>
  ({
    id: 'lol:twisted-treeline',
    name: 'Twisted Treeline',
    size: 6400,
    factions: [{ id: 'blue' }, { id: 'red' }],
  }) as unknown as MapSummary;

const geometry = (extra: Record<string, unknown> = {}): MapGeometry =>
  ({
    terrain: { wall: [], bush: [], water: [] },
    slots: { spawn: [], minion: [], structure: [], neutral: [] },
    ...extra,
  }) as unknown as MapGeometry;

describe('joining a map summary to its geometry', () => {
  it('keeps the catalogue id when the pack data carries one of its own', () => {
    const active = activeMapOf(summary(), geometry({ id: 'map-nhap-vao' }));
    expect(active.id).toBe('lol:twisted-treeline');
  });

  /**
   * The same hole, and the three that happened to agree so far. A pack whose
   * geometry named a different `size` would have silently resized the world.
   */
  it('keeps the catalogue name, size and factions too', () => {
    const active = activeMapOf(
      summary(),
      geometry({ name: 'Bản nháp 3', size: 2416, factions: [{ id: 'green' }] })
    );
    expect(active.name).toBe('Twisted Treeline');
    expect(active.size).toBe(6400);
    expect(active.factions).toEqual([{ id: 'blue' }, { id: 'red' }]);
  });

  it('still carries the geometry it was fetched for', () => {
    const walls = [[{ x: 1, y: 2 }]];
    const active = activeMapOf(summary(), geometry({ terrain: { wall: walls, bush: [], water: [] } }));
    expect(active.terrain.wall).toBe(walls);
    expect(active.slots.spawn).toEqual([]);
  });

  it('carries lanes when the map has them', () => {
    const lanes = [{ id: 'mid', waypoints: [] }];
    const active = activeMapOf(summary(), geometry({ lanes }));
    expect(active.lanes).toBe(lanes);
  });

  /**
   * `lanes: undefined` is not the same shape as no `lanes` key: the engine
   * tests for the field on a map with no lanes ("no waves, and PUSH falls
   * through"), and a present-but-undefined key answers a different question.
   */
  it('leaves lanes absent, not undefined, on a map without them', () => {
    expect('lanes' in activeMapOf(summary(), geometry())).toBe(false);
  });

  /** An ice map shipped `zones`, and the join dropped them: nothing slid in a real match. */
  it('carries terrain zones when the map has them, and leaves them absent otherwise', () => {
    const zones = [{ kind: 'ice', polygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }] }];
    expect(activeMapOf(summary(), geometry({ zones } as never)).zones).toBe(zones);
    expect('zones' in activeMapOf(summary(), geometry())).toBe(false);
  });

  /** Nothing a pack invents may reach the match by riding along. */
  it('lets no unknown key through at all', () => {
    const active = activeMapOf(summary(), geometry({ authoring: { strokes: 900 } }));
    expect('authoring' in active).toBe(false);
  });
});
