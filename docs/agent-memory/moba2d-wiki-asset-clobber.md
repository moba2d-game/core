---
name: moba2d-wiki-asset-clobber
description: "The wiki importer owns <slug>_<slot><n>.png and overwrote the pack's own phase/recast art; how to tell, and where pack-local art must live"
metadata:
  type: project
---

**The wiki crawler is `lol/scripts/wiki/import-abilities.mjs`** — `npm run
ability:import` / `ability:update` / `ability:check` (check runs inside
`verify`). Siblings: `sync-spell-names.mjs`, `sync-damage-types.mjs`,
`check-abilities.mjs`, `mediawiki.mjs`, `normalize.mjs`. Records land in
`docs/abilities/<champ>/<slot>.json`, provenance in
`assets/source-manifest.json`.

**IT WAS AN IMPORTER BUG, NOT A WIKI LIMIT — I got this wrong twice before
checking properly.** The wiki *does* publish per-phase icons
(`Steel Tempest.png`, `Steel Tempest 2.png`, `Steel Tempest 3.png`); I concluded
otherwise from the cached record's identical sha1s, then from a raw-cache grep,
and the user was right both times. Read `docs/abilities/cache/normalized/<champ>/<slot>.json`
and look at each form's `fields.icon*` before claiming the wiki lacks art.

**The actual defect:** the importer took the *first usable* of
`icon`..`icon4` per form, but **every form page carries the whole chain** — so
all three of Yasuo's forms resolved to `Steel Tempest.png`. Fixed by matching
the icon to the form **by name** (exact, then the shortest containing match).
Positional indexing was tried first and is *worse*: it is off by one whenever an
earlier slot is the literal `false` (Zed's Living Shadow), and it handed Blue
Card an animation gif and Xin Zhao's passive a diagram. Ashe's chain is even
reversed (`icon` is the "2" variant), which is why the containing match must
take the **shortest** normalised name, not the first.

**Do not also filter gifs.** Tried, and it swept up Thresh's Flay icons, which
are animated here on purpose — `tests/build/runtimeBundle.test.ts` pins that the
encoder leaves gifs alone, and removing the only five gifs in the pack failed
it. Name matching already passes over `Twisted Fate Pick a Card.gif`, because
the form is `Pick a Card` and the still is named for it exactly.

**Result:** 24 abilities re-derived; byte-identical spell icons **68 -> 14**, and
the 14 left are abilities the wiki genuinely draws once (Thresh Flay's five
template sub-pages, Jinx's Pow-Pow forms, Blitzcrank, Garen, TF's Gold Card).

**`--update` will not re-fetch on its own.** It skips when `source.revisionId`
and `contentHash` match and no image changed, and a changed *icon selection*
does not always trip that — Yasuo only got written because its description had
also changed. To force a re-derive: delete the specific
`docs/abilities/<champ>/<slot>.json` and run `--update` (plain import refuses a
champion if *any* of its records exists). Afterwards check the manifest both
ways — rows whose file is missing, and files whose sha256 no longer matches
their row — and re-derive those champions too; `ability:check` fails on either.

**What it silently ate (found 2026-09-06).** The importer writes one file per
*form*: `assets/images/spells/<slug>_<slot><formSuffix>.png`, suffix `''`, `2`,
`3`… An ability with three forms therefore claims `yasuo_q.png`, `yasuo_q2.png`,
`yasuo_q3.png` — and the wiki serves **one image for all forms** (every form in
`yasuo/q.json` carries the same sha1). So it honestly overwrote the pack's own
distinct phase art with three copies of one square, and Yasuo's Q1/Q2/Q3 icon
swap became invisible in play. Reported as "ko thấy nó đổi image khi có Q2 Q3";
the swap code was correct all along.

**`yasuo_q1.png` survived, and that is the whole tell**: it is PACK-LOCAL,
because the importer's suffix scheme starts at `2` and never emits `_q1`. Same
for `zed_r1.png`, `leblanc_w1.png`.

**It cannot be put back under the wiki-owned names.** `source-manifest.json`
pins each path to that one wiki content hash and `ability:check` enforces
`contentHash(bytes) === row.contentHash`; restoring the art there would fail
`verify` *and* be a lie about provenance. It also cannot be un-owned: the check
throws `unreferenced asset key` for a manifest row no ability record names, and
the records legitimately name all three forms.

**So pack-local art lives outside the importer's namespace — which is already
normal: 25 of 355 spell icons have no manifest row** (`flash`, `heal`,
`anivia_q`, `leblanc_w1`…). Use a **non-numeric suffix**, which the importer
provably cannot generate. Restored 2026-09-06 from the old LOL2D checkout at
`~/Desktop/Github/LOL2D/assets/images/spells/`:
`yasuo_q_phase2/3`, `zed_w_recast`, `zed_r_recast`, `shaco_r_recast`.

**Blast radius, measured — don't panic at the raw number.** 68 spell icons in 29
byte-identical groups, but only **7 files / 3 champions** were a real loss: 40
are duplicated in the old repo too (genuinely one icon per ability) and 21 are
champions added since the old project. The check that finds it: md5 every
`assets/images/spells/*.png`, group duplicates, then diff each against the old
checkout — anything that differs there was clobbered.

**How to apply:** before running `ability:import`/`ability:update`, know that any
`<slug>_<slot>` or `<slug>_<slot><n≥2>` file is the importer's to overwrite. Art
the pack authored belongs on a non-numeric name from the start. See
[[moba2d-lol2d-handover]] for the old repo and [[moba2d-workspace-layout]] for
where the wiki pipeline moved to.
