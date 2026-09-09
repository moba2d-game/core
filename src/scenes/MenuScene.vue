<script setup lang="ts">
/**
 * The main menu: background, logo, and the buttons. Scene transitions
 * lifecycle, not presentation, so this only emits — `MenuScene.ts` maps
 * `play`/`openLan`/`openAbout`/`openPacks` onto
 * `sceneManager.showScene`, the same split `LoadingScene.vue` uses for its own
 * scene handover.
 *
 * The fullscreen toggle is pure view state with no scene-transition involved,
 * so — unlike the buttons above — it stays entirely local to this component
 * instead of being driven from `MenuScene.ts`.
 *
 * ## Two big buttons, and each one is a way into a match
 *
 * The menu used to carry three identical `.hextech-btn`s — Chơi, Cấu Hình Trận
 * Đấu, Chơi LAN — of which two started a match and one unfolded a panel, and
 * the panel then produced a *fourth* identical button inside itself. Nothing on
 * screen said which press was a mode, which was a setting and which was a
 * sub-step of another. Cấu hình became a `.menu-link` for a while on the
 * reading that it is a screen you visit *between* matches, like Giới thiệu.
 *
 * **That reading was wrong, and it is gone.** Configuring is not something you
 * do between matches, it is the step before every one of them — and a player
 * who never noticed the link never found the roster, the rules or the map
 * picker either. Chơi opens the panel now and the panel's own Bắt Đầu starts
 * the match. That is the same *shape* the original complaint was about — a
 * button that opens a panel with a button in it — and it is fine here for the
 * reason the original was not: this is a line (play, set up, start), not three
 * peers where one of them was a setting pretending to be a mode.
 *
 * So the two big buttons are the two ways into a match, `.menu-links` holds
 * the three screens that are not (Tướng & Map, Tạo map, Giới thiệu), and the
 * LAN half lives in `LanScene.vue`.
 *
 * **Nothing on this screen waits for the warm-up any more.** Both big buttons
 * open a *screen* — the setup panel and the LAN lobby — and neither needs a
 * byte of what the bar is fetching. The wait moved to the two presses that
 * actually open a match: Bắt Đầu in the panel and Vào trận in the lobby. The
 * bar is still here, as progress rather than a gate, so a player sets their
 * match up while it loads instead of watching it first.
 *
 * **The logo and the background are drawn, not fetched.** Both used to be
 * images, and both were Riot's: the Vietnamese *Liên Minh Huyền Thoại*
 * wordmark and a champion splash. Core ships no content of its own — every
 * champion, map and monster arrives in a pack from another repository under
 * its own licence — so a menu wearing one pack's artwork was the engine
 * claiming something that is not its. The wordmark is now text in this
 * project's own palette and the background is a gradient, which also happens
 * to remove 170KB and two precache entries from the first load.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import DomUtils from '@/utils/dom.utils';
import { installReady, iosManualInstall, promptInstall, runningStandalone } from '@/pwa/install';
import {
  offlineReady,
  requestUpdate,
  updateDownloadedCount,
  updateDownloading,
  updateQueued,
  updateReady,
} from '@/pwa/updates';
import { watchPreload, type PreloadState } from './gamePreload';
import { packStageLabel } from './packStageLabel';
import {
  dismissPackBanner,
  packBannerDismissed,
  packInstallFailures,
  retryPackInstall,
} from './packBanner';
import { packHealthDismissed, packProblems, updatablePackProblems } from '@/content/packHealth';
import { markPackNudgeSeen, packNudgeSeen } from './packNudge';

/**
 * ## The pack-health notice
 *
 * Separate from the install banner above it, which reports a pack that could
 * not be installed *this boot*. This one reports a pack that installed fine
 * and has since gone out of date — the failure the player actually met: a
 * republished pack, a chunk graph pointing at files the host had deleted, and
 * a champion whose ability silently did nothing.
 *
 * `runtimePacks` is imported **dynamically** in the handler, never at the top
 * of this file. It reaches `ContentApi` and `install.ts`, i.e. the engine, and
 * a static import here would pull the whole match into the menu's chunk with
 * nothing on screen looking wrong (`scripts/check-chunks.mjs`). `packHealth`
 * itself is dependency-free apart from `vue` for exactly this reason, so the
 * state can be read statically while the action is fetched.
 */
