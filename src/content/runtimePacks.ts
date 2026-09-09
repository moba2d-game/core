import { buildContentApi, type ContentApi } from './ContentApi';
import { isDevPackUrl } from './devPack';
import { installRuntimePack } from './install';
import { clearPackProblem, notePackProblem } from './packHealth';
import {
  announcePackBases,
  forgetPack,
  missingPackFiles,
  pinPackManifest,
  readPinnedManifest,
  packBaseFor,
  prefetchPackFiles,
  type PrefetchReport,
} from './packCache';
import {
  fetchPackManifest,
  checkPackManifest,
  loadPackFromManifest,
  PackLoadError,
  resolvePackIcon,
  type RuntimePackManifest,
} from './packSource';
import type { PackRegistry } from './PackRegistry';
import { contentRegistry, rebuildContentRegistry } from './registry';
import {
  readInstalledPacks,
  writeInstalledPacks,
  hasSeededDefaultPack,
  markDefaultPackSeeded,
  type InstalledPackRecord,
} from './installedPackStore';

/**
 * Installing every remembered pack, once, during the loading screen.
 *
 * **Nothing here may throw.** The game is already playable when this runs —
 * `main.ts` installed core and the reference pack synchronously before
 * `LoadingScene` ever mounted — so every failure below costs the player
 * content they can retry for, and none of it may cost them the menu. That
 * is why the return is a list of outcomes rather than a promise that
 * rejects: the caller reports what failed and carries on.
 *
 * One pack's failure does not stop the next. A player with two packs and one
 * dead host should lose one roster, not both.
 *
 * **The registry is rebuilt exactly once, before the loop, not once per
 * pack.** Rebuilding inside the loop (the shape this function started as)
 * discards and reinstalls the *whole* registry — core, the reference pack
 * and every runtime pack installed so far in this same call — on every
 * iteration, which is O(n^2) in the pack count and, worse, throws away a
 * pack installed two iterations ago the instant the *next* one rebuilds. One
 * rebuild up front is enough: `installRuntimePack` only needs a registry
 * that already reflects the bundled packs, and every runtime pack after that
 * installs directly into the same instance.
 *
 * **An empty stored list seeds the default only once, ever — not once per
 * empty list.** `readInstalledPacks()` returning `[]` means two different
 * things: a browser that has never run this game, and a browser whose
 * player has removed every pack. Seeding the default on both makes an
 * uninstall impossible to keep — the very next boot would just bring it
 * back. `installedPackStore.ts`'s `hasSeededDefaultPack()` is what tells
 * the two apart.
 *
 * **The flag is set on a seed that *worked*, never on one that merely
 * happened.** It used to be set either way, reasoned as "a browser with no
 * network must not phone an unreachable host on every launch forever". That
 * is the wrong trade and it was measured to be: `DEFAULT_PACK_URL` answers
 * 404 until the pack repository's own publish workflow has run, so every
 * browser that boots before publication spends its single automatic attempt
 * on a guaranteed failure, `wanted` is permanently `[]` afterwards, and the
 * retry offered on the banner is `location.reload()` — which cannot re-seed,
 * because the flag is already set. One unlucky first launch and that browser
 * never sees the content again. The cost of the other choice is one failed
 * `fetch` per launch on a browser with no packs and no network, which is a
 * few hundred bytes that never leave the machine. The uninstall case the
 * flag exists for is untouched: a successful seed sets it, so a player who
 * removes every pack afterwards is not re-seeded.
 *
 * **There are two writers of the installed list, and both have to mark this
 * flag.** This function is one; `installPackNow()` below — the packs
 * screen's "install by URL" path — is the other, and it marks the flag on
 * its own successful, non-skipped install for the same reason: a player who
 * installs a pack by hand has made their own choice, spending the automatic
 * offer just as surely as a seed landing would have. Leaving `installPackNow`
 * out reopens exactly the hole this section describes — a browser whose
 * first boot could not reach `DEFAULT_PACK_URL` installs one by URL instead,
 * later removes it, and the next boot re-seeds a default the player never
 * asked for, because nothing ever told the flag the offer was spent.
 *
 * **A pack whose id is already installed is skipped, not failed.** Both
 * content paths can be live at once until Plan 2 retires core's compile-in
 * step, and the default pack's id (`riot`) is the same id on both. The skip
 * happens after the manifest — cheap JSON, and the only way to learn the id
 * — and before the entry is fetched or any asset manifest is registered:
 * `AssetManager.registerPackAssets` is a bare `Map.set`, so an install that
 * runs it on the way to a duplicate-id throw silently repoints every one of
 * that pack's art keys at the remote host for the rest of the session.
 *
 * **The offline prefetch is fire-and-forget, on purpose.** The real pack is
 * 4.7MB, and this function's `await` is the statement standing between the
 * player and the menu — `LoadingScene.enter()` fires `void this.boot()`, so
 * anything that rejects above the handover is an unhandled rejection and the
 * menu never opens, and anything merely slow is the same dead screen with
 * extra steps. `installRuntimePacks()` announces the installed bases (a
 * chunk fetched mid-match is cached by the worker's own route too, so the
 * announce always happens) and then starts the prefetch without awaiting it,
 * catching whatever it throws so a slow or failing cache never becomes the
 * player's problem. `window.__moba2dPackPrefetch` is where that background
 * work reports in, once it is actually done — see this file's own export.
 */

