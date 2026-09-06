---
name: moba2d-reach-scan
description: "npm run reach:scan (2026-09-06) — compares each spell's hit radius against the radius it actually paints, across core + all linked packs"
metadata:
  type: project
---

`npm run reach:scan` (core, `scripts/reach-scan.mjs`) answers one question over
core's game tree and every linked pack: **does the picture reach as far as the
damage does?** Written the day Riven's Q and Tryndamere's E were both found to
disagree with their own hitboxes. ~0.56s over ~500 files. Reports and ranks,
exits 0, `--max N` to gate, `--coverage` for what it could not see. Same family
as [[moba2d-perf-scan]] and [[moba2d-duty-scan]]; TypeScript compiler API, no
checker (syntax only), exports `RULES`/`scanSource`/`scanTree` behind a
direct-invoke guard for `tests/scripts/reachScan.test.ts`.

**How it works:** reduces both halves to `sum(id * factor) + k`, keeping module
level and imported constants *named* (resolving `Q_RADIUS` to 150 up front would
throw away the only thing that lets the two halves be recognised as the same
quantity) and inlining local aliases, `this.x` getters and class initialisers.
Hit reach = a `new Circle({r})` or a `hypot/dist <= X` outside a draw. Drawn
reach = `circle/ellipse/arc/square` diameters, `cos/sin` arms, and `Spell.range`
(the engine's own ring). Compares the **widest** drawn factor per id, so inner
decoration is not mistaken for a claim about reach.

**Three rules:** `drawn-wider-than-it-hits`, `drawn-narrower-than-it-hits` (which
also covers "the hit adds a term nothing is painted at"), `reach-never-painted`.

**2026-09-06, after the fix pass: 9 findings** (2 wider, 1 narrower, 6
never-painted), and every one of the 9 was read by a human-equivalent and judged
deliberate — a target-acquisition radius, a hidden trap's trigger, a translucent
aura over an honest rim. The arc was 143 -> 40 by tuning, 40 -> 11 by three more
scanner fixes the fix pass exposed, 11 -> 9 by one more. Earlier — 8 wider, 4 narrower, 57 never-painted
(that last is mostly item auras, i.e. a design inventory rather than a bug list).
Worth looking at: Ashe_R 2x, Orianna_Q 1.7x, Varus_E 1.6x, Ekko_W 1.35x,
Vladimir_R 1.3x; Jinx_R hits 2.78x past its own edge, Singed_Q 2x, Nasus_R 1.8x.
None acted on.

**Precision over recall, on purpose:** it only speaks when both halves name the
same constant. Pass the radius to the `SpellObject` through its constructor —
the recommended shape, and what both real fixes did — and the scan goes quiet.
A tool that cries at the fix gets switched off; `--coverage` (123 of 240 files
with a hit radius were comparable) is what keeps the silence honest.

**Tuning it was the whole job — 143 on the first run, 40 after eight
narrowings, every one a real scanner defect and every one now a falsifiable
test (A/B'd by disabling the guard and watching the test go red):**
- `a ?? 0` fell through to `0`, so `HIT_RADIUS + (size ?? 0) / 2` lost the size
  term entirely and **the scan missed the very bug it was written from.** Fix:
  an unreadable expression becomes an *opaque atom named for its own source
  text*, never `null`.
- `LENGTH / 2 + WIDTH` is the broad-phase circle every line-shaped ability uses
  before its real rectangle test — 4 false findings. Now: **a sum of two or more
  SCREAMING_CASE constants is a bounding query, skip it.** Tryndamere survives
  it because a body-size read is not a named constant.
- `Spell.range` is painted by the base class' `drawPreview` whether or not a
  spell overrides it — ~60 item auras and cast ranges read as invisible.
- `RADIUS * 2 * eased` came back `null` (two unknowns multiplied), leaving a
  decorative inner ring as the widest mark and reporting XinZhao_E as hitting
  2.2x past its edge. Draw side only: the side carrying a named constant is the
  length, the other is a curve running to 1.
- `(cos(a) * d) / 2` — matching the product alone read Ekko_Q's clock face at
  twice its reach. Climb the parents folding constant `*` and `/`.
- A body radius added to a *targeted* `dist <=` check is invisible by design;
  the missing-term rule is `Circle` queries only.
- `reach-never-painted` was the weakest rule and needed two more cuts, which
  took it 57 -> 28: **a `dist <=` check is a test, not an area** (an arrival
  test `dist < speed`, a hook's stop gap — no player wants a ring around
  either), so that rule is `Circle` queries only too; and a name matching
  `SPEED|STEP|GAP|DISTANCE|SEARCH|SEEK|BOUNCE|CHAIN|HUNT|FOLLOW|CLAMP` is not
  an area at all.
- **`blast.radius = BLAST_RADIUS` is a hand-off too.** Counting only `new X(…)`
  arguments read a whole family of correct spells as never-painted; any
  assignment to a property access counts now.

## Shipping it to the packs found two live holes (2026-09-06)

`reach:scan` is bin **fifteen** (`moba2d-reach-scan`, in `bin` + `files`, pin
bumped in `tests/content/publicSurface.test.ts`), and all three packs plus the
`pack-new` scaffold now declare `"reach:scan": "moba2d-reach-scan"`.

- **Shipping a bin was never enough.** npm writes `node_modules/.bin` shims at
  *install* time; a dev link swaps core's package for a symlink and never
  touches `.bin`, so every bin core added after a pack's last install resolved
  to nothing — `npx moba2d-perf-scan` in a pack went to the public registry and
  came back **404**. `perf-scan`, `duty-scan`, `perf-guard` and `shoot-vfx` had
  all been unreachable that way. `linkPack` now writes a **relative** shim
  (`../@moba2d/core/scripts/x.mjs`, so it follows whatever that name resolves
  to) for every declared bin, and chmods the target.
- **The self-invoke guard bug was still live in both other scans.** Through a
  `.bin` symlink `process.argv[1]` stays the symlink path while
  `import.meta.url` is already resolved, so `resolve(a) === resolve(b)` is false
  and the whole CLI block silently never runs: no output, no error, exit 0.
  `check-seams.mjs`'s header documents it; `perf-scan` and `duty-scan` still had
  the broken form and became *reachably* broken the moment the shims landed.
  All three use the `realpathSync` form now.
- **Core may not name a pack's champions, and that includes a tool's comments.**
  `tests/content/corePackTarball.test.ts` scans every shipped file: adding
  `scripts/reach-scan.mjs` to `files` made its own prose a violation (14 hits —
  the two bug write-ups plus every tuning note). Rewritten to describe shapes
  ("a dash-and-slash", "a dial-shaped field"), and the default sibling roots
  now read `node_modules/@moba2d/content-*` instead of a hardcoded pack list.
  The fixtures in `tests/scripts/reachScan.test.ts` keep the real names — tests
  are not shipped.

**All three scans are pack-aware now, and none of them names a pack.** The
shared `defaultRoots()` shape: `packRootFrom(process.cwd())` first (walk up to
the nearest `package.json` depending on `@moba2d/core`) — from a pack that
means *that* pack's `spells/` + `monsters/`; otherwise core's tree plus every
`node_modules/@moba2d/content-*` link. `perf-scan` and `duty-scan` had
`['lol','naruto','dota']` resolved relative to core, which was silently wrong
from anywhere else and became reachable-and-wrong once the shims landed. Both
now also see `monsters/` and the reference pack (perf 161 unchanged, duty
146 -> 148). Report paths go through `realpathSync`, or a linked pack prints as
`node_modules/@moba2d/content-lol/...`.

## Handing it to three agents found four more scanner defects (2026-09-06)

Two agents independently reported the same gap, which is the signal to trust.
**Fixing the findings is what tests the scan** — none of these was visible from
inside the tool:

- **`_drawCage` is a drawing.** `isDrawName` was `/^draw/`, so an
  underscore-prefixed private method hid a whole spell's art and it read as
  painting nothing. `/^_*draw/`.
- **`showImpact(victim, RADIUS * 2)` is a hand-off**, and so is
  `line(0, -HALF_WIDTH, 0, HALF_WIDTH)`. Following only `new X(…)` read both as
  a radius nobody paints. Now *any* call's arguments count, excluding nodes
  inside the hit expression itself (`effectiveRange(RADIUS, owner)` is the query,
  not a hand-off — counting it would exempt every ability there is). This
  subsumed a whole `EDGE_MARKS` table of drawing primitives that was written
  first and then deleted: its test stayed green with the table emptied, which is
  how it was caught. What survives the rule now is a constant that appears
  **nowhere but the query**, which is a much stronger claim.
- **`this.range + <anything>` is a pre-filter, never a reach.** Inlining
  `this.range` to the literal behind it threw away that it was a *cast range*;
  it stays named now, and `drawnReaches` emits the engine's range ring under
  both names so a hit that reads `this.range` still matches it.
- **Bracketing a hit radius between two polygon marks was designed and
  rejected**: the founding crescent's own `line` calls span 0.38x-1.12x, which
  brackets 1.0 and would have silenced the bug the tool exists for. Sprite
  detail (fins, barbs, a hull) lives outside a hitbox legitimately, so polygon
  marks may prove a reach is *visible* but must never set the outer claim.

Two known false positives are left standing on purpose, both documented in the
fix pass: a translucent aura fill drawn at 1.7x over a hard rim that is exactly
right (the scan takes the widest mark as the claim and cannot read alpha), and a
missile drawn with rects/quads whose fins reach past its collision radius.

**Validate any new rule against the bug it came from before trusting it** —
`git show HEAD:spells/X.ts` into a temp dir and scan that. Both originals are
kept as fixtures in the test file.
