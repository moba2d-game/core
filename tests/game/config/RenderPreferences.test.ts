import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as GameModule from '../../../src/game/Game';
import type { RenderScale } from '../../../src/game/config/renderPreferences';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('render preferences', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('defaults invalid stored values to auto quality and 60 FPS', () => {
    expect((GameModule as any).renderQualityPreference).toBeTypeOf('function');
    expect((GameModule as any).renderFpsPreference).toBeTypeOf('function');

    storage.setItem('moba2d.renderQuality', 'potato');
    storage.setItem('moba2d.renderFps', '144');

    expect((GameModule as any).renderQualityPreference()).toBe('auto');
    expect((GameModule as any).renderFpsPreference()).toBe(60);
  });

  it('persists supported quality and FPS values', () => {
    expect((GameModule as any).setRenderQualityPreference).toBeTypeOf('function');
    expect((GameModule as any).setRenderFpsPreference).toBeTypeOf('function');

    (GameModule as any).setRenderQualityPreference('low');
    (GameModule as any).setRenderFpsPreference(30);

    expect(storage.getItem('moba2d.renderQuality')).toBe('low');
    expect(storage.getItem('moba2d.renderFps')).toBe('30');
    expect((GameModule as any).renderQualityPreference()).toBe('low');
    expect((GameModule as any).renderFpsPreference()).toBe(30);
  });

  it('caps p5 rendering without changing the 60 Hz simulation rate', () => {
    const applyFrameRate = vi.fn();
    vi.stubGlobal('frameRate', applyFrameRate);
    const game = { fps: 60, renderFps: 60 };

    GameModule.default.prototype.setRenderFps.call(game as any, 30);

    expect(game.fps).toBe(60);
    expect(game.renderFps).toBe(30);
    expect(applyFrameRate).toHaveBeenCalledWith(30);
  });
});

describe('render scale', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('round-trips every supported scale through storage, re-exported from Game', () => {
    for (const scale of [100, 75, 50, 'auto'] as const) {
      (GameModule as any).setRenderScalePreference(scale);
      expect(storage.getItem('moba2d.renderScale')).toBe(String(scale));
      expect((GameModule as any).renderScalePreference()).toBe(scale);
    }
  });

  it('reads a missing or invalid stored scale as auto', () => {
    expect((GameModule as any).renderScalePreference()).toBe('auto');
    storage.setItem('moba2d.renderScale', '33');
    expect((GameModule as any).renderScalePreference()).toBe('auto');
    (GameModule as any).setRenderScalePreference(33);
    expect(storage.getItem('moba2d.renderScale')).toBe('auto');
  });

  it('maps a scale and a stress tier to a canvas density', async () => {
    const { canvasDensity } = await import('../../../src/game/config/renderPreferences');
    const table: Array<[RenderScale, 0 | 1 | 2, number]> = [
      ['auto', 0, 1],
      ['auto', 1, 1],
      ['auto', 2, 0.75],
      [100, 0, 1],
      [100, 2, 1],
      [75, 0, 0.75],
      [75, 2, 0.75],
      [50, 0, 0.5],
      [50, 2, 0.5],
    ];
    for (const [scale, tier, density] of table) {
      expect(canvasDensity(scale, tier), `${scale} @ tier ${tier}`).toBe(density);
    }
  });

  it('resizes the canvas only when the density changes, never per frame', () => {
    const applyDensity = vi.fn();
    vi.stubGlobal('pixelDensity', applyDensity);
    const game = {
      renderScale: 'auto',
      renderQuality: 'low',
      renderStressed: false,
      deeplyStressed: false,
      appliedCanvasDensity: 1,
    };
    const apply = (GameModule.default.prototype as any).applyCanvasDensity;

    apply.call(game);
    apply.call(game);
    expect(applyDensity.mock.calls).toEqual([[0.75]]);

    // Leaving the deep tier is a change, and so is put back exactly once.
    game.renderQuality = 'high';
    apply.call(game);
    apply.call(game);
    expect(applyDensity.mock.calls).toEqual([[0.75], [1]]);
  });

  it('stores the chosen scale on the game and persists it', () => {
    vi.stubGlobal('pixelDensity', vi.fn());
    const game = { renderScale: 'auto' };

    (GameModule.default.prototype as any).setRenderScale.call(game, 50);
    expect(game.renderScale).toBe(50);
    expect(storage.getItem('moba2d.renderScale')).toBe('50');

    (GameModule.default.prototype as any).setRenderScale.call(game, 33);
    expect(game.renderScale).toBe('auto');
  });
});

describe('screen-shake preference', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('is on by default when the OS says nothing about motion', async () => {
    vi.stubGlobal('window', { localStorage: storage });
    const prefs = await import('../../../src/game/config/renderPreferences');
    expect(prefs.screenShakePreference()).toBe(true);
  });

  it('is off by default under prefers-reduced-motion', async () => {
    vi.stubGlobal('window', {
      localStorage: storage,
      matchMedia: (query: string) => ({ matches: query.includes('reduce') }),
    });
    const prefs = await import('../../../src/game/config/renderPreferences');
    expect(prefs.screenShakePreference()).toBe(false);
  });

  it('lets an explicit choice beat the OS hint, both ways', async () => {
    vi.stubGlobal('window', {
      localStorage: storage,
      matchMedia: (query: string) => ({ matches: query.includes('reduce') }),
    });
    const prefs = await import('../../../src/game/config/renderPreferences');
    prefs.setScreenShakePreference(true);
    expect(storage.getItem('moba2d.screenShake')).toBe('on');
    expect(prefs.screenShakePreference()).toBe(true);
    prefs.setScreenShakePreference(false);
    expect(prefs.screenShakePreference()).toBe(false);
  });
});
