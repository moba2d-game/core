import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/content/packSource', () => ({
  PackLoadError: class extends Error {
    stage: string;
    constructor(stage: string, message: string) {
      super(message);
      this.stage = stage;
    }
  },
  fetchPackManifest: vi.fn(),
  loadPackFromManifest: vi.fn(),
  // Boot reads the pinned manifest through this. A real pass-through, not a
  // stub: the pin is re-checked on the way in on purpose (a stored manifest is
  // still a stranger's file), and a stub that waved it through would make the
  // pinned path look safer here than it is in the app.
  checkPackManifest: (parsed: unknown) => parsed,
  // A real implementation, not a bare `vi.fn()`, for the reason the
  // `packCache` mock below gives: what this returns lands in the stored
  // record, and several cases assert on that record whole. A stub returning
  // `undefined` would make every one of them pass without the field ever
  // being derived.
  resolvePackIcon: (manifest: { icon?: string }, manifestUrl: string) => {
    if (!manifest.icon) return undefined;
    try {
      const resolved = new URL(manifest.icon, manifestUrl);
      return resolved.origin === new URL(manifestUrl).origin ? resolved.href : undefined;
    } catch {
      return undefined;
    }
  },
}));
vi.mock('@/content/install', () => ({ installRuntimePack: vi.fn() }));
vi.mock('@/content/registry', () => ({
  contentRegistry: vi.fn(() => ({ hasPack: () => false })),
  rebuildContentRegistry: vi.fn(() => ({ hasPack: () => false })),
}));
vi.mock('@/content/ContentApi', () => ({ buildContentApi: vi.fn(() => ({})) }));
vi.mock('@/content/packCache', () => ({
  // A real implementation, not a bare `vi.fn()`: the base is what the
  // prefetch tests assert on, and hard-coding it a second time in every test
  // would just be `packBaseFor` copied badly.
  packBaseFor: vi.fn((url: string) => {
    try {
      return new URL('./', url).href;
    } catch {
      return '';
    }
  }),
  announcePackBases: vi.fn(),
  prefetchPackFiles: vi.fn(),
  // Defaults to "nothing is pinned", which is a browser installing for the
  // first time — the state every case below was written against, and the one
  // that still exercises the network path.
  forgetPack: vi.fn(async () => 0),
  readPinnedManifest: vi.fn(async () => null),
  pinPackManifest: vi.fn(async () => true),
  missingPackFiles: vi.fn(async () => []),
}));

import { installRuntimePacks, installPackNow, DEFAULT_PACK_URL } from '@/content/runtimePacks';
import { forgetPack, pinPackManifest, readPinnedManifest } from '@/content/packCache';
import {
  checkPackUpdates,
  notePackSpellFailures,
  updatePack,
  updatePacks,
} from '@/content/runtimePacks';
import { notePackProblem, packProblems, resetPackHealthForTests } from '@/content/packHealth';
import { fetchPackManifest, loadPackFromManifest } from '@/content/packSource';
import { installRuntimePack } from '@/content/install';
import { contentRegistry, rebuildContentRegistry } from '@/content/registry';
import { announcePackBases, prefetchPackFiles, type PrefetchReport } from '@/content/packCache';
import {
  readInstalledPacks,
  writeInstalledPacks,
  hasSeededDefaultPack,
  markDefaultPackSeeded,
  PACK_STORE_KEY,
} from '@/content/installedPackStore';

const withStorage = () => {
  const map = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  return map;
};

const manifest = {
  id: 'riot',
  version: '1.0.0',
  coreRange: '>=1.0.0',
  name: 'Riot',
  entry: 'pack.js',
  assets: 'assets/',
};

/**
 * What a prefetch that never touched the cache looks like. The brief names
 * this constant without defining it — it has to match `PrefetchReport`
 * (`packCache.ts`) field for field, since it stands in for a resolved value
 * `prefetchPackFiles` never actually computed in these tests.
 */
const EMPTY_REPORT: PrefetchReport = {
  base: '',
  requested: 0,
  added: 0,
  skipped: 0,
  failed: 0,
  gone: 0,
};

