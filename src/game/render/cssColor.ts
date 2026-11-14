/**
 * Cached CSS color strings for draw paths that speak to the native canvas.
 *
 * The hottest draws in the game go through `drawingContext` rather than p5 —
 * `Minion.drawHealthBar` proved the move at ~2.6x — and the native context
 * wants its colors as strings. Building `rgba(...)` per call would hand back
 * an allocation per color per unit per frame, which is exactly the churn the
 * bypass exists to avoid. Almost every color these paths use is a constant
 * channel triple under an alpha that is 255 in all but a fade's few frames,
 * so the whole population of distinct strings is tiny and never changes —
 * cache them forever, keyed by the packed channels.
 *
 * `Minion.ts` keeps its own two-string cache from before this existed; three
 * fixed strings did not need a map. Anything new goes through here.
 */
const CSS_CACHE = new Map<number, string>();

/** `rgba()` for 0-255 channels, alpha included as a 0-255 byte (p5's habit). */
export function cssColor(r: number, g: number, b: number, a255 = 255): string {
  // Alpha quantised to the byte it already is; the key packs all four.
  const a = a255 < 0 ? 0 : a255 > 255 ? 255 : a255 | 0;
  const key = (((r | 0) * 256 + (g | 0)) * 256 + (b | 0)) * 256 + a;
  let css = CSS_CACHE.get(key);
  if (css === undefined) {
    css =
      a === 255
        ? `rgb(${r | 0}, ${g | 0}, ${b | 0})`
        : `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${(a / 255).toFixed(3)})`;
    CSS_CACHE.set(key, css);
  }
  return css;
}

/**
 * The string p5's `fill(r, g, b, a)` hands the context, character for
 * character: rounded channels and the alpha as an unrounded float.
 *
 * For a raw-context port of a draw whose alpha is a *fraction* every frame (a
 * fade). `cssColor` floors alpha to a byte so it can cache, and on a phone's
 * canvas that came out one level off p5's own string (measured on the speed
 * streaks). Not cached: a fade's alpha never repeats.
 */
export function p5Rgba(r: number, g: number, b: number, a255: number): string {
  const alpha = a255 < 0 ? 0 : a255 > 255 ? 1 : a255 / 255;
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;
}
