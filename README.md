# MOBA2D Core

[![Build](https://github.com/moba2d-game/core/actions/workflows/build.yml/badge.svg)](https://github.com/moba2d-game/core/actions/workflows/build.yml)
<!-- aio-desktop-badge:start -->
[![AIO Desktop](https://img.shields.io/badge/Try-AIO_Desktop-7c3aed?style=for-the-badge&logo=googlechrome&logoColor=white)](https://fbaio.org/#/desktop)
<!-- aio-desktop-badge:end -->

A 2D MOBA engine that runs entirely in the browser — team fights, bot opponents, fog of war, lanes and minion waves, and an installable PWA that plays offline.

**This repository is the engine, not a game's worth of content.** It ships one champion of its own (Vera, in `packs/reference/`) and one map. Every larger roster arrives as a **content pack**: a separate package, built against a published `ContentApi`, that the game fetches from a URL at runtime. See [Content packs](#content-packs).

**[▶ Play](https://moba2d.pages.dev/)**

> Working on this repository with an AI coding agent? [`CLAUDE.md`](./CLAUDE.md) is the briefing — the invariants, the seams that enforce them, and which doc to open for a given task. This README is the human tour.

## Contents

- [What core is](#what-core-is)
- [Controls](#controls)
- [Getting started](#getting-started)
- [npm scripts](#npm-scripts)
- [Project layout](#project-layout)
- [Architecture](#architecture)
- [Content packs](#content-packs)
- [Assets](#assets)
- [The map editor](#the-map-editor)
- [Testing](#testing)
- [Contributing](#contributing)
- [Trademarks and third-party assets](#trademarks-and-third-party-assets)

## What core is

TypeScript throughout: [p5.js](https://p5js.org/) draws the canvas, [Vue 3](https://vuejs.org/) drives the HUD, [Vite](https://vitejs.dev/) bundles it.

- **A spell runtime** — skillshots, charged casts, channels, recasts, shields, heals, and a full spread of crowd control, all driven by a typed `castSpec` lifecycle rather than hand-rolled state.
- **A kit builder**: mix and match abilities from an installed roster into a custom loadout, save it, and drop it onto yourself or any bot.
- **Team fights** — Blue vs Red, with bots, neutral jungle camps, fountains and turrets, and three lanes of minion waves.
- **A bot brain** with a posture FSM, lane assignment, turret-threat geometry, and no ability to see through terrain.
- **Fog of war** built from a visibility-polygon sweep, with bushes and walls that really do block line of sight.
- **Touch controls** and a mobile-friendly HUD alongside mouse and keyboard.
- **Installable as a PWA** — plays offline once cached.
- **A content-pack SDK**: champions, spells, maps and monsters are packages built against a public `ContentApi`, never code forked into this repository.

## Controls

| Action                                     | Key                        |
| ------------------------------------------ | -------------------------- |
| Move / attack target                       | Right click ground / enemy |
| Abilities                                  | `A` `Q` `W` `E` `R`        |
| Summoner spells                            | `D` `F`                    |
| Recall to fountain                         | `B` (hold)                 |
| Toggle camera follow                       | `Space`                    |
| Zoom                                       | Mouse wheel                |
| Nav debug overlay                          | `N`                        |
| Match config panel (pause + live settings) | `Esc`                      |

Charged abilities are held down and fire on release. `Esc` pauses and opens the config panel rather than leaving the match — exit from the panel's _Trận đấu_ tab.

## Getting started

Requires [Node.js](https://nodejs.org/) 20 or newer.

```bash
git clone https://github.com/moba2d-game/core.git
cd moba2d-core
npm install
npm run dev
```

Open the URL Vite prints (http://localhost:5173 by default). You will get the menu, a match, and one champion — that is core standing on its own, which is exactly what CI gates.

> `npm run dev` runs `assets:generate` and `vendor:copy` first, so the asset manifest matches what is on disk and p5 is served locally rather than from a CDN.

Production build:

```bash
npm run build     # emits dist/
npm run preview   # serve the built output
```

## npm scripts

| Script                                             | What it does                                                                                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                      | Dev server with hot reload (copies vendor libs + regenerates assets and the spell catalogue first)                                                                                     |
| `npm run build`                                    | Production build into `dist/`                                                                                                                                                          |
| `npm run preview`                                  | Serve the built output                                                                                                                                                                 |
| `npm test`                                         | Run the unit suite once                                                                                                                                                                |
| `npm run test:watch`                               | Run the unit suite in watch mode                                                                                                                                                       |
| `npm run typecheck`                                | Type-check the whole project                                                                                                                                                           |
| `npm run typecheck:core`                           | Strict type-check of the core modules                                                                                                                                                  |
| `npm run typecheck:sw`                             | Strict type-check of the service worker, which needs the WebWorker lib rather than the DOM one                                                                                         |
| `npm run verify`                                   | **Everything CI runs** — installed-packs/asset/catalogue checks, all three type-checks, tests, build, the per-champion chunk check, and the source-scan seams. Run before opening a PR |
| `npm run verify:all`                               | `verify`, plus the reference pack's own `check-seams`                                                                                                                                  |
| `npm run assets:generate` / `assets:check`         | Regenerate / verify the asset manifest from `assets/`                                                                                                                                  |
| `npm run catalog:generate` / `catalog:check`       | Regenerate / verify the generated spell catalogue                                                                                                                                      |
| `npm run vendor:copy`                              | Copy p5 from `node_modules` into `public/vendor/` (the PWA needs it local, not on a CDN)                                                                                               |
| `npm run pack:new`                                 | Scaffold a new content pack — see `docs/PACK_AUTHORING.md`                                                                                                                             |
| `npm run chunks:check`                             | Fail if a per-champion spell chunk leaked, or if menu/pregame code reached the match chunk                                                                                             |
| `npm run check-seams`                              | Run the source-scan seam rules (`pack-core-boundary`, `dash-onupdate`, and the rest) over core's own spell/buff/attackable-unit trees                                                  |
| `npm run e2e:core-alone`                           | Drive a real browser to a real, playable match with no optional content pack installed                                                                                                 |
| `npm run e2e:runtime-pack`                         | Serve a built pack from a second origin and prove it installs, grows the roster, and casts                                                                                             |
| `npm run e2e:packs`                                | Drive the packs screen: paste a URL, see the origin disclosure, confirm or cancel, remove — the management-screen half of the runtime-pack claim                                       |
| `npm run e2e:pwa`                                  | Build, then verify the PWA boots and plays offline in a real browser                                                                                                                   |
| `npm run e2e:pack` / `e2e:map-picker` / `e2e:bots` | Narrower Playwright scripts — see `tests/e2e/` for the full list                                                                                                                       |
| `npm run verify:pack-standalone <path>`            | The pack-repository acceptance drill: pack core, install it from that tarball into a fresh sandbox alongside a scaffolded pack, and prove both green                                   |

## Project layout

```
src/
├── main.ts                    # entry point: boots p5 (global mode) and the SceneManager
├── sw.ts                      # the service worker, hand-written (see its own header)
├── scenes/                    # LoadingScene → MenuScene → GameScene
│   └── setup/                 # pregame setup screen (roster, kit builder, rules)
├── content/                   # the pack boundary: registry, install, validate, packSource
├── game/
│   ├── Game.ts                # main loop, owns camera/objectManager/terrainMap/fogOfWar
│   ├── MatchDirector.ts       # every mutation of a running match, and the only thing that persists them
│   ├── ai/                    # the bot brain: posture FSM, lanes, turret threat, aim prediction
│   ├── gameObject/
│   │   ├── attackableUnits/   # Champion, AIChampion, Minion, Monster, Turret
│   │   ├── coreSpells/        # engine-owned spells only — champion abilities live in a content pack
│   │   ├── spellObjects/      # base classes: Missile, Area, Beam, HomingMissile
│   │   ├── buffs/             # Stun, Slow, Shield, Invisible, ...
│   │   ├── structures/        # Turret, Fountain
│   │   └── map/               # TerrainMap, FogOfWar, Camera, Obstacle, Minimap
│   ├── combat/                # Vision, MatchTally, ExecuteTargeting
│   ├── nav/                   # NavGrid pathfinding
│   ├── managers/              # ObjectManager (quadtree), MinionSpawner, EventManager
│   ├── input/                 # keyboard/mouse + TouchControls
│   ├── spell/runtime/         # the spell lifecycle state machine
│   ├── config/                # PregameConfig, savedKits (localStorage)
│   ├── enums/                 # TeamId, ActionState, StatusFlags, SpellState, EventType
│   ├── vfx/, debug/           # shared VFX helpers, nav/debug overlays
│   └── hud/                   # Vue-based HUD, incl. hud/config/ (the Esc panel)
├── managers/                  # AssetManager, SceneManager
├── pwa/                       # service worker registration and the update prompt
├── seams/                     # the source-scan rules `check-seams` runs
└── generated/                 # script-generated manifests — do not hand-edit
packs/reference/               # core's own champion and map, and the worked example for pack authors
```

## Architecture

**Spell lifecycle.** Every spell declares a `castSpec` describing how it is cast — press, hold-and-release, channel, or recast — and `SpellRuntime` runs the `READY → CASTING/CHARGING → ACTIVE → COOLDOWN` state machine, including resource commit, refund on interrupt, and interrupt sources (death, stun, silence, displacement). Spells implement only the `onCastStart` / `onRelease` / `onSpellCast` hooks.

**Spell objects.** Projectiles extend `MissileSpellObject`, area effects extend `AreaSpellObject`, lines use `BeamSpellObject` — note that the beam is hit detection only and **does not draw itself**, so subclass it and write a `draw()`.

**Collision and queries.** `ObjectManager` maintains a quadtree rebuilt each frame; all target selection goes through `queryObjects({ area, filters })` with the ready-made predicates in `PredefinedFilters`.

**Crowd control.** Buffs raise and clear bits in `StatusFlags`, which the system resolves into `ActionState` (can move / can cast / targetable).

**Teams and lanes.** A running match assigns the player to Blue and balances bots across Blue/Red; champions share their side's fountain, turret row, and lane minions. `MinionSpawner` runs mirrored waves down the three paths in `lanes.ts`, including melee, caster and cannon minions.

**The bot brain** (`src/game/ai/`) is one shared FSM — `RETREAT RECOVER DISENGAGE FIGHT SEARCH ENGAGE PUSH ROAM` — with lane assignment, turret-ring geometry, and spell scoring. It reads the whole object list exactly once per 250ms, through `TeamBlackboard`, and a source scan keeps it that way.

**The match config panel** (`Esc`) is one component mounted in two places — over the menu and over a paused match — behind the `MatchConfigSource` seam, so a control cannot exist on one screen and not the other.

**PWA.** The build copies p5 into `public/vendor/` and loads it locally instead of from a CDN, and a hand-written service worker (`src/sw.ts`) precaches the app shell and caches installed packs, so the game boots and plays fully offline after the first visit.

Details live in [`docs/ADDING_SPELLS.md`](./docs/ADDING_SPELLS.md) — **read it before writing a spell.** Writing one for a pack of your own starts a level up, at [`docs/PACK_AUTHORING.md`](./docs/PACK_AUTHORING.md).

## Content packs

Core reaches every champion, spell, map or monster beyond its own single reference champion through a content pack: an ordinary package that depends on `@moba2d/core` and never imports its internals as a value, only through the published `ContentApi`.

There are two ways a pack gets in.

**At runtime, from a URL.** The game fetches `manifest.json`, checks it against core's version, imports the entry, and installs it during the loading screen — no rebuild of core involved. A first boot with nothing installed seeds one default URL; after that the list is the player's, stored in `localStorage` under `moba2d:packs:v1`.

**At build time, as a dependency.** Still supported, for a developer who wants a pack in the tree while working:

```bash
npm install github:moba2d-packs/lol
npm run packs:generate     # rewrites src/generated/installedPacks.ts
npm run dev
```

`packs:generate` is what makes the pack visible to `src/content/install.ts`; `predev`/`prebuild` already run it. Uninstalling the package and re-running it puts core back to one champion; nothing else has to be undone.

**No CI proves this composes.** Neither repository's automation puts core and a pack in the same tree; `npm run e2e:runtime-pack` and `npm run e2e:pwa`, run locally against a sibling pack checkout, are what check the join.

**A pack is code, not data.** It is JavaScript running on the game's own origin, with the game's `localStorage` and the game's DOM. `validate.ts` rejects a pack of the wrong _shape_ — missing fields, wrong types, a duplicate id — and rejects nothing that is deliberately hostile. Install packs from sources you trust.

[`docs/PACK_AUTHORING.md`](./docs/PACK_AUTHORING.md) is the whole guide to writing one, starting from `npx moba2d-pack-new`.

## Assets

Images and JSON live under `assets/`. `npm run assets:generate` walks that tree and emits `src/generated/assetManifest.ts` with a typed `AssetKey` union, so a typo in an asset name is a compile error rather than a broken image at runtime. To add art, drop the file in the right folder and re-run that script. A content pack has the identical pair of scripts, scoped to its own art and its own generated manifest.

`tools/` also holds [shape-maker](./tools/shape-maker/), a standalone p5 app for drawing a map's polygon data.

## The map editor

`src/mapEditor/` is a full map editor, served with the game at `<game>/map-editor/` and reachable from the menu's **Tạo map**. It draws terrain, spawn/turret/minion/jungle slots and lanes straight into the `MapGeometry` shape `ContentPack.ts` defines, so a map drawn there installs through `PackRegistry.installData` — the same door a published pack uses, with the same validator — and is playable from the picker without a rebuild.

**It is a separate document on purpose** — its own Vite entry (`map-editor/index.html`), loaded as its own page rather than as part of the game bundle, so the editor never costs the game a byte. It is ordinary TypeScript under `src/`, typechecked with everything else and free to import core (`ui.ts` takes `TUNING_SCHEMA` from `@/game/config/tuningSchema`); only its CSS, tracing images and two classic-script libs sit in `public/map-editor/`. Being a separate document is what still limits it at *runtime*: the two halves share two `localStorage` keys and nothing else, held by two tests that drive the real editor — `tests/content/localMaps.test.ts` for maps going out to the game, `tests/content/editorCatalog.test.ts` for the map list coming in. **Rename a key on either side and those tests are what tell you.**

**One map screen, and it is the editor's.** The editor's *Map của bạn* lists the author's drafts and, beneath them, every map the game has installed — core publishes that list (`src/content/editorCatalog.ts`) on the way into the editor. It briefly worked the other way, with a picker in the menu, and that was wrong twice over: two map lists holding two different sets that could not see each other, and a panel that could not fit on a landscape phone.

Two things a contributor is most likely to want:

- **Editing a map that already exists.** Open a copy from *Từ game*. The pack's own map is never touched — a pack is read-only — so the edit saves as a new local map, and deleting it takes it back out of the game's picker.
- **The cut pieces come back together on their own.** A pack map ships *cut* — `TerrainField` and `Vision` are only correct on convex polygons, so Summoner's Rift is 329 pieces for 69 walls — and opening one rebuilds the drawn shapes as its own undo step. Every merge has to pass a grid-sampling check that the transform cannot grade itself on; one that fails leaves the pieces alone. Anywhere else the editor only *offers*: **Sửa → Gộp polygon dính nhau**.

[`docs/MAP_EDITOR.md`](./docs/MAP_EDITOR.md) is the full guide — controls, the object model, the checks it runs, and the code layout.

## Testing

**Unit tests** run under Vitest with no browser: every p5 drawing global is stubbed with a spy, so a test can prove which primitives a spell asks for and how its logic behaves.

```bash
npm test
npx vitest run tests/game/spells/MySpell.test.ts   # a single file
```

House rule: **tuning values are exported as constants from the spell file and imported by its test.** Tests assert the wiring, not a copy of the numbers — retuning damage should never mean editing a test.

**End-to-end** tests drive real Chrome through Playwright, because a unit test cannot prove the game boots and paints. `tests/e2e/` has 25+ scripts covering the config panel, touch controls, minimap, kit builder, runtime pack install, and the offline PWA boot — run the one that touches what you changed rather than the whole folder:

```bash
npm run e2e:core-alone              # a real, playable match on core alone
npm run e2e:pwa                     # build, then boot and play with the network cut
node tests/e2e/drive-practice-panel.mjs
```

Scripts reach into the running game through `window.__moba2d`, which only exists in dev builds. `MOBA2D_CHROME_CHANNEL=` (empty) swaps system Chrome for Playwright's bundled Chromium. Scripts that need a pack read one from a sibling `moba2d-content-riot` checkout, or from `MOBA2D_PACK_DIST`.

## Contributing

Contributions are welcome. What you need to know:

1. **Fork and branch** off `main`.
2. **Run `npm run verify` before opening a PR.** It runs exactly what CI runs. That is the repository's complete offline check.
3. **Adding a spell?** Read [`docs/ADDING_SPELLS.md`](./docs/ADDING_SPELLS.md) first — or [`docs/PACK_AUTHORING.md`](./docs/PACK_AUTHORING.md) if the spell belongs to a content pack. There are three registration points, and missing one means the spell never shows up.
4. **Bring tests.** Export the tuning constants from the spell and import them in the test rather than copying numbers.
5. **Look at it.** If your change is visual, open the real game — or write a script in `tests/e2e/`. A test asserting `draw()` was called proves nothing about how it looks.
6. **Formatting** follows Prettier (`.prettierrc`: 2 spaces, single quotes, trailing commas, 100 columns).
7. **Comments explain _why_, not _what_.** Prefer recording the reason an approach was chosen, or the trap that forced the code into its current shape.
8. **Do not add third-party art.** See the section below — core is meant to be installable and redistributable on its own.

## Trademarks and third-party assets

This is a non-commercial, unofficial hobby project. It is **not affiliated with, authorised by, or endorsed by [Riot Games](https://www.riotgames.com/)**, and it generates no revenue.

The engine's own code is original, and so is every pixel it draws. The menu wordmark is type in this project's own palette, the menu background is two CSS gradients, and the mark on the loading screen, the favicons and the PWA icons are all generated from `assets/images/others/logo.svg`, which is a hexagon this repository drew.

**The gameplay art it inherited is gone too.** Twenty status-effect glyphs, the basic-attack icon and the mouse cursor came across from the project this engine grew out of and are now redrawn from source this repository owns: `tools/icons/**/*.svg`, rasterised by `node scripts/render-icons.mjs`. The three `assets/images/screenshots/*.jpg` were deleted rather than replaced — nothing in the game rendered them, and they had been shipping into every build regardless.

Two things about that set are worth knowing before changing it:

- **A buff icon is a mechanic's icon, not a pack's.** `StatusFlags` is an engine vocabulary — a stun is core's stun whoever cast it — so this set is shared and there is no override. `tests/content/buffIcons.test.ts` enforces it, after two buffs were caught pointing at content art. A pack needing a status core does not have ships its own `Buff` subclass, carrying its own art, through `ContentApi` — no new mechanism required.
- **The SVG is the source.** Edit `tools/icons/`, re-run the renderer, commit both halves. `scripts/render-icons.mjs --check` fails when they drift, and the glyphs share one palette and one stroke convention so the set keeps looking like a set.

Champion art, ability icons and champion names for the 58-champion roster are **not** here at all: they live in the separate content pack, which is where Riot-derived material belongs — and the packs screen names that pack for what it is, because a player deciding whether to install something has to know what it contains.

League of Legends and all related trademarks, characters, artwork and other assets are the property of Riot Games. This project claims no ownership over that intellectual property. None of it is in this repository — that is what the section above is for.

<!-- aio-desktop:start -->
### 🖥️ AIO Desktop

**EN:** Find this game and many more free tools & games in **[AIO Desktop](https://fbaio.org/#/desktop)**, a Windows/macOS-style web desktop by Social AIO. [▶ Open AIO Desktop](https://fbaio.org/#/desktop)

**VI:** Xem game này cùng nhiều công cụ, trò chơi miễn phí khác trong **[AIO Desktop](https://fbaio.org/#/desktop)**, màn kiểu Windows/macOS của Social AIO. [▶ Mở AIO Desktop](https://fbaio.org/#/desktop)
<!-- aio-desktop:end -->