describe('installRuntimePacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` clears recorded calls, not implementations — so a test
    // that gives `rebuildContentRegistry` a registry of its own would leak it
    // into every test after it. Re-stated here rather than reached for with
    // `resetAllMocks`, which would also wipe the factories in the `vi.mock`
    // calls above.
    vi.mocked(rebuildContentRegistry).mockReturnValue({ hasPack: () => false } as never);
    withStorage();
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it('seeds the default pack on a first run with nothing stored', async () => {
    expect(hasSeededDefaultPack()).toBe(false);
    vi.mocked(fetchPackManifest).mockResolvedValue(manifest);
    vi.mocked(loadPackFromManifest).mockResolvedValue({ manifest } as never);

    const outcomes = await installRuntimePacks();

    expect(fetchPackManifest).toHaveBeenCalledWith(DEFAULT_PACK_URL);
    expect(outcomes).toEqual([{ manifestUrl: DEFAULT_PACK_URL, ok: true, id: 'riot' }]);
    // `name` is stored too: the packs screen lists a pack the way its author
    // named it, and derives its monogram from that, so a record without it
    // would show a machine id in both places.
    expect(readInstalledPacks()).toEqual([
      // `fileCount: 0` is this manifest declaring no `files` — the record
      // says "this pack saves nothing offline" rather than saying nothing,
      // which is what the packs screen needs to tell that state from an
      // unfinished download. See `InstalledPackRecord.fileCount`.
      { manifestUrl: DEFAULT_PACK_URL, id: 'riot', version: '1.0.0', name: 'Riot', fileCount: 0 },
    ]);
    // The offer is spent only once it has actually been taken — see
    // `runtimePacks.ts`'s own header.
    expect(hasSeededDefaultPack()).toBe(true);
  });

  it('does not seed the default once the flag says it already offered it, even with nothing stored', async () => {
    // The situation the flag exists for: an old browser whose player
    // removed every pack looks identical, from the list alone, to a
    // browser that has never run this game. Only the flag tells them apart.
    markDefaultPackSeeded();

    const outcomes = await installRuntimePacks();

    expect(fetchPackManifest).not.toHaveBeenCalled();
    expect(loadPackFromManifest).not.toHaveBeenCalled();
    expect(installRuntimePack).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
    expect(readInstalledPacks()).toEqual([]);
  });

  it('leaves the offer unspent when the seeding attempt fails, so the next boot retries it', async () => {
    // The reversal the whole-branch review forced, and it was right:
    // `DEFAULT_PACK_URL` answers 404 until the pack repository publishes, so
    // marking the flag on a failed attempt locks every browser that booted
    // before publication out of the content permanently — and the retry the
    // banner offers is `location.reload()`, which re-runs this same code and
    // finds the flag already set.
    const { PackLoadError } = await import('@/content/packSource');
    vi.mocked(fetchPackManifest).mockRejectedValue(new PackLoadError('fetch', 'offline'));
    expect(hasSeededDefaultPack()).toBe(false);

    await installRuntimePacks();

    expect(hasSeededDefaultPack()).toBe(false);
  });

  it('tries the default again on the next boot after a failed seeding attempt', async () => {
    const { PackLoadError } = await import('@/content/packSource');
    vi.mocked(fetchPackManifest).mockRejectedValue(new PackLoadError('fetch', '404'));

    await installRuntimePacks();
    await installRuntimePacks();

    expect(fetchPackManifest).toHaveBeenCalledTimes(2);
    expect(fetchPackManifest).toHaveBeenNthCalledWith(2, DEFAULT_PACK_URL);
  });

  it('skips a pack whose id is already installed, without fetching its entry', async () => {
    // Both content paths are live until Plan 2 retires core's compile-in
    // step, and they answer to the same id. The skip has to happen before
    // `loadPackFromManifest` (or the pack is downloaded for nothing) and
    // before `installRuntimePack` (whose asset registration is a bare
    // `Map.set` that would repoint the local pack's art at the remote host).
    vi.mocked(rebuildContentRegistry).mockReturnValue({
      hasPack: (id: string) => id === 'riot',
    } as never);
    vi.mocked(fetchPackManifest).mockResolvedValue(manifest);

    const outcomes = await installRuntimePacks();

    expect(loadPackFromManifest).not.toHaveBeenCalled();
    expect(installRuntimePack).not.toHaveBeenCalled();
    expect(outcomes).toEqual([
      { manifestUrl: DEFAULT_PACK_URL, ok: true, id: 'riot', skipped: true },
    ]);
  });

  it('counts a skip as content the player has, not as a failure', async () => {
    vi.mocked(rebuildContentRegistry).mockReturnValue({
      hasPack: (id: string) => id === 'riot',
    } as never);
    vi.mocked(fetchPackManifest).mockResolvedValue(manifest);

    const outcomes = await installRuntimePacks();

    expect(outcomes[0]).toMatchObject({ ok: true, skipped: true });
    // The id is present, so the one-time offer is settled and the list is
    // worth remembering — the next boot re-reads it and skips again cheaply,
    // and installs for real once the compile-in step is gone.
    expect(hasSeededDefaultPack()).toBe(true);
    expect(readInstalledPacks()).toEqual([
      { manifestUrl: DEFAULT_PACK_URL, id: 'riot', version: '1.0.0', name: 'Riot', fileCount: 0 },
    ]);
  });

  it('answers with an outcome instead of rejecting when the registry itself throws', async () => {
    // `buildContentApi()` and `rebuildContentRegistry()` sit outside the
    // per-pack `try`, and `LoadingScene.enter()` calls `boot()` as
    // `void this.boot()` — so a throw here used to be an unhandled rejection
    // and the menu handover never ran. "Nothing here may throw" was a
    // comment enforced by nothing; this is the enforcement.
    vi.mocked(rebuildContentRegistry).mockImplementation(() => {
      throw new Error('registry exploded');
    });

    const outcomes = await installRuntimePacks();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0]).toMatchObject({ stage: 'registry', message: 'registry exploded' });
  });

  it('reports a failure instead of throwing, and stores nothing', async () => {
    const { PackLoadError } = await import('@/content/packSource');
    vi.mocked(fetchPackManifest).mockRejectedValue(new PackLoadError('fetch', 'offline'));

    const outcomes = await installRuntimePacks();

    expect(outcomes).toEqual([
      { manifestUrl: DEFAULT_PACK_URL, ok: false, stage: 'fetch', message: 'offline' },
    ]);
    expect(installRuntimePack).not.toHaveBeenCalled();
    expect(readInstalledPacks()).toEqual([]);
  });

  it('does not re-seed the default once a list exists', async () => {
    writeInstalledPacks([
      { manifestUrl: 'https://other/manifest.json', id: 'other', version: '2.0.0' },
    ]);
    vi.mocked(fetchPackManifest).mockResolvedValue({ ...manifest, id: 'other', version: '2.0.0' });
    vi.mocked(loadPackFromManifest).mockResolvedValue({ manifest } as never);

    await installRuntimePacks();

    expect(fetchPackManifest).toHaveBeenCalledTimes(1);
    expect(fetchPackManifest).toHaveBeenCalledWith('https://other/manifest.json');
  });

  it('keeps going after one pack fails, so a bad entry cannot hide a good one', async () => {
    writeInstalledPacks([
      { manifestUrl: 'https://bad/manifest.json', id: 'bad', version: '1.0.0' },
      { manifestUrl: 'https://good/manifest.json', id: 'good', version: '1.0.0' },
    ]);
    const { PackLoadError } = await import('@/content/packSource');
    vi.mocked(fetchPackManifest)
      .mockRejectedValueOnce(new PackLoadError('fetch', 'gone'))
      .mockResolvedValueOnce({ ...manifest, id: 'good' });
    vi.mocked(loadPackFromManifest).mockResolvedValue({ manifest } as never);

    const outcomes = await installRuntimePacks();

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[1].ok).toBe(true);
    expect(localStorage.getItem(PACK_STORE_KEY)).toContain('good');
  });

  it('rebuilds the content registry exactly once, not once per pack', async () => {
    writeInstalledPacks([
      { manifestUrl: 'https://a/manifest.json', id: 'a', version: '1.0.0' },
      { manifestUrl: 'https://b/manifest.json', id: 'b', version: '1.0.0' },
    ]);
    vi.mocked(fetchPackManifest)
      .mockResolvedValueOnce({ ...manifest, id: 'a' })
      .mockResolvedValueOnce({ ...manifest, id: 'b' });
    vi.mocked(loadPackFromManifest).mockResolvedValue({ manifest } as never);

    await installRuntimePacks();

    expect(rebuildContentRegistry).toHaveBeenCalledTimes(1);
  });
});