const packProblem = computed(() => packProblems.value[0] ?? null);
const updatingPack = ref(false);
const packUpdateFailed = ref(false);

/**
 * Every pack one press of Cập nhật settles — see
 * `content/packHealth.ts`'s `updatablePackProblems`.
 *
 * The banner read `packProblems[0]` and nothing else, so a player with three
 * stale packs pressed Cập nhật, watched the page reload, and was met by the
 * next notice: three answers and three reloads to do one thing, and no way to
 * know how many were left. Empty while the head problem is a dev rebuild,
 * whose fix is a reload rather than a fetch.
 */
const pendingUpdates = computed(() =>
  packProblem.value?.kind === 'dev-changed' ? [] : updatablePackProblems()
);

const packProblemText = computed(() => {
  const problem = packProblem.value;
  if (!problem) return '';
  const name = problem.name;
  if (problem.kind === 'dev-changed')
    return `Pack "${name}" vừa được build lại — tải lại trang để chạy bản mới.`;

  // More than one waiting: say how many and name them, because the count is
  // the fact the old banner hid. The names are two or three short strings —
  // this game ships three packs — so a list reads better than a number alone.
  const waiting = pendingUpdates.value;
  if (waiting.length > 1) {
    const names = waiting.map(entry => entry.name).join(', ');
    return `${waiting.length} pack đã có bản mới: ${names}.`;
  }

  if (problem.kind === 'update') return `Pack "${name}" đã có bản mới.`;
  const missing = problem.missingSpells;
  return missing
    ? `Pack "${name}" đã cũ — ${missing} chiêu thức không tải được, đang tạm dùng đòn đánh thường.`
    : `Pack "${name}" đã cũ — thiếu một phần nội dung.`;
});

async function updateProblemPack(): Promise<void> {
  const problem = packProblem.value;
  if (!problem || updatingPack.value) return;
  // A dev pack has nothing to fetch and nothing to replace: boot never pinned
  // it (`devPack.ts`), so the newest build is already what the next load
  // reads. Going through `updatePack` here would be worse than pointless — it
  // pins unconditionally, putting back the very pin the dev rule refuses.
  if (problem.kind === 'dev-changed') {
    location.reload();
    return;
  }
  // **All of them, not the one on screen.** The reload below costs the player
  // the same whether it settles one pack or three, so doing them together is
  // the difference between one answer and three.
  const targets: string[] = [];
  for (const entry of pendingUpdates.value) targets.push(entry.manifestUrl);
  if (targets.length === 0) return;

  updatingPack.value = true;
  packUpdateFailed.value = false;
  try {
    const { updatePacks } = await import('@/content/runtimePacks');
    if ((await updatePacks(targets)) > 0) {
      // A reload, not a live swap. The old build's modules have already been
      // evaluated in this page and ES modules evaluate once, so carrying on
      // would leave the previous classes running behind the new manifest —
      // the exact mismatch the update exists to end.
      //
      // Reloaded on *any* success rather than only on all of them: a pack the
      // network refused is still stale, and it will say so again after the
      // reload rather than holding the ones that worked hostage.
      location.reload();
      return;
    }
    packUpdateFailed.value = true;
  } catch {
    packUpdateFailed.value = true;
  } finally {
    updatingPack.value = false;
  }
}

function dismissPackProblem(): void {
  packHealthDismissed.value = true;
}

const props = defineProps<{
  /** True when the catalog holds nothing beyond core's own single champion. */
  soloContent?: boolean;
}>();

/**
 * ## The "you have no roster" nudge
 *
 * Core alone is a complete game — one champion, one map — and that is by
 * design, not a broken state. But a player pressing Chơi on a fresh install
 * has no way to know a roster exists somewhere, and the packs screen is a link
 * they have never had a reason to open. They meet one champion and conclude
 * that is the game.
 *
 * **The test is the champion count, not the installed-pack list.** The first
 * boot *seeds* a default pack URL (`runtimePacks.ts`), so that list is never
 * empty and a nudge keyed on it would never appear for anyone. What the player
 * actually has is what the catalog holds, and `soloContent` is `MenuScene.ts`
 * asking it — out here, because reaching `contentCatalog` from this component
 * would put it in the menu's own chunk.
 *
 * **Once per page load, and not persisted.** Answering it settles the question
 * for this sitting, not for good; a reload asks again. The flag lives in
 * `packNudge.ts` rather than here because `<script setup>` is the setup
 * function and `MenuScene` remounts this component on every "Quay lại" — a
 * `let` at this level would ask again on the second press of Chơi. The packs
 * screen stays one press away in the row below either way.
 */

