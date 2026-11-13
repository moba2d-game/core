/**
 * The packs this build offers by name — the shelf a player with nothing
 * installed and no URL to paste actually chooses from.
 *
 * It replaces one line of dead text. The packs screen used to end its empty
 * state with `Pack mặc định: https://…/manifest.json` rendered as a plain
 * `<span>`, which on this page could not be clicked, could not be installed,
 * and could not even be *copied* — `styles/main.css` sets `user-select: none`
 * on `*`, so the one thing the screen told a player to do with that string was
 * the one thing the screen prevented.
 *
 * **A shelf entry names the pack, and that is the point.** A player choosing
 * whether to install something has to know what it is, and "hơn 50 tướng" is
 * not that. This is the one place core is allowed to say what a pack's
 * content is, because the content is not core's: the pack lives in its own
 * repository, under its own licence, and this is a pointer to it. Core's own
 * screens — menu, loading, About — carry no such artwork or wording, and
 * `tests/content/vocabularyBoundary.test.ts` keeps the *engine* clear of the
 * bundled pack's champion, monster and spell vocabulary, which is a different
 * rule from this one.
 *
 * **Adding an entry is meant to be the whole change.** Append an object below
 * with an `id`, a `name`, a one-line `description`, its `manifestUrl` and the
 * `repoUrl` a player can read the pack's source at; `PacksScene.vue` renders
 * whatever is here. `tests/scenes/packsSuggested.test.ts` checks the shape and
 * that both URLs are `https://`.
 *
 * **A suggestion is not a permission.** Nothing here shortens the path an
 * install takes: the Cài button fills the URL field and runs the same
 * `checkUrl` a pasted URL runs, so the origin disclosure in
 * `PackInstallConfirm.vue` stands in front of a suggested pack exactly as it
 * stands in front of a stranger's. Being listed in this file buys a pack a
 * button, not trust — see that component's own header for why the disclosure
 * is the whole of the security model.
 *
 * Imports nothing: this module is loaded by the packs screen, which
 * `tests/scenes/packsBootPath.test.ts` keeps clear of `src/game/` and of
 * `@/content/runtimePacks`.
 */
export interface SuggestedPack {
  /** The pack's own id, as its manifest declares it — used to notice it is already installed under some other URL. */
  id: string;
  name: string;
  /** One line, player-facing: what a player gets by installing it. */
  description: string;
  manifestUrl: string;
  /** Where the pack's source can be read. Shown as a plain link, never fetched. */
  repoUrl: string;
  /**
   * The pack's own logo, absolute, on the pack's own host — or absent for a
   * shelf entry that would rather wear a monogram.
   *
   * **A shelf entry is core's own claim; an install prompt carries a
   * stranger's.** That is the whole of why this field can exist here and
   * deliberately does not exist on the install confirmation. An entry in this
   * array was chosen here, in core's source, alongside the origin core is
   * about to send the player to — showing its artwork adds no trust core has
   * not already extended by listing the URL at all. The confirmation dialog is
   * the opposite case: the manifest there was fetched from wherever the player
   * pasted, and a hostile pack that can paint its own logo onto the screen
   * where the player decides whether to trust it can dress up as one they
   * already know. That screen stays monogram-only (`packSource.resolvePackIcon`
   * and spec §3.2), and this field must never be plumbed into it.
   *
   * Core cannot ship the image instead: this pack's logo is the other game's
   * property, and core carries no content's branding — which is the same rule
   * that took the old wordmark off the menu. Hot-linking leaves the bytes on
   * the pack's host where they belong. It also means the request only happens
   * when a player opens "Tìm pack", and a failure — offline, moved file —
   * falls back to the monogram with nothing to report.
   */
  icon?: string;
}

export const SUGGESTED_PACKS: SuggestedPack[] = [
  {
    id: 'lol',
    name: 'Liên Minh Huyền Thoại',
    description:
      'Hơn 50 tướng LMHT đủ 4 chiêu, phép bổ trợ, quái rừng, bản đồ Summoner’s Rift. Bản fan-made, không liên kết với Riot Games.',
    manifestUrl: 'https://moba2d-packs.github.io/lol/manifest.json',
    repoUrl: 'https://github.com/moba2d-packs/lol',
    icon: 'https://moba2d-packs.github.io/lol/icon.png',
  },
  {
    id: 'dota',
    name: 'Dota 2',
    description:
      'Bốn tướng Dota 2 đủ 4 chiêu: Pudge, Lina, Juggernaut, Crystal Maiden. Chưa có bản đồ riêng — chơi trên bản đồ đang cài. Bản fan-made, không liên kết với Valve.',
    manifestUrl: 'https://moba2d-packs.github.io/dota/manifest.json',
    repoUrl: 'https://github.com/moba2d-packs/dota',
    icon: 'https://moba2d-packs.github.io/dota/icon.png',
  },
  {
    id: 'naruto',
    name: 'Naruto',
    description:
      'Naruto và Sasuke, mỗi người 4 chiêu cộng một dạng biến hình đổi luôn Q/W/E: Kurama Mode và Susanoo. Chưa có bản đồ riêng. Bản fan-made, không liên kết với Shueisha.',
    manifestUrl: 'https://moba2d-packs.github.io/naruto/manifest.json',
    repoUrl: 'https://github.com/moba2d-packs/naruto',
    icon: 'https://moba2d-packs.github.io/naruto/icon.png',
  },
  {
    id: 'tidelight',
    name: 'Tidelight — Triều Đăng',
    description:
      'Thế giới gốc, không dựa trên game nào: 5 tướng, bản đồ Driftglass Reef và luật chơi riêng — hộ tống Đèn Triều về bến trong lúc thuỷ triều đổi chiều mỗi 30 giây. Có 2 phép bổ trợ riêng.',
    manifestUrl: 'https://moba2d-packs.github.io/tidelight/manifest.json',
    repoUrl: 'https://github.com/moba2d-packs/tidelight',
    icon: 'https://moba2d-packs.github.io/tidelight/icon.png',
  },
];
