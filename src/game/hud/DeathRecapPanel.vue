<script setup lang="ts">
/**
 * The death recap: who killed the player and what the last seconds of damage
 * were made of, the way the source game retells a death. Mounted once from
 * `InGameHUD`, above whichever view (`DesktopHudView` / `MobileHudView`) is
 * up, so both modes share one panel — the same reason the shop lives there.
 *
 * Shown while dead, dismissable, and re-shown on the next death: `recap.seq`
 * bumps per death, and the panel remembers only which seq was closed.
 *
 * **This is the bottom bar, on both layouts.** Always collapsed when it
 * arrives, anchored to the bottom edge and opening *upward*, it
 * holds the three things a dead player reads — who killed them, how long until
 * they are back, and whose eyes they are borrowing — in the place the revive
 * pill used to have to itself. `SpectateBar` is the same content for the case
 * this panel is not on screen (dismissed, or a desktop layout where the panel
 * has never owned the bottom edge); `hud.css` hides the one while the other is
 * up, with `:has()`, so neither component has to know about the other.
 *
 * ## Why the bar does not move
 *
 * It is a bar a player *presses* — the headline opens it, and two buttons on
 * the right collapse and dismiss it — so every part of it that moves is a
 * mis-tap waiting to happen. Three things had it moving, all of them at the
 * one moment a player is most likely to be reaching for it:
 *
 *  - **The countdown and the ally control shared the headline's line.** Four
 *    things on one row, and the killer's name is the one that gives: it pushed
 *    the rest out, and on a phone there was no room to push into.
 *  - **They then went away on respawn**, and everything after them slid left
 *    into the space. What the player pressed was the button that used to be
 *    there.
 *  - **The panel was `width: auto` while collapsed** and centred, so losing
 *    them re-centred the whole bar as well — the two shifts compounding.
 *
 * So: the live half is its own line *above* the headline, the panel holds one
 * width in every state, and the buttons live in `.death-recap-actions` at the
 * end of the row. The panel is anchored to the bottom of the screen and grows
 * upward, which is what makes the first of those work — the line with the
 * buttons on it is the last line, and the last line never moves, whether the
 * live strip above it is there or not, whether the panel is open or shut.
 */
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue';
import { vTap } from './tapGuard';
import type { HudInteractions } from './hudInteractions';
import type { DeathRecapDisplay } from './hudState';

const props = defineProps<{
  recap: DeathRecapDisplay;
  /** While dead a stray tap must not eat the panel; alive, any tap outside closes it. */
  isDead: boolean;
  /** Seconds until respawn — 0 once alive. Shown only while dead. */
  reviveAfter: number;
  /** The ally the death camera is on, or null while it lingers on the corpse. */
  spectating: string | null;
  /**
   * Whether a fight save point exists to rewind to — `HudState.hasCheckpoint`.
   * False in a LAN match, so the retry shortcut never renders there.
   */
  canRetry?: boolean;
  /** Whether a deliberate save exists — see `HudState.hasManualCheckpoint`. */
  retryArmed?: boolean;
}>();

const hud = inject<HudInteractions>('hud')!;

/** The bar's live half: only worth drawing while the player is actually down. */
const showRevive = computed(() => props.isDead);

const dismissedSeq = ref(0);
const dismiss = (): void => {
  dismissedSeq.value = props.recap.seq;
};

/**
 * Collapsed = just the bar. Open only for the death that was opened.
 *
 * Keyed on `recap.seq` the way `dismissedSeq` above is, and for the same
 * reason: this component is **not** remounted between deaths — `deathRecap`
 * outlives a respawn, so `v-if` never lets go and a plain `ref(true)` would
 * still be open on the next one. A seq that has moved on is a new death, and a
 * new death opens shut.
 *
 * Nothing is persisted. Opening it takes most of the screen (`hud.css`), which
 * is a fair trade for a question a player asked and a bad one for an answer
 * that arrives by itself every time they die — so the panel forgets, on
 * purpose, rather than remembering a preference it would then impose.
 */
const expandedSeq = ref(0);
const collapsed = computed(() => props.recap.seq !== expandedSeq.value);
const toggleCollapse = (): void => {
  expandedSeq.value = collapsed.value ? props.recap.seq : 0;
};

/**
 * Tap-outside-to-close, but only once respawned: while dead the player is
 * *reading*, and there is nothing else those taps could mean; alive, the
 * first order they give the game doubles as "done with the recap".
 * `pointerdown` because `GameScene` calls `preventDefault()` on every touch,
 * which kills synthesized clicks but never the pointer stream.
 */
const panelEl = ref<HTMLElement | null>(null);
const onOutsidePointer = (event: PointerEvent): void => {
  if (props.isDead) return;
  if (props.recap.seq === dismissedSeq.value) return;
  if (panelEl.value && event.target instanceof Node && panelEl.value.contains(event.target)) return;
  dismiss();
};
onMounted(() => document.addEventListener('pointerdown', onOutsidePointer, true));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutsidePointer, true));
</script>

