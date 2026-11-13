<script setup lang="ts">
/**
 * The kill callouts and the banner, one component for both HUD layouts.
 *
 * Top centre, like the game this one is inspired by: the newest callout
 * lands under the top edge and pushes the older ones down; a banner for the
 * moments worth shouting sits beneath the stack. Pure display — everything
 * it shows is decided in `hudState`'s `buildFeed` (who is ally, which badges,
 * which colour family, how faded, whose kill), so this file has no game
 * import and no opinion. Mounted from `InGameHUD.vue` beside the death
 * recap, hidden with the corner cluster when a panel takes the corner.
 *
 * **A row is a run, not a kill** (`hud/killFeedGroups.ts`): one killer, then
 * every face they took down. Two `transition-group`s, nested, are what makes
 * that read as an update rather than a new callout — the outer one is keyed
 * on the row's opening kill, so a growing run is the same node and never
 * re-enters, and the inner one animates only the face just added.
 *
 * The names go once there is more than one victim. Five of them never fit a
 * phone's top edge, and the row that tried was the row that had to be capped
 * at three and then two — the faces are what a player reads at a glance
 * anyway, and the badge already says how many.
 *
 * Past five faces the row counts instead of drawing (`MAX_FEED_VICTIMS`): a
 * ten-kill run was 755px wide on a 692px window and lost both its ends to the
 * clip, the killer's own face among them. Newest face first, so the run's
 * older kills are the ones that fall into the count.
 *
 * A badge's word is wrapped rather than left bare so a narrow window can drop
 * it (`hud.css`) and keep the icon: the colour and the glyph already say which
 * kind of moment it was, and the row losing its left end costs far more.
 *
 * An objective row — a turret, an epic camp — has no portrait to put on the
 * right, so the glyph for its kind stands in for one and the name is kept.
 *
 * ## What stops it stacking on itself
 *
 * Three things, all of which only showed up when kills came faster than a row
 * lives — a 1v10 practice fight, which is what this room is for:
 *
 *  - **The stack is capped here, not in `hud.css`.** `nth-child` counts the
 *    rows *leaving* too, so a ghost sitting at the top of the list pushed a
 *    live row past the cap and blanked it for the length of a fade. A number
 *    the template slices by cannot miscount.
 *  - **A leaving row is pinned where it died.** `.kill-feed-leave-active` takes
 *    it out of flow, and an out-of-flow child of a centred flex column has its
 *    static position at the *top* of that column — so every ghost teleported
 *    onto the newest callout and faded there, two rows deep. `pinLeaving`
 *    writes the offsets it already had before the class lands.
 *  - **The banner is one element, not a queue of them.** See below.
 */
import { computed, ref, watch } from 'vue';
import type { FeedDisplay } from './hudState';
import type { AnnouncementKind, ObjectiveKind } from '@/game/combat/Announcer';

const props = defineProps<{ feed: FeedDisplay; touch?: boolean }>();

/**
 * Rows the stack draws, by layout. Three on a monitor, two on a phone — the
 * feed sits over the fight and the occlusion budget is the whole reason there
 * is a cap at all. `hudState` hands over at most `FEED_ROWS`; this narrows it
 * for the touch layout, which used to be `hud.css`'s job and cannot be, for
 * the counting reason in the header.
 */
const MAX_ROWS = 3;
const MAX_ROWS_TOUCH = 2;

const rows = computed(() => props.feed.rows.slice(0, props.touch ? MAX_ROWS_TOUCH : MAX_ROWS));

/**
 * Flips whenever the banner's words change, and at no other time.
 *
 * The banner used to be keyed on the announcement, so every new moment built a
 * *second* banner: `<transition>` runs enter and leave together, both are
 * absolutely positioned at the same spot, and 40px gradient type over 40px
 * gradient type is unreadable — the "two announcers on top of each other" this
 * component was reported for. Unkeyed, one element stays mounted for the whole
 * fight and simply rewrites itself. This is what puts the punch back: swapping
 * the class restarts the pop animation, because a class that is already there
 * would not.
 */
const pop = ref(0);
watch(
  () => {
    const banner = props.feed.banner;
    return banner && `${banner.seq}\u0000${banner.kind}\u0000${banner.title}\u0000${banner.subtitle}`;
  },
  next => {
    if (next) pop.value ^= 1;
  }
);

/**
 * Holds a leaving row at the offsets it had while it was still in flow, before
 * `.kill-feed-leave-active` makes it absolute and the flex column forgets where
 * it was. Vue 3's `TransitionGroup` does this for rows that *move* and not for
 * rows that go.
 */
