import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AssetManager, {
  FORCED_RESTORE_HIDDEN_MS,
  PROBE_SIZE,
  backingStoreProbe,
  setProbeCanvasFactory,
} from '../../src/managers/AssetManager';
import { assetManifest, type AssetKey } from '../../src/generated/assetManifest';

/**
 * Recovering from the browser throwing away every image in the game.
 *
 * Reported from a real match on an installed PWA: background the app, come back
 * five minutes later, and every avatar and every spell icon is blank while
 * every shape the game *draws* is fine. That split is the whole diagnosis. p5
 * 1.11 builds a `p5.Image` out of `document.createElement('canvas')`
 * (`p5.js:96392`) and `loadImage` draws the decoded `<img>` into it exactly once
 * before dropping it (`p5.js:94848`) — so all ~370 assets live as off-DOM
 * canvas backing stores, which is precisely what a mobile browser reclaims
 * under memory pressure. Vector drawing survives because it repaints the
 * visible canvas every frame.
 *
 * The repaint has to land in the **same** `p5.Image` object: every champion,
 * spell and HUD row is holding a reference to it, and swapping the handle's
 * `data` for a fresh image would leave all of them pointing at the blank one.
 *
 * Both halves of the browser contact are injectable, because the suite runs on
 * `environment: 'node'` — there is no `document` to make a canvas out of and no
 * `Image` to decode with.
 */

/** Stands in for a `p5.Image`: the one method the repaint reaches for. */
const fakeImage = () => {
  const painted: unknown[] = [];
  return {
    painted,
    width: 4,
    height: 4,
    drawingContext: {
      drawImage: (source: unknown) => painted.push(source),
    },
  };
};

const imageKeys = (Object.keys(assetManifest) as AssetKey[]).filter(
  key => assetManifest[key].kind === 'image'
);

/** A key nobody else in this file has touched, so the static caches cannot collide. */
let nextKey = 0;
const freshKey = (): AssetKey => imageKeys[nextKey++];

const realLost = AssetManager.backingStoresLost;
const realArm = AssetManager.armBackingStoreProbe;

/** A canvas as far as the probe can tell: events, a size, and a context that can be lost. */
class FakeCanvas extends EventTarget {
  width = 0;
  height = 0;
  lost = false;
  getContext() {
    return { fillStyle: '', fillRect: () => undefined, isContextLost: () => this.lost };
  }
}