const packNudgeOpen = ref(false);

/**
 * Chơi, with the nudge in front of it exactly once.
 *
 * The nudge is not a gate: both of its buttons lead somewhere, and the one
 * that plays is the default-looking one.
 */
function pressPlay(): void {
  if (props.soloContent === true && !packNudgeSeen()) {
    packNudgeOpen.value = true;
    return;
  }
  emit('play');
}

/** Remember the answer, whichever it was, then act on it. */
function answerNudge(to: 'packs' | 'play'): void {
  markPackNudgeSeen();
  packNudgeOpen.value = false;
  // Branched rather than `emit(cond ? a : b)`: `defineEmits` types each event
  // name as its own overload, so a union of names matches none of them.
  if (to === 'packs') emit('openPacks');
  else emit('play');
}

const emit = defineEmits<{
  play: [];
  openLan: [];
  openAbout: [];
  openPacks: [];
  openEditor: [];
}>();

// Reads real document state rather than always starting from "not
// fullscreen": this component remounts on every menu entry (see
// MenuScene.ts), but the browser's actual fullscreen state does not reset
// just because the player visited the pregame screen and came back.
const isFullscreen = ref(!!document.fullscreenElement);

/**
 * ## The warm-up bar
 *
 * `gamePreload` fetches the game's code and every image a match draws while
 * the player is looking at this screen, and Chơi waits for it. Two reasons it
 * is a gate rather than a hint: pressing Play mid-fetch used to mean a black
 * pause of unknown length, and the match itself used to open on placeholder
 * squares that filled in over the first several seconds.
 *
 * The state is module-level and survives this component, which remounts on
 * every return from the pregame screen — so a second visit finds the load long
 * finished and never shows the bar at all.
 *
 * `codeFailed` still shows Play. A menu with no way into a match is a worse
 * failure than a slow one, and `loadGameScene` retries the fetch when pressed.
 */
const preload = ref<PreloadState>({
  loaded: 0,
  total: 0,
  ratio: 0,
  done: false,
  codeFailed: false,
});
let stopWatching: (() => void) | null = null;

const percent = computed(() => Math.round(preload.value.ratio * 100));
const ready = computed(() => preload.value.done);

onMounted(() => {
  stopWatching = watchPreload(state => {
    preload.value = state;
  });
});
onUnmounted(() => {
  stopWatching?.();
  stopWatching = null;
});

const toggleFullscreen = (): void => {
  isFullscreen.value = DomUtils.toggleFullscreen();
};

/**
 * ## The version stamp, and the update offer beside it
 *
 * `__APP_VERSION__` is `package.json`'s version, replaced at build time (see
 * `vite.config.ts`). It is on the menu rather than anywhere else for the
 * reason a version number is ever shown: so a player reporting "spell X is
 * broken" can say *which build* they are on. An installed PWA makes that
 * question real — it serves whatever it cached until it is told otherwise, so
 * two players can be on different builds of the same URL.
 *
 * Which is also why the update lives here. `src/pwa/updates.ts` holds the new
 * build back rather than swapping it in, and this is the screen where taking
 * the reload costs nothing: no match is running.
 *
 * The refs are module state, not component state — this component remounts on
 * every return to the menu, and a worker that finished installing while the
 * player was in a match must still be offered when they come back out.
 */
const appVersion = __APP_VERSION__;

