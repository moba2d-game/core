<script setup lang="ts">
/**
 * The About screen's content: what the game is, a link to the source, any
 * write-ups about the project, and a player-facing changelog.
 *
 * **What a content pack is, and how to install one, is not here.** It was,
 * and it made this screen twice as long while putting the explanation one
 * scene away from the buttons that act on it. It lives on the packs screen
 * now, which is where a player who wants to know is already standing; this
 * screen keeps one sentence and a button through to it.
 *
 * One scrollable panel rather than a tabbed one (contrast
 * `MatchConfigPanel.vue`): three short, read-only sections fit a single
 * scroll without needing per-section state to survive a re-mount, so a tab
 * bar here would only add a click between them for no control gained.
 *
 * `CHANGELOG` (`./about/changelog.ts`) and `ARTICLES` (`./about/articles.ts`)
 * are plain data — no `src/game/` import, see their own file comments and
 * `tests/scenes/aboutBootPath.test.ts` — and are the two files meant to be
 * edited directly, including by someone who does not read the rest of this
 * component.
 *
 * No hand-rolled touch scrolling here, unlike `MatchConfigPanel`'s tabs: that
 * machinery exists because the practice panel is also mounted *inside*
 * `#game-scene`, under `touch-action: none` (see `styles/game-scene.css`),
 * where a plain scroll container fights the canvas for the gesture. This
 * screen mounts over `#about-scene`, a sibling of `#game-scene` reached only
 * from the menu — no p5 canvas exists yet, `GameScene.syncTouches` only ever
 * claims touches whose target *is* that canvas (see its own comment), and
 * `body { overflow: hidden }` is the only ancestor rule in play. Plain
 * `overflow-y: auto` on `.about-body` is therefore the whole of the fix.
 */
import { CHANGELOG } from './about/changelog';
import { ARTICLES } from './about/articles';

const emit = defineEmits<{ close: []; openPacks: [] }>();

/**
 * This repository, not the one the project started in. `HoangTran0410/MOBA2D`
 * is where it lived before the engine and its content were split apart, and
 * a link to a repository that is no longer the one being played is worse
 * than no link at all — see `README.md`, which carried the same stale URL.
 */
const REPO_URL = 'https://github.com/moba2d-game/core';

/** AIO Desktop lists this game too and embeds it in an iframe; the link is pointless there. */
const AIO_DESKTOP_URL = 'https://fbaio.org/#/desktop';
const isEmbedded = typeof window !== 'undefined' && window.self !== window.top;
</script>

<template>
  <div class="about-panel">
    <header class="about-header">
      <h1>Giới thiệu</h1>
      <button
        type="button"
        class="about-close"
        id="about-close"
        title="Quay lại"
        @click="emit('close')"
      >
        <i class="fas fa-arrow-left" aria-hidden="true"></i>
      </button>
    </header>

    <div class="about-body">
      <section class="about-section about-intro">
        <p class="about-intro-text">
          <strong>MOBA2D</strong> — game MOBA 2D chơi thẳng trên trình duyệt. Không cần cài, không
          cần tài khoản.
        </p>

        <!-- Chips, not a paragraph. What the game is reads as a list of things
             you can do, and a player skims a row of icons where they skip a
             block of prose. -->
        <ul class="about-chips">
          <li class="about-chip">
            <i class="fas fa-wand-sparkles" aria-hidden="true"></i> Tự ghép bộ chiêu
          </li>
          <li class="about-chip">
            <i class="fas fa-users" aria-hidden="true"></i> Chia phe Xanh / Đỏ
          </li>
          <li class="about-chip">
            <i class="fas fa-chess-rook" aria-hidden="true"></i> 3 đường, lính, trụ
          </li>
          <li class="about-chip"><i class="fas fa-robot" aria-hidden="true"></i> Đấu với bot</li>
          <li class="about-chip">
            <i class="fas fa-mobile-screen" aria-hidden="true"></i> Điện thoại &amp; PC
          </li>
          <li class="about-chip">
            <i class="fas fa-plane-up" aria-hidden="true"></i> Chơi được khi mất mạng
          </li>
        </ul>

        <p class="about-intro-text">
          Game không kèm sẵn tướng — tướng, chiêu và bản đồ nạp bằng
          <strong>pack</strong>. Màn Nội dung / Pack nói rõ pack là gì và cài thế nào.
        </p>

        <div class="about-link-row">
          <button
            type="button"
            id="about-open-packs"
            class="hextech-btn secondary about-link"
            @click="emit('openPacks')"
            @touchend.prevent="emit('openPacks')"
          >
            <i class="fas fa-cubes" aria-hidden="true"></i> Nội dung / Pack
          </button>
          <a
            class="hextech-btn secondary about-link"
            :href="REPO_URL"
            target="_blank"
            rel="noopener noreferrer"
          >
            <i class="fab fa-github" aria-hidden="true"></i> Mã nguồn
          </a>
          <a
            v-if="!isEmbedded"
            class="hextech-btn secondary about-link"
            :href="AIO_DESKTOP_URL"
            target="_blank"
            rel="noopener noreferrer"
          >
            <i class="fas fa-desktop" aria-hidden="true"></i> Thêm công cụ &amp; trò chơi: AIO
            Desktop
          </a>
        </div>
      </section>

      <section class="about-section about-articles">
        <h2><i class="fas fa-newspaper" aria-hidden="true"></i> Bài viết</h2>
        <ul v-if="ARTICLES.length" class="about-article-list">
          <li v-for="article in ARTICLES" :key="article.url" class="about-article">
            <a
              class="about-article-title"
              :href="article.url"
              target="_blank"
              rel="noopener noreferrer"
            >
              {{ article.title }}
            </a>
            <p class="about-article-desc">{{ article.description }}</p>
          </li>
        </ul>
        <p v-else class="about-empty">Chưa có bài viết nào ở đây.</p>
      </section>

      <section class="about-section about-changelog">
        <h2><i class="fas fa-clock-rotate-left" aria-hidden="true"></i> Có gì mới</h2>
        <!-- Newest open, the rest folded. A changelog only grows, and every
             older release is a screen of text between a returning player and
             the one entry they came to read. `<details>` rather than a
             hand-rolled toggle: it is keyboard- and screen-reader-correct for
             free, and this screen never mounts over the p5 canvas, so the
             `preventDefault()` that kills native controls in the HUD does not
             apply here — see this component's own header. -->
        <details
          v-for="(release, index) in CHANGELOG"
          :key="release.date + release.title"
          class="about-release"
          :open="index === 0"
        >
          <summary class="about-release-title">
            {{ release.title }}
            <span class="about-release-date">{{ release.date }}</span>
          </summary>
          <ul class="about-release-list">
            <li v-for="item in release.highlights" :key="item">{{ item }}</li>
          </ul>
        </details>
      </section>
    </div>
  </div>
</template>