describe('recovering images the browser threw away', () => {
  beforeEach(() => {
    setProbeCanvasFactory(() => new FakeCanvas() as unknown as HTMLCanvasElement);
    AssetManager.armBackingStoreProbe = () => undefined;
  });

  afterEach(() => {
    AssetManager.backingStoresLost = realLost;
    AssetManager.armBackingStoreProbe = realArm;
    AssetManager.configureLoaders({
      image: () => Promise.reject(new Error('no loader')),
      json: () => Promise.reject(new Error('no loader')),
      audio: () => Promise.reject(new Error('no loader')),
    });
  });

  /** Loads `key` with a stand-in image and hands both back. */
  const loaded = async () => {
    const key = freshKey();
    const image = fakeImage();
    AssetManager.configureLoaders({
      image: () => Promise.resolve(image),
      json: () => Promise.reject(new Error('unused')),
      audio: () => Promise.reject(new Error('unused')),
    });
    await AssetManager.ensure(key);
    return { key, image };
  };

  // "Back ra app khác xong quay lại game là nó đen hết luôn": a short hop, the
  // 1x1 probe kept its pixel (Chrome never put it on the GPU), so nothing was
  // restored. The browser's own events are the signal now.
  it('hears the browser say the context was lost, on a short hop too', async () => {
    AssetManager.armBackingStoreProbe = realArm;
    AssetManager.armBackingStoreProbe();
    expect(AssetManager.backingStoresLost()).toBe(false);
    backingStoreProbe()!.dispatchEvent(new Event('contextlost'));
    expect(AssetManager.backingStoresLost()).toBe(true);
    const { image } = await loaded();
    await AssetManager.recoverIfLost(() => Promise.resolve('fresh' as never), 0);
    expect(image.painted).toContain('fresh');
    // The recovery re-arms, so the next hop starts clean.
    expect(AssetManager.backingStoresLost()).toBe(false);
  });

  it('repaints on contextrestored by itself, without waiting for a resume', async () => {
    AssetManager.armBackingStoreProbe = realArm;
    AssetManager.armBackingStoreProbe();
    const { image } = await loaded();
    const epoch = AssetManager.purgeEpoch;
    backingStoreProbe()!.dispatchEvent(new Event('contextrestored'));
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    // A completed restore — the epoch moves only at the end of `restoreImages`.
    // (Its default decoder needs a browser `Image`, so nothing is painted here.)
    expect(AssetManager.purgeEpoch).toBe(epoch + 1);
    void image;
  });

  it('is big enough for Chrome to put on the GPU, where the purge happens', () => {
    const probe = backingStoreProbe()!;
    expect(probe.width * probe.height).toBeGreaterThanOrEqual(PROBE_SIZE * PROBE_SIZE);
    expect(PROBE_SIZE).toBeGreaterThanOrEqual(256);
  });

  it('does nothing at all while the pixels are still there', async () => {
    const { image } = await loaded();
    AssetManager.backingStoresLost = () => false;

    expect(await AssetManager.recoverIfLost(() => Promise.resolve('decoded'))).toEqual([]);
    expect(image.painted).toEqual([]);
  });

  /**
   * The probe is one 1x1 canvas and the purge is the browser's own sweep at
   * the browser's own granularity — a buffer that small can survive a sweep
   * that took every real asset, and did, on a real installed PWA after the
   * probe shipped. A return from a long stay in the background therefore
   * restores whatever the probe claims; only short hops stay probe-gated.
   */
  it('restores after a long stay hidden even when the probe noticed nothing', async () => {
    const { key, image } = await loaded();
    AssetManager.backingStoresLost = () => false;

    const restored = await AssetManager.recoverIfLost(
      () => Promise.resolve('decoded'),
      FORCED_RESTORE_HIDDEN_MS
    );

    expect(restored).toContain(key);
    expect(image.painted).toEqual(['decoded']);
  });

  it('keeps a short hop probe-gated', async () => {
    const { image } = await loaded();
    AssetManager.backingStoresLost = () => false;

    const restored = await AssetManager.recoverIfLost(
      () => Promise.resolve('decoded'),
      FORCED_RESTORE_HIDDEN_MS - 1
    );

    expect(restored).toEqual([]);
    expect(image.painted).toEqual([]);
  });

  /**
   * A forced restore can land on a canvas that was never purged, and an image
   * with alpha drawn over itself thickens every translucent pixel. The repaint
   * clears the surface first when the image exposes one.
   */
  it('clears the surface before repainting into it', async () => {
    const key = freshKey();
    const calls: string[] = [];
    const image = {
      canvas: { width: 4, height: 4 },
      drawingContext: {
        clearRect: () => calls.push('clear'),
        drawImage: () => calls.push('draw'),
      },
    };
    AssetManager.configureLoaders({
      image: () => Promise.resolve(image),
      json: () => Promise.reject(new Error('unused')),
      audio: () => Promise.reject(new Error('unused')),
    });
    await AssetManager.ensure(key);
    AssetManager.backingStoresLost = () => true;

    await AssetManager.recoverIfLost(() => Promise.resolve('decoded'));
    expect(calls).toEqual(['clear', 'draw']);
  });

  it('bumps the purge epoch, so self-painted buffers hear about the sweep', async () => {
    await loaded();
    AssetManager.backingStoresLost = () => true;
    const before = AssetManager.purgeEpoch;

    await AssetManager.recoverIfLost(() => Promise.resolve('decoded'));
    expect(AssetManager.purgeEpoch).toBe(before + 1);
  });

  it('repaints into the image object everything is already holding', async () => {
    // The identity check is the point. Champions, spells and HUD rows are all
    // holding this exact object; replacing `handle.data` would fix the manager
    // and leave every one of them drawing a blank.
    const { key, image } = await loaded();
    AssetManager.backingStoresLost = () => true;
    const decoded = { tag: 'decoded' };

    expect(await AssetManager.recoverIfLost(() => Promise.resolve(decoded))).toContain(key);
    expect(image.painted).toEqual([decoded]);
    expect(AssetManager.get(key).data).toBe(image);
  });

  it('re-arms the probe, so the next resume is free', async () => {
    await loaded();
    AssetManager.backingStoresLost = () => true;
    let armed = 0;
    AssetManager.armBackingStoreProbe = () => {
      armed++;
    };

    await AssetManager.recoverIfLost(() => Promise.resolve('decoded'));
    expect(armed).toBe(1);
  });

  it('leaves an asset nobody ever loaded alone', async () => {
    // `get` hands back an idle handle with `data: null`; repainting into that
    // would throw, and there is nothing to repaint into anyway.
    const key = freshKey();
    expect(AssetManager.get(key).status).toBe('idle');
    AssetManager.backingStoresLost = () => true;

    expect(await AssetManager.recoverIfLost(() => Promise.resolve('decoded'))).not.toContain(key);
  });

  it('carries on when one file cannot be decoded', async () => {
    // Offline, or one entry missing from the precache. The other 369 assets are
    // not held hostage by it.
    const first = await loaded();
    const second = await loaded();
    AssetManager.backingStoresLost = () => true;

    const restored = await AssetManager.recoverIfLost(url =>
      url === AssetManager.get(first.key).url
        ? Promise.reject(new Error('offline'))
        : Promise.resolve('decoded')
    );

    expect(restored).not.toContain(first.key);
    expect(restored).toContain(second.key);
    expect(second.image.painted).toEqual(['decoded']);
  });
});
