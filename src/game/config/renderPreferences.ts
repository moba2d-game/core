/**
 * Render quality and the FPS cap, as `localStorage` and nothing else.
 *
 * Split out of `Game.ts` for the reason `game/input/touchPreferences.ts` was
 * split out of `TouchControls.ts`: the match-config panel reads and writes
 * these, and that panel is mounted over the **menu** as well as over a running
 * match. `Game.ts` is the match — every spell, every unit, the navigation grid
 * — so a settings row asking "what FPS cap is stored?" would have pulled all of
 * it into the menu's chunk. Vite's `manualChunks` sends anything under
 * `src/game/` to the `game` chunk, but a module with no imports of its own
 * costs nothing to pull in.
 *
 * No p5 globals, no game objects: safe to import from the menu. `Game.ts`
 * re-exports them all so every existing `from '@/game/Game'` still resolves,
 * and remains the only thing that *applies* them (`frameRate`, the quality
 * branch in `ObjectManager`).
 */
import type { RenderQuality } from '@/game/managers/ObjectManager';

export type RenderFps = 30 | 60;
/**
 * How many canvas pixels back each CSS pixel, as a percentage — or `'auto'`,
 * which gives up a quarter of them only while the machine is deep in trouble
 * (see `canvasDensity`).
 */
export type RenderScale = 'auto' | 100 | 75 | 50;

/**
 * What the ground of a map looks like: the pack's painted art, or core's
 * solid polygons with nothing decorative on them — for a player who wants to
 * read the fight and the spells, not the scenery.
 */
export type MapGround = 'detailed' | 'plain';

const RENDER_QUALITY_STORAGE_KEY = 'moba2d.renderQuality';
const RENDER_FPS_STORAGE_KEY = 'moba2d.renderFps';
const RENDER_SCALE_STORAGE_KEY = 'moba2d.renderScale';
const SCREEN_SHAKE_STORAGE_KEY = 'moba2d.screenShake';
const MAP_GROUND_STORAGE_KEY = 'moba2d.mapGround';

export function renderQualityPreference(): RenderQuality {
  try {
    const stored = window.localStorage.getItem(RENDER_QUALITY_STORAGE_KEY);
    if (stored === 'low' || stored === 'high') return stored;
  } catch {
    /* storage blocked: use automatic quality */
  }
  return 'auto';
}

export function setRenderQualityPreference(quality: RenderQuality): void {
  try {
    window.localStorage.setItem(
      RENDER_QUALITY_STORAGE_KEY,
      quality === 'low' || quality === 'high' ? quality : 'auto'
    );
  } catch {
    /* storage blocked: the live setting still works */
  }
}

export function renderFpsPreference(): RenderFps {
  try {
    if (window.localStorage.getItem(RENDER_FPS_STORAGE_KEY) === '30') return 30;
  } catch {
    /* storage blocked: use 60 FPS */
  }
  return 60;
}

export function setRenderFpsPreference(fps: RenderFps): void {
  try {
    window.localStorage.setItem(RENDER_FPS_STORAGE_KEY, fps === 30 ? '30' : '60');
  } catch {
    /* storage blocked: the live setting still works */
  }
}

export function renderScalePreference(): RenderScale {
  try {
    const stored = window.localStorage.getItem(RENDER_SCALE_STORAGE_KEY);
    if (stored === '100') return 100;
    if (stored === '75') return 75;
    if (stored === '50') return 50;
  } catch {
    /* storage blocked: use the automatic scale */
  }
  return 'auto';
}

export function setRenderScalePreference(scale: RenderScale): void {
  try {
    window.localStorage.setItem(
      RENDER_SCALE_STORAGE_KEY,
      scale === 100 || scale === 75 || scale === 50 ? String(scale) : 'auto'
    );
  } catch {
    /* storage blocked: the live setting still works */
  }
}

export function mapGroundPreference(): MapGround {
  try {
    if (window.localStorage.getItem(MAP_GROUND_STORAGE_KEY) === 'plain') return 'plain';
  } catch {
    /* storage blocked: use the painted ground */
  }
  return 'detailed';
}

export function setMapGroundPreference(ground: MapGround): void {
  try {
    window.localStorage.setItem(MAP_GROUND_STORAGE_KEY, ground === 'plain' ? 'plain' : 'detailed');
  } catch {
    /* storage blocked: the live setting still works */
  }
}

/**
 * The p5 `pixelDensity` a scale asks for, given `stressTier(...)`.
 *
 * Fill is what a weak phone pays for, so fewer canvas pixels is the one lever
 * that cuts every draw at once: a 10-champion fight on an Oppo CPH1912
 * measured 15.9 fps at density 1, 18.3 at 0.75 and 21.4 at 0.5 (interleaved,
 * medians). `'auto'` takes only the first step, and only on the deep tier —
 * a machine that keeps up stays sharp. Pure, so the menu can import it;
 * `Game.applyCanvasDensity` is the only thing that applies the answer.
 */
export function canvasDensity(scale: RenderScale, tier: 0 | 1 | 2): number {
  if (scale === 100) return 1;
  if (scale === 75) return 0.75;
  if (scale === 50) return 0.5;
  return tier === 2 ? 0.75 : 1;
}

/**
 * Whether the camera may shake on the player's own heavy hits, kills and
 * death (`Camera.shake`, fed from `render/hitFeedback.ts`).
 *
 * On by default — except when the OS asks for reduced motion, which is the
 * one thing a player has already said about exactly this kind of effect. An
 * explicit choice in the settings tab wins over the OS either way.
 */
export function screenShakePreference(): boolean {
  try {
    const stored = window.localStorage.getItem(SCREEN_SHAKE_STORAGE_KEY);
    if (stored === 'on') return true;
    if (stored === 'off') return false;
  } catch {
    /* storage blocked: fall through to the OS hint */
  }
  return !prefersReducedMotion();
}

export function setScreenShakePreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(SCREEN_SHAKE_STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    /* storage blocked: the live setting still works */
  }
}

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
    );
  } catch {
    return false;
  }
}
