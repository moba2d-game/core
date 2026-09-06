---
name: moba2d-decoys-and-hidden-traps
description: Pet.disguisedAsChampion (one core flag for every decoy clone) and why a hidden Pet must draw nothing but its own picture
metadata:
  type: project
---

Landed 2026-09-06, uncommitted (another agent was mid-edit; user said "đừng commit vội").

**`Pet.disguisedAsChampion`** — new core flag on `Pet`. A decoy sets it and the body
presents as a champion: full 125px frame, no lifetime clock, and the *champion's*
compact knobs at mobile zoom. It replaced a hand-rolled version that already existed
in the naruto pack (`Naruto_W_Clone` had two field overrides restating 88/true plus
`api.units.Champion.prototype.drawHealthBar.call(this, compact)`); that pack now sets
the flag instead. `Shaco_R_Clone` (lol) sets it too.

**The knobs are accessors now, not fields.** `Champion.compactBarWidth` /
`compactShowsBuffIcons` became `protected get`, because a *subclass's* field
initialiser runs after `Pet`'s — a decoy would be measured before it declared itself.
Any pack overriding them as properties is a TS2610 build break, which is exactly how
naruto was found.

**Presentation only.** `killCredit`/`wallet`/`goldBounty` stay a summon's on purpose:
`TeamBlackboard` reads `killCredit !== 'champion'` so a bot team never rallies onto a
clone. Bots are deliberately *not* fooled; the deception is for human eyes.

**The trap bug: `Untargetable.draw()` painted three rings at a fixed alpha.**
`Pet.setHidden` pairs `Invisible` + `Untargetable`; `Stealthed` only fades the body to
`animatedValues.alpha === 20`, it does **not** cull it — so a buried Shaco box was a
ring of light on empty ground while the crate under it was invisible. Two fixes: the
rings now scale by the unit's alpha, and `Pet.draw` returns after `drawAvatar()` while
`hidden` (no bar, no clock, no buffs, no facing line). A hidden pet's whole picture is
whatever its subclass paints — see Teemo R's shroom at alpha 25 for the target look.

Numbers a decoy must copy itself (only the spell knows who it is impersonating):
maxHealth (drives tick-mark count), current health, maxMana, size, speed, the whole
attack profile (range alone decides melee vs ranged), and `score`. Current mana can't
be copied — the `mana-spend` seam bans a pack naming `stats.mana`, and `restoreMana`
only grants.

Related: [[moba2d-hud-stacking]], [[moba2d-flat-ui]], [[moba2d-naruto-pack]].