describe('the offline prefetch', () => {
  // A sibling of `describe('installRuntimePacks', ...)` above, not nested in
  // it — its `beforeEach`/`afterEach` are scoped to that block alone, so the
  // storage and mock setup has to be re-stated here rather than inherited.
  const PACK_URL = 'https://packs.example/riot/manifest.json';
  const PACK_BASE = 'https://packs.example/riot/';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rebuildContentRegistry).mockReturnValue({ hasPack: () => false } as never);
    vi.mocked(prefetchPackFiles).mockResolvedValue(EMPTY_REPORT);
    withStorage();
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
    // Minor 6: two tests in this block now write `__moba2dPackPrefetch`
    // (this one and 'publishes what the prefetch actually did...') and one
    // waits on its value with `vi.waitFor` — leaving a previous test's
    // publish in place is an ordering hazard, not hygiene, since a later
    // test's own `vi.waitFor` could observe a stale value and pass for the
    // wrong reason.
    delete (globalThis as Record<string, unknown>).__moba2dPackPrefetch;
  });

  /** One stored pack whose manifest is reachable at `PACK_URL`/`PACK_BASE`. */
  const seedInstalledPack = (files?: string[]) => {
    writeInstalledPacks([{ manifestUrl: PACK_URL, id: 'riot', version: '1.0.0' }]);
    const seeded = { ...manifest, files };
    vi.mocked(fetchPackManifest).mockResolvedValue(seeded);
    vi.mocked(loadPackFromManifest).mockResolvedValue({ manifest: seeded } as never);
  };

  it("announces every installed pack's base to the worker", async () => {
    seedInstalledPack(['pack.js']);

    await installRuntimePacks();

    expect(announcePackBases).toHaveBeenCalledWith([PACK_BASE], [PACK_URL]);
  });

  it('prefetches the files the manifest listed', async () => {
    seedInstalledPack(['pack.js']);

    await installRuntimePacks();

    expect(prefetchPackFiles).toHaveBeenCalledWith(PACK_BASE, ['pack.js']);
  });

  it('does not prefetch a pack that listed nothing', async () => {
    seedInstalledPack(undefined);

    await installRuntimePacks();

    expect(prefetchPackFiles).not.toHaveBeenCalled();
  });

  it('does not prefetch a pack that failed to install', async () => {
    writeInstalledPacks([{ manifestUrl: PACK_URL, id: 'riot', version: '1.0.0' }]);
    const { PackLoadError } = await import('@/content/packSource');
    vi.mocked(fetchPackManifest).mockRejectedValue(new PackLoadError('fetch', 'offline'));

    await installRuntimePacks();

    expect(prefetchPackFiles).not.toHaveBeenCalled();
  });

  it("announces a skipped pack's base too — its bytes are still worth caching", async () => {
    // The duplicate-id skip branch is not the install branch, and both
    // report to `installed.push(...)` — this is the other one.
    vi.mocked(rebuildContentRegistry).mockReturnValue({
      hasPack: (id: string) => id === 'riot',
    } as never);
    seedInstalledPack(['pack.js']);

    await installRuntimePacks();

    expect(announcePackBases).toHaveBeenCalledWith([PACK_BASE], [PACK_URL]);
    expect(prefetchPackFiles).toHaveBeenCalledWith(PACK_BASE, ['pack.js']);
  });

  it('resolves before the prefetch does — the menu does not wait for 4.7MB', async () => {
    // The one that matters. `prefetchPackFiles` is made to hang; the whole
    // point is that `installRuntimePacks()` still resolves.
    seedInstalledPack(['pack.js']);
    let release: () => void = () => {};
    vi.mocked(prefetchPackFiles).mockImplementation(
      () =>
        new Promise(resolve => {
          release = () => resolve(EMPTY_REPORT);
        })
    );

    await expect(installRuntimePacks()).resolves.toBeInstanceOf(Array);

    release();
  });

  it('a prefetch that rejects does not become an unhandled rejection, and its report is synthesized', async () => {
    seedInstalledPack(['pack.js']);
    vi.mocked(prefetchPackFiles).mockRejectedValue(new Error('disk full'));

    await expect(installRuntimePacks()).resolves.toBeInstanceOf(Array);
    // and nothing thrown out of band — the suite fails on one if it happens

    // Beyond "it resolves" (true under the old `Promise.all` too, since
    // nothing here awaits the fire-and-forget chain), this exercises the
    // synthesized-report branch in `runtimePacks.ts` — nothing else in this
    // suite does. `vi.waitFor` because `installRuntimePacks()` resolving
    // does not mean the background `.then` has run yet.
    await vi.waitFor(() => {
      expect((globalThis as Record<string, unknown>).__moba2dPackPrefetch).toEqual([
        // `gone: 0` and not `gone: 1`: the promise rejected, so nothing was
        // ever asked and nothing came back 404. A synthesized report must not
        // invent the one signal that means "this build is gone from the
        // server".
        { base: PACK_BASE, requested: 1, added: 0, skipped: 0, failed: 1, gone: 0 },
      ]);
    });
  });

  it('publishes what the prefetch actually did, once every pack has settled', async () => {
    // The deliverable itself: everything above this test only checks that
    // `prefetchPackFiles`/`announcePackBases` were *called* right, never
    // that the background chain's own write lands with the right shape.
    // `installRuntimePacks()` resolving does not mean the fire-and-forget
    // `.then` has run yet — `vi.waitFor` is what waits for that without a
    // sleep.
    seedInstalledPack(['pack.js']);
    const report: PrefetchReport = {
      base: PACK_BASE,
      requested: 1,
      added: 1,
      skipped: 0,
      failed: 0,
    };
    vi.mocked(prefetchPackFiles).mockResolvedValue(report);

    await installRuntimePacks();

    await vi.waitFor(() => {
      expect((globalThis as Record<string, unknown>).__moba2dPackPrefetch).toEqual([report]);
    });
  });

  it('still announces (an empty list) when the only pack cannot resolve to a base, but never prefetches it', async () => {
    // `packBaseFor` answers `''` for a stored `manifestUrl` that is relative
    // or malformed rather than throwing (see `packCache.ts`); both branches
    // guard on that before pushing anything, and this is what exercises the
    // guard instead of leaving it implied by the mock never returning ''.
    //
    // The announce itself is unconditional (Minor 7: dropping every pack
    // must clear the worker's memory too, and an unreachable base is the
    // same "nothing to serve" fact from the worker's point of view), so this
    // is `toHaveBeenCalledWith([])`, not `not.toHaveBeenCalled()`.
    writeInstalledPacks([{ manifestUrl: 'not-a-real-url', id: 'riot', version: '1.0.0' }]);
    const seeded = { ...manifest, files: ['pack.js'] };
    vi.mocked(fetchPackManifest).mockResolvedValue(seeded);
    vi.mocked(loadPackFromManifest).mockResolvedValue({ manifest: seeded } as never);

    await expect(installRuntimePacks()).resolves.toBeInstanceOf(Array);

    expect(announcePackBases).toHaveBeenCalledWith([], []);
    expect(prefetchPackFiles).not.toHaveBeenCalled();
  });

  it('announces an empty list when nothing is installed at all, so a fresh removal reload clears the worker', async () => {
    // The exact case Minor 7 names: a player removes their only pack, which
    // writes an empty stored list and reloads. `installRuntimePacks()` on
    // that reload has nothing to seed (the flag is already set) and nothing
    // to install — `bases` never leaves its initial `[]` — and the worker
    // must still hear about it, or `packBases` in `src/sw.ts` holds the
    // removed pack's base forever.
    markDefaultPackSeeded();

    await installRuntimePacks();

    expect(announcePackBases).toHaveBeenCalledWith([], []);
  });
});

