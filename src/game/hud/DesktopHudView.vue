<script setup lang="ts">
/**
 * The mouse-and-keyboard HUD: the bar along the bottom of the screen, spell
 * cooldowns drawn on its own icons, hover for the description.
 *
 * Reads `HudState` (via the `state` prop, recomputed at `HUD_UPDATE_INTERVAL_MS`
 * by `InGameHUD`) and `HudInteractions` (via `inject('hud')`, shared with
 * `MobileHudView` and the practice panel) — it owns neither. Its whole job is
 * this layout; the desktop-specific behaviour in it is `mouseover`/`mouseout`
 * for the tooltip, everything else is the shared interaction layer.
 */
import { inject, ref } from 'vue';
import FormatUtils from '@/utils/format.utils';
import { InventoryDrag } from './inventoryDrag';
import { vTap } from './tapGuard';
import type { HudInteractions } from './hudInteractions';
import type { HudState } from './hudState';

defineProps<{ state: HudState }>();

const hud = inject<HudInteractions>('hud')!;

/**
 * Rearranging the bag by dragging one slot onto another — see
 * `inventoryDrag.ts` for why the gesture itself lives in a module and what the
 * threshold is protecting.
 *
 * The state machine is plain, so `bump` is what tells Vue a highlight moved:
 * incrementing a ref is cheaper and far less surprising than making a class
 * with a `hypot` in it reactive, and the only thing the template reads out of
 * it is `drag.over`.
 */
const drag = new InventoryDrag();
const bump = ref(0);

/**
 * Which bag slot is under a screen point, or `null`.
 *
 * `elementFromPoint` rather than `@pointerenter` on each slot: a pointer that
 * has been captured — which is every touch drag — stops firing enter and leave
 * on anything it passes over, so the per-slot handlers would light nothing on
 * a phone. One hit test on the point the browser already gave us answers the
 * same question in both worlds.
 */
const slotAt = (x: number, y: number): number | null => {
  const under = document.elementFromPoint(x, y)?.closest('[data-item-slot]');
  const index = under?.getAttribute('data-item-slot');
  return index === null || index === undefined ? null : Number(index);
};