/**
 * Where the game's own content comes from when a player has never installed
 * anything. Seeded into the stored list on first run, after which it is an
 * ordinary entry the player can remove.
 *
 * **Measure the redirect chain before changing this string.** That is the
 * lesson the previous host taught and it outlived the host itself: the pack
 * used to live under `hoangtran0410.github.io`, and — measured with `curl -sI`
 * — that form 301-redirects to `http://hoangtran99.is-a.dev/...`, a downgrade
 * to plain HTTP, with no `access-control-allow-origin` on the redirect
 * response. A browser `fetch()` requires *every* hop of a cross-origin
 * redirect to carry CORS headers, not just the last, so that form could never
 * succeed from a page — not "not published yet", structurally broken. The
 * redirect exists because that account has a custom domain on its user page,
 * which makes every project path under `github.io` bounce to it.
 *
 * This host has no such redirect: an organisation with no custom domain
 * answers directly, and measurement says `200` and `404` alike carry
 * `access-control-allow-origin: *`. A name that "should" be more stable is
 * not a reason to reopen this — a measurement is.
 *
 * The pack is `lol`, for the game, rather than `riot`, for the company that
 * makes it. The company also makes other games; the pack holds champions from
 * exactly one of them, and naming it after the company both overclaims and
 * describes less.
 */
export const DEFAULT_PACK_URL = 'https://moba2d-packs.github.io/lol/manifest.json';

export type PackInstallOutcome =
  /**
   * The pack is here. `skipped` is set only when it was *already* here under
   * this id and this call did nothing — not a failure (the content the
   * player wanted is installed either way), and deliberately distinguishable
   * so a caller can say which of the two happened.
   */
  | { manifestUrl: string; ok: true; id: string; skipped?: true; icon?: string }
  | { manifestUrl: string; ok: false; stage: string; message: string };

/**
 * One stored record, from a manifest and where it came from.
 *
 * Three call sites write the installed list — two in `installRuntimePacks`
 * and one in `installPackNow` — and they all go through here so a field
 * added to `InstalledPackRecord` cannot land in two of them and be missing
 * from the third. `icon` is `undefined` for a manifest that declared none,
 * and `JSON.stringify` drops the key entirely, which is what the store's own
 * defensive read expects.
 */
function recordFor(manifestUrl: string, manifest: RuntimePackManifest): InstalledPackRecord {
  return {
    manifestUrl,
    id: manifest.id,
    version: manifest.version,
    // Which build is pinned. `version` was already meant to carry this and
    // could not: riot's stayed `1.0.0` across dozens of publishes, so the
    // "so an update can be noticed later" comment on that field described
    // something no code could ever act on. `buildId` is derived by the pack's
    // manifest writer from its own file list, so it moves on its own.
    buildId: manifest.buildId,
    name: manifest.name,
    // The denominator the packs screen shows a download against — see
    // `InstalledPackRecord.fileCount`. `Array.isArray` rather than
    // `manifest.files?.length ?? 0`, for the reason `packSource.ts` gives at
    // its own `files` check: this came out of a stranger's JSON and may be
    // any shape at all. A manifest that declares none stores `0`, which is
    // the truth — that pack saves nothing for offline.
    fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
    icon: resolvePackIcon(manifest, manifestUrl),
  };
}

