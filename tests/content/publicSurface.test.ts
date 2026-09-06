import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as seams from '../../src/seams/index';
import * as contentApi from '../../src/content/ContentApi';
import * as contentPack from '../../src/content/ContentPack';
import * as contentTypes from '../../src/content/types';
import * as testingSetup from '../../src/testing/setup';
import * as testingVitest from '../../src/testing/vitest.mjs';

/**
 * `package.json`'s `exports` is the whole answer to "what may a content pack
 * import from core" — not a convention documented in a doc comment
 * somewhere, a field a reviewer can see move in a diff. Widening it (adding
 * a subpath, or pointing one at a different file) is a decision this test
 * forces to be deliberate: touch the list, touch this test.
 *
 * The original measured surface (`docs/superpowers/surveys/2026-08-22-...`)
 * was three content modules, all `import type`, plus `src/seams/` for the
 * seam-checker CLI, which is tooling rather than content API. Content-pack-
 * extraction batch 5 task 6 fix round 2 widened it by three, all the same
 * shape as `./seams` — build tooling a pack's own standalone `tsc` program
 * needs, not content API: `./tsconfig.base.json` (the shared compiler
 * options, and `@/*`, core's own internal alias — resolved relative to
 * *this* file's location regardless of who extends it, which is what lets a
 * pack's `tsconfig.json` reach it by package name instead of a `../../`
 * path into this checkout) and `./types/global.d.ts` /
 * `./types/poly-decomp.d.ts` (the ambient declarations — p5 in global mode,
 * the physics library's missing types — a pack's own strict typecheck needs
 * to see real types through `ContentApi`'s own internals, which are core's
 * unbundled source and import via `@/*` like the rest of this codebase).
 * `packs/riot/tsconfig.json`'s own header has the full account.
 *
 * Content-pack-and-repo-split batch 6 task 1 widened it by three more, none
 * of them content API either: `./testing` and `./testing/spell` are the
 * observer's half of core's surface — the two fixture worlds a pack's own
 * Vitest suite builds a match against and reads results from, as distinct
 * from `ContentApi`, which is what a *spell* sees from inside a running
 * match. `./package.json` is there so a consumer's own tooling can locate
 * core's package root at all — `require.resolve('@moba2d/core/package.json')`
 * throws `ERR_PACKAGE_PATH_NOT_EXPORTED` without it.
 *
 * Task 3 widened it by two more: `./testing/vitest` is the Vitest config
 * fragment (`moba2dPackTestConfig`) a pack's own `vitest.config.ts` spreads,
 * so that config and core's own `vitest.config.ts` run the same
 * `resolve.alias`/`test.environment`/`test.clearMocks` rather than a
 * hand-copied approximation. It is a plain `.mjs` file, not `.ts` — a pack's
 * config loader hands a bare specifier under `node_modules` straight to
 * Node, which refuses to strip types there, so a `.ts` target here would
 * break every pack's first `npm test` — and it is not re-exported from
 * `./testing`'s own barrel: that barrel is loaded by every test file in
 * every pack, and a config helper reached only once, by a config file, has
 * no business on that path.
 *
 * `./testing/setup` is the fix round that followed the same task, and it
 * looks redundant with `./testing` until you know what it is guarding
 * against. `installEngineGlobalsForTests`/`installPackForTests` are also
 * exported from `./testing` itself, but `export *` evaluates *every* module
 * a barrel re-exports, not only the bindings a particular import
 * destructures — so a `setupFiles` entry that imports them from `./testing`
 * also, for real, evaluates `api.ts`, which value-imports
 * `content/ContentApi.ts`, which value-imports `Champion`, `packAsset` and
 * the real `AssetManager`, all before any individual test file's own
 * `vi.mock(...)` calls have registered. Core's own `tests/setup.ts` hit
 * exactly this — a mocked `AssetManager` stopped being mocked, and a test
 * that used to see `undefined` from the mock instead hit the real class's
 * "Unknown asset key" — and fixed it by importing from this narrower subpath
 * instead of the barrel. A separated pack's own setup file needs the same
 * fix available under its own package name, not just inside this checkout,
 * which is the whole reason this is a published subpath rather than a
 * comment telling pack authors to import a relative path that does not
 * resolve outside this repository.
 *
 * Content-pack-and-repo-split batch 6 task 7 step 4b added the thirteenth:
 * `./testing/spells` publishes `src/testing/spellRegistry.ts`
 * (`loadSpellsForTests`/`resolveSpellBarrel`) on its own, out of the
 * `./testing` barrel that used to re-export it. The standalone drill
 * (`verify:pack-standalone`) is what prompted this, but not because
 * `spellRegistry.ts` leaks — the first reading of its first real failure
 * said exactly that (`spellRegistry.ts` reaches `src/game/spellRegistry.ts`,
 * which reaches core's content-install graph and, through it,
 * `src/generated/installedPacks.ts`, which names an installed pack by
 * *package* name) and it was wrong: that generated file regenerates with no
 * pack reference at all the moment a pack is not physically installed in
 * core's own tree, which `npm run verify:without-packs` already proves on
 * every run of its own. The actual fault was the drill packing core *with
 * the pack still installed*, a state core will never ship in — fixed in the
 * drill itself (`scripts/verify-pack-standalone.mjs` now moves every
 * optional pack aside and regenerates before `npm pack`), not in this
 * barrel. `spellRegistry` still left the barrel, on its own merit: `export *`
 * evaluates the whole module regardless of which binding a caller
 * destructures, so leaving it in would mean every pack test file that
 * imports anything at all from `@moba2d/core/testing` evaluates core's
 * content-install machinery, whether or not that file ever calls
 * `loadSpellsForTests` — the same eager-loading cost Task 3 measured for
 * `vi.mock` one level down. A pack that wants the whole registry filled says
 * so explicitly, at this subpath. Fourteen subpaths and no more.
 *
 * The lesson `./testing/setup` cost a fix round to learn: a subpath in this
 * map publishes the *file's entire export list*, not the bindings anyone
 * had in mind when they added the subpath. `src/testing/index.ts` re-exports
 * `installEngineGlobalsForTests`/`installPackForTests` from `./setup` by
 * name specifically because `./setup` used to also export
 * `cachedLanesForTests`, an implementation detail — adding `./testing/setup`
 * to this map made that binding importable by any pack too, invisibly,
 * because ES modules have no visibility control and this test (correctly)
 * only checks that each *target file* exists, never what it exports. Moving
 * `cachedLanesForTests` to an unmapped module (`src/testing/lanes.ts`) is
 * what actually closed that, not a comment; the check below still only pins
 * the list of subpaths, not the bindings behind them, so the same shape of
 * mistake is exactly as available the next time a subpath is added here as
 * it was this time.
 */

