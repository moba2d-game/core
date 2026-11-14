<script setup lang="ts">
/**
 * The quick scoreboard: both teams side by side, the player's on the left.
 *
 * A glance, not a panel. It is up while Tab is held (or, on touch, until the
 * next tap on the dimmed edge or the close button), it pauses nothing, and it
 * changes nothing — the config panel's Đội tab is where a match is edited.
 * Pure display: every number is built in `hudState.buildScoreboard`, so this
 * file reads like the board it draws.
 *
 * The one thing it *does* is describe an item: hover (mouse) or tap (touch)
 * a bag slot and the same card the owner's inventory shows — stats block and
 * prose — opens beside it. Drawn here rather than through `hud.spellHover`
 * because that panel lives in the desktop layout only, and this board is on
 * both.
 */
import { ref } from 'vue';
import { vTap, type TouchLike } from './tapGuard';
import type { ItemSlotDisplay, ScoreboardDisplay } from './hudState';

defineProps<{ board: ScoreboardDisplay; touch: boolean }>();
const emit = defineEmits<{ close: [] }>();

const compact = (n: number): string =>
  n >= 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);

interface ItemDetail {
  item: ItemSlotDisplay;
  key: string;
  style: Record<string, string>;
}

const detail = ref<ItemDetail | null>(null);

/**
 * Place the card under the slot, kept inside the viewport on all four edges
 * — the same rule `HudInteractions.showSpellInfo` applies under a thumb, for
 * the same reason: a slot near the bottom of a short phone screen would
 * otherwise push most of the card off it.
 */
const placeDetail = (item: ItemSlotDisplay, key: string, element: HTMLElement): void => {
  const { x, width, bottom, y } = element.getBoundingClientRect();
  const panelWidth = Math.min(300, window.innerWidth * 0.78);
  const left = Math.min(
    Math.max(x + width / 2 - panelWidth / 2, 6),
    Math.max(6, window.innerWidth - panelWidth - 6)
  );
  const maxPanelHeight = window.innerHeight * 0.6;
  const below = bottom + 8;
  const fits = below + maxPanelHeight <= window.innerHeight - 6;
  detail.value = {
    item,
    key,
    style: fits
      ? { top: `${below}px`, bottom: 'auto', left: `${left}px`, width: `${panelWidth}px` }
      : { top: 'auto', bottom: `${window.innerHeight - y + 8}px`, left: `${left}px`, width: `${panelWidth}px` },
  };
};

const hoverDetail = (item: ItemSlotDisplay, key: string, event: MouseEvent): void => {
  if (!item.filled) return;
  placeDetail(item, key, event.currentTarget as HTMLElement);
};

const hideDetail = (): void => {
  detail.value = null;
};

/** A tap toggles the card, so a thumb has a way to read it and a way to put it away. */
const tapDetail = (item: ItemSlotDisplay, key: string, event: Event | TouchLike): void => {
  if (!item.filled) return;
  if (detail.value?.key === key) return hideDetail();
  // `v-tap` hands over the native TouchEvent behind its `TouchLike` face.
  placeDetail(item, key, (event as Event).currentTarget as HTMLElement);
};

/** Only the dimmed edge closes the board — a tap that landed on the board itself is reading it. */
const onBackdrop = (event: Event | TouchLike): void => {
  const native = event as Event;
  if (native.target !== native.currentTarget) return;
  emit('close');
};
</script>