/**
 * Boot must not ask the network what a pack is.
 *
 * It used to, on every launch — and let the worker's `CacheFirst` route decide
 * where the answer came from. The route claimed the manifest by prefix, so the
 * first fetch froze it and every later boot got that same copy for ever: an
 * installed pack could never see a newer build of itself, and any file the
 * first prefetch missed 404'd for ever against a deploy that keeps exactly one
 * build. The strategy was making a decision nobody had stated.
 *
 * Now there are two named reads. This is the pinned one.
 */
describe('the pinned manifest', () => {
  const PACK_URL = 'https://packs.example/riot/manifest.json';

  // A sibling block, so it carries its own resets — see `installPackNow`'s.
  // `readPinnedManifest` in particular has to be re-stated every test:
  // `clearAllMocks` clears recorded calls and not implementations, so one
  // test's `mockResolvedValue` would otherwise pin every test after it.
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rebuildContentRegistry).mockReturnValue({ hasPack: () => false } as never);
    vi.mocked(readPinnedManifest).mockResolvedValue(null);
    vi.mocked(prefetchPackFiles).mockResolvedValue({ ...EMPTY_REPORT });
    withStorage();
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  const pinned = (manifest: unknown) =>
    vi.mocked(readPinnedManifest).mockResolvedValue(JSON.stringify(manifest));

  it('boots from the pin without touching the network', async () => {
    writeInstalledPacks([{ manifestUrl: PACK_URL, id: 'riot', version: '1.0.0' }]);
    pinned({
      id: 'riot',
      version: '1.0.0',
      coreRange: '*',
      name: 'Riot',
      entry: 'pack.js',
      assets: 'assets/',
    });
    vi.mocked(loadPackFromManifest).mockResolvedValue({ manifest: { id: 'riot' } } as never);

    await installRuntimePacks();

    expect(fetchPackManifest).not.toHaveBeenCalled();
    expect(loadPackFromManifest).toHaveBeenCalled();
  });

  it('fetches and pins when there is no pin yet', async () => {
    writeInstalledPacks([{ manifestUrl: PACK_URL, id: 'riot', version: '1.0.0' }]);
    const manifest = {
      id: 'riot',
      version: '1.0.0',
      coreRange: '*',
      name: 'Riot',
      entry: 'pack.js',
      assets: 'assets/',
    };
    vi.mocked(fetchPackManifest).mockResolvedValue(manifest as never);
    vi.mocked(loadPackFromManifest).mockResolvedValue({ manifest } as never);

    await installRuntimePacks();

    expect(fetchPackManifest).toHaveBeenCalledWith(PACK_URL);
    // Pinned as the *checked* object re-serialised, not as the bytes that
    // arrived: what is worth keeping is exactly what passed validation.
    expect(pinPackManifest).toHaveBeenCalledWith(PACK_URL, JSON.stringify(manifest));
  });

  /**
   * A pin is a stranger's file that has been sitting on the player's own disk.
   * It gets the same checks the network copy gets, and a pin that no longer
   * passes them falls back to the network rather than refusing the pack.
   */
  it('falls back to the network when the pin no longer checks out', async () => {
    writeInstalledPacks([{ manifestUrl: PACK_URL, id: 'riot', version: '1.0.0' }]);
    vi.mocked(readPinnedManifest).mockResolvedValue('{ not json');
    const manifest = {
      id: 'riot',
      version: '1.0.0',
      coreRange: '*',
      name: 'Riot',
      entry: 'pack.js',
      assets: 'assets/',
    };
    vi.mocked(fetchPackManifest).mockResolvedValue(manifest as never);
    vi.mocked(loadPackFromManifest).mockResolvedValue({ manifest } as never);

    const outcomes = await installRuntimePacks();

    expect(fetchPackManifest).toHaveBeenCalledWith(PACK_URL);
    expect(outcomes[0]).toMatchObject({ ok: true });
  });

  it('tells the worker which URL it must never answer from its own cache', async () => {
    writeInstalledPacks([{ manifestUrl: PACK_URL, id: 'riot', version: '1.0.0' }]);
    pinned({
      id: 'riot',
      version: '1.0.0',
      coreRange: '*',
      name: 'Riot',
      entry: 'pack.js',
      assets: 'assets/',
    });
    vi.mocked(loadPackFromManifest).mockResolvedValue({ manifest: { id: 'riot' } } as never);

    await installRuntimePacks();

    expect(announcePackBases).toHaveBeenCalledWith(['https://packs.example/riot/'], [PACK_URL]);
  });

  it('remembers which build it pinned', async () => {
    writeInstalledPacks([{ manifestUrl: PACK_URL, id: 'riot', version: '1.0.0' }]);
    pinned({
      id: 'riot',
      version: '1.0.0',
      coreRange: '*',
      name: 'Riot',
      entry: 'pack.js',
      assets: 'assets/',
      buildId: 'deadbeef',
    });
    vi.mocked(loadPackFromManifest).mockResolvedValue({ manifest: { id: 'riot' } } as never);

    await installRuntimePacks();

    expect(readInstalledPacks()[0].buildId).toBe('deadbeef');
  });
});

