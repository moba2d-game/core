---
name: moba2d-ability-scaling-diagnosis
description: "Ability damage DOES scale automatically (Amplification.ts) — how to prove it in one test, and the two real reasons a champion still falls off late"
metadata:
  type: project
---

**"This champion's damage doesn't scale with stats" is almost always wrong, and
there is a two-minute way to prove it.** Core's `combat/Amplification.ts`
multiplies at the `takeDamage` funnel; no spell file writes a ratio.
`Spell.damageScalesWithAbilityPower` defaults true and `Buff` captures it **in a
field initialiser** — i.e. inside the applying spell's own bracket — so a DoT
applied frames later still scales. `AttackableUnit.updateBuffs` re-brackets each
buff as its own attribution, and `SpellObject.attributedTo` is stamped at
construction, so the whole chain **Spell → SpellObject → Buff → tick** carries.

**Measured 2026-09-06 on Singed's poison** (a two-hop chain, the least obvious
case): 3/tick base → **27/tick at abilityPower 7.9**, exactly ×8.9. Copy
`lol/tests/abilityScaling.test.ts`'s `burst()` shape; for a DoT, drive
`spell.update()` + `game.objectManager.update()` + `victim.update()` in a loop
until `victim.recentDamageLog` is non-empty, and read `hit.amount`.

**So when a champion really does fall off, look at these two instead:**

1. **Does the kit have a term that grows with what the *enemy* bought?** Flat
   damage against a pool that goes 100 → ~375 over a build is the whole problem.
   A `% of target maxHealth` term fixes it and needs no retuning when the shop
   moves. Precedent: `Item_DeadMansPlate` (`targetUnit.stats.maxHealth.value *
   RATIO`), `KogMaw_R.damageFor`.
2. **Does the ultimate grant the stat the kit actually reads?** Singed's granted
   maxHealth + speed + attackDamage — three stats that do nothing for a poison
   trail. `abilityPower` is a **fraction** in `StatAmp.bonuses`
   (`abilityPower: { baseBonus: 0.6 }` = +60%), and it is the only way a
   champion who spends gold on health ever scales.

**Shop scale to size against (lol, 2026-09-06):** health items +25..+70 each, so
a tank build reaches ~375 maxHealth on a ~100 base. AP items 0.5..1.5 each, six
best summing to **7.9** (= ×8.9 damage), which `abilityScaling.test.ts` pins.

**Read `docs/abilities/<champ>/*.json` before designing anything** — the wiki
import is cached in the pack and settled both Singed questions outright: `e.json`
says the fling damage is "based on the target's health ratio" (we shipped only
the flat half) and `r.json` lists ability power *first* among what the potion
grants (we granted none). Extract with `json.load` + strip `<[^>]+>` and
`[[...|x]]`; the `fields.description.raw` is wikitext.

**Don't port a cap whose premise doesn't hold here.** Upstream caps Fling's
health half at 300 against monsters because League camps carry thousands; the
biggest camp in this pack has **260**, so the share is 21 against a flat 28. A
branch that cannot change an outcome is one nobody can test. See
[[moba2d-vamp-and-heal-cut]] for the stat model and [[moba2d-lol-content]] for
the shop.
