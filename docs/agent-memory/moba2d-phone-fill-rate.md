---
name: moba2d-phone-fill-rate
description: "Phone lag is FILL AREA, not CPU — how to tell them apart, the arithmetic that proves it without a phone, and why every existing instrument is blind to it"
metadata:
  type: project
---

**"Lag on the phone, fine on desktop" is a fill-rate report, and none of this
repo's instruments can see it.** Paid for 2026-09-06: the user reported 6 bots
dropping to 15fps on a PWA phone, *"kể cả máy mạnh"*, alive and dead alike.

**What was ruled out first, and how** — do this before touching art:
- `MOBA2D_BOTS=9 MOBA2D_CPU_THROTTLE={4,6}` against the ladder recorded in
  [[moba2d-teamfight-profile]]: **4x fps 57.6 / draw 7.70ms** and **6x fps 41.7
  / draw 13.01ms**, both equal-or-better than the recorded 56.6/9.62 and
  34.5/16.34. No CPU regression, so no amount of tick or draw-call work is the
  answer.
- `perf:scan` 161 findings vs a recorded 160 — nothing crossed its threshold,
  because **it counts p5 calls and a fill is one call whatever its area**.

**Three blind spots found in `measure-frame-cost.mjs`, all now fixed:**
1. **It only ever reported an *average* fps** (`frames * 1000 / wall`). The
   complaint was a *minimum* of 15, and an average of 60 is entirely compatible
   with that. It prints `p95Fps / p99Fps / worstFps / longFrames` now — the
   average was always fine and was never the number to argue with.
2. **It always ran a desktop viewport at DPR 1.** `MOBA2D_MOBILE=1` runs a phone
   viewport + touch + `deviceScaleFactor: 3`. Caveat that matters: it is this
   machine's GPU drawing a phone's pixel count, so read it as a **ratio**, never
   as ms. It measured only +18%, which is exactly why it under-called the bug.
3. **Its bots never bought items** — `autoBuy` is on by default in a real match
   (`PregameConfig.DEFAULT_BOT_BEHAVIOUR`) and the script set only
   move/attack/cast. Now on, with `MOBA2D_BOT_BUY=0` for the old naked fight.
   (Bots still need gold and time, so a 6s window may not exercise it.)

**The instrument that actually settled it was arithmetic, not a browser.** Fill
area is the phone's cost model, so compute blended px² per frame from the
source and compare it to a phone screen (844x390 CSS at DPR 3 = **2.96M device
px**):
- `Singed_Q`'s trail: r=90 body **plus four filled puffs inside it**, and the
  trail keeps `CLOUD_LIFETIME / DROP_INTERVAL` = **8.2 clouds alive**. Total
  **1.34x the whole phone screen, blended, every frame, for one champion** — and
  53% of it was the puffs, which sit inside the body disc and cannot reach past
  its edge, so every pixel was drawn twice to say nothing.
- `Nasus_R`: one permanent filled r=200 disc = **0.38x the screen**, every frame
  for the whole ultimate.
- Combined **1.72x → 0.78x** after: puffs became three `arc()`s (a stroke costs
  perimeter, not area) and the disc became an edge band. Both keep the hard rim,
  so the reach statements from [[moba2d-reach-scan]] survive intact.

**The rules that fall out, and they are already house precedent** (the
fountain's widest disc became a rim for this exact reason):
- **Area is the cost; alpha is not.** A 26-alpha disc costs the same as a
  240-alpha one. Lowering alpha to "make it cheaper" does nothing.
- **A filled shape drawn inside another filled shape is pure overdraw.** Free to
  delete, and it is where the wins are.
- **Prefer a band/rim/arc to a disc** for anything large or long-lived. It is
  cheaper *and* states where the effect stops.
- Budget to think in: one champion's persistent effect should not approach 1x
  the screen.

**Still open:** nothing scans for fill area — `perf:scan` counts calls and is
structurally blind to it. A `fill-scan` (resolve the radius the way
`reach-scan.mjs` already does, multiply by concurrency, rank by px²/frame) is
the obvious next instrument and was not built. Also unverified: whether the two
fixes above are enough on the user's actual phone.
