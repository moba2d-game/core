---
name: moba2d-stealth-and-summon-scaling
description: "Stealth now breaks on damage only (not on casting), and a summon's damage finally scales with its summoner — the three-part core fix and the test traps both halves hit"
metadata: 
  node_type: memory
  type: project
  originSessionId: 665212cc-7818-4af2-ad5e-3ee385564f6d
  modified: 2026-09-09T21:59:16.604Z
---

Landed 2026-09-10 on the user's report about Shaco ("W hộp hề ko scale theo stats",
"Q ko nên bị huỷ tàng hình khi dùng W+R"). Both were core bugs, not pack bugs, and
both were fixed at the engine level for every champion in all three packs.

**Stealth: damage, not casting.** `combat/StealthBreak.ts` used to end a stealth on
*any accepted cast* (`Spell.press`, gated by a now-deleted `Spell.breaksStealth`
flag, whose only opt-out was `Recall`). The rule is now: a stealth ends when its
owner **deals or takes damage**, enforced in `AttackableUnit.takeDamage` (both ends,
right after the `damage <= 0` guard, before mitigation). The one seam that is not the
damage funnel is still `BasicAttackController.launch` — a committed swing reveals
before its bolt lands, same reasoning as `combat/AttackReveal.ts`.
**A tick of `DamageOverTime` reveals neither end** — asked for in the same session
once the Twitch case was flagged, and implemented as `revealsStealth` on the
*attribution* (`DamageAttribution`), defaulting true, opted out by that one buff, with
the flag also on `Buff` so a hand-written burn can do the same. Both ends on purpose:
otherwise a poisoner cannot use their own stealth, and a single burn hard-counters
every stealth in the game. Applying the poison still reveals.
dota's Glimmer Cape card was reworded because its "đánh hay dùng chiêu không làm lộ"
claim had already been false for attacking.
One exemption exists: a stealth buff that *also* clears `Targetable`
(`statusFlagsToDisable`) is never torn off — Pantheon's R skyward buff carries
Stealthed|Stunned|Ghosted in one buff, and `deactivateBuff` would drop him out of his
own ultimate. See [[moba2d-decoys-and-hidden-traps]].

**Summon scaling took three edits, and any one alone changes nothing:**
1. `Pet.attributedTo = currentAttribution()` (stamped at construction like
   `SpellObject` does) — without it `abilityPowerScales()` was **false** for
   everything a pet did from `update()`, so no pet damage in any pack was amplified
   at all, and the recap named nothing.
2. `Pet.abilityDamageOwner → ownerUnit`, followed by `Amplification.buildOf` — the
   box deals the hit but the *summoner's* build is what it reads. Deliberately not
   "pass the champion as the attacker": the attacker is who gets turret aggro,
   `lastCombatMs`, and the assist ledger.
3. `landBasicAttack` now brackets itself with `BASIC_ATTACK_ATTRIBUTION`
   (`damageScalesWithAbilityPower: false`). Before, a swing was non-ability only
   *by accident* (ambient was null); with (1) a pet's autos would have started
   double-dipping AP on top of AD. Proved: 10 → 30 without the bracket.

Roughly ten pet abilities across the three packs now scale where their `dmg()`
tooltips had been promising it — see [[moba2d-hud-effective-numbers]] and
[[moba2d-damage-text-helpers]].

**The seam is published on `AttackableUnit`, not on `Pet`**, because the second
body that needs it is not a pet: `lol`'s `Zed_W_Clone extends Champion` directly
(same file already carries the `killCredit = 'none'` override for the same
inheritance reason). Its mirrored abilities were dealing their authored numbers
forever — reported 2026-09-10, fixed with a three-line `get abilityDamageOwner()`.
Any future "clone/mimic that re-casts its owner's kit" needs that line.

**Traps paid for in this session:**
- A pet's damage cannot be tested by calling `pet.update()` — the attribution only
  exists inside `ObjectManager.attributed`, so drive `objectManager.update()`, and
  **twice**, because `addObject` lands on the next tick.
- `lol/tests/noCoreReach.test.ts` asserts an exact **count of scanned test files**
  (139 → 140). Adding any pack test file fails it until the literal is bumped.
- Core's vocabulary gate reads comments: "Shaco" and "Pantheon" in new core doc
  comments failed `vocabularyBoundary` + `corePackTarball` — see
  [[moba2d-monster-attack-vfx]]. And `tests/game/types/BuffUnitTypes.test.ts` bans
  the bare word **"any"** in `Buff`/`AttackableUnit`/`buffs/*` — prose included, so
  "any other hit" in a doc comment fails it. See [[moba2d-pet-kill-credit]].
- A test that drives a `DamageOverTime` needs `installSketchMathGlobals()` too: its
  flames roll `random(0, TWO_PI)` on every tick.
- Packs resolve `@moba2d/core` to its **TypeScript source**, not `dist/`, so core
  edits are live in pack tests with no rebuild.
- `npm run verify` cannot run while the three packs are linked (`links:check`
  refuses); the baseline is **7 failing core tests**, all pack-registry ones.
  See [[moba2d-workspace-layout]].

All of it is uncommitted in `moba2d-core`, `lol` and `dota` as of that date.