/**
 * Core's semver, which is a different question from the build clock above.
 *
 * `__APP_VERSION__` answers "which build am I on". This answers "which core",
 * and it is the number a content pack's `coreRange` is measured against — so
 * it is the one that decides whether a pack installs.
 *
 * It is on screen because of the failure that put it there. An install was
 * refused with *"pack lol needs core >=1.4.0, this is 1.3.0"* on a machine
 * whose `package.json` said 1.4.0: a dev server that had been up since before
 * the bump was still serving the old `define`. There was nowhere in the
 * running app to see which core it really was, so the only evidence available
 * was the refusal — and the refusal was the thing in doubt. Now the menu says
 * it before anyone has to install anything to find out.
 *
 * The define, not `packSource`'s `CORE_VERSION` re-export: identical value,
 * and importing it would pull the pack loader into the menu's chunk for a
 * string. `versionStamp.test.ts` keeps the two reading the same identifier.
 */
const coreVersion = __CORE_VERSION__;
const updating = ref(false);

const installUpdate = async (): Promise<void> => {
  // `requestUpdate`, not `applyUpdate`: the button is now offered on the fast
  // signal, seconds before there is a build to hand over to, so a press that
  // arrives early is remembered rather than refused. See `src/pwa/updates.ts`.
  await requestUpdate();
  if (updateReady.value) updating.value = true;
};

/**
 * What the one update button says, which is three different things.
 *
 * One button and not three states of two elements: the player's decision is
 * the same in all of them — *take the new build* — and the only thing that
 * changes is how much of it has arrived. A dead "đang tải…" line that becomes
 * a button twenty seconds later is two things to notice instead of one.
 */
const updateLabel = computed(() => {
  if (updating.value) return 'Đang cập nhật…';
  if (updateQueued.value && !updateReady.value) {
    // The count is what makes a wait of up to twenty seconds legible as
    // progress rather than as a hang. Omitted until the first file lands, so
    // the label never reads "0 tệp".
    return updateDownloadedCount.value > 0
      ? `Đang tải… ${updateDownloadedCount.value} tệp`
      : 'Sẽ cập nhật khi tải xong…';
  }
  return 'Có bản mới — cập nhật';
});

/** `downloading` | `queued` | `ready` — the hook `e2e:pwa-update` measures against. */
const updateState = computed(() => {
  if (updateReady.value) return 'ready';
  return updateQueued.value ? 'queued' : 'downloading';
});

/**
 * ## The failed-pack banner
 *
 * Spec §7 puts it here rather than on the loading screen, and says it does
 * not dismiss itself: a game quietly missing 58 champions reads as a broken
 * game, so the player has to be the one who decides to ignore it. Both refs
 * are module state (`./packBanner`) for the same reason the update refs
 * above are — this component remounts on every return to the menu, and a
 * banner that came back after being dismissed, or a failure list that
 * nothing ever set again, are the two shapes component state would give.
 */

/**
 * ## The install offer
 *
 * Shown only when pressing it can lead somewhere: a parked Chromium prompt,
 * or an iOS browser where installing is a manual gesture the hint dialog
 * teaches. Never inside the installed app itself.
 */
const installHintOpen = ref(false);
const installOffered = computed(
  () => !runningStandalone() && (installReady.value || iosManualInstall())
);
async function pressInstall() {
  if (installReady.value) await promptInstall();
  else installHintOpen.value = true;
}
</script>