const onSlotDown = (slot: number, event: PointerEvent): void => {
  // Captured on the slot itself so the drag survives the pointer leaving the
  // bar — without it a release over the canvas never reaches this component
  // and the gesture hangs, holding a highlight for ever.
  (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
  drag.begin(slot, event.clientX, event.clientY);
  bump.value++;
};

const onSlotMove = (event: PointerEvent): void => {
  if (drag.from === null) return;
  drag.moveTo(event.clientX, event.clientY);
  drag.hover(slotAt(event.clientX, event.clientY));
  bump.value++;
};

/**
 * One release, two meanings. A tap opens the shop — which is how a player
 * reaches it from the bar at all — and a real drag moves the item.
 * `Champion.moveItem` refuses the pairs that are not moves (two empty slots,
 * a slot that is not one), so nothing here re-decides that.
 */
const onSlotUp = (event: PointerEvent): void => {
  const gesture = drag.end(slotAt(event.clientX, event.clientY));
  bump.value++;
  if (gesture.kind === 'open') hud.openShop();
  else if (gesture.kind === 'move') hud.moveItem(gesture.from, gesture.to);
};

const onSlotCancel = (): void => {
  drag.cancel();
  bump.value++;
};

/** The drop highlight. `bump` is read so Vue re-evaluates when the drag moves. */
const dropTarget = (slot: number): boolean => {
  void bump.value;
  return drag.over === slot;
};

const lifted = (slot: number): boolean => {
  void bump.value;
  return drag.dragging && drag.from === slot;
};
</script>

<template>
  <div
    v-if="hud.spellHover"
    class="spell-info"
    :style="
      'top:' +
      hud.spellInfo.top +
      ';bottom:' +
      hud.spellInfo.bottom +
      ';left:' +
      hud.spellInfo.left +
      ';width:' +
      hud.spellInfo.width
    "
  >
    <div class="header">
      <div>
        <img crossorigin="anonymous" :src="hud.spellHover.image" alt="spell" />
        <h4>{{ hud.spellHover.name }}</h4>
      </div>
      <!-- An item with no active has neither number, and "0s / 0 mana" under
           its name is noise rather than information. -->
      <div v-if="hud.spellHover.coolDown > 0 || hud.spellHover.manaCost > 0" class="costs">
        <span v-if="hud.spellHover.coolDown > 0"
          >{{ FormatUtils.spellSeconds(hud.spellHover.coolDown) }}s</span
        >
        <span v-if="hud.spellHover.manaCost > 0" class="mana"
          >{{ hud.spellHover.manaCost }} mana</span
        >
      </div>
      <!-- A buff's own line, where a spell prints its cooldown and cost: how
           long is left, and how many layers. Nothing casts a buff, so the two
           numbers above are always zero for one and the row would otherwise be
           blank. -->
      <div v-else-if="hud.spellHover.note" class="costs">
        <span>{{ hud.spellHover.note }}</span>
      </div>
    </div>
    <!--
      The stat block, above the prose and only for an item — a spell hover
      carries no `stats` at all, so `v-if` is the whole of the distinction and
      the panel needs no second variant.

      One stat to a line, matching the shop card exactly (`itemStatLines.ts`
      builds both). The packs used to write this block into the description as
      a sentence, which the shop then printed a second time under its own list
      and the inventory printed in one undifferentiated grey.
    -->
    <ul v-if="hud.spellHover.stats?.length" class="hover-stats">
      <li v-for="line of hud.spellHover.stats" :key="line.label">
        <span class="amount">{{ line.amount }}</span> {{ line.label }}
      </li>
    </ul>
    <ul v-if="hud.spellHover.totals?.length" class="item-totals">
      <li class="item-totals-title">Trong trận này</li>
      <li v-for="line of hud.spellHover.totals" :key="line.label">
        <span class="amount">{{ line.amount }}</span> {{ line.label }}
      </li>
    </ul>
    <p v-if="hud.spellHover.description" class="body" v-html="hud.spellHover.description"></p>
  </div>

  <div v-if="state.avatar" class="bottom-HUD">
    <!--
      The portrait is the way to the team, which is the panel this HUD had no
      direct gesture for: Esc and the corner button both open it wherever it
      was last left. A plain `<div>` with handlers rather than a `<button>`,
      matching the `.spell` icons three lines down — this is a round framed
      picture with a badge positioned inside it, and a button element would
      arrive with a reset to undo before any of that draws.

      Both handlers, because `GameScene` calls `preventDefault()` on every
      touch on the page: a `@click`-only control is perfect under a mouse and
      dead under a thumb, and `.prevent` stops the pair firing twice where the
      click *is* synthesised. `hudInteractions.test.ts` scans for both.
    -->
    <div
      class="champion-avatar"
      title="Xem đội"
      @click="hud.openRoster()"
      v-tap="() => hud.openRoster()"
    >
      <img
        crossorigin="anonymous"
        :src="state.avatar"
        alt="champion-avatar"
        :style="state.isDead ? 'filter: grayscale(100%)' : ''"
      />
      <span v-if="state.isDead" class="revive-counter">{{ state.reviveAfter }}</span>

      <!--
        The passive, on the portrait rather than in the ability row. It is a
        spell the champion *has*, not one it casts — no key, no cooldown, no
        cost — and putting it in a row of pressable icons would say the
        opposite. Both games this engine's players know place it here for the
        same reason.
      -->
      <div
        v-if="state.passive"
        class="passive-badge"
        @mouseover="hud.mouseover(state.passive, $event)"
        @mouseout="hud.mouseout(state.passive)"
      >
        <img crossorigin="anonymous" :src="state.passive.image" alt="passive" />
      </div>
    </div>

    <div class="champion-details">
      <div class="spells">
        <div
          v-for="(spell, index) of state.spells"
          :key="index"
          :class="[spell.small ? 'spell small' : 'spell', { sustaining: spell.sustaining }]"
          @click="hud.openPlayerLoadout(index)"
          v-tap="() => hud.openPlayerLoadout(index)"
          @mouseover="hud.mouseover(spell, $event)"
          @mouseout="hud.mouseout(spell)"
        >
          <img
            crossorigin="anonymous"
            :src="spell.image"
            alt="spell"
            :style="
              spell.disabled || spell.lockedOut || !spell.canCast || !spell.affordable
                ? 'filter: grayscale(100%)'
                : ''
            "
          />

          <!--
            Whether the ability is *on*, which the bar never said. A toggle
            carries its badge in both states — "TẮT" is the half that tells a
            player the key is a switch at all, and an indicator that only
            appears when lit leaves "off" and "not a toggle" looking the same.
            A bounded window (a recast stage, a timed stance) counts its
            seconds down instead, and drains the strip along the top edge:
            top-right is the one corner the stack badge, the mana pill and the
            hotkey all leave free.
          -->
          <span
            v-if="spell.toggle"
            :class="spell.sustaining ? 'toggle-badge on' : 'toggle-badge off'"
            >{{ spell.sustaining ? 'BẬT' : 'TẮT' }}</span
          >
          <span
            v-else-if="spell.sustaining && spell.sustainSecondsLeft > 0"
            class="toggle-badge on"
            >{{ spell.sustainSecondsLeft }}</span
          >
          <div
            v-if="spell.sustaining && spell.sustainPercent > 0"
            class="sustain-bar"
            :style="'width:' + spell.sustainPercent + '%'"
          ></div>

          <span v-if="spell.hotKey" class="hotKey">{{ spell.hotKey }}</span>
          <span v-if="spell.stackCount !== undefined" class="stacks">{{ spell.stackCount }}</span>
          <span
            v-if="spell.manaCost > 0"
            :class="spell.affordable ? 'mana-cost' : 'mana-cost short'"
            >{{ spell.manaCost }}</span
          >
          <div v-if="spell.showCoolDown">
            <div
              :class="spell.lockedOut ? 'cooldown-overlay' : 'cooldown-overlay rhythm'"
              :style="'height:' + spell.coolDownPercent + '%'"
            ></div>
            <div v-if="spell.lockedOut" class="cooldown">
              <p>{{ spell.coolDownText }}</p>
            </div>
          </div>
        </div>
      </div>
      <div class="health-bar">
        <div class="bar">
          <div :style="'width:' + state.stats.healthPercent + '%; background-color:#0ca20c'"></div>
          <div
            v-if="state.stats.shield > 0"
            class="shield"
            :style="
              'position:absolute; top:0; bottom:0; left:' +
              state.stats.shieldLeftPercent +
              '%; width:' +
              state.stats.shieldPercent +
              '%; background-color:rgba(225,230,238,0.85)'
            "
          ></div>
          <p>
            {{ state.stats.health }} / {{ state.stats.maxHealth
            }}<span v-if="state.stats.shield > 0"> (+{{ state.stats.shield }})</span>
          </p>
        </div>
        <div class="bar" style="margin-top: 3px">
          <div :style="'width:' + state.stats.manaPercent + '%; background-color:#218bdd;'"></div>
          <p>{{ state.stats.mana }} / {{ state.stats.maxMana }}</p>
        </div>
      </div>
      <!--
        Hoverable, on the same handlers and into the same panel as a spell or an
        item: `BuffDisplay` carries `name`, `description` and `note`, and
        nothing in the tooltip's own markup below is buff-specific. Six
        unlabelled icons is a row a player can only learn by being hit by each
        of them once and remembering the picture — the name and the time left
        were both already known and simply never shown.

        `hudState.ts` reuses one display object per kind of buff, which is what
        makes the countdown in the panel keep counting: `showSpellInfo` holds
        the object it was handed, so a fresh one every 50ms would have frozen
        the note at whatever it said when the pointer arrived.
      -->
      <div class="buffs">
        <div
          v-for="(buff, index) of state.buffs"
          :key="index"
          class="buff"
          @mouseover="hud.mouseover(buff, $event)"
          @mouseout="hud.mouseout(buff)"
        >
          <img crossorigin="anonymous" :src="buff.image" alt="buff" />
          <span v-if="buff.timeLeftText > 0">{{ buff.timeLeftText }}</span>
          <span v-if="buff.stacks > 1" class="stacks">{{ buff.stacks }}</span>
        </div>
      </div>
    </div>

    <!--
      The inventory, to the right of the abilities and the bars — six slots,
      always, filled or not. A row that grew as items were bought would move
      every key under the player's hand; a fixed grid is a shape they learn the
      position of.

      A slot answers two gestures. **Tapping** one opens the shop — the only
      place an item can be sold, so the row is also how a player finds it —
      and **dragging** one onto another swaps them, which is how the player
      decides which item sits under which key. `inventoryDrag.ts` is where a
      tap and a drag are told apart, and why the threshold is what it is.

      Pointer events rather than `@click` + `@touchend.prevent`: `dragstart`
      never fires under a thumb, and pointer events are the one path a mouse
      and a finger both travel. `touch-action: none` on `.item-slot` is what
      stops the browser claiming the drag as a scroll.
    -->
    <div class="inventory">
      <div class="items">
        <div
          v-for="(item, index) of state.items"
          :key="index"
          class="item-slot"
          :data-item-slot="index"
          :class="{
            filled: item.filled,
            sustaining: item.sustaining,
            lifted: lifted(index),
            'drop-target': dropTarget(index),
          }"
          @pointerdown="onSlotDown(index, $event)"
          @pointermove="onSlotMove($event)"
          @pointerup="onSlotUp($event)"
          @pointercancel="onSlotCancel()"
          @mouseover="item.filled && hud.mouseover(item, $event)"
          @mouseout="hud.mouseout(item)"
        >
          <!-- `draggable="false"` is load-bearing, not tidiness. An `<img>` is
               natively draggable, so the browser starts its own HTML5 drag on
               the icon the moment the pointer travels — and fires
               `pointercancel` at us to say it has taken the gesture. Measured:
               the pointer stream was `pointerdown, pointermove, pointercancel`
               and the swap never happened. -->
          <img
            v-if="item.image"
            crossorigin="anonymous"
            draggable="false"
            :src="item.image"
            alt="item"
          />
          <span v-if="item.hotKey" class="hotKey">{{ item.hotKey }}</span>
          <div v-if="item.showCoolDown">
            <div class="cooldown-overlay" :style="'height:' + item.coolDownPercent + '%'"></div>
            <div class="cooldown">
              <p>{{ item.coolDownText }}</p>
            </div>
          </div>
        </div>
      </div>

      <!--
        Hồi Thành and the gold, on one line under the inventory.
        
        It used to sit at the end of the ability strip, where it stretched the
        whole bar by its own width plus a margin for a control that is pressed
        once a minute. Here it costs nothing: the inventory column is already
        three tiles wide and the gold pill was using a third of that line.
        
        The grouping is not just packing, either — going home, the gold and the
        bag are the three things about the fountain, and they now read as one
        cluster instead of one being marooned among the abilities.
      -->
      <div class="inventory-footer">
        <!--
          Hồi Thành. It lives on `Champion.recall`, not in `spells[]` (see
          `Recall.ts`), and it used to sit at the end of the ability strip to
          say so — where it also stretched the whole bar by its own width plus
          a margin, for a control pressed about once a minute. It says the same
          thing more cheaply from here: it is the only round control in the
          bar, and it is nowhere near a hotkey.

          `v-tap` beside `@click` is not belt-and-braces — `GameScene`
          cancels touches on the canvas, so a thumb never synthesises the
          click and a `@click`-only control is dead under one. The guard form
          (`./tapGuard.ts`), not a bare `@touchend`, so a drag that merely
          began on the button does not press it on release.
          Clicking again cancels: `Game.recall()` owns that, not this.
        -->
        <button
          v-if="state.recall"
          class="recall-btn"
          :class="{
            channeling: state.recall.channeling,
            unavailable: !state.recall.canCast,
          }"
          :title="`${state.recall.name} (${state.recall.hotKey})`"
          @click="hud.recall()"
          v-tap="() => hud.recall()"
        >
          <i class="fa-solid fa-house-chimney"></i>
          <!-- The key moved into the tooltip when this button shrank to 22px.
               A letter hanging off a circle that small is not legible and it
               collided with the gold pill beside it; every other hotkey in the
               bar sits on a 3em tile with room for one. -->
          <div
            v-if="state.recall.channeling"
            class="recall-fill"
            :style="'height:' + state.recall.progressPercent + '%'"
          ></div>
          <span v-if="state.recall.channeling" class="recall-count">{{
            state.recall.secondsLeft
          }}</span>
        </button>

        <button
          class="gold-pill"
          :class="{ 'at-shop': state.canShop }"
          :title="state.canShop ? 'Mở cửa hàng' : 'Về bệ đá để mua đồ'"
          @click="hud.openShop()"
          v-tap="() => hud.openShop()"
        >
          <i class="fa-solid fa-coins"></i>
          <span>{{ state.gold }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
