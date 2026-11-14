import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/managers/AssetManager', () => ({
  default: { get: (key: string) => ({ key, path: key, status: 'ready', data: null }) },
}));

import { buildContentApi } from '../../src/content/ContentApi';
import { stressTier } from '../../src/game/render/renderStress';

/**
 * A pack's scenery is a large share of a weak phone's frame — the Tidelight
 * reef alone was 60-85 of ~400 draw calls on a Helio P35 — and a pack had no
 * way to ask the question core's own fog and minimap ask. `api.render` is that
 * question, and it has to be *the same answer*: a second rule on the pack side
 * is how Cao quietly stops meaning "draw everything".
 */
describe('api.render.plainGround', () => {
  const api = buildContentApi();

  it('is true only for a player who chose the plain ground', () => {
    expect(api.render.plainGround({ mapGround: 'plain' })).toBe(true);
    expect(api.render.plainGround({ mapGround: 'detailed' })).toBe(false);
  });

  it('is the painted art for a game that cannot answer', () => {
    expect(api.render.plainGround({})).toBe(false);
    expect(api.render.plainGround(undefined)).toBe(false);
    expect(api.render.plainGround(null)).toBe(false);
  });
});

describe('api.render.stressTier', () => {
  const api = buildContentApi();

  it('is 0 for a machine keeping up, so a pack draws its full art', () => {
    expect(api.render.stressTier({ renderQuality: 'auto', renderStressed: false })).toBe(0);
  });

  it('follows the measurement under auto', () => {
    expect(api.render.stressTier({ renderQuality: 'auto', renderStressed: true })).toBe(1);
    expect(
      api.render.stressTier({ renderQuality: 'auto', renderStressed: true, deeplyStressed: true })
    ).toBe(2);
  });

  it('never overrides a player who chose Cao, and gives Thấp all of it', () => {
    expect(
      api.render.stressTier({ renderQuality: 'high', renderStressed: true, deeplyStressed: true })
    ).toBe(0);
    expect(api.render.stressTier({ renderQuality: 'low' })).toBe(2);
  });

  it('agrees with core for every combination, and is total on a missing game', () => {
    for (const quality of ['auto', 'low', 'high', undefined] as const) {
      for (const stressed of [true, false, undefined]) {
        for (const deep of [true, false, undefined]) {
          expect(
            api.render.stressTier({ renderQuality: quality, renderStressed: stressed, deeplyStressed: deep })
          ).toBe(stressTier(quality, stressed, deep));
        }
      }
    }
    expect(api.render.stressTier(undefined)).toBe(0);
    expect(api.render.stressTier(null)).toBe(0);
  });
});
