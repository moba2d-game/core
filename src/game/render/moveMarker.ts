/**
 * Where a move click landed, as a ring that shrinks and fades over
 * `MOVE_MARKER_MS`. It replaced a 40 px green dot that lost 10% of its size every
 * sim tick: gone in about a third of a second, and reported as "no marker when I
 * click to move".
 *
 * Timed in match milliseconds, never in frames (`docs/TRAPS.md`, the two clocks).
 */
export const MOVE_MARKER_MS = 550;
export const MOVE_MARKER_RADIUS = 30;

export interface MoveMarker {
  x: number;
  y: number;
  /** `Game.matchTimeMs` when it was placed. */
  atMs: number;
}

export interface MoveMarkerPose {
  /** Outer ring radius, world px. */
  radius: number;
  /** 0..1, for stroke and fill alpha. */
  alpha: number;
}

/** How the marker looks `nowMs` into the match, or null once it has gone. */
export function moveMarkerPose(marker: MoveMarker | null, nowMs: number): MoveMarkerPose | null {
  if (!marker) return null;
  const t = (nowMs - marker.atMs) / MOVE_MARKER_MS;
  if (t < 0 || t >= 1) return null;
  // Starts a little wide and settles in, so the eye catches the movement.
  return { radius: MOVE_MARKER_RADIUS * (1 - 0.55 * t), alpha: 1 - t * t };
}

/** Paint it on the raw 2D context, inside the camera transform. */
export function drawMoveMarker(ctx: CanvasRenderingContext2D, marker: MoveMarker, pose: MoveMarkerPose): void {
  ctx.save();
  ctx.globalAlpha = pose.alpha;
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.beginPath();
  ctx.arc(marker.x, marker.y, pose.radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#4cff6a';
  ctx.stroke();
  ctx.fillStyle = '#4cff6a';
  ctx.beginPath();
  ctx.arc(marker.x, marker.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
