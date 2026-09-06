---
name: moba2d-declared-never-wired
description: A family of core symbols that are declared but never emitted or set — the recurring reason a pack ability turns out unbuildable — plus how the ContentApi contract question actually resolves
metadata: 
  node_type: memory
  type: project
  originSessionId: a77d192d-ed59-472e-a2b7-9a5db74bd224
  modified: 2026-09-06T15:15:44.131Z
---

Four independent research passes on 2026-09-06 kept hitting the **same shape of
bug**: a symbol exists in core's public surface, so a pack author writes an
ability against it, and it is wired to nothing. Check for this before declaring
an ability buildable.

Confirmed members of the family:

- **`EventType.ON_HEAL`** — declared; `takeHeal` fires nothing. Killed LoL's
  Staff of Flowing Water and Echoes of Helia outright.
- **`EventType.ON_BUFF_ADD`** — declared; emitted nowhere. Forced Imperial
  Mandate to mark targets off magic damage instead.
- **`StatusFlags.InBush` (`1 << 12`)** — declared; **set nowhere**, grep returns
  exactly one hit. No bush query on `api.terrain` or `api.combat.Vision`. Killed
  Rengar's brush-leap.
- **`combat/DamageAttribution.ts`** — the inverse case: it *is* wired (`takeDamage`
  itself calls it) but is **not exposed on `api.combat`**, so `modifyIncomingDamage`
  cannot tell a pack whether a hit was an ability. Killed Sivir's spell shield and
  is the named gap in `Jax_E.ts`.

Adjacent hard limits, verified rather than assumed: **no unit facing angle at all**
(`grep facingAngle` in core is empty; `Champion.drawTrail` argues against adding one,
and spell damage carries the *caster's* position, not the projectile's) — so
Bristleback's rear-arc reduction has no honest answer; **a unit's own attack target
cannot be forced or restricted** (`AttackTargeting` only helps *choose*; `Taunt` runs
the opposite way) — so Windranger's Focus Fire loses its lock; **mana cannot be taken
from a victim** (`restoreMana` is the granting half only, and the mana-spend seam bans
naming `stats.mana` in `spells/` at all) — Anti-Mage's burn is modelled as a negative
`maxMana` ceiling instead; and **`die()` runs unconditionally inside `takeDamage` with
no hook between**, and calls `clearBuffs()` — so Karthus's Death Defied is not fakeable
past the Guardian-Angel clamp-to-1 trick.

**The ContentApi contract question resolves cleanly, and this is the part worth not
re-deriving:** `tests/content/apiContract.test.ts` recurses only into *plain objects* —
a class is one leaf and is never walked. `ON_HEAL` and `ON_BUFF_ADD` are **already in
`apiSurface.snapshot.json`**; `Buff.modifyIncomingDamage`, `AttackableUnit.takeHeal`
and `payAssists` are **not in it at all**. So emitting an already-declared enum member,
adding a method, or adding a TS interface field are all **no contract bump** — and all
three packs already declare `>=1.22.0`, core's current contract, so no-bump means
literally zero pack edits. Treat that as a **blind spot, not a licence**: a pack then
has no floor it can honestly name, which is the user's call to make. `contract:bump`
also raises core's minor and is never a side effect of unrelated work.

The one gap that is genuinely big: **a seam that intercepts an incoming cast has no
chokepoint** — effects reach a unit through three unrelated paths across 300+ pack
spell files, and only `UNIT`-targeted casts have a victim at press time. Recommended
against. But `Buff.blocksIncoming` already exists and *is* the "before a buff is
applied" hook `Morgana_E.ts` complains is missing, so the crowd-control half of a
spell shield is buildable today; the honest small fix is one optional 4th parameter on
`modifyIncomingDamage` carrying `currentAttribution()`, which `takeDamage` already
reads three lines earlier.

Full plan with file:line references: `moba2d/_specs/core-engine-gaps-plan.md`.
Related: [[moba2d-lol-content]], [[moba2d-roster-expansion-2026-09]], [[moba2d-core-subpath-and-map-rules]].
