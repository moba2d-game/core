---
name: moba2d-practice-presets
description: "Trận mẫu (match templates) + Mốc đã lưu (save points/rewind) — architecture, the restore-in-place law, what crosses sessions, and the traps paid"
metadata: 
  node_type: memory
  type: project
  originSessionId: ce7d1f5a-7224-4b55-809e-79ba23c29559
  modified: 2026-09-05T19:43:38.950Z
---

Landed 2026-09-06 on core main: `b129de0` (Trận mẫu), `d1230d8` (Mốc đã lưu). Both are practice-room features — no win/lose language anywhere (see [[moba2d-sandbox-not-win-condition]]).

**Trận mẫu** (`src/game/config/matchTemplates.ts`, key `moba2d:matchTemplates:v1`): a named save of `PregameConfig` (roster, per-bot autoMove/autoAttack/autoCast/autoBuy/autoReroll, rules, world, mode, mapId, cheats) + pack-qualified bags `{player, bots[][]}`. Bags are deliberately NOT in `PregameConfig` — they'd re-grant every ordinary boot and delete the shop; they're a one-shot stash the `Game` constructor consumes. Seam: `MatchConfigSource.templateSetup()/applyTemplateSetup()` served by both pregame and in-match sources (contract-tested); in-match apply goes through `MatchDirector.applyConfig()` (extracted from `resetToDefaults`) + `ItemShop.grantTemplateBag()`. UI is the same `MatchTab.vue` on both surfaces; one-press Bắt đầu only renders where the Bắt Đầu footer does (LAN lobby gets Áp dụng). Missing packs degrade via `templateGaps.ts` — warn line, skip, never crash.

**Mốc đã lưu** (`src/game/checkpoint/Checkpoint.ts`, `src/game/config/savedMoments.ts`, `CheckpointPanel.vue`): two tiers.
- In-match rewind is **restore-in-place on the same instances** — that law is what keeps every identity-keyed WeakMap alive (rearm parking in Buff.ts, ShopHistory, pack proc maps). Never clone-and-swap units. Buffs captured with live constructor refs (memory-held, never serialized), reconstructed in captured order, scalars assigned pre-`addBuff`, sourceSpell re-linked by name; death state re-applied directly, never via `die()` (no bounty/tally). Bag restored as a per-slot diff in the LAN `applyBag` shape so unchanged slots keep armed spells.
- Cross-session reopen = template machinery + `stashMomentBoot` (seed consumed before `spawnJungle`) + `applyMomentOverlay` over the built world. Carries gold, positions, pools, cooldowns, death state, wave clock, camps, matchTimeMs, and spell-held state (stackCount + reflected own-enumerable scalars). **Does NOT carry running timed buffs**: the LAN wire has no buff vocabulary at all (clients replay spells locally), and `constructor.name` dies under minification — stated in the UI ("buff tạm thời không theo mốc qua phiên").
- LAN gate is three-deep: hidden buttons, refusing hud methods, and `restoreCheckpoint`'s own `world.net` guard.
- HUD entry is a top-left corner button — `CORNER_BUTTON_BOX` forbids a third top-right button. Death screens (DeathRecapPanel + SpectateBar) carry "Thử lại từ mốc gần nhất". Auto "Đầu trận" checkpoint at boot.

Deferred, plumbing ready: 30s out-of-combat auto-checkpoint cadence (`auto` flag + "Tự động" tag exist); toggle/channel spells restore not-sustaining; pets dropped on rewind (recast brings them back).

**Turret husks + relic/shop rewind** (`a10c6aa`, 2026-09-06): turrets were NEVER removed on death — they already died in place with a 30s auto-rebuild clock (my "turrets vanish" explanation was wrong). Now `reviveTime = Infinity`: rubble stays until a rewind or `resetToDefaults` revives it (owner not yet asked whether the old 30s auto-rebuild should return; `rebuildTime` tuning key kept in schema but inert). `respawn()` re-hangs preset passives (pre-existing loss through clearBuffs); LAN needed zero wire change (dead flag already synced; the die() clamp also fixed a client-side hardcoded 1-hour revive). Overlay gained optional `turrets` (Game.turrets order) and `relics` (`cooling/coolingTotal`, walk covers `_objectToBeAdd` because overlay applies pre-flush); shop undo stacks captured as slices (length-truncation rejected: the cap shift()s the front). Trap: `Turret.test.ts` imports packs/riot and is excluded on dev machines — core-only turret tests go in `TurretHusk.test.ts`. Known edge: rewind after the bag CHANGED since capture → a rebuilt item passive re-arms fresh next frame and can replace that one restored passive-buff's state (identical-bag rewinds keep full fidelity).

Feasibility facts that shaped this (from the 2026-09-06 investigation): deterministic replay is dead in this engine — raw `Math.random()` in crit rolls (`BasicAttack.ts`), bot jitter, ~95 pack call sites, and `matchSeed.ts` explicitly rejects a shared RNG stream ("seed is a value, not a stream"). Any future rewind/replay work must stay a state snapshot.

**The rewind-clock family** (found by playtest 2026-09-06, fixed in four commits with tests each): every subsystem that stamps `matchTimeMs` into a field breaks when a rewind pulls the clock behind the stamp — negative age never grows old, so TTL gates hold forever. Fixed with per-subsystem `rewindTo`/`rewindClocks` called from `restoreCheckpoint`: MatchAnnouncer (rows + kill runs + first blood re-untaken), BotBrain (think/cast/damaged/push stamps, pending charge/recast, toggles) + TeamBlackboard (forget the future-built view), AttackableUnit (lastCombatMs, fog-reveal deadline, assist ledger, both recap ledgers — walked for every object in the world), DeathCamera (clamps a future corpse stamp in its own tick). Audited safe: countdowns, `performance.now`/`Date.now` stamps, SpellRuntime's own elapsed accumulator, capture-restored spell/buff fields, LAN (refused wholesale). Any NEW absolute-stamp field must join a rewind hook or use a countdown.

**Death-retry arming rule:** the shortcut auto-rewinds only to the newest DELIBERATE save; with none it opens the shelf instead — the auto "Đầu trận" anchor must never be one press from a death (owner: "người mới... bấm phát nó rewind về đầu trận là cay lắm").

Trap receipts: `pregameBootPath.test.ts` has a config carve-out allowlist that new config modules must join; chunk check's pregame ceiling and the 7 dev-linked vitest failures are pre-existing (A/B against baseline HEAD before blaming new work — see [[moba2d-bot-shopping]]).
