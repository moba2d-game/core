import type { ZoneCircle, ZoneResult, ZoneState } from './zoneRules';

/** Outside tint, ring and warning ring. Tuning lives here so a look change is one edit. */
export const ZONE_TINT = 'rgba(120, 40, 160, 0.32)';
export const ZONE_RING = 'rgba(190, 90, 255, 0.95)';
export const ZONE_NEXT_RING = 'rgba(255, 255, 255, 0.85)';

interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * World space, inside `camera.makeDraw`. Two raw canvas calls plus the warning
 * ring: one even-odd path (view rectangle with the safe circle cut out) for the
 * tint, one stroke for the ring. No p5 shapes, no per-frame allocation beyond
 * the path.
 */
export function drawZone(ctx: CanvasRenderingContext2D, state: ZoneState, view: View): void {
  const c = state.current;
  const pad = 8;
  ctx.save();
  ctx.beginPath();
  ctx.rect(view.x - pad, view.y - pad, view.w + pad * 2, view.h + pad * 2);
  ctx.moveTo(c.x + c.r, c.y);
  ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
  ctx.fillStyle = ZONE_TINT;
  ctx.fill('evenodd');

  ctx.beginPath();
  ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
  ctx.lineWidth = 10;
  ctx.strokeStyle = ZONE_RING;
  ctx.stroke();

  if (state.next) {
    ctx.beginPath();
    ctx.arc(state.next.x, state.next.y, state.next.r, 0, Math.PI * 2);
    ctx.lineWidth = 6;
    ctx.strokeStyle = ZONE_NEXT_RING;
    ctx.setLineDash([40, 30]);
    ctx.stroke();
  }
  ctx.restore();
}

/** Screen-space line: the countdown, or the verdict. Null when there is nothing to say. */
export function zoneBanner(
  state: ZoneState,
  result: ZoneResult,
  playerTeam: string | undefined
): string | null {
  if (result) {
    if ('draw' in result) return 'HÒA — không còn ai sống sót';
    return result.winner === playerTeam ? 'CHIẾN THẮNG' : 'THẤT BẠI';
  }
  if (state.msToNextShrink === null) return 'Vùng độc đã thu nhỏ hết cỡ';
  if (state.next) return `Vùng độc thu hẹp sau ${Math.ceil(state.msToNextShrink / 1000)}s`;
  return null;
}

export type { ZoneCircle };