/**
 * The manifest this browser pinned at install, or `null` to go and fetch one.
 *
 * **Boot's read.** The network one is `fetchPackManifest`, and keeping them
 * two named calls is the correction: they used to be one `fetch()` whose
 * answer came from wherever the worker's `CacheFirst` route decided, and it
 * decided "cache, for ever" — so an installed pack could never see a newer
 * build of itself, and any file the first prefetch missed 404'd against a
 * deploy that keeps exactly one build.
 *
 * The pinned copy is re-checked, not trusted. It was a stranger's file when it
 * was written and `CacheStorage` is the player's own disk; the origin and
 * `coreRange` rules are what the install confirmation's promise rests on, so
 * they are re-applied here through the very same function the network path
 * uses.
 */
async function readPinnedPackManifest(manifestUrl: string): Promise<RuntimePackManifest | null> {
  const body = await readPinnedManifest(manifestUrl);
  if (!body) return null;
  try {
    return checkPackManifest(JSON.parse(body), manifestUrl);
  } catch {
    // A pin that no longer passes — a core whose `coreRange` floor has moved
    // under it, or a hand-edited cache — is not a reason to refuse the pack.
    // Fall through to the network, which is what a browser with no pin does.
    return null;
  }
}

export async function installRuntimePacks(): Promise<PackInstallOutcome[]> {
  const stored = readInstalledPacks();

  // Seeding the default is a one-time offer, not "whatever the list is
  // empty this boot": a list that is empty *because a real list already
  // exists and the player cleared it* must stay empty. See this file's own
  // header for the full reasoning.
  let seeding = false;
  let wanted: string[];
  if (stored.length > 0) {
    wanted = stored.map(record => record.manifestUrl);
  } else if (!hasSeededDefaultPack()) {
    wanted = [DEFAULT_PACK_URL];
    seeding = true;
  } else {
    wanted = [];
  }

  const outcomes: PackInstallOutcome[] = [];
  const installed: InstalledPackRecord[] = [];
  // `anyInstalled` means "the pack is in the registry", which a skip
  // satisfies as much as an install does: the id is present, so the record
  // is worth remembering and — if this was the seeding run — the offer is
  // settled. Only a real failure leaves both undone.
  let anyInstalled = false;
  // Every base worth announcing to the worker, and every file list worth
  // prefetching — filled in beside `installed.push(...)` in both loop
  // branches below, because a pack core already has under its id is still a
  // pack whose bytes are worth caching, same as one this call just fetched.
  const bases: string[] = [];
  const manifests: string[] = [];
  const toPrefetch: { base: string; files: string[] }[] = [];

  let api: ContentApi;
  let registry: PackRegistry;
  try {
    api = buildContentApi();
    registry = rebuildContentRegistry();
  } catch (thrown) {
    // The two calls the per-pack `try` below never covered, and the reason
    // this function's "nothing here may throw" was a comment rather than a
    // fact: `LoadingScene.enter()` fires `void this.boot()`, so a throw here
    // became an unhandled rejection and the menu handover never ran.
    return [
      {
        manifestUrl: '',
        ok: false,
        stage: 'registry',
        message: (thrown as Error)?.message ?? String(thrown),
      },
    ];
  }

  // Both loop branches below need to register a pack's base and its files
  // for prefetch — a pack core already has under its id (the skip branch)
  // is still a pack whose bytes are worth caching, same as one this call
  // just fetched (the install branch), so this is the one copy of that
  // logic. A closure over `bases`/`toPrefetch` rather than a function
  // returning them: both accumulate across every pack in `wanted`, not
  // just the one call.
  const registerForCaching = (manifestUrl: string, manifest: RuntimePackManifest): void => {
    const base = packBaseFor(manifestUrl);
    if (!base) return;
    // A dev pack is the one pack that must never be cached: its author is
    // rebuilding it, and the route's prefix match would freeze it at whatever
    // build installed first — this function's own comment below, read the
    // other way round. `forgetPack` is for the author who installed a
    // localhost pack before this rule existed and whose worker is still
    // holding that base; nothing else would ever tell it to let go. Not
    // awaited, for the reason the prefetch below is not: no boot may wait on
    // a cache.
    if (isDevPackUrl(manifestUrl)) {
      void forgetPack(base).catch(() => {});
      return;
    }
    bases.push(base);
    // The worker must be told to leave this URL alone, or the route's prefix
    // match claims it and the pack is frozen at whatever build installed
    // first — see `seams/packRoute.ts`.
    manifests.push(manifestUrl);
    if (manifest.files && manifest.files.length > 0)
      toPrefetch.push({ base, files: manifest.files });
  };

  /**
   * Fetch a manifest and pin it, so the next boot needs no network.
   *
   * Pinned as the *checked* object re-serialised rather than as the bytes
   * that arrived: what is worth keeping is exactly what passed
   * `checkPackManifest`, and an unknown field surviving the round trip would
   * be a field nothing validated.
   */
  const fetched = async (url: string): Promise<RuntimePackManifest> => {
    const manifest = await fetchPackManifest(url);
    await pinPackManifest(url, JSON.stringify(manifest));
    return manifest;
  };

  /**
   * The same fetch for a pack its author is still writing: no pin read on the
   * way in, no pin written on the way out, and the HTTP cache bypassed.
   *
   * The pin exists so a published pack boots with no request at all. Applied
   * to a pack being served out of somebody's `dist/`, that property is the bug
   * — the author rebuilds, reloads, and is handed the manifest they had
   * before. `bypassCache` is the same `no-store` the update check uses and for
   * the same reason: this read's entire job is to notice a change.
   */
  const freshFromHost = (url: string): Promise<RuntimePackManifest> =>
    fetchPackManifest(url, undefined, { bypassCache: true });

  for (const manifestUrl of wanted) {
    try {
      // The pin first, the network second. A pinned pack boots with no request
      // at all, which is what makes it immune to the server moving underneath
      // it — and is also the offline story, now that the manifest is out of
      // the worker's cache-first route.
      const manifest = isDevPackUrl(manifestUrl)
        ? await freshFromHost(manifestUrl)
        : ((await readPinnedPackManifest(manifestUrl)) ?? (await fetched(manifestUrl)));
      // Ahead of `loadPackFromManifest`, so a pack core already has is not
      // re-downloaded, and ahead of any asset registration — see this
      // file's own header.
      if (registry.hasPack(manifest.id)) {
        anyInstalled = true;
        installed.push(recordFor(manifestUrl, manifest));
        outcomes.push({ manifestUrl, ok: true, id: manifest.id, skipped: true });
        registerForCaching(manifestUrl, manifest);
        continue;
      }
      const pack = await loadPackFromManifest(manifest, manifestUrl);
      installRuntimePack(registry, api, pack);
      anyInstalled = true;
      installed.push(recordFor(manifestUrl, manifest));
      outcomes.push({ manifestUrl, ok: true, id: manifest.id });
      registerForCaching(manifestUrl, manifest);
    } catch (thrown) {
      const error = thrown as PackLoadError;
      outcomes.push({
        manifestUrl,
        ok: false,
        stage: error.stage ?? 'import',
        message: error.message,
      });
    }
  }

  // The offer is spent only once it has actually been taken. See this
  // file's own header: marking it on a failed attempt locks a browser out
  // of the default pack permanently, and the retry the banner offers is a
  // reload, which cannot undo it.
  if (seeding && anyInstalled) markDefaultPackSeeded();

  // Only what actually installed is remembered. A URL that failed is not
  // written, so a first run that could not reach the network retries the
  // default next time instead of remembering a pack it never had.
  if (anyInstalled) writeInstalledPacks(installed);

  // The worker needs the bases whether or not anything is prefetched: a chunk
  // fetched mid-match is cached by that route too, which is what makes the
  // prefetch a completeness measure rather than the only path.
  //
  // Always announced, including an empty list: a player who removes their
  // only pack must clear the worker's memory of it too, or `packBases` in
  // `src/sw.ts` holds a base forever — harmless today (`forgetPack` already
  // emptied the cache entries, so the route falls through to the network),
  // but it widens Important 1's stale-persisted-list window from "bounded by
  // this boot" to "unbounded", since nothing ever tells the worker the list
  // shrank.
  announcePackBases(bases, manifests);

  // **Not awaited, deliberately.** This is 4.7MB on the real pack, and the
  // menu handover is the statement after the caller's `await` on this
  // function. Spec §6: "trả sau lưng người chơi thay vì trước mặt". The
  // `catch` is what keeps a rejected prefetch from becoming an unhandled
  // rejection on the boot path — `prefetchPackFiles` counts its own failures
  // and should never reject, and this is the belt that makes that a fact
  // rather than a comment.
  //
  // **`allSettled`, not `all`.** `prefetchPackFiles` made this exact switch
  // one task ago, for its own internal fan-out, on the same reasoning that
  // applies here one level up: `all` rejecting the instant any one pack's
  // promise does would drop every OTHER pack's already-settled report along
  // with it, not just the failing one's — silently, since the whole point of
  // this being fire-and-forget is that nothing is watching. A rejection
  // should never happen (that is what the `prefetchPackFiles` contract
  // promises), so a settled report is synthesized for it rather than
  // omitted: "one report per requested pack" stays true for whatever reads
  // `window.__moba2dPackPrefetch`, and the synthesized report's own numbers
  // say plainly that nothing made it in.
  if (toPrefetch.length > 0) {
    void Promise.allSettled(toPrefetch.map(pack => prefetchPackFiles(pack.base, pack.files)))
      .then(settled => {
        // A plain loop, not `.filter`/`.map`+cast: `Array.prototype.filter`
        // is polyfilled in this project and cannot narrow a type, and this
        // walk needs the matching `toPrefetch[i]` for a rejected entry
        // anyway.
        const reports: PrefetchReport[] = [];
        for (let i = 0; i < settled.length; i++) {
          const outcome = settled[i];
          if (outcome.status === 'fulfilled') {
            reports.push(outcome.value);
            continue;
          }
          const pack = toPrefetch[i];
          reports.push({
            base: pack.base,
            requested: pack.files.length,
            added: 0,
            skipped: 0,
            failed: pack.files.length,
            // Nothing was asked, so nothing came back 404. A synthesized
            // report must not invent the one signal that means "this build is
            // gone from the server" — that would send a player to an update
            // on the strength of a promise that rejected.
            gone: 0,
          });
        }
        publishPrefetchReports(reports);
        // A 404 on a path this pack's own manifest listed is the one stale
        // signal that is evidence rather than inference: the deploy keeps
        // exactly one build, so the build this browser pinned is gone from the
        // host and the missing part can never be fetched. `failed` alone would
        // not do — a dropped connection means "try later" — which is why
        // `prefetchPackFiles` counts the two apart.
        for (const report of reports) {
          if (report.gone === 0) continue;
          const record = installed.find(entry => packBaseFor(entry.manifestUrl) === report.base);
          if (!record) continue;
          notePackProblem({
            id: record.id,
            name: record.name || record.id,
            manifestUrl: record.manifestUrl,
            kind: 'broken',
          });
        }
      })
      .catch(thrown => console.error('[packs] prefetch threw', thrown));
  }

  return outcomes;
}

