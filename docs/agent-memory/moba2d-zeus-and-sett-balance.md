---
name: moba2d-zeus-and-sett-balance
description: "Zeus (dota) nerfed to champions-only with real landing delays, and Sett R made to scale off the carried body — what the user asked for and the rules that came out of it"
metadata: 
  node_type: memory
  type: project
  originSessionId: 665212cc-7818-4af2-ad5e-3ee385564f6d
  modified: 2026-09-09T22:56:28.859Z
---

Two balance reports, 2026-09-10, both uncommitted.

**Zeus felt oppressive** — "tức thì / ko animation hay charging + toàn bản đồ + ko né
đc kể cả tướng ko thể chọn làm mục tiêu + trụ và lính và quái cũng dính luôn, fam
lính fam mạng fam rừng dễ ẹt mỗi khi có R". Four fixes, all in `dota/spells/Zeus_*`:

- **R walked `objectManager.objects` and hit everything on it** — the wave, the
  camps, the towers — on a 19s cooldown, while its own card had always said "mọi
  tướng địch". Now `Zeus_R.picks()`: `instanceof Champion && !(instanceof Pet)`.
  The `Pet` half is load-bearing (`Pet extends Champion`) and is what keeps trap
  boxes and decoys off it.
- **R and W now land after a fall** (`R_STRIKE_DELAY_MS = 400`, `W_STRIKE_MS`
  90 → 250). The payload moved out of `onSpellCast` into the bolt object's
  `update()`, which re-asks every condition on arrival — including
  `victim.targetable`, which nothing asked before. The bolt *follows* the victim:
  a global is not dodged by walking, it is dodged by leaving the map.
- **E is champions-only too.** 12% of *current* health was being taken off
  turrets every 13s, which is a siege engine nobody designed. Source-accurate:
  Static Field is heroes-only.
- **Q now travels**, after a follow-up report that it still felt instant. The
  whole four-body chain used to resolve on the press frame; each link now takes
  `Q_JUMP_MS = 130`, the bolt picks the *next* body when it arrives (so a crowd
  that scatters breaks the chain), and each arrival re-checks alive/targetable
  **and the hop's own reach** from `hopFrom`. In Dota the arc visibly hops and
  Zeus plays a cast animation, so the old version was more instant than the
  source. No cast point was added — that is still an open option.

Cooldowns were *not* touched: every ultimate in the dota pack sits at 17–19s
(`tempo.test.ts` allows 60s), so raising Zeus's would have made him the outlier.

**Sett R was "hơi yếu so với LMHT"** because it was two flat numbers. Added
`SETT_R_CARRIED_HEALTH_SHARE = 0.15` of the **carried** champion's *maximum*
health, paid by the thrown body and by everyone in the crater. Max rather than
League's *bonus* health on purpose: pools here are ~100 and bonus health is
frequently zero, so a bonus scaling would be an ultimate that behaves identically
until one specific item is bought.

**Miss Fortune, same session:** "tầm nó vừa ngắn vừa khó thấy hiệu ứng". Her
auto range is 300 (`ATTACK.MARKSMAN`), and her abilities barely out-ranged her own
right-click — Q 320→**400** (bounce 190→230), E cast 340→**430**, R 380→**520**
(in band with Draven/Irelia/Xerath). The R picture was the "khó thấy" half: the
cone was painted *per wave* at alpha 60 and faded in 300ms, so the shape blinked
ten times per channel. New `MissFortune_R_Field` holds one cone (weak fill + hard
gold outline) for the whole channel, removed in `onCancel`; waves dropped their
own wedge fill (net *cheaper* — two used to overlap), got 9 bigger slugs and a
muzzle flare. Q's slug was `LEATHER` (58,36,40 — nearly black) at 22x9 crossing
400 units in a third of a second: now a bright crimson body with the dark as its
*outline*, 28x11, plus a two-pass tracer streak behind it.

