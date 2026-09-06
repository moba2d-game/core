<script setup lang="ts">
/**
 * The dead player's pill: how long until respawn, and whose eyes they are
 * borrowing meanwhile.
 *
 * The countdown used to live on the corpse (`AttackableUnit.drawAvatar`'s dead
 * branch) and on the desktop portrait. The corpse leaves the screen once the
 * death camera (`render/deathCamera.ts`) moves to an ally, and the phone has
 * no portrait, so this is the one place both layouts can be sure to find it.
 *
 * One control: the ally's name is the button, and pressing it goes to the
 * next living ally. Not a row of portraits — the roster can be nine and the
 * pill is 40px tall on a phone — and not a separate arrow, because "the thing
 * you are looking at" and "the thing you press to look elsewhere" being the
 * same object is what makes it need no label.
 */
import { inject } from 'vue';
import type { HudInteractions } from './hudInteractions';
import { vTap } from './tapGuard';

defineProps<{
  reviveAfter: number;
  /** The ally on screen, or null while the camera lingers on the corpse. */
  spectating: string | null;
  touch: boolean;
  /** Whether a fight save point exists to rewind to — never true in a LAN match. */
  canRetry?: boolean;
  /** Whether a deliberate save exists — see `HudState.hasManualCheckpoint`. */
  retryArmed?: boolean;
}>();

const hud = inject<HudInteractions>('hud')!;
</script>

<template>
  <div class="spectate-bar" :class="{ touch }" id="spectate-bar">
    <span class="spectate-revive">
      Hồi sinh sau <strong id="spectate-revive-seconds">{{ reviveAfter }}</strong>s
    </span>
    <!-- The practice room's retry: back to the newest save point without
         waiting the clock out. Same pill as the ally control beside it. -->
    <button
      v-if="canRetry"
      type="button"
      class="spectate-next spectate-retry"
      id="spectate-retry-checkpoint"
      :title="retryArmed ? 'Quay lại mốc gần nhất' : 'Trận này chưa lưu mốc nào — mở bảng Mốc đã lưu để chọn'"
      @click="hud.retryFromCheckpoint()"
      v-tap="() => hud.retryFromCheckpoint()"
    >
      <i class="fas fa-clock-rotate-left" aria-hidden="true"></i>
      <span class="spectate-name">{{ retryArmed ? 'Thử lại từ mốc' : 'Thử lại…' }}</span>
    </button>
    <button
      v-if="spectating"
      type="button"
      class="spectate-next"
      id="spectate-next"
      title="Xem đồng minh tiếp theo"
      @click="hud.spectateNext()"
      v-tap="() => hud.spectateNext()"
    >
      <i class="fas fa-eye" aria-hidden="true"></i>
      <span class="spectate-name">{{ spectating }}</span>
      <i class="fas fa-forward" aria-hidden="true"></i>
    </button>
  </div>
</template>