/**
 * Asks every installed pack's host whether it is still serving the build this
 * browser pinned.
 *
 * **Runs after the menu is up, and blocks nothing.** The pinned pack already
 * works; this only decides whether to offer the player something newer, so it
 * has no business on the boot path — and putting it there would trade the
 * dead-screen risk the whole pinning design exists to remove for a nicety.
 *
 * Its failure mode is silence. A host that cannot be reached is a player on a
 * train, not a broken pack, and a notice saying otherwise would be a lie the
 * player cannot check.
 *
 * ## What counts as "moved on"
 *
 * `buildId` against `buildId`, and nothing else. `version` cannot do this job:
 * it is a number a human bumps and riot's stayed `1.0.0` across dozens of
 * publishes. A record with **no** pinned build id is reported as an update
 * when the host has one — such an install predates build ids, so its entry URL
 * carries none, so nothing stops a cache serving it across a republish. That
 * install is precisely the one the dead-chunk-graph bug happens to, and
 * offering it the update is the point. When neither side has one there is
 * nothing to compare and nothing is said.
 */
export async function checkPackUpdates(): Promise<void> {
  for (const record of readInstalledPacks()) {
    // A dev pack moves on every rebuild and has no pin to update — and the
    // button this notice puts up calls `updatePack`, which pins
    // unconditionally, putting back the very pin boot refused to write.
    // `devPackWatch.ts` is what tells its author a rebuild has landed.
    if (isDevPackUrl(record.manifestUrl)) continue;
    let fresh: RuntimePackManifest;
    try {
      fresh = await fetchPackManifest(record.manifestUrl, undefined, { bypassCache: true });
    } catch {
      // Unreachable, too slow, or serving something that no longer passes the
      // manifest checks. None of that is news about the pinned copy, which is
      // sitting in the cache working.
      continue;
    }
    if (!fresh.buildId || fresh.buildId === record.buildId) continue;
    notePackProblem({
      id: record.id,
      name: fresh.name || record.name || record.id,
      manifestUrl: record.manifestUrl,
      kind: 'update',
    });
  }
}

