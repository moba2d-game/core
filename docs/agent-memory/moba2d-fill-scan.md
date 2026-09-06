---
name: moba2d-fill-scan
description: "npm run fill:scan (2026-09-06) — ranks how many pixels each effect BLENDS, the cost a phone pays and every other instrument is blind to"
metadata:
  type: project
---

`npm run fill:scan` / `moba2d-fill-scan` (core, `scripts/fill-scan.mjs`, **bin
sixteen**) measures the one cost nothing else here can see: **area blended per
frame**. `perf-scan` counts p5 calls and one `circle()` is one call whether it
covers ten pixels or a million; `measure-frame-cost` runs a desktop GPU. Written
after a phone dropped to 15fps in a fight that held 60 on desktop — see
[[moba2d-phone-fill-rate]] for that diagnosis.

Reports every filled shape as a **share of a phone screen** (844x390 at DPR 3 =
2.96M device px), ranked. Three rules: `fill-inside-fill` (overdraw — a fill
that cannot escape the fill beneath it), `large-fill`, `effect-over-budget`.
`--live N` multiplies by concurrent instances, `--all` lists every effect by
what one frame of it blends. Exits 0; `--max N` gates. Baseline 2026-09-06:
**115 findings**; biggest real ones `HealthRelic` r=425 (172% of a screen, in
**core**), `Renekton_Q` 7 filled arcs, `Diana_R` r=330.

**Concurrency is asked for, never derived.** The first version guessed it from
`lifeTime / smallest-interval-constant` and reported a single cage as *83 alive*
and one ultimate as *145*. `perf-scan` learned the same lesson: per-instance is
what gates, and a saturated figure nobody can reach is not evidence. The trail
that started this is `--live 8` (1800ms of cloud life / 220ms drop).

**Six wrong numbers it produced before it was trustworthy — every one now a
falsifiable test (A/B'd by reverting the guard and watching it go red):**
- **`pop()` restores the fill.** Ignoring the push/pop stack left it believing a
  fill was still on for the rest of a method, costing stroked decoration as
  solid.
- **An arc is a slice.** Costing `arc(…, a, a+1.5)` as a whole ellipse put
  decorative sweeps at the top of the report; unknown sweep is charged half a
  turn, not a whole one.
- **`max(a) - max(b)` is not the largest value of `a - b`.** Produced seven
  negative radii — and worse, *hid* the shapes it inverted, since a negative
  size is skipped. Fixed by carrying `{lo, hi}` intervals throughout.
- **`this.x` must resolve from its own class only.** A file holds several
  classes reusing field names; borrowing another's read a 46px disc as 833
  (six screens of fiction). A field inherited from a base class in another file
  is *unknown*, and unknown is right. `own` also takes `obj.x = …` writes at a
  `new <ThisClass>` site, which is the legitimate hand-off case.
- **Locals resolve by lexical scope, not a file-wide table.** Draw methods are
  full of `d`, `r`, `w`; a flat map resolved one method's `const d` to another's.
- **Read the guard on an ease.** `t > 0.82 ? 1 - (t - 0.82) / 0.18 : 1` never
  leaves 0..1, but an interval ignoring the condition reads it as **5.56** and
  multiplies a 100px radius into 556. `narrowFrom` narrows `<name> <op> <number>`
  per branch.
- Related: **an unknown call is unknown, not "the span of its arguments"**.
  That fallback made `constrain(age/MS, 0, 1)` span `age/MS` and read a 6px head
  as r=2104. Allowlist only: `effectiveRange`, `constrain`/`clamp`, `min`/`max`,
  `abs`, `random`, trig.

**Why:** a report whose top row is fiction discredits every true row under it,
and four of the six above put fiction at the very top.

**How to apply:** validate any new rule against the bug it came from —
`tests/scripts/fillScan.test.ts` keeps both original offenders as fixtures. The
repairs it suggests are art, not code: strokes instead of inner fills, a band or
rim instead of a disc. Area is the cost; **alpha is not**.