/**
 * Noticing that a pack has a newer build than the one pinned.
 *
 * There was no such check, and no way to write one: `manifest.version` was the
 * only candidate and riot's stayed `1.0.0` across dozens of publishes. Now the
 * pack derives a `buildId` from its own emitted file list, so the comparison
 * is between two values that actually move.
 *
 * Runs after the menu is up and never blocks anything. Its failure mode is
 * silence: a player on a train has an unreachable host, not a broken pack.
 */
describe('checkPackUpdates', () => {
  const PACK_URL = 'https://packs.example/riot/manifest.json';
  const record = (buildId?: string) => ({
    manifestUrl: PACK_URL,
    id: 'riot',
    version: '1.0.0',
    name: 'Riot',
    ...(buildId ? { buildId } : {}),
  });
  const served = (buildId?: string) =>
    vi.mocked(fetchPackManifest).mockResolvedValue({
      ...manifest,
      ...(buildId ? { buildId } : {}),
    } as never);

  beforeEach(() => {
    vi.clearAllMocks();
    resetPackHealthForTests();
    withStorage();
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it('says nothing when the host is serving the build that is pinned', async () => {
    writeInstalledPacks([record('abc123')]);
    served('abc123');

    await checkPackUpdates();

    expect(packProblems.value).toEqual([]);
  });

  it('reports an update when the host has moved on', async () => {
    writeInstalledPacks([record('abc123')]);
    served('def456');

    await checkPackUpdates();

    expect(packProblems.value).toMatchObject([{ id: 'riot', kind: 'update' }]);
  });

  /**
   * A pin written before build ids existed is of unknown vintage, and it is
   * exactly the install at risk of the dead-chunk-graph bug — its entry URL
   * carries no build id, so nothing stops a cache serving it across a
   * republish. Offering the update is the point.
   */
  it('reports an update for an install that predates build ids', async () => {
    writeInstalledPacks([record()]);
    served('def456');

    await checkPackUpdates();

    expect(packProblems.value).toMatchObject([{ kind: 'update' }]);
  });

  it('says nothing when the pack publishes no build id at all', async () => {
    writeInstalledPacks([record()]);
    served();

    await checkPackUpdates();

    expect(packProblems.value).toEqual([]);
  });

  /**
   * The check must bypass the browser's HTTP cache as well as the worker's.
   * riot's manifest ships `max-age=600`, so for ten minutes after a republish
   * a plain fetch answers with the previous build's file list — a check that
   * cannot see a change is not a check.
   */
  it('asks the network, not a cache', async () => {
    writeInstalledPacks([record('abc123')]);
    served('abc123');

    await checkPackUpdates();

    expect(fetchPackManifest).toHaveBeenCalledWith(PACK_URL, undefined, { bypassCache: true });
  });

  /** A player on a train has an unreachable host, not a broken pack. */
  it('stays silent when the host cannot be reached', async () => {
    writeInstalledPacks([record('abc123')]);
    vi.mocked(fetchPackManifest).mockRejectedValue(new Error('offline'));

    await expect(checkPackUpdates()).resolves.toBeUndefined();

    expect(packProblems.value).toEqual([]);
  });

  it('checks every installed pack, not only the first', async () => {
    writeInstalledPacks([
      record('abc123'),
      { manifestUrl: 'https://h/other/manifest.json', id: 'other', version: '1.0.0' },
    ]);
    served('def456');

    await checkPackUpdates();

    expect(fetchPackManifest).toHaveBeenCalledTimes(2);
  });
});

/**
 * The action behind the button. Replaces the pinned snapshot with what the
 * host is serving now.
 *
 * It cannot swap the pack in place: the previous build's modules have already
 * been evaluated in this page, and ES modules evaluate once. So this prepares
 * the ground — new pin, new record, old bytes gone — and the caller reloads.
 * Doing it in that order matters, and the order is the test.
 */
describe('updatePack', () => {
  const PACK_URL = 'https://packs.example/riot/manifest.json';
  const PACK_BASE = 'https://packs.example/riot/';

  beforeEach(() => {
    vi.clearAllMocks();
    resetPackHealthForTests();
    withStorage();
    writeInstalledPacks([
      { manifestUrl: PACK_URL, id: 'riot', version: '1.0.0', name: 'Riot', buildId: 'old' },
    ]);
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  const serving = (buildId: string) =>
    vi.mocked(fetchPackManifest).mockResolvedValue({ ...manifest, buildId } as never);

  it('pins the build the host is serving now', async () => {
    serving('new');
    await expect(updatePack(PACK_URL)).resolves.toBe(true);
    expect(pinPackManifest).toHaveBeenCalledWith(
      PACK_URL,
      JSON.stringify({ ...manifest, buildId: 'new' })
    );
    expect(readInstalledPacks()[0].buildId).toBe('new');
  });

  /**
   * The old build's bytes have to go, and this is the one place it is safe to
   * drop them. Every name under the base is content-hashed except the entry,
   * so the old chunks are dead weight the moment the new manifest lands — and
   * leaving them lets the cache answer a request the new graph never makes.
   */
  it('drops the old build from the cache', async () => {
    serving('new');
    await updatePack(PACK_URL);
    expect(forgetPack).toHaveBeenCalledWith(PACK_BASE);
  });

  it('clears the notice it was pressed from', async () => {
    notePackProblem({ id: 'riot', name: 'Riot', manifestUrl: PACK_URL, kind: 'broken' });
    serving('new');
    await updatePack(PACK_URL);
    expect(packProblems.value).toEqual([]);
  });

  /**
   * The failure that must not happen: dropping the working copy and then
   * failing to get a new one, which turns "there is an update" into "you now
   * have no pack". The fetch comes first for exactly this reason.
   */
  it('keeps the pinned build when the host cannot be reached', async () => {
    vi.mocked(fetchPackManifest).mockRejectedValue(new Error('offline'));

    await expect(updatePack(PACK_URL)).resolves.toBe(false);

    expect(forgetPack).not.toHaveBeenCalled();
    expect(pinPackManifest).not.toHaveBeenCalled();
    expect(readInstalledPacks()[0].buildId).toBe('old');
  });

  it('answers false for a URL that is not installed', async () => {
    await expect(updatePack('https://h/nope/manifest.json')).resolves.toBe(false);
    expect(fetchPackManifest).not.toHaveBeenCalled();
  });
});

/**
 * **Three stale packs are one press, not three reloads.**
 *
 * The menu updated `packProblems[0]` and reloaded, so a player with three
 * packs behind answered the same notice three times and only learned there was
 * another after each reload. Reported exactly that way.
 *
 * What this has to get right is the *order*: `updatePack` is a
 * read-modify-write of the installed list, so two of them in flight together
 * both read the same snapshot and the second write puts back the first's stale
 * record — an update that reports success and did not move.
 */
describe('updatePacks', () => {
  const RIOT_URL = 'https://packs.example/riot/manifest.json';
  const DOTA_URL = 'https://packs.example/dota/manifest.json';

  beforeEach(() => {
    vi.clearAllMocks();
    resetPackHealthForTests();
    withStorage();
    writeInstalledPacks([
      { manifestUrl: RIOT_URL, id: 'riot', version: '1.0.0', name: 'Riot', buildId: 'old' },
      { manifestUrl: DOTA_URL, id: 'dota', version: '1.0.0', name: 'Dota', buildId: 'old' },
    ]);
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it('moves every pack it was handed, and says how many', async () => {
    vi.mocked(fetchPackManifest).mockImplementation((async (url: string) => ({
      ...manifest,
      id: url === DOTA_URL ? 'dota' : 'riot',
      buildId: 'new',
    })) as never);

    await expect(updatePacks([RIOT_URL, DOTA_URL])).resolves.toBe(2);

    const stored = readInstalledPacks();
    expect(stored.map(record => record.buildId)).toEqual(['new', 'new']);
  });

  /**
   * The read-modify-write, held to the thing that would break it: if the
   * second call read its snapshot before the first had written, the first
   * pack's new build id would be gone from the list at the end.
   */
  it('runs them one at a time, so neither write clobbers the other', async () => {
    const seen: string[] = [];
    vi.mocked(fetchPackManifest).mockImplementation((async (url: string) => {
      // Every fetch has to observe the *finished* state of the one before it.
      seen.push(`start:${url}`);
      await Promise.resolve();
      seen.push(`end:${url}`);
      return { ...manifest, id: url === DOTA_URL ? 'dota' : 'riot', buildId: 'new' };
    }) as never);

    await updatePacks([RIOT_URL, DOTA_URL]);

    expect(seen).toEqual([
      `start:${RIOT_URL}`,
      `end:${RIOT_URL}`,
      `start:${DOTA_URL}`,
      `end:${DOTA_URL}`,
    ]);
    expect(readInstalledPacks().map(record => record.buildId)).toEqual(['new', 'new']);
  });

  /** One dead host does not hold the ones that worked. */
  it('counts only what moved when a host refuses', async () => {
    vi.mocked(fetchPackManifest).mockImplementation((async (url: string) => {
      if (url === DOTA_URL) throw new Error('offline');
      return { ...manifest, buildId: 'new' };
    }) as never);

    await expect(updatePacks([RIOT_URL, DOTA_URL])).resolves.toBe(1);

    const stored = readInstalledPacks();
    expect(stored[0].buildId).toBe('new');
    expect(stored[1].buildId, 'a refused fetch moved the record anyway').toBe('old');
  });

  it('answers zero for an empty list without touching the network', async () => {
    await expect(updatePacks([])).resolves.toBe(0);
    expect(fetchPackManifest).not.toHaveBeenCalled();
  });
});

/**
 * Turning "these spell chunks never arrived" into a notice naming the pack.
 *
 * This is the reported bug's own path. `GameScene.startGame` loads exactly the
 * kits a match needs and then builds the match from whatever loaded; an id
 * that did not load falls back to `BasicAttack` in `preset.ts`, deliberately,
 * so a stale loadout slot cannot break a match. What was missing is that a
 * *pack* failing is not a stale slot, and the player was shown neither.
 */
describe('notePackSpellFailures', () => {
  const PACK_URL = 'https://packs.example/riot/manifest.json';

  beforeEach(() => {
    vi.clearAllMocks();
    resetPackHealthForTests();
    withStorage();
    writeInstalledPacks([
      { manifestUrl: PACK_URL, id: 'riot', version: '1.0.0', name: 'Liên Minh', buildId: 'old' },
    ]);
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it('names the pack the failed ids belong to, and counts them', () => {
    notePackSpellFailures(['riot:Rammus_Q', 'riot:Rammus_W']);
    expect(packProblems.value).toMatchObject([
      { id: 'riot', name: 'Liên Minh', kind: 'broken', missingSpells: 2 },
    ]);
  });

  it('says nothing when nothing failed', () => {
    notePackSpellFailures([]);
    expect(packProblems.value).toEqual([]);
  });

  /**
   * Core's own spells are not a pack anybody can update, so a notice offering
   * to would be a dead end. If those fail the app itself is broken, which is
   * the service worker's problem, not this one's.
   */
  it('ignores an id belonging to no installed pack', () => {
    notePackSpellFailures(['nosuchpack:Alpha_Q']);
    expect(packProblems.value).toEqual([]);
  });

  it('groups per pack rather than per spell', () => {
    writeInstalledPacks([
      { manifestUrl: PACK_URL, id: 'riot', version: '1.0.0', name: 'Liên Minh' },
      { manifestUrl: 'https://h/other/manifest.json', id: 'other', version: '1.0.0' },
    ]);
    notePackSpellFailures(['riot:A_Q', 'riot:A_W', 'other:B_Q']);
    expect(packProblems.value).toHaveLength(2);
    expect(packProblems.value.find(p => p.id === 'riot')?.missingSpells).toBe(2);
  });
});

describe('installPackNow', () => {
  // A sibling of the two `describe` blocks above, not nested — same reason
  // `describe('the offline prefetch', ...)` isn't nested either: its own
  // `beforeEach`/`afterEach` scope the storage and mock resets to this block
  // alone.
  const packUrl = 'https://packs.example/riot/manifest.json';
  const packBase = 'https://packs.example/riot/';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(contentRegistry).mockReturnValue({ hasPack: () => false } as never);
    withStorage();
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it('installs into the existing (live) registry, not a rebuilt one', async () => {
    const registry = { hasPack: () => false };
    vi.mocked(contentRegistry).mockReturnValue(registry as never);
    vi.mocked(loadPackFromManifest).mockResolvedValue({ manifest } as never);

    const outcome = await installPackNow(packUrl, manifest);

    expect(outcome).toEqual({ manifestUrl: packUrl, ok: true, id: 'riot' });
    expect(installRuntimePack).toHaveBeenCalledWith(registry, expect.anything(), { manifest });
    // The whole reason `installPackNow` exists rather than reusing
    // `installRuntimePacks`'s own path: a rebuild would discard and
    // reinstall core, the reference pack and every already-installed
    // runtime pack for no gain — see `runtimePacks.ts`'s own doc comment.
    expect(rebuildContentRegistry).not.toHaveBeenCalled();
  });

  it('skips a pack whose id is already installed, without fetching its entry', async () => {
    vi.mocked(contentRegistry).mockReturnValue({ hasPack: (id: string) => id === 'riot' } as never);

    const outcome = await installPackNow(packUrl, manifest);

    expect(outcome).toEqual({ manifestUrl: packUrl, ok: true, id: 'riot', skipped: true });
    expect(loadPackFromManifest).not.toHaveBeenCalled();
    expect(installRuntimePack).not.toHaveBeenCalled();
  });

  it('appends to the store without duplicating an existing URL', async () => {
    writeInstalledPacks([
      { manifestUrl: 'https://other/manifest.json', id: 'other', version: '1.0.0' },
      { manifestUrl: packUrl, id: 'riot', version: '0.9.0' },
    ]);
    vi.mocked(loadPackFromManifest).mockResolvedValue({ manifest } as never);

    await installPackNow(packUrl, { ...manifest, version: '2.0.0' });

    expect(readInstalledPacks()).toEqual([
      { manifestUrl: 'https://other/manifest.json', id: 'other', version: '1.0.0' },
      { manifestUrl: packUrl, id: 'riot', version: '2.0.0', name: 'Riot', fileCount: 0 },
    ]);
  });

  it('announces every installed base, not only the one just installed', async () => {
    writeInstalledPacks([{ manifestUrl: 'https://a/manifest.json', id: 'a', version: '1.0.0' }]);
    vi.mocked(loadPackFromManifest).mockResolvedValue({ manifest } as never);

    await installPackNow(packUrl, manifest);

    expect(announcePackBases).toHaveBeenCalledWith(
      ['https://a/', packBase],
      ['https://a/manifest.json', packUrl]
    );
  });

  it('comes back ok: false with the stage, instead of throwing, when loadPackFromManifest rejects', async () => {
    const { PackLoadError } = await import('@/content/packSource');
    vi.mocked(loadPackFromManifest).mockRejectedValue(new PackLoadError('import', 'boom'));

    await expect(installPackNow(packUrl, manifest)).resolves.toEqual({
      manifestUrl: packUrl,
      ok: false,
      stage: 'import',
      message: 'boom',
    });
    expect(installRuntimePack).not.toHaveBeenCalled();
    expect(readInstalledPacks()).toEqual([]);
    // Important 2's failure-path guard: a fetch that never landed must not
    // spend the automatic offer either — same reasoning `installRuntimePacks`
    // already applies to its own seeding attempt.
    expect(hasSeededDefaultPack()).toBe(false);
  });

  it('spends the default-seed offer on a successful, non-skipped install', async () => {
    // Important 2: `markDefaultPackSeeded()` used to be written from exactly
    // one place, `installRuntimePacks`'s own seeding run. A browser whose
    // first boot could not reach `DEFAULT_PACK_URL` (flag stays `false` —
    // see this file's own header) could install a pack by hand through this
    // function, remove it later, and have the very next boot re-seed a
    // default it never asked for — `installRuntimePacks()` cannot tell that
    // apart from a browser that has never run the game at all.
    expect(hasSeededDefaultPack()).toBe(false);
    vi.mocked(loadPackFromManifest).mockResolvedValue({ manifest } as never);

    await installPackNow(packUrl, manifest);

    expect(hasSeededDefaultPack()).toBe(true);
  });

  it('does not spend the offer on a skipped install — nothing changed for it to settle', async () => {
    vi.mocked(contentRegistry).mockReturnValue({ hasPack: (id: string) => id === 'riot' } as never);

    const outcome = await installPackNow(packUrl, manifest);

    expect(outcome).toMatchObject({ ok: true, skipped: true });
    expect(hasSeededDefaultPack()).toBe(false);
  });
});

/**
 * A pack served from the author's own machine.
 *
 * Everything core does to keep a *published* pack working while its host moves
 * underneath it — pinning the manifest, letting the worker answer from cache —
 * is what stops a pack author from ever seeing the build they just made. The
 * rule is one predicate (`isDevPackUrl`) gating decisions boot already makes,
 * and the last case here is the one that matters most: a published pack must
 * come out of this untouched.
 */
describe('a dev pack served from loopback', () => {
  const DEV_URL = 'http://localhost:5174/manifest.json';
  const DEV_BASE = 'http://localhost:5174/';
  const PUBLISHED_URL = 'https://packs.example/riot/manifest.json';

  const devManifest = {
    id: 'my-pack',
    version: '1.0.0',
    coreRange: '*',
    name: 'My Pack',
    entry: 'pack.js',
    assets: 'assets/',
    buildId: 'aaaa',
    files: ['pack.js'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rebuildContentRegistry).mockReturnValue({ hasPack: () => false } as never);
    vi.mocked(readPinnedManifest).mockResolvedValue(null);
    vi.mocked(prefetchPackFiles).mockResolvedValue({ ...EMPTY_REPORT });
    vi.mocked(loadPackFromManifest).mockResolvedValue({ manifest: devManifest } as never);
    vi.mocked(fetchPackManifest).mockResolvedValue(devManifest as never);
    withStorage();
    resetPackHealthForTests();
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it('ignores a pin it already has, and writes none — a rebuild is the point', async () => {
    writeInstalledPacks([{ manifestUrl: DEV_URL, id: 'my-pack', version: '1.0.0' }]);
    // Deliberately a *valid* pin. Boot's ordinary path would take it and never
    // reach the network, which is exactly the state that makes an author think
    // their build did not land.
    vi.mocked(readPinnedManifest).mockResolvedValue(JSON.stringify(devManifest));

    await installRuntimePacks();

    expect(fetchPackManifest).toHaveBeenCalledWith(DEV_URL, undefined, { bypassCache: true });
    expect(pinPackManifest).not.toHaveBeenCalled();
  });

  it('never announces its base, so the worker cannot freeze it at one build', async () => {
    writeInstalledPacks([{ manifestUrl: DEV_URL, id: 'my-pack', version: '1.0.0' }]);

    await installRuntimePacks();

    expect(announcePackBases).toHaveBeenCalledWith([], []);
    expect(prefetchPackFiles).not.toHaveBeenCalled();
  });

  it('releases a base the worker was already holding from an earlier install', async () => {
    // The author who most needs this rule is the one who already installed a
    // localhost pack before it existed: their worker is still holding that
    // base, and nothing else would ever tell it to let go.
    writeInstalledPacks([{ manifestUrl: DEV_URL, id: 'my-pack', version: '1.0.0' }]);

    await installRuntimePacks();

    expect(forgetPack).toHaveBeenCalledWith(DEV_BASE);
  });

  it('is left alone by the update check, which has no pin to update', async () => {
    // `updatePack` pins unconditionally, so an "update" notice on a dev pack
    // offers a button that would put back the pin boot just refused.
    writeInstalledPacks([
      { manifestUrl: DEV_URL, id: 'my-pack', version: '1.0.0', buildId: 'aaaa' },
    ]);
    vi.mocked(fetchPackManifest).mockResolvedValue({ ...devManifest, buildId: 'bbbb' } as never);

    await checkPackUpdates();

    expect(packProblems.value).toEqual([]);
  });

  it('leaves a published pack pinned, cached and checked exactly as before', async () => {
    const published = { ...devManifest, id: 'riot', name: 'Riot', buildId: 'cccc' };
    writeInstalledPacks([{ manifestUrl: PUBLISHED_URL, id: 'riot', version: '1.0.0' }]);
    vi.mocked(fetchPackManifest).mockResolvedValue(published as never);
    vi.mocked(loadPackFromManifest).mockResolvedValue({ manifest: published } as never);

    await installRuntimePacks();

    expect(fetchPackManifest).toHaveBeenCalledWith(PUBLISHED_URL);
    expect(pinPackManifest).toHaveBeenCalledWith(PUBLISHED_URL, JSON.stringify(published));
    expect(announcePackBases).toHaveBeenCalledWith(
      ['https://packs.example/riot/'],
      [PUBLISHED_URL]
    );
    expect(forgetPack).not.toHaveBeenCalled();
  });
});