/**
 * Reports spell ids that an installed pack declared and could not deliver.
 *
 * `GameScene.startGame` loads exactly the kits a match needs and then builds
 * the match from what loaded — an id that did not load falls back to
 * `BasicAttack` in `preset.ts`, deliberately, so a stale loadout slot cannot
 * break a match. What was missing is that a failing *pack* is not a stale
 * slot. `loadSpells` tells the two apart now (a rejection, not a `null`), and
 * this is where that turns into something a player can read.
 *
 * Grouped per pack rather than per spell: "3 chiêu của Liên Minh không tải
 * được" is one thing that happened, and three notices are three copies of the
 * same news with the same single fix.
 *
 * An id belonging to no installed pack is dropped. Core's own spells are not a
 * pack anybody can update, so a notice offering to would be a dead end — if
 * those fail, the app itself is broken, which the service worker owns.
 */
export function notePackSpellFailures(failedIds: readonly string[]): void {
  if (!failedIds || failedIds.length === 0) return;
  const byId = new Map<string, InstalledPackRecord>();
  for (const record of readInstalledPacks()) byId.set(record.id, record);

  const counts = new Map<string, number>();
  for (const qualified of failedIds) {
    const separator = qualified.indexOf(':');
    if (separator <= 0) continue;
    const packId = qualified.slice(0, separator);
    if (!byId.has(packId)) continue;
    counts.set(packId, (counts.get(packId) ?? 0) + 1);
  }

  for (const [packId, missingSpells] of counts) {
    const record = byId.get(packId) as InstalledPackRecord;
    notePackProblem({
      id: record.id,
      name: record.name || record.id,
      manifestUrl: record.manifestUrl,
      kind: 'broken',
      missingSpells,
    });
  }
}

