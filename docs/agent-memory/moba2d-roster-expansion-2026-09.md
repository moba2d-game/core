---
name: moba2d-roster-expansion-2026-09
description: "2026-09-06 — 30 champions added across all three packs in one session, plus where the wave-2 specs live and the per-pack traps that batch paid for"
metadata: 
  node_type: memory
  type: project
  originSessionId: a77d192d-ed59-472e-a2b7-9a5db74bd224
  modified: 2026-09-06T15:16:14.999Z
---

**2026-09-06, all committed and UNPUSHED.** Thirty champions landed, one agent
per repo so nothing collided on the shared roster files (`lol/data.ts`,
`dota/pack.ts`, `naruto/pack.ts` — those are why champion work and item work in
the same pack must be serialised, never run in parallel).

- **lol 67 → 77**: Aatrox, Akali, Braum, Draven, Fiora, Jax, Lucian, Miss Fortune,
  Mordekaiser, Xerath. Verify green at 134 test files / 1260 tests.
- **dota 9 → 19**: Anti-Mage, Lion, Sven, Drow Ranger, Phantom Assassin, Tidehunter,
  Mirana, Zeus, Queen of Pain, Bloodseeker. Green at 113 files / 829 tests, art 92 → 137.
- **naruto 7 → 17**: Neji, Zabuza, Haku, Itachi, Deidara, Rock Lee, Hinata, Jiraiya,
  Tsunade, Minato. Green at 36 files / 689 tests. **All 40 new spell icons are lettered
  placeholder tiles** from `art:placeholders`, on the ledger with no `sourceUrl` —
  deleting a placeholder is how you ask for it to be redrawn.

**Written specs, durable, ~360KB in `moba2d/_specs/`** (they were produced in a job
tmp dir that gets cleaned when the job is deleted — that is why they were copied out;
do the same for anything future agents park there): `lol-items-spec.md`,
`dota-items-spec.md`, `lol-champions-wave2-spec.md`, `dota-heroes-wave2-spec.md`,
`core-engine-gaps-plan.md`, plus an unrelated `scanbrowser-research.md`. Each carries
verified source ids/slugs, rescaled numbers with the arithmetic shown, and an honest
per-ability buildability verdict.

**Traps this batch paid for, none visible from the file you are editing:**

- **`dota`'s `check-seams` caps every `coolDown` at 20 000 ms.** Not in AGENTS.md, and
  `tempo.test.ts`'s "60s" is actively misleading — the seam is the real gate. The pack's
  ultimate band is 17-19s; a 45s ultimate is rejected outright.
- **`Dash` ends a flight within one step of the destination, so `dashSpeed` *is* the
  landing error.** At the free-aim speed of 190, a dash aimed at a body 400 away lands
  165 short. Body-aimed dashes need ~55. Assert with a tolerance, never an exact position.
- **The test spatial index is built, not watched** — a radius query after any body moved
  (including the caster mid-dash) needs `indexObjects` called again.
- **All three packs' typecheck compiles the other two**, via core's
  `src/generated/installedPacks.ts`. A sibling agent's broken file reddens *your* verify;
  check `../lol` / `../dota` / `../naruto` before believing a stray `error TS`, and never
  edit another pack to make your own gate green.
- **`lol`'s `names:sync` rewrites the first `name = 'X (tag)'` line in a file**, not the
  spell's — it once wrote a champion ability's Vietnamese name into a buff. Stack counters
  read `xN` now. Riot's vi_VN also ships four names with a trailing space;
  `scripts/wiki/sync-spell-names.mjs` now `.trim()`s.
- **`lol`'s ROSTER row has no `range` and no `defence` field** — `placedAttack`/
  `placedDefence` derive them from `generated/championRecordStats.ts`, clamped to
  `{min: 0.75, max: 1.3}` of the role mean. Only `boltUnitsPerSecond` is an override.
- **Miss Fortune imports as `--champion "Miss Fortune"`**, quoted with the space;
  `MissFortune` and `Miss_Fortune` are both rejected.
- **`lol` tests may not call `onSpellCast`/`onRecast`/`onChannelTick`/`onActivate`** —
  drive through `pressSpell`/`spell.update()`. `castspec-frozen` also flags arrow
  functions inside `castSpec`; `Xerath_Q` shows the module-level-function pattern.
- **naruto:** `Root` re-applied with `RENEW_EXISTING` keeps the *old* duration (use
  `REPLACE_EXISTING`); a `SpellObject` attached to a `Dash` buff is dropped by
  `dropIfAttachmentLost` on arrival, so attach to the unit; `actionState` folds in during
  the unit's own frame, so assert on `statusFlagsToEnable`, not `Dash.CanDash`.
- **Dota art slugs do not derive.** Sand King is a structural break — crop is `sand_king`,
  abilities are `sandking_*`, and `import-art.mjs` builds the ability URL as
  `` `${slug}_${ability}` ``, so no single column yields both (the wave-2 spec carries the
  `abilitySlug` patch). Zeus is `zuus` for portrait *and* all four abilities; Shadow Fiend
  is `nevermore`; Windranger is `windrunner`; Lich's Frost Blast is still filed
  `lich_frost_nova`. Wrong-but-200 alternates exist, so a bad pick ships silently.

**Two live bugs found and not yet fixed:** `lol`'s shop sits at gold-value ratio **2.062**
against its own hard `< 2.1` ceiling while `balanceReport.test.ts`'s comment still claims
1.81; and `dota/spells/CrystalMaiden_R.ts` declares `interrupts: SpellForm.HELD` while its
header and its player-facing card both claim movement breaks the channel — `CancelPolicy.ts`
shows `HELD` has `move: false`, so that card is lying today.

Related: [[moba2d-declared-never-wired]], [[moba2d-workspace-layout]], [[moba2d-lol-content]].