**Vọng Âm Luden:** its proc did not scale, and the engine will not do it —
`economy/ItemShop` switches `damageScalesWithAbilityPower` off for **every** item
passive/active on purpose (most procs already read attack damage). So the item
states its own ratio: `LUDENS_ABILITY_RATIO = 0.5` of the wearer's
`abilityPower`, applied to both halves via `ludensScale()`. Half rather than all
of the multiplier, because `abilityPower` here multiplies a *whole* ability and
the source item's ratio is deliberately small. **The same is still true of every
other item proc in every pack** — Liandry, Shadowflame, Rylai and the rest are
flat by the same engine rule.

**A cast never stopped the caster's feet — an engine gap, not a pack one.**
`CancelPolicy` watches `movementRevision`, which counts move *orders*, so a
champion who was **already walking** when a channel began issued no new order,
the watcher saw nothing, and she crossed the lane firing an ultimate she is
supposed to stand still for (9 channelled spells across the packs). And
`castTimeMs` only delayed the release — it did not root. Both fixed in
`Spell`: `press()` calls `stopMovement()` when the resolved interrupt policy
has `move: true` (before `snapshotOwner`; `stopMovement` writes the destination
directly and does **not** bump the revision, so it cannot cancel the cast it
just started), and `holdStillWhileCasting()` re-plants every frame while the
state is `CASTING`. Both calls are `?.()` — several fixtures build a spell
against an owner stub with no feet. MF E gained `castTimeMs: 200` on the back
of it, which is what the user meant by "miss E … nó ko ngưng".

**Test traps this cost:**
- `dota/tests/_units.ts`'s `unit()` builds a bare `AttackableUnit`, **not a
  Champion** — so every champions-only ability needs the new `champion()` helper
  there, and `unit()` becomes the "and this one is not a champion" body.
  `summon()` is the `Pet` case.
- A body left in `objectManager.objects` **regenerates between the hit and the
  assertion** — that is how a 45 reads as 42.7. Zero `stats.healthRegen` in any
  fixture that ticks the world (also hit in `lol/tests/spells/Zed.test.ts`).
- A share of *current* health must be read **before** the hit, or the helper
  reports on the smaller body it just left.

**The bug the Q rewrite shipped, and the shape worth remembering:** a missed
shot never went away. The chain's fade started in `land()` and only there, so a
cast handed `head = null` never entered it, `spentAtMs` stayed null, and the
removal test could never be true — the bolt stayed painted for the rest of the
match. **A removal condition gated behind a state the miss path never reaches**
is the general form; the fix is an invariant over "is anything still in flight"
rather than a second null check at the cast site. Worth checking on any object
whose expiry is tied to its payload resolving.

**Shipping this took three gates nobody remembers until they fire:**
- `npm run contract:bump` is the only right way to raise core's version — the
  recorded contract **must equal core's minor** (`apiContract.test.ts` asserts
  it), so editing `package.json` by hand fails the suite. Adding a class member
  or a TS interface field is *not* a surface change, so the surface list was
  untouched and only the number moved.
- The **pre-push perf guard** (`moba2d-perf-guard`) refuses on a *new*
  `heavy-draw` finding: MissFortune R's rewritten volley hit ~85 p5 calls a
  frame against a ceiling of 60. Fixed rather than skipped, by computing the
  rotated slug corners by hand (`quad`) instead of `push/rotate/pop` per bullet
  and hoisting the two fills out of the loop. Its **dynamic** half needs Chrome
  at the macOS app path — `MOBA2D_CHROME_CHANNEL= git push` swaps in
  Playwright's bundled Chromium and the guard runs for real.
- dota's pre-push also runs `check-unused`: one leftover test import blocked it.
- `lol` **commits `generated/spellCatalog.ts`** (dota gitignores `generated/`),
  which is what caught a real bug in a description: lol's local `pct` takes a
  *fraction* while `api.text.pct` takes a *percent*, and mixing them printed
  "tăng theo 5000% sức mạnh phép" on Luden's card.