/**
 * Replaces one pack's pinned snapshot with whatever its host is serving now.
 *
 * **Cannot swap the pack in place.** The pinned build's modules have already
 * been evaluated in this page and ES modules evaluate once, so a live swap
 * would leave the old classes running behind a new manifest — the exact
 * mismatch this whole change exists to end. This prepares the ground and
 * answers `true`; the caller reloads.
 *
 * The order is the design. The fetch comes **first**, and nothing is dropped
 * until it has succeeded, because the failure that must not happen is throwing
 * away a working copy and then failing to get a new one — turning "there is an
 * update" into "you now have no pack", on the tap of a button whose whole
 * promise was the opposite. Offline, this changes nothing and says so.
 *
 * Then the old bytes go. Every name under a pack's base is content-hashed
 * except the entry, so once the new manifest is pinned the old chunks are
 * unreachable weight — and leaving them lets the cache answer a request the
 * new graph never makes.
 */
export async function updatePack(manifestUrl: string): Promise<boolean> {
  const stored = readInstalledPacks();
  // A plain loop, not `.find`: this walk needs the index-free "is it here at
  // all" answer and the record together, and the list is three entries long.
  let current: InstalledPackRecord | null = null;
  for (const record of stored) {
    if (record.manifestUrl === manifestUrl) current = record;
  }
  if (!current) return false;

  let fresh: RuntimePackManifest;
  try {
    fresh = await fetchPackManifest(manifestUrl, undefined, { bypassCache: true });
  } catch {
    return false;
  }

  const base = packBaseFor(manifestUrl);
  if (base) await forgetPack(base);
  await pinPackManifest(manifestUrl, JSON.stringify(fresh));

  const next: InstalledPackRecord[] = [];
  for (const record of stored) {
    next.push(record.manifestUrl === manifestUrl ? recordFor(manifestUrl, fresh) : record);
  }
  writeInstalledPacks(next);
  clearPackProblem(manifestUrl);
  return true;
}

/**
 * Updates several packs, and **one at a time on purpose**.
 *
 * `updatePack` above is a read-modify-write of the installed list: it reads
 * every record, replaces one, and writes them all back. Two of those in flight
 * together both read the same snapshot and the second write puts back the
 * first's stale record — a pack that reported success and did not move, which
 * is the worst possible outcome for an update button. So this is a `for` loop
 * with an `await` in it and not `Promise.all`, and that is not a style
 * preference.
 *
 * Answers how many actually moved, so the caller can tell "nothing to do" from
 * "the network refused" and reload only when something changed.
 */