<template>
  <div class="scoreboard-backdrop" @click="onBackdrop" v-tap="onBackdrop">
    <div class="scoreboard" role="dialog" aria-label="Bảng điểm" @click="hideDetail">
      <header class="scoreboard-head">
        <span class="scoreboard-title"><i class="fa-solid fa-ranking-star" aria-hidden="true"></i> Bảng điểm</span>
        <span v-if="!touch" class="scoreboard-hint">Giữ Tab</span>
        <button
          v-else
          type="button"
          class="scoreboard-close"
          aria-label="Đóng bảng điểm"
          @click.stop="emit('close')"
          v-tap="() => emit('close')"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </header>

      <div class="scoreboard-teams">
        <section
          v-for="team of board.teams"
          :key="team.teamId"
          class="scoreboard-team"
          :class="['scoreboard-team--' + team.modifier, { mine: team.mine }]"
        >
          <header class="scoreboard-team-head">
            <span class="scoreboard-team-name">{{ team.label }}</span>
            <span class="scoreboard-team-kills"><i class="fa-solid fa-skull" aria-hidden="true"></i> {{ team.kills }}</span>
          </header>
          <div class="scoreboard-cols" aria-hidden="true">
            <span></span><span></span><span>K / D / A</span><span>CS</span><span>Vàng</span><span class="col-dmg">Dmg</span><span>Đồ</span>
          </div>
          <ul class="scoreboard-rows">
            <li
              v-for="row of team.rows"
              :key="row.id"
              class="scoreboard-row"
              :class="{ me: row.isPlayer, dead: row.isDead }"
            >
              <span class="scoreboard-face">
                <img v-if="row.avatar" crossorigin="anonymous" :src="row.avatar" alt="" />
                <!-- The respawn countdown over the grey portrait; a skull when the
                     count has run out but the body has not stood up yet. -->
                <span v-if="row.isDead" class="scoreboard-dead">
                  <template v-if="row.reviveAfter > 0">{{ row.reviveAfter }}</template>
                  <i v-else class="fa-solid fa-skull" aria-hidden="true"></i>
                </span>
              </span>
              <span class="scoreboard-name">
                <span class="scoreboard-name-text">{{ row.name }}</span>
                <span v-if="row.streak >= 3" class="scoreboard-streak" :title="`Chuỗi ${row.streak}`">
                  <i class="fa-solid fa-fire" aria-hidden="true"></i>{{ row.streak }}
                </span>
              </span>
              <span class="scoreboard-kda">
                <b>{{ row.kills }}</b> / <span class="d">{{ row.deaths }}</span> / {{ row.assists }}
              </span>
              <span class="scoreboard-cs">{{ row.cs }}</span>
              <span class="scoreboard-gold"><i class="fa-solid fa-coins" aria-hidden="true"></i>{{ compact(row.gold) }}</span>
              <span class="scoreboard-dmg col-dmg">{{ compact(row.damage) }}</span>
              <span class="scoreboard-items">
                <span
                  v-for="(item, i) of row.items"
                  :key="i"
                  class="scoreboard-item"
                  :class="{ empty: !item.filled, filled: item.filled, active: detail?.key === row.id + ':' + i }"
                  @mouseenter="hoverDetail(item, row.id + ':' + i, $event)"
                  @mouseleave="hideDetail"
                  @click.stop="tapDetail(item, row.id + ':' + i, $event)"
                  v-tap="(event: TouchLike) => tapDetail(item, row.id + ':' + i, event)"
                >
                  <img v-if="item.image" crossorigin="anonymous" :src="item.image" alt="" />
                </span>
              </span>
            </li>
          </ul>
        </section>
      </div>
    </div>

    <!-- The item card: the inventory's own panel classes, so it looks like the
         one the owner sees, positioned by `placeDetail`. -->
    <div v-if="detail" class="spell-info scoreboard-item-info" :style="detail.style">
      <div class="header">
        <div>
          <img crossorigin="anonymous" :src="detail.item.image" alt="" />
          <h4>{{ detail.item.name }}</h4>
        </div>
        <div v-if="detail.item.hasActive" class="costs"><span>Kích hoạt</span></div>
      </div>
      <ul v-if="detail.item.stats.length" class="hover-stats">
        <li v-for="line of detail.item.stats" :key="line.label">
          <span class="amount">{{ line.amount }}</span> {{ line.label }}
        </li>
      </ul>
      <ul v-if="detail.item.totals?.length" class="item-totals">
        <li class="item-totals-title">Trong trận này</li>
        <li v-for="line of detail.item.totals" :key="line.label">
          <span class="amount">{{ line.amount }}</span> {{ line.label }}
        </li>
      </ul>
      <p v-if="detail.item.description" class="body" v-html="detail.item.description"></p>
    </div>
  </div>
</template>