<template>
  <div v-if="recap.seq !== dismissedSeq" ref="panelEl" class="death-recap" :class="{ collapsed }">
    <!-- The half that only exists while the player is down, on the line above
         the one they press. It comes and goes; nothing under it may. -->
    <div v-if="showRevive" class="death-recap-live">
      <span class="death-recap-revive">
        Hồi sinh sau <b id="recap-revive-seconds">{{ reviveAfter }}</b
        >s
      </span>
      <!-- The practice room's own answer to dying: back to the last save
           point, this instant. Rendered only when one exists to go to. -->
      <button
        v-if="canRetry"
        type="button"
        class="death-recap-spectate death-recap-retry"
        id="recap-retry-checkpoint"
        :title="retryArmed ? 'Quay lại mốc gần nhất' : 'Trận này chưa lưu mốc nào — mở bảng Mốc đã lưu để chọn'"
        @click="hud.retryFromCheckpoint()"
        v-tap="() => hud.retryFromCheckpoint()"
      >
        <i class="fas fa-clock-rotate-left" aria-hidden="true"></i>
        <span class="death-recap-spectate-name">{{ retryArmed ? 'Thử lại từ mốc gần nhất' : 'Thử lại…' }}</span>
      </button>
      <button
        v-if="spectating"
        type="button"
        class="death-recap-spectate"
        title="Xem đồng minh tiếp theo"
        @click="hud.spectateNext()"
        v-tap="() => hud.spectateNext()"
      >
        <i class="fas fa-eye" aria-hidden="true"></i>
        <span class="death-recap-spectate-name">{{ spectating }}</span>
        <i class="fas fa-forward" aria-hidden="true"></i>
      </button>
    </div>
    <div class="death-recap-head">
      <!-- The whole headline toggles, not just the chevron: on a phone this is
           the bar you press to open the panel, and a 16px glyph is not that. -->
      <span
        class="death-recap-title"
        role="button"
        :aria-expanded="!collapsed"
        @click="toggleCollapse()"
        v-tap="toggleCollapse"
      >
        <i class="fas fa-skull" aria-hidden="true"></i>
        Hạ gục bởi <b>{{ recap.killer }}</b>
      </span>
      <!-- One box for both buttons, so they are the row's *last* item however
           much or little sits to their left. Loose in the flex row they were
           the third and fourth of four, and `space-between` moved them both
           whenever one of the other two went. -->
      <span class="death-recap-actions">
        <button
          type="button"
          class="death-recap-close"
          :title="collapsed ? 'Mở rộng' : 'Thu gọn'"
          :aria-label="collapsed ? 'Mở rộng bảng tổng kết' : 'Thu gọn bảng tổng kết'"
          :aria-expanded="!collapsed"
          @click="toggleCollapse()"
          v-tap="toggleCollapse"
        >
          <!-- The arrow points the way the panel moves, and the panel opens
               upward from the bottom edge: closed it offers "up", open it
               offers "down". It pointed the other way while this lived at the
               top of the screen and grew downward. -->
          <i
            class="fas"
            :class="collapsed ? 'fa-chevron-up' : 'fa-chevron-down'"
            aria-hidden="true"
          ></i>
        </button>
        <button
          type="button"
          class="death-recap-close"
          title="Đóng"
          aria-label="Đóng bảng tổng kết"
          @click="dismiss()"
          v-tap="dismiss"
        >
          <i class="fas fa-times" aria-hidden="true"></i>
        </button>
      </span>
    </div>
    <div v-show="!collapsed" class="death-recap-rows">
      <div v-for="row in recap.rows" :key="row.attacker" class="death-recap-row">
        <div class="death-recap-attacker">
          <span class="death-recap-attacker-name">{{ row.attacker }}</span>
          <span class="death-recap-attacker-total">{{ row.total }}</span>
        </div>
        <div v-for="line in row.sources" :key="line.label + line.type" class="death-recap-source">
          <img
            v-if="line.image"
            crossorigin="anonymous"
            class="death-recap-source-icon"
            :src="line.image"
            alt=""
            loading="lazy"
            decoding="async"
          />
          <span v-else class="death-recap-source-dot" aria-hidden="true"></span>
          <span class="death-recap-source-label">{{ line.label }}</span>
          <span v-if="line.hits > 1" class="death-recap-source-hits">×{{ line.hits }}</span>
          <!-- What a shield ate out of this source, when it ate anything. A
               source that landed nothing at all shows only the blocked figure,
               which is the whole point: it *was* there, and the bubble is why
               it did not count. -->
          <span v-if="line.blocked > 0" class="death-recap-source-blocked" title="Bị khiên chặn">
            <i class="fas fa-shield-alt" aria-hidden="true"></i>{{ line.blocked }}
          </span>
          <span class="death-recap-source-amount" :class="'dmg-' + line.type.toLowerCase()">
            {{ line.amount }}
          </span>
        </div>
      </div>
    </div>
    <div v-show="!collapsed" class="death-recap-total">
      Tổng <b>{{ recap.total }}</b> sát thương phải chịu
      <!-- Its own clause rather than folded into the total: the two answer
           different questions, and adding them would break the figure a player
           checks against their own health pool. -->
      <span v-if="recap.blocked > 0" class="death-recap-blocked-total">
        · khiên chặn <b>{{ recap.blocked }}</b>
      </span>
    </div>
    <!-- The same window as the rows above, so the two totals are comparable
         at a glance — which is the whole reason this line exists. -->
    <div v-show="!collapsed" class="death-recap-dealt">
      <span class="death-recap-dealt-label">Bạn đã gây</span>
      <span class="death-recap-dealt-figures">
        <span class="dmg-physical">{{ recap.dealt.physical }}</span>
        <span class="dmg-magic">{{ recap.dealt.magic }}</span>
        <span class="dmg-true">{{ recap.dealt.true }}</span>
      </span>
    </div>
  </div>
</template>
