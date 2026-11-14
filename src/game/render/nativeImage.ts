/**
 * `image()` without p5, for the draws that happen once per unit per frame.
 *
 * p5's `image()` normalises its arguments, re-reads the image mode, checks for
 * a tint and a GIF and only then reaches `drawImage` — measured on a Helio P35
 * phone at roughly five times the cost of the native call it ends in, and the
 * avatar and the buff row pay it for every champion on screen. This is that
 * native call, centred the way `imageMode(CENTER)` centres it (`GameScene`
 * sets that once and it is never changed for world drawing).
 *
 * Anything that is not a plain canvas-backed picture — an animated GIF, whose
 * current frame only p5 advances, or a stand-in with no canvas at all — still
 * goes through p5, so this can never draw less than `image()` would have.
 */
interface CanvasBacked {
  canvas?: CanvasImageSource | null;
  elt?: CanvasImageSource | null;
  gifProperties?: unknown;
}

export function drawImageCentered(
  ctx: CanvasRenderingContext2D,
  source: unknown,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const picture = source as CanvasBacked | null | undefined;
  const native = picture && !picture.gifProperties ? (picture.canvas ?? picture.elt) : null;
  if (native) ctx.drawImage(native, x - w / 2, y - h / 2, w, h);
  else image(source as p5.Image, x, y, w, h);
}