export async function updatePacks(manifestUrls: readonly string[]): Promise<number> {
  let updated = 0;
  for (const manifestUrl of manifestUrls) {
    if (await updatePack(manifestUrl)) updated += 1;
  }
  return updated;
}

/**
 * Installs one pack into the live registry, without a reload — spec §5.2.
 *
 * Takes the manifest rather than fetching it, because the caller has already
 * fetched it: spec §3 splits the fetch from the import precisely so a player
 * can be shown the origin in between, and a function that did both would put
 * that screen back inside the same call it exists to interrupt.
 *
 * Everything after this point is what `installRuntimePacks` does per pack,
 * minus the loop: the same duplicate-id skip, the same registry, the same
 * store write, the same base announcement and prefetch — and, on a real
 * (non-skipped) install, the same `markDefaultPackSeeded()` this file's own
 * header explains under "two writers of the installed list".
 */
export async function installPackNow(
  manifestUrl: string,
  manifest: RuntimePackManifest
): Promise<PackInstallOutcome> {
  try {
    const registry = contentRegistry();
    if (registry.hasPack(manifest.id)) {
      return { manifestUrl, ok: true, id: manifest.id, skipped: true };
    }
    const pack = await loadPackFromManifest(manifest, manifestUrl);
    installRuntimePack(registry, buildContentApi(), pack);

    // Pinned here, at the moment of installing, so the next boot needs no
    // network to know what this pack is. The caller fetched this manifest to
    // show the player an origin; that same checked object is what gets kept.
    await pinPackManifest(manifestUrl, JSON.stringify(manifest));

    const stored = readInstalledPacks();
    // A plain loop, not `.filter` — see CLAUDE.md.
    const next: InstalledPackRecord[] = [];
    for (const record of stored) {
      if (record.manifestUrl !== manifestUrl) next.push(record);
    }
    next.push(recordFor(manifestUrl, manifest));
    writeInstalledPacks(next);
    // The player has just made their own choice of pack, by URL — the
    // automatic offer this flag guards is spent either way. Without this,
    // a browser whose first boot could not reach `DEFAULT_PACK_URL` (the
    // flag stays `false` — see this file's own header) installs a pack by
    // hand, later removes it, and the next boot re-seeds a default the
    // player never asked for: `installRuntimePacks()` sees an empty stored
    // list and an unset flag and reads that exactly like a browser that has
    // never run this game. See `installedPackStore.ts`'s own header —
    // "Seeding the default on both makes an uninstall impossible to keep."
    // `installRuntimePacks()` is the other writer of the installed list and
    // marks this same flag on its own successful seed; this is the second.
    markDefaultPackSeeded();

    const base = packBaseFor(manifestUrl);
    if (base) {
      // Every base, not just this one: the message replaces the worker's whole
      // list, so sending one would drop the packs installed at boot.
      const bases: string[] = [];
      const manifests: string[] = [];
      for (const record of next) {
        const recordBase = packBaseFor(record.manifestUrl);
        if (recordBase) {
          bases.push(recordBase);
          manifests.push(record.manifestUrl);
        }
      }
      announcePackBases(bases, manifests);
      if (manifest.files && manifest.files.length > 0) {
        void prefetchPackFiles(base, manifest.files).catch(() => {});
      }
    }
    return { manifestUrl, ok: true, id: manifest.id, icon: resolvePackIcon(manifest, manifestUrl) };
  } catch (thrown) {
    const error = thrown as PackLoadError;
    return { manifestUrl, ok: false, stage: error.stage ?? 'import', message: error.message };
  }
}

/**
 * What the background prefetch did, on a global.
 *
 * Same reasoning as `packBanner.ts`'s `__moba2dPackInstall`, and the same bill
 * already paid once: an install whose only voice was `console.warn` reported
 * itself green through a Playwright run that had no way to hear it. An
 * offline check in particular cannot be written at all without a signal for
 * "the prefetch has finished" — the alternative is a sleep, which is a check
 * that passes on a slow machine by accident.
 */
const PACK_PREFETCH_GLOBAL = '__moba2dPackPrefetch';

function publishPrefetchReports(reports: PrefetchReport[]): void {
  (globalThis as Record<string, unknown>)[PACK_PREFETCH_GLOBAL] = reports;
}