const repoRoot = join(__dirname, '..', '..');
const packageJsonPath = join(repoRoot, 'package.json');

function readPackageJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
}

describe('package.json public surface', () => {
  it('declares exports as exactly the fifteen content-pack-facing subpaths', () => {
    const pkg = readPackageJson();
    const exportsMap = pkg.exports as Record<string, string> | undefined;

    expect(exportsMap).toBeDefined();
    expect(Object.keys(exportsMap!).sort()).toEqual(
      [
        './content/ContentApi',
        './content/ContentPack',
        './content/types',
        './seams',
        './tsconfig.base.json',
        './types/global.d.ts',
        './types/poly-decomp.d.ts',
        './testing',
        './testing/spell',
        './testing/spells',
        // `describeSpellDescriptions` — the rules a description's coloured
        // numbers have to satisfy, published for the reason `./testing/items`
        // below is and with the sharpest evidence for it: all three packs had
        // written their own scan of the same markup, the three checked
        // different things, and a defect caught in one shipped in the other
        // two. The rules belong beside `combat/DamageText.ts`, which is what
        // decides what a valid span is.
        './testing/spellText',
        // The sixteenth, and the first subpath here that publishes *rules*
        // rather than tools: `./testing/items` is `describeItemShop`, the
        // assertions every pack's shop has to satisfy because they are facts
        // about what core does with an item — the icon it looks up, the
        // spell ids it resolves, the recipe it combines, the
        // `MAX_COOLDOWN_REDUCTION` it clamps at. Both shipped packs had
        // written their own half of that list, differently, with core's own
        // cooldown ceiling copied into each as a literal.
        //
        // Deliberately not in `scripts/templates/pack/`, where a scaffold's
        // files come from: a template is a copy, and once two packs exist a
        // fix to the template is a fix to neither of them —
        // `scripts/pack-core-link.mjs` makes that argument about itself in
        // its own header. It is also not in the `./testing` barrel, for the
        // reason `./testing/spells` is not: `export *` evaluates the whole
        // module, and this one value-imports `game/items/Item` and
        // `gameObject/Stats` for the two constants it refuses to copy.
        './testing/items',
        // The seventeenth, published for exactly the reason `./testing/items`
        // was and one step further along the same road: `./testing/maps` is
        // `mapIssues`, the rules a map has to satisfy — a lane wide enough for
        // a body, a turret some wave walks past, a wave able to stand where it
        // forms up. Both shipped packs had written their own half of that,
        // differently, as tables of coordinates measured off the map on the
        // day somebody looked at it.
        //
        // The implementation is not here and not in either pack: it is
        // `src/mapEditor/mapRules.ts`, plain browser JavaScript,
        // because the map editor has no bundler and cannot import anything
        // else — so the tool a person draws maps in runs the same function
        // this gate does, and the two cannot disagree about whether a map is
        // shippable. `./seams` publishes the same functions for core's own
        // use; a pack is held to a named list of subpaths and that barrel,
        // full of source scanners, is rightly not on it.
        './testing/maps',
        // The eighteenth, and the same argument a third time. `./testing/
        // boundary` is `describeCoreBoundary` — "this pack names no core
        // internal", the rule `src/seams/packCoreBoundary.ts` has always
        // owned, registered as a suite a pack's own `npm test` runs.
        //
        // It is published rather than left as ten lines in each pack because
        // it had been ten lines in *one* pack: the other pack's test suite
        // said nothing about the rule at all. And it is a pack-side suite
        // rather than only a `check-seams` rule because of the one thing
        // TypeScript cannot do here — a pack's `tsconfig.json` must publish
        // core's `@/*` alias so its `tsc` can see types through core's own
        // unbundled source, `paths` has no notion of which file is asking,
        // and so `import … from '@/game/…'` in a pack spell typechecks
        // cleanly and always will.
        //
        // Its own subpath, not the `./testing` barrel, for the reason
        // `./testing/items` has one: this module reaches `src/seams`, which
        // is `node:fs` and a directory walk, and no pack's fixture world
        // should carry that to build a match.
        './testing/boundary',
        // The nineteenth, and the first of these rules that fails as an
        // *absence*. `./testing/bots` is `describeBotRoles`: it scores every
        // ability in every kit through `BotBrain.scoreSpell` itself and
        // refuses a kit the bot cannot reach. Reported from a real match as
        // "the bot never presses R" — and nothing was broken. The ultimate
        // was castable, in range and off cooldown; it scored 6 against an
        // ordinary Q's 16, because `inferRoles` reads every costed `SELF`
        // cast as `Buff | Shield` and `scoreSpell` prices `Shield` at −5
        // above half health, which is exactly 0 once `Buff` is added — and
        // `chooseSpell` drops candidates scoring `<= 0`. The first sweep of
        // the three shipped packs found 226 abilities in that shape.
        //
        // It value-imports `BotBrain` on purpose, and that is precisely why
        // it is not in the `./testing` barrel: `export *` would drag 84KB of
        // engine into every pack test file that only wanted a champion.
        './testing/bots',
        // The twentieth. `./testing/tempo` is `describeTempo`, the cooldown
        // band — 10s on an ultimate, 12s on a basic, measured off the
        // reference pack's own 306 abilities. Here for `./testing/items`'
        // reason: moba2d being a fast game is a property of the *engine*, and
        // every pack was otherwise deciding it alone, in numbers nothing
        // compared to anything. A pack that means to be slower overrides them
        // in one visible line.
        './testing/tempo',
  './testing/vfx',
        './testing/vitest',
        './testing/setup',
        // The two build helpers a pack's own tooling runs, added when the
        // scaffold gained an art path it could actually grow: `pack-assets` is
        // the asset-manifest generator behind `moba2d-generate-assets` (a pack
        // test imports `assetKeyForPath` from it), and `pack-webp` is the Vite
        // plugin that re-encodes art on the way into `dist/`. Neither is ever
        // part of a published `pack.js`.
        './pack-assets',
        './pack-webp',
        './package.json',
      ].sort()
    );
  });

  it('points every exports target at a file that exists on disk', () => {
    const pkg = readPackageJson();
    const exportsMap = pkg.exports as Record<string, string> | undefined;

    expect(exportsMap).toBeDefined();
    for (const [specifier, target] of Object.entries(exportsMap!)) {
      const absoluteTarget = join(repoRoot, target);
      expect(existsSync(absoluteTarget), `${specifier} -> ${target} does not exist on disk`).toBe(
        true
      );
    }
  });

  it('is named @moba2d/core', () => {
    const pkg = readPackageJson();
    expect(pkg.name).toBe('@moba2d/core');
  });

  it('declares exactly sixteen bins, the eleven below plus the five a pack no longer copies', () => {
    // The scaffold (content-pack-and-repo-split batch 6 task 8) widened this
    // from two to four: `moba2d-pack-new` scaffolds a fresh, runnable pack
    // into an empty directory, and `moba2d-pack-add` adds one piece of
    // content — a spell today — plus its test to the pack the current
    // directory is inside. Both read their templates from
    // `scripts/templates/pack/`, which is why that directory (and
    // `scripts/lib/packRoot.mjs`, which `moba2d-pack-add` imports) are in
    // `files` alongside the two script entries below — `verify:pack-standalone`
    // is what proves a missing `files` entry here shows up in a real tarball
    // install rather than only in this checkout.
    const pkg = readPackageJson();
    const bin = pkg.bin as Record<string, string> | undefined;

    expect(bin).toBeDefined();
    expect(bin).toEqual({
      'moba2d-check-seams': './scripts/check-seams.mjs',
      // Thirteen, not eleven. A pack is its own repository and a spell is
      // pushed from it, so the two halves of the performance guard have to be
      // reachable from inside one: `moba2d-perf-scan` reads the shapes that
      // have cost this game a frame, and `moba2d-perf-guard` is what a
      // `pre-push` hook runs over the spell files a push is adding. Both are
      // in `files` beside these entries; the dynamic half lives in `tests/`,
      // is not shipped, and the guard says so rather than failing without one.
      'moba2d-perf-scan': './scripts/perf-scan.mjs',
      // Fourteen, not thirteen. `moba2d-duty-scan` is the balance-side sibling
      // of `perf-scan`: it reads how much of the time an ability's own power
      // state is up. It exists because capping twenty-four cooldowns to the
      // practice room's pace raised every one of those abilities' uptime
      // without anyone deciding it should, and reading the files by hand found
      // two of the four that mattered. A pack is its own repository and owns
      // its own balance, so it has to be able to run this from inside one.
      'moba2d-duty-scan': './scripts/duty-scan.mjs',
      // Fifteen, not fourteen, and the third scan for the same reason as the
      // other two. `moba2d-reach-scan` asks whether an ability's picture
      // reaches as far as its damage does — the two abilities it was written
      // from had each shipped for weeks with a hitbox their own art disagreed
      // with, and both were found by a player rather than by anything here,
      // because a test asserts on damage and nothing asserts on pixels. A
      // pack owns its own art and its own hitboxes, so it has to be able to
      // run this from inside its own repository.
      'moba2d-reach-scan': './scripts/reach-scan.mjs',
      // Sixteen, not fifteen, and the fourth scan. `moba2d-fill-scan` measures
      // the one cost every other instrument here is structurally blind to:
      // pixels blended, which is what a phone pays and what `perf-scan` cannot
      // see because one `circle()` is one call whether it covers ten pixels or
      // a million. It exists because a phone dropped to 15fps in a fight that
      // held 60 on a desktop and nothing in this repository could say why. A
      // pack owns its own art, so it has to be able to run this from inside
      // its own repository.
      'moba2d-fill-scan': './scripts/fill-scan.mjs',
      'moba2d-perf-guard': './scripts/perf-guard.mjs',
      'moba2d-generate-spell-catalog': './scripts/generate-spell-catalog.mjs',
      'moba2d-pack-new': './scripts/pack-new.mjs',
      'moba2d-pack-add': './scripts/pack-add.mjs',
      // Eleven, not ten. `verify` cannot see whether an effect is legible and
      // no unit test ever will, so the only honest check is to run the
      // ability and look at it — which needs core's own dev server and rig.
      // A pack that had to copy that would have copied it wrong: the last
      // three files the scaffold copied had all drifted, and one shipped a
      // published manifest pointing at a 404.
      'moba2d-shoot-vfx': './scripts/shoot-vfx.mjs',
      // Five, not four. The scaffold's `assetManifest.ts` told an author, in
      // its own header, that "core's own `scripts/generate-assets.mjs` is the
      // worked example" for a pack with more than a handful of images — and
      // that file was absent from `files`, so it was in no pack's
      // `node_modules` and the sentence pointed at nothing the reader could
      // open. A scaffolded pack shipped one placeholder tile and no way up
      // from it; the largest pack there is solved that by copying the whole
      // generator.
      'moba2d-generate-assets': './scripts/pack-assets.mjs',
      // Six, not five. A pack author does not have a checkout of core to run
      // the game from — they scaffold a repository and install their build
      // into a *hosted* copy by pasting a localhost URL. The thing standing
      // between the two is a static server with four exact headers, and
      // getting one wrong reads as an unexplained CORS error. So core ships
      // the server, the same way it ships the scaffolder.
      'moba2d-pack-serve': './scripts/pack-serve.mjs',
      // Seven, not six, and the same shape as `moba2d-generate-assets` two
      // entries up. `public/map-editor/` is core's, so the rules about which
      // of an export's fields may reach a player — never `id`, never
      // `authoring` — are facts about core's own format. They were learned
      // in a pack instead: a stray editor `id` rode a `{ ...summary,
      // ...geometry }` spread into `Game.activeMapId` and made a whole map
      // unjoinable over the wire (`src/content/activeMap.ts`). Leaving the
      // generator that strips it in whichever pack was bitten means the next
      // pack learns it the same way.
      'moba2d-generate-maps': './scripts/pack-maps.mjs',
      // Ten, not seven, and this trio is the same lesson a third time. All
      // three used to be files `moba2d-pack-new` *copied* into a pack, so a
      // fix to one was a fix to none — and the copies had already drifted.
      // `check-core-link.mjs` was byte-identical in every checkout that has
      // one (it describes core's own linking mechanism; there was never
      // anything for a pack to change). `check-unused.mjs` differed by the
      // package name in a single `console.log`, read from `package.json`
      // here. `write-manifest.mjs` was the one with a real cost: one copy
      // hardcoded `icon: 'icon.png'` where the template tests for the file,
      // which points a published manifest at a 404 the day somebody deletes
      // it. It also stopped declaring `coreRange` — that literal existed
      // here *and* in the pack's own data half, with a paragraph in each
      // saying they must move together and a pack test that regexed this
      // file's source to compare them. It reads `data.manifest` now, so
      // there is no second copy to police.
      'moba2d-check-core-link': './scripts/pack-core-link.mjs',
      'moba2d-check-unused': './scripts/pack-unused.mjs',
      'moba2d-write-manifest': './scripts/pack-manifest.mjs',
    });
    for (const target of Object.values(bin!)) {
      expect(existsSync(join(repoRoot, target)), `${target} does not exist on disk`).toBe(true);
    }
  });
});

