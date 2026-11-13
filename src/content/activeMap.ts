import type { ActiveMap, MapGeometry, MapSummary } from './ContentPack';

/**
 * The catalogue's map, joined to the geometry that was fetched for it.
 *
 * Both call sites used to write `{ ...summary, ...geometry }` — the offline
 * one in `GameScene.startGame` and the net one in `clientBoot.ts` — and that
 * spread is a hole rather than a shorthand. `MapGeometry` declares three
 * fields; a pack's *data* is under no obligation to carry only those, and
 * `loadMapGeometry` hands back whatever the pack's chunk actually contains.
 * With geometry spread second, every stray key wins.
 *
 * One of them was `id`, and it cost a whole map. `@moba2d/content-riot` ships
 * Twisted Treeline as a chunk that begins:
 *
 *     { "id": "map-nhap-vao", "name": "Twisted Treeline", "size": 6400, … }
 *
 * — the id the map was drawn under in the editor, left in the export. The
 * catalogue's own id is `lol:twisted-treeline`, qualified by `PackRegistry`,
 * and the spread threw it away: `Game.activeMapId` became `map-nhap-vao`,
 * which is not a name anything else in the system knows. Offline nobody
 * noticed, because nothing else reads that id. Over the wire it is the
 * hello's `mapId`, so the client looked for `map-nhap-vao` in a catalogue
 * holding `lol:twisted-treeline`, missed, and reported *"host plays on
 * map-nhap-vao, which this client does not have and could not install"* —
 * blaming the packs, because installing one is the only remedy that code
 * knows. **A host on Twisted Treeline could not be joined at all.**
 *
 * `name`, `size` and `factions` were being overwritten by the same data by
 * the same route; they merely happened to agree.
 *
 * So the join is explicit, and deliberately not a spread. Geometry
 * contributes exactly the three fields it is defined to contribute, and the
 * summary — which is core's own record of what this map *is* — cannot be
 * overwritten by content at all. A future pack with a stray `size`, `factions`
 * or anything else lands nowhere.
 *
 * Type-checking could not have caught this and still cannot: the offending key
 * is absent from `MapGeometry`, so `{ ...summary, ...geometry }` is
 * well-typed, and excess-property checks do not apply to a value that arrived
 * as `MapGeometry` from a loader. The guard has to be the construction itself.
 */
export const activeMapOf = (summary: MapSummary, geometry: MapGeometry): ActiveMap => ({
  ...summary,
  terrain: geometry.terrain,
  slots: geometry.slots,
  // Absent on a map with no lanes, and absent must stay absent: `lanes: undefined`
  // is not the same shape as no `lanes` key to code that tests for the field.
  ...(geometry.lanes === undefined ? {} : { lanes: geometry.lanes }),
  // Ice and other `TerrainZone`s: dropping them here left `TerrainMap.zones`
  // empty in a real match, so an ice map never slid although its tests passed.
  ...(geometry.zones === undefined ? {} : { zones: geometry.zones }),
});
