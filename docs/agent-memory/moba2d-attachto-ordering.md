---
name: moba2d-attachto-ordering
description: "SpellObject.attachTo(unit, buff) must be called AFTER addBuff — before it, liveBuffOn resolves null and the effect detaches on frame one"
metadata:
  type: project
---

`SpellObject.attachTo(unit, buff)` resolves the instance the unit *actually
ticks* via `SpellObject.liveBuffOn` — `unit.buffs.includes(buff)`, else a
`stackId` match. Call it **before** `unit.addBuff(buff)` and there is nothing to
resolve: `_anchorBuff` is null, `_anchorWatchesBuff` is true, so
`attachmentLost` latches **true on the object's first update** and the effect
detaches immediately.

What that looks like in a match: the effect plays out at the point of the cast
and does not follow the champion. Found 2026-09-06 in `lol/spells/Tryndamere_E.ts`
— the whirling blades stayed where he pressed E while he dashed away. The
symptom reads as a *drawing* bug, so it is easy to go hunting in `draw()`.

**How to apply:** `owner.addBuff(buff)` first, then `obj.attachTo(owner, buff)`.
Objects that attach inside their own `onAdded()` (`Riven_E_Shell`,
`Sakura_R_Leap`'s siblings) are safe by construction — the flush happens after
the cast — which is why Tryndamere was the only offender in all three packs
(scanned: attachTo-line-number vs addBuff-line-number across lol/dota/naruto/core).

Two related traps in the same file family:
- A deactivated buff **stays in `unit.buffs`** until the unit's next `update()`,
  so `buffs.find(b => b instanceof Dash)` after three casts hands back the first,
  already-spent one. In tests, reach for the object's own `obj.dash` field.
- `isDead` is `deathData !== null`, not the health pool — `stats.health.baseValue = 0`
  does not make a corpse; call `die(...)`.

See [[moba2d-hit-feedback]] for the other half of the draw-vs-simulate seam.