/**
 * The gap the tests above cannot see, cost twice already: `package.json`
 * publishes a subpath's *entire* export list, not the bindings anyone had
 * in mind when they added it, and the checks above only pin that the
 * subpath list is exactly thirteen entries and that each target exists on
 * disk — never what is actually reachable through it. Task 3 published
 * `./testing/setup` and silently made a checkout-only lane cache
 * (`cachedLanesForTests`) importable by any pack; Task 5 added
 * `stripComments` to `src/seams/index.ts`, widening `./seams` with nothing
 * to notice either time. Both changes were reasonable — the invisibility
 * was the defect, and this is the same shape `tests/testing/
 * testingSurface.test.ts` already pins `./testing`, `./testing/spell` and
 * `./testing/spells` with, for the six subpaths that test does not cover.
 *
 * **Runtime bindings only.** `Object.keys()` on an imported namespace never
 * sees a `type`/`interface` export — those are erased before this file's
 * `import * as x` even runs — so `./content/types` pins to `[]` below on
 * purpose: every one of its exports is `export type`, and that empty array
 * is itself the fact worth pinning (a real value export landing there would
 * be exactly the kind of unnoticed widening this file exists to catch).
 * `./content/ContentApi` and `./content/ContentPack` mix interfaces with a
 * handful of real functions/consts; only the latter show up here. Widening
 * any list below is allowed and is meant to be a visible act, the same
 * contract `testingSurface.test.ts` states for its own two lists.
 */
