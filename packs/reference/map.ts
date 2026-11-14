import type { MapDefinition } from '@moba2d/core/content/ContentPack';

/**
 * The reference pack's own map — core's proof that it ships a real world of
 * its own rather than existing only to host somebody else's.
 *
 * ## What it is
 *
 * A single-lane bridge map: two bases in opposite corners, one lane between
 * them, brush along its length, a relic pad off to one side and a pit for a
 * neutral objective in the middle. Drawn in `src/mapEditor/` and kept as that
 * editor's own export (`maps/aram.json`); `aramGeometry.ts` is the shipped
 * copy, and a test pins the two together — see that module's header for why
 * both exist.
 *
 * It replaced a hand-written fixture map (Proving Grounds) whose job was to be
 * *hostile* to the pathfinder: a corridor in the 60-90px band `NavGrid`'s
 * clearance pass is fragile in, and a point-symmetric structure row. What that
 * map bought is now bought differently — `tests/content/referenceMap.test.ts`
 * measures this map's own narrowest corridor rather than asserting a number
 * somebody chose, so the fixture value survives the map that carried it
 * changing. What it does not buy any more is the symmetry: this map is drawn
 * by hand and is *near*-symmetric, not exactly so, and the test says which.
 *
 * ## Why the neutral slots are not all this pack's own
 *
 * Its `slots.neutral` names two roles. `relic` is core's own furniture and is
 * answered without any pack at all (`gameObject/structures/slotObjects.ts`).
 * `dragon` is nobody's here: this pack ships no monster that fills it, so the
 * pit is empty in a checkout with only core installed and holds whatever a
 * content pack answers `dragon` with when one is. That is the cross-pack match
 * `MonsterDef.fills` exists for, seen from the map's side.
 *
 * ## The split
 *
 * This module is the cheap summary a picker lists — a name, a size, two
 * factions, never polygons — and the heavy half sits behind `geometry`'s
 * dynamic import. `vite.config.ts`'s `map-<id>` `manualChunks` rule matches
 * `aramGeometry.ts` by basename ahead of the blanket `/packs/reference/` ->
 * `pregame` rule, which is what keeps the walls off the menu; `npm run
 * chunks:check` and a real `vite build` are what confirm it still holds.
 *
 * The **id is hand-written here and never read off the export**, which is the
 * one field a re-export must not be able to change: it becomes
 * `Game.activeMapId` and the `mapId` in a LAN hello, and an editor's working
 * name reaching that made a host unjoinable once already.
 */
export const referenceMap: MapDefinition = {
  id: 'aram',
  name: 'ARAM',
  size: 4000,
  factions: [{ id: 'amber' }, { id: 'jade' }],
  // `art/` paints the walls, the brush and the lane from the same polygons the
  // collision uses; core's grey fills underneath would be a whole extra layer
  // of overdraw. The object that paints rides in on a slot — `art/scenery.ts`.
  paintsOwnTerrain: true,
  geometry: () => import('./aramGeometry').then(module => module.aramGeometry),
};
