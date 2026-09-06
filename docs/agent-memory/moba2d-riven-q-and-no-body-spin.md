---
name: moba2d-riven-q-and-no-body-spin
description: "2026-09-06: Riven Q rebuilt as lane+fan with a leaping Q3 slam; the user rejected rotating champion avatars outright"
metadata:
  type: feedback
---

**Never rotate a champion's avatar.** Tried 2026-09-06 as an `AttackableUnit.bodySpin`
seam (rotation applied around `drawBody` in `drawAvatar`) so Tryndamere E and
Riven Q would visibly turn. The user's verdict on sight: *"body spin tếu tếu
quá, với nó xoay nhanh cũng ko thấy gì :)) chắc bỏ body spin đi, giữ lại các
visual khác"* — a round portrait spinning in place reads as a joke, and fast
enough to say "whirlwind" it reads as nothing. The core seam was reverted;
`AttackableUnit` is untouched. **Spin belongs in the effect** (blades, motion
fans, a rotating dashed rim), never in the body.

**Why:** the avatar is a circle. Rotating a circle communicates nothing and
costs the portrait's readability.

**Riven Q, as rebuilt the same day** (the complaint was "khó gây damage… nếu kẻ
địch đứng gần riven là riven lướt qua luôn ko gây damage"):
- The old hit was a 90°/r130 fan **at the arrival point**, so a body standing in
  front of her sat 180° off the wedge axis after the dash — the closer it stood,
  the more surely she whiffed.
- Now: **lane ∪ fan**. Lane = capsule of half-width `Q_SWEEP_RADIUS` (80) on the
  segment start→arrival, ends capped, so anyone she passes through (or took off
  beside) is cut. Fan = 120° / r150 at the landing. Both resolved instantly at
  cast from start+arrival; the dash is ~180ms and aiming through a body should pay.
- **Q3 is a leap now**, per the user's "Q3 phải bay lên rồi đập kiếm xuống…
  simulate y change trong lmht": `Riven_Q_Leap` holds the dash, adds a
  `StatsModifier` with `height.baseBonus = Q_LEAP_HEIGHT`, draws a shrinking
  shadow + a dashed landing telegraph, and pays out on touchdown with a **circular**
  `Q_SLAM_RADIUS` (190) knock-up. `Q_STEP_FINAL` was cut 200→150 *so the leap is
  shorter than the slam is wide* — that is what keeps a hugging enemy inside it.
- Damage-radius honesty: the fan/slam radii are computed once and handed to the
  drawing. The old art drew 1.12× (and 1.30× under R) wider than it cut.
- `StatsModifier` values are folded in by `addModifier`; **never mutate one per
  frame** to animate — add once, remove once, let `animatedValues.height`'s lerp
  smooth the rise and fall.

**Cooldown, fixed 2026-09-06 after "spam chiêu liên tục luôn":** it was
`3_500` — the same as a *single-cast* Q like Yasuo's — while Riven pays it once
for **three** casts. That let her cast at one per 1.34s against a shelf of
3.0-3.5s: **2.6x every other champion in the pack**. Now `9_000`, which puts the
combo at one cast per 3.21s, mid-shelf. `Q_CHARGE_GAP_MS` 260 -> **313**, which
is upstream's stated "0.3125-second static cooldown between casts".

**How the number was chosen, because the two honest anchors disagree:** upstream
is 13s and this pack runs at a **median 0.83 of upstream on basic abilities**
(measured over 134 spells with a cached `docs/abilities/*/[qwe].json` — the
script is a 20-line ratio over `coolDown` vs `fields.cooldown`), which says 10.8.
But that ratio comes from *single-cast* abilities, so applying it to a
three-cast one and then also asking for per-cast parity discounts twice. Parity
won. Both anchors are written into the constant's comment so a retune argues
with the choice instead of rediscovering it. (Full-slot median is 0.67; use the
basic-ability figure for a Q/W/E, since ultimates are compressed hardest by the
20s pace rule.)

**THE ACTUAL BUG, found only after the retune did not help (2026-09-06):**
`castSpec` is resolved **once, on the opening press, and frozen for the match**
(`src/seams/castSpecFrozen.ts` — `Spell.runtime` is a lazy getter that stores
`resolvedSpec`). Riven's returned `isFinal ? coolDown : Q_CHARGE_GAP_MS`, which
reads `charges` — 3 on that first press — so the frozen answer was **the 313ms
gap, forever**. The third swing never once started the real cooldown: Q was
literally unlimited. The tuning number was never the problem.

Fix, and it is the shape `Ahri_R` has always used (which is why that one was
never broken): **spec states a constant** (`durationMs: this.coolDown`), and
`onSpellCast` sets `this.currentCooldown = isFinal ? this.reducedCooldown(this.coolDown)
: Q_CHARGE_GAP_MS` by hand. `onSpellCast` runs *after* the runtime's
`startCooldown`, so the hand-set value wins — verified, not assumed.
`reducedCooldown` is required or ability haste skips the hand-set path.

**Why every test missed it:** they all called `onSpellCast` directly, which
never touches `castSpec`, the runtime, or `currentCooldown`. The test that
catches it drives `pressSpell` and asserts the charged cooldown across **two**
combos: `[gap, gap, coolDown, gap, gap, coolDown]`.

**Why the lint missed it:** it did not — `Riven_Q.ts` was in
`spells/seam-debt.mjs`'s `GRANDFATHERED` set for `castspec-frozen`, i.e. known
debt nobody had paid. Removing the entry is part of the fix, and check-seams
reports a stale exemption if you forget.

**Ten other files were in that set; `Vayne_Q` had the same bug and is fixed
too.** Its spec read `this.coolDown * this.cooldownScale`, and `cooldownScale`
asks whether Final Hour is up — frozen on her first Q of the match, which a
Vayne always casts before ulting, so **her ultimate's cooldown reduction did
nothing all game**. Same repair, plus an `effectiveCoolDownMs` override so the
HUD ring still reads the live scale (the HUD calls that getter fresh; only the
*runtime* freezes). The other nine freeze charge/channel values, not cooldowns —
stale but not unlimited-cast.

**A latent bug closed with it:** `castSpec` is resolved *before* the cast is
committed, so it read the spent-out `charges = 0` and called the press final,
while `onSpellCast` refilled to three and played it as a first swing — the press
paid the **full** cooldown for a first swing. Reachable only while the cooldown
was shorter than `Q_WINDOW_MS` (3.5s vs 4s, which is what shipped). Both halves
now go through `chargesForNextCast()`. **Do not** collapse the refill test in
`onSpellCast` to `chargesForNextCast() !== charges`: a fresh combo already holds
three, so that test is false exactly when the combo clock most needs starting —
it broke 5 tests when tried.

Tryndamere E in the same pass: hit radius 70→85, and the drawing now uses
`whirlReach()` = radius + half body size, the same number the query uses (the
picture used to be a champion-radius short of the hitbox). See
[[moba2d-attachto-ordering]] for the bug that made its blades stay behind.