describe('what each subpath actually publishes, not just that it exists', () => {
  it('./seams exports exactly this list', () => {
    expect(Object.keys(seams).sort()).toEqual(
      [
        'checkBuffDeactivate',
        'checkCastSpecFrozen',
        'checkCooldowns',
        'checkDashOnUpdate',
        'checkManaSpend',
        'checkPackAssetKey',
        'checkPackCoreBoundary',
        'checkSeams',
        'checkSpellObjectDisplayBox',
        'checkSpellRuntimeDrive',
        'checkStatResourceModifier',
        'checkTargetVision',
        'checkTargetingModeDeclared',
        'checkTerrainField',
        'checkUnitTargetTeam',
        'checkWorldMouseInSpellCode',
        // The map-rule entries are the odd ones out and belong here anyway:
        // every other name is a static *source* scan, these are geometric
        // rules over map data — can a minion body walk this lane, does every
        // turret have a wave that walks past it, is a paired camp the mirror
        // of its twin. They are published for the same reason the scans are,
        // that the rule belongs to the engine and the population belongs to
        // the content; and their single implementation lives in the map
        // editor's own plain JavaScript, because that tool has no bundler and
        // cannot import anything else. Three copies of those thresholds
        // existed before this (this repo's own test, a pack's, and the
        // editor's), and two of them already disagreed.
        //
        // A pack reaches them through `./testing/maps` instead — this barrel
        // carries core's source scanners and its own boundary checker, which
        // is not a surface content has any business in.
        'laneIssues',
        'laneRuleLimits',
        'mapIssues',
        'mapRules',
        'packAssetKeySeam',
        'packCoreBoundarySeam',
        'scanImports',
        'scannedSeamFiles',
        'seams',
        'staleSkipEntries',
        'stripComments',
        'structureIssues',
      ].sort()
    );
  });

  it('./content/ContentApi exports exactly this list', () => {
    // `ContentApi` itself is an interface — erased. `buildContentApi()` is
    // core's own installer alone; a pack never calls it (see
    // `pack-core-boundary`'s own `ALLOWED_TYPE_ONLY`), but it is a real,
    // reachable export of this module regardless of who is licensed to call
    // it, which is exactly what this test is pinning.
    expect(Object.keys(contentApi).sort()).toEqual(['buildContentApi'].sort());
  });

  it('./content/ContentPack exports exactly this list', () => {
    // `MINION_STYLES`, `MONSTER_TEMPERAMENTS`, `MONSTER_ROAM_LAYERS` and
    // `NEUTRAL_KINDS` join `STRUCTURE_KINDS` as runtime vocabularies for the
    // same reason it is one: the union type is erased by the time a published
    // pack's JSON reaches `validate.ts`, so the list of legal values has to
    // survive to runtime to be checked at all.
    expect(Object.keys(contentPack).sort()).toEqual(
      [
        'MINION_STYLES',
        'MONSTER_ATTACK_STYLES',
        'MONSTER_ROAM_LAYERS',
        'MONSTER_TEMPERAMENTS',
        'NEUTRAL_KINDS',
        'STRUCTURE_KINDS',
        'isSpellLoader',
        'lazy',
      ].sort()
    );
  });

  it('./content/types exports no runtime bindings at all', () => {
    expect(Object.keys(contentTypes)).toEqual([]);
  });

  it('./testing/setup exports exactly this list', () => {
    expect(Object.keys(testingSetup).sort()).toEqual(
      ['installEngineGlobalsForTests', 'installPackForTests'].sort()
    );
  });

  it('./testing/vitest exports exactly this list', () => {
    expect(Object.keys(testingVitest).sort()).toEqual(['moba2dPackTestConfig'].sort());
  });
});