<template>
  <div class="background"></div>

  <div class="menu-brand">
    <div class="shiny">
      <h1 id="menu-logo" class="menu-wordmark">
        <span class="menu-wordmark-main">MOBA</span><span class="menu-wordmark-2d">2D</span>
      </h1>
    </div>
  </div>

  <!-- The bar stands exactly where the buttons will, so the menu does not jump
       when it is replaced by them. -->
  <div v-if="!ready" id="menu-loading" class="menu-loading" aria-live="polite">
    <div class="menu-loading-track">
      <div class="menu-loading-fill" :style="{ width: `${percent}%` }"></div>
    </div>
    <p class="menu-loading-label">Đang tải tài nguyên trận đấu… {{ percent }}%</p>
  </div>

  <!-- The two ways into a match, and nothing else at this size.
       **Neither waits on the warm-up any more.** Both now open a screen —
       the setup panel and the LAN lobby — and neither of those needs a single
       byte of what the bar is fetching. The wait moved to where it belongs:
       the Bắt Đầu inside the panel, and Vào trận inside the lobby, which are
       the presses that actually open a match. So the player sets up their
       match *while* it loads instead of watching a bar first. -->
  <button id="play-btn" class="hextech-btn" @click="pressPlay" @touchend.prevent="pressPlay">
    Chơi
  </button>
  <button id="lan-btn" class="hextech-btn" @click="emit('openLan')" @touchend.prevent="emit('openLan')">
    <i class="fas fa-user-group" aria-hidden="true"></i>
    Online
  </button>
  <p v-if="preload.codeFailed" class="menu-loading-warning">
    Tải dữ liệu chưa xong — bấm Chơi để thử lại.
  </p>

  <!-- Both `@click` and `@touchend.prevent` on each button: once a
       `GameScene` is on screen it calls `preventDefault()` on every touch on
       the page, which stops the browser synthesising a trailing `click`, so a
       click-only handler is dead under a thumb. -->
  <div v-if="packInstallFailures.length && !packBannerDismissed" class="pack-banner" role="alert">
    <span>
      Chưa tải được nội dung — {{ packStageLabel(packInstallFailures[0].stage) }}. Đang chơi với
      tướng mặc định.
    </span>
    <div class="pack-banner-actions">
      <button id="pack-banner-retry" type="button" @click="retryPackInstall" @touchend.prevent="retryPackInstall">
        Thử lại
      </button>
      <button id="pack-banner-dismiss" type="button" class="ghost" @click="dismissPackBanner"
        @touchend.prevent="dismissPackBanner">
        Bỏ qua
      </button>
    </div>
  </div>

  <!-- A pack that installed fine and has since gone out of date. Its own
       banner rather than a line in the one above: that one is about this
       boot's install, this one is about a pack the player already has, and
       the way out of each is different. -->
  <div v-if="packProblem && !packHealthDismissed" class="pack-banner"
    :class="{ 'pack-banner-broken': packProblem.kind === 'broken' }" role="alert">
    <span>
      {{ packProblemText }}
      <template v-if="packUpdateFailed"> Không cập nhật được — thử lại khi có mạng. </template>
    </span>
    <div class="pack-banner-actions">
      <button id="pack-update" type="button" :disabled="updatingPack" @click="updateProblemPack"
        @touchend.prevent="updateProblemPack">
        {{
          packProblem.kind === 'dev-changed'
            ? 'Tải lại'
            : updatingPack
              ? 'Đang cập nhật…'
              : pendingUpdates.length > 1
                ? `Cập nhật cả ${pendingUpdates.length}`
                : 'Cập nhật'
        }}
      </button>
      <button id="pack-update-dismiss" type="button" class="ghost" @click="dismissPackProblem"
        @touchend.prevent="dismissPackProblem">
        Để sau
      </button>
    </div>
  </div>

  <!-- In the column, under the two buttons above — not pinned to the top-right
       corner beside the fullscreen toggle, which is where two of these spent
       their whole life as unlabelled 1em glyphs. Neither was findable there,
       and "Nội dung / Pack" is now the screen a player gets a roster from at
       all, so it cannot also be the least visible control on the menu.

       Cấu hình joined them: it was a third full-size button competing with the
       two that start a match, and it is the same *kind* of thing as these two —
       a screen you visit between matches. Its id stays `config-btn`, which
       several e2e scripts address it by.

       All three sit outside the `ready` gate above, for the reason in this
       file's header: none opens game code, so none waits on the warm-up. -->
  <div class="menu-links">
    <button id="packs-btn" class="menu-link" title="Thêm tướng và map từ pack" @click="emit('openPacks')"
      @touchend.prevent="emit('openPacks')">
      <i class="fas fa-cubes" aria-hidden="true"></i>
      <span>Tải Pack</span>
    </button>

    <button id="editor-btn" class="menu-link" title="Vẽ map của riêng bạn, hoặc sửa một map có sẵn, rồi chơi thử ngay"
      @click="emit('openEditor')" @touchend.prevent="emit('openEditor')">
      <i class="fas fa-pen-ruler" aria-hidden="true"></i>
      <span>Tạo map</span>
    </button>

    <button v-if="installOffered" id="install-btn" class="menu-link"
      title="Cài game thành app: mở từ màn hình chính, toàn màn hình, chơi được offline" @click="pressInstall"
      @touchend.prevent="pressInstall">
      <i class="fas fa-download" aria-hidden="true"></i>
      <span>Cài app</span>
    </button>

    <button id="about-btn" class="menu-link" title="Giới thiệu" @click="emit('openAbout')"
      @touchend.prevent="emit('openAbout')">
      <i class="fas fa-circle-info" aria-hidden="true"></i>
      <span>Giới thiệu</span>
    </button>
  </div>

  <!-- Sits over the menu rather than replacing it, so the answer is visibly
       a choice and not a screen the player has been sent to. Both handlers
       carry `@touchend.prevent` beside `@click` for the reason every control
       here does: a `GameScene` on the page kills synthesised clicks. -->
  <div v-if="packNudgeOpen" id="pack-nudge" class="pack-nudge" role="dialog" aria-modal="true">
    <div class="pack-nudge-box">
      <h2>Chưa cài pack nào</h2>
      <p>
        Trận đấu sẽ dùng nội dung mặc định: <b>1 tướng</b> và
        <b>1 map</b>. Cài thêm pack để có thêm tướng, map, vật phẩm và quái rừng.
      </p>
      <div class="pack-nudge-actions">
        <button id="pack-nudge-play" type="button" class="hextech-btn" @click="answerNudge('play')"
          @touchend.prevent="answerNudge('play')">
          Chơi luôn
        </button>
        <button id="pack-nudge-packs" type="button" class="menu-link" @click="answerNudge('packs')"
          @touchend.prevent="answerNudge('packs')">
          <i class="fas fa-cubes" aria-hidden="true"></i>
          <span>Xem pack</span>
        </button>
      </div>
    </div>
  </div>

  <!-- The iOS answer to the install button: no prompt event exists there, so
       the button opens the recipe instead. Wears the pack-nudge dress — the
       same kind of thing, a small modal choice over the menu. -->
  <div v-if="installHintOpen" id="install-hint" class="pack-nudge" role="dialog" aria-modal="true">
    <div class="pack-nudge-box">
      <h2>Cài app trên iPhone/iPad</h2>
      <p>
        Mở trang này bằng <b>Safari</b>, bấm nút <b>Chia sẻ</b>
        <i class="fas fa-arrow-up-from-bracket" aria-hidden="true"></i>, rồi chọn
        <b>Thêm vào MH chính</b>.
      </p>
      <div class="pack-nudge-actions">
        <button id="install-hint-close" type="button" class="hextech-btn" @click="installHintOpen = false"
          @touchend.prevent="installHintOpen = false">
          Đã hiểu
        </button>
      </div>
    </div>
  </div>

  <button id="fullscreen-btn" @click="toggleFullscreen">
    <i :class="isFullscreen ? 'fas fa-compress' : 'fas fa-expand'"></i>
  </button>

  <!-- Bottom corner, dim: findable when someone asks "what version are you
       on", invisible the rest of the time. -->
  <p id="menu-version" class="menu-version">
    v{{ appVersion }}
    <!-- Core's own semver, dimmer than the build clock beside it: it matters
         on exactly one day, when a pack refuses to install and its message
         names a number this is the only place to check. -->
    <span id="menu-core-version" class="menu-version-core" title="Phiên bản core, dùng để kiểm tra pack">
      core {{ coreVersion }}
    </span>
    <span v-if="offlineReady" class="menu-version-offline" title="Đã lưu để chơi offline">
      <i class="fas fa-circle-check" aria-hidden="true"></i> offline
    </span>
  </p>

  <!-- Offered on the *fast* signal — `updatefound`, about a second — not on
       the slow one. Pressing before the download finishes is a promise, not a
       refusal: `requestUpdate` remembers it and applies the moment the build
       is ready. See src/pwa/updates.ts for why the two are ~19s apart.

       Only ever on the menu, which is the one screen where losing the page
       costs nothing. -->
  <button v-if="updateDownloading || updateReady" id="menu-update-btn" class="menu-update" :data-state="updateState"
    :data-downloaded="updateDownloadedCount" :disabled="updating || (updateQueued && !updateReady)"
    @click="installUpdate">
    <i class="fas fa-arrow-rotate-right" :class="{ 'fa-spin': updating || (updateQueued && !updateReady) }"
      aria-hidden="true"></i>
    <span>{{ updateLabel }}</span>
  </button>
</template>