const pinLeaving = (el: Element): void => {
  const row = el as HTMLElement;
  row.style.top = `${row.offsetTop}px`;
  row.style.left = `${row.offsetLeft}px`;
  row.style.width = `${row.offsetWidth}px`;
};

/**
 * And drops the pin again on the way in. `top` and `left` mean nothing to a
 * row back in flow, but `width` does: a row reusing an element that left
 * earlier would wear the width it had then.
 */
const unpin = (el: Element): void => {
  const row = el as HTMLElement;
  row.style.top = '';
  row.style.left = '';
  row.style.width = '';
};

/** The glyph an objective wears where a champion would have a face. */
const OBJECTIVE_ICON: Record<ObjectiveKind, string> = {
  turret: 'fa-solid fa-chess-rook',
  epic: 'fa-solid fa-dragon',
};

const TAG_ICON: Record<AnnouncementKind, string> = {
  first: 'fa-solid fa-droplet',
  multi: 'fa-solid fa-bolt',
  streak: 'fa-solid fa-fire',
  shutdown: 'fa-solid fa-fire-extinguisher',
  bounty: 'fa-solid fa-sack-dollar',
};

/** The letter under a portrait while its image is still on its way from a pack's host. */
const initial = (name: string): string => name.trim().charAt(0).toUpperCase();
</script>

<template>
  <!-- One column, so the banner always sits under however many rows there are. -->
  <div v-if="feed.rows.length || feed.banner" class="kill-callouts">
    <!-- Always rendered, empty or not: `hud.css` reserves its height so the
         banner under it has a fixed place to sit. Dropping the element when
         the last row ages out is what used to jerk the banner up the screen
         mid-fight. -->
    <transition-group
      tag="ul"
      name="kill-feed"
      class="kill-feed"
      aria-live="polite"
      @before-enter="unpin"
      @before-leave="pinLeaving"
    >
      <li
        v-for="row of rows"
        :key="row.seq"
        class="kill-feed-row"
        :class="[row.accent && 'accent-' + row.accent, { mine: row.mine }]"
        :style="{ '--row-fade': row.fade }"
      >
        <template v-if="row.killer">
          <span class="kill-feed-face" :class="row.killer.side">
            {{ initial(row.killer.name) }}
            <img v-if="row.killer.avatar" crossorigin="anonymous" :src="row.killer.avatar" alt="" />
          </span>
          <span class="kill-feed-name" :class="row.killer.side">{{ row.killer.name }}</span>
        </template>
        <i class="fa-solid fa-skull-crossbones kill-feed-mark" aria-hidden="true"></i>
        <span
          v-if="row.victims.length === 1"
          class="kill-feed-name"
          :class="row.objective ? 'objective' : row.victims[0].side"
        >
          {{ row.victims[0].name }}
        </span>
        <transition-group tag="span" name="kill-feed-victim" class="kill-feed-victims">
          <span
            v-for="victim of row.victims"
            :key="victim.seq"
            class="kill-feed-face"
            :class="row.objective ? 'objective' : victim.side"
            :title="victim.name"
          >
            <i v-if="row.objective" :class="OBJECTIVE_ICON[row.objective]" aria-hidden="true"></i>
            <template v-else>
              {{ initial(victim.name) }}
              <img v-if="victim.avatar" crossorigin="anonymous" :src="victim.avatar" alt="" />
            </template>
          </span>
          <span v-if="row.overflow" key="overflow" class="kill-feed-more">+{{ row.overflow }}</span>
        </transition-group>
        <span
          v-for="tag of row.tags"
          :key="tag.kind"
          class="kill-feed-badge"
          :class="'badge-' + tag.kind"
          :title="tag.label"
        >
          <i :class="TAG_ICON[tag.kind]" aria-hidden="true"></i>
          <span class="kill-feed-badge-label">{{ tag.label }}</span>
        </span>
      </li>
    </transition-group>

    <!-- Unkeyed and `out-in`, so there is never a second banner: the words are
         rewritten in place while one is on screen, and the only enter/leave
         left is the banner arriving out of nothing or going. See `pop`. -->
    <transition name="kill-banner" mode="out-in">
      <div
        v-if="feed.banner"
        class="kill-banner"
        :class="[
          'banner-' + feed.banner.kind,
          feed.banner.tier ? 'tier-' + feed.banner.tier : null,
          'pop-' + pop,
        ]"
      >
        <div class="kill-banner-title">{{ feed.banner.title }}</div>
        <div v-if="feed.banner.subtitle" class="kill-banner-sub">{{ feed.banner.subtitle }}</div>
      </div>
    </transition>
  </div>
</template>
