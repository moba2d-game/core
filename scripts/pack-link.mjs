#!/usr/bin/env node
/**
 * `npm run pack:link -- ../lol` / `npm run pack:unlink -- lol`
 *
 * Wires a content pack sitting beside this checkout into it, in both
 * directions, so `npm run dev` serves the pack from source with HMR and the
 * pack's own tests run against the core next to them.
 *
 * ## Who this is for, and who it is not for
 *
 * It is for a checkout that has core *and* a pack in it — this monorepo, or
 * anyone who cloned both. That is the narrow case. Almost nobody writing a
 * pack has a copy of core: they scaffold a repository with `moba2d-pack-new`
 * and install their build into a hosted copy of the game, which is what
 * `scripts/pack-serve.mjs` exists for. Reach for that one first; this is the
 * shortcut available only when both halves are on the same disk.
 *
 * ## Why two links
 *
 * Because both directions were broken, and only one of them was obvious.
 *
 *   - **core -> pack.** `scripts/installed-packs.mjs` answers "which packs
 *     does this checkout have" by reading `node_modules/@moba2d/`, on purpose:
 *     a pack is a package, and that reading survives the pack becoming its own
 *     repository. A pack in a sibling directory is not in there, so core's dev
 *     server cannot see it at all. The link is exactly the shape npm's own
 *     workspace linking produces, so nothing downstream needs to know.
 *   - **pack -> core.** The quieter one. A scaffolded pack declares
 *     `@moba2d/core` as `github:moba2d-game/core#main`, so
 *     `node_modules/@moba2d/core` inside the pack is a *copy npm fetched* —
 *     which means editing core here and running the pack's tests tests the
 *     published core, not the one just edited, and says nothing about it.
 *     That copy is moved aside rather than deleted, so `pack:unlink` puts it
 *     back with no network.
 *
 * ## What it costs
 *
 * `src/generated/installedPacks.ts` is a tracked file, and linking regenerates
 * it — so while a pack is linked, this checkout has a real diff. That is the
 * honest state (`npm run packs:check` in `verify` exists to make the file and
 * the filesystem agree) and the reason `pack:unlink` exists rather than a
 * `.gitignore` entry. `npm install` may also drop the symlink; re-running this
 * is the fix, which is why it is safe to run twice.
 *
 * **And core's own suite assumes a core-only checkout.** Eight tests across
 * four files read the shape of a checkout with no optional pack in it —
 * `BUNDLED_PACK_ID` is `reference` and bare ids resolve against it, exactly
 * one pack is installed, the shop stocks core's items and no others. Link any
 * pack and all four go red, having found precisely what they say they check.
 * Nothing here can fix that from this side: the tests are right about the
 * checkout they were written for, and making them right about both is a
 * change to four unrelated test files, not to a linking script. So this
 * prints the fact rather than letting someone meet it as unexplained red.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { devLinkedPacks } from './lib/devLinks.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const coreRootDefault = resolve(dirname(scriptPath), '..');

const SCOPE = '@moba2d';
const PACKAGE_PREFIX = 'content-';

/**
 * The two files `scripts/generate-installed-packs.mjs` requires before it will
 * name a pack in the barrel. Checked here, by path, so a pack whose layout
 * drifted fails with its own name and the missing file in the message —
 * rather than as an unresolved specifier in `tsc`'s output three steps later.
 */
const REQUIRED = ['pack.ts', join('generated', 'assetManifest.ts')];

/** Where the npm-installed core is parked while a link stands in its place. */
const ASIDE = '.core-npm';

/**
 * Written beside the link with the linked core's path in it, read by the
 * pack's own `scripts/pack-core-link.mjs`. An `npm install` (or `bun
 * install`) in the pack replaces the pack->core symlink with the registry/git
 * copy and leaves everything else in the scope directory alone — so this file
 * outliving the symlink is how the pack detects the stomp and can print the
 * exact repair, instead of the author meeting it as typecheck errors against
 * an old core. Nobody remembers "an install drops the link"; this remembers
 * for them.
 */
const MARKER = '.core-link-target';

/**
 * Packs that are core's own and are never linked or unlinked by this script.
 *
 * `scripts/installed-packs.mjs` keeps the same set for the same reason: the
 * reference pack is core's own content, `src/content/install.ts` imports it
 * unconditionally, and npm's workspace link makes
 * `node_modules/@moba2d/content-reference` a symlink like any other. Without
 * this, "every linked content-* package" swept it up and `--all` unlinked the
 * one pack that is never optional — found by running it.
 */
const CORE_OWN = new Set(['reference']);

/** `@moba2d/content-lol` -> `lol`. The pack's local name, stated once. */
const localName = packageName => packageName.slice(`${SCOPE}/${PACKAGE_PREFIX}`.length);

async function readPackageName(dir) {
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`${dir} has no package.json — is that the pack's root?`);
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (cause) {
    throw new Error(`${manifestPath} is not valid JSON: ${cause.message}`);
  }
  const name = manifest.name ?? '';
  if (!name.startsWith(`${SCOPE}/${PACKAGE_PREFIX}`)) {
    throw new Error(
      `${dir} declares itself "${name}", not a ${SCOPE}/${PACKAGE_PREFIX}* package — ` +
        `only a content pack can be linked.`
    );
  }
  return name;
}

/**
 * Replaces `path` with a symlink to `target`, whatever was there before.
 *
 * `junction` on Windows: a plain directory symlink needs a privilege an
 * ordinary account does not have, and a junction needs none.
 */
async function linkTo(path, target) {
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { recursive: true, force: true });
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * Core's bins, reachable from inside the pack.
 *
 * npm writes `node_modules/.bin` shims at *install* time, from the bin list
 * core declared on the day of that install. A dev link replaces the installed
 * copy of core with a symlink and never touches `.bin`, so every bin core has
 * added since — `moba2d-perf-scan`, `moba2d-duty-scan`, `moba2d-perf-guard`,
 * `moba2d-shoot-vfx`, `moba2d-reach-scan` — resolved to **nothing** in a linked
 * checkout. `npx moba2d-perf-scan` inside a pack went to the public registry
 * and came back `404`, which is a confusing way to be told a tool exists three
 * directories away. Shipping a bin was never enough on its own; this is the
 * other half.
 *
 * Written **relative** to `../@moba2d/core`, so the shim follows whatever that
 * name currently resolves to rather than pinning the absolute path of the core
 * checkout that happened to be linked when it was created — an unlink then
 * leaves the pack running the npm copy's tools, not a stale checkout's.
 */
async function linkBins(pack, core) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(core, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  const bins = manifest.bin ?? {};
  const written = [];
  for (const [name, target] of Object.entries(bins)) {
    const absolute = join(core, target.replace(/^\.\//, ''));
    if (!existsSync(absolute)) continue;
    // A shim is only useful if the file behind it can be executed; a script
    // added with a plain redirect arrives 644 and fails with EACCES.
    await chmod(absolute, 0o755).catch(() => {});
    const shim = join(pack, 'node_modules', '.bin', name);
    await mkdir(dirname(shim), { recursive: true });
    await rm(shim, { force: true });
    await symlink(join('..', SCOPE, 'core', target.replace(/^\.\//, '')), shim, 'file');
    written.push(name);
  }
  return written;
}

/** Whether `path` exists and is a symlink — the two questions asked together. */
async function isLink(path) {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Links `packDir` into `coreRoot`, and `coreRoot` back into `packDir`.
 *
 * Idempotent on purpose: `npm install` in either half can drop a symlink, so
 * re-running this is the ordinary repair and must not, on the second run,
 * mistake the link it made itself for an npm-installed copy worth parking.
 */
export async function linkPack({ coreRoot = coreRootDefault, packDir }) {
  const pack = resolve(packDir);
  const core = resolve(coreRoot);
  const packageName = await readPackageName(pack);
  if (CORE_OWN.has(localName(packageName))) {
    throw new Error(`${packageName} is core's own pack — it is installed already, never linked.`);
  }

  for (const file of REQUIRED) {
    if (!existsSync(join(pack, file))) {
      throw new Error(
        `${packageName} has no ${file} — core's pack barrel imports it, so the ` +
          `link would resolve to nothing. Run the pack's own \`npm run build\` first ` +
          `if it is a generated file.`
      );
    }
  }

  const name = localName(packageName);

  // pack -> core. Done first: it is the one with something to preserve, and a
  // failure here should not leave core already pointing at a pack whose own
  // dependency is still the published copy.
  const coreInPack = join(pack, 'node_modules', SCOPE, 'core');
  const aside = join(pack, 'node_modules', SCOPE, ASIDE);
  if (existsSync(coreInPack) && !(await isLink(coreInPack)) && !existsSync(aside)) {
    await mkdir(dirname(aside), { recursive: true });
    await rename(coreInPack, aside);
  }
  await linkTo(coreInPack, core);
  await writeFile(join(pack, 'node_modules', SCOPE, MARKER), `${core}\n`);
  await linkBins(pack, core);

  // core -> pack.
  await linkTo(join(core, 'node_modules', SCOPE, `${PACKAGE_PREFIX}${name}`), pack);

  return name;
}

/**
 * Undoes `linkPack`. `packDir` is optional: without it only core's side is
 * unlinked, which is all that is knowable when the caller has a name and not
 * a path.
 */
export async function unlinkPack({ coreRoot = coreRootDefault, name, packDir }) {
  if (CORE_OWN.has(name)) return;
  const core = resolve(coreRoot);
  await rm(join(core, 'node_modules', SCOPE, `${PACKAGE_PREFIX}${name}`), {
    recursive: true,
    force: true,
  });

  if (!packDir) return;
  const pack = resolve(packDir);
  const coreInPack = join(pack, 'node_modules', SCOPE, 'core');
  const aside = join(pack, 'node_modules', SCOPE, ASIDE);
  if (await isLink(coreInPack)) await rm(coreInPack, { recursive: true, force: true });
  if (existsSync(aside)) await rename(aside, coreInPack);
  await rm(join(pack, 'node_modules', SCOPE, MARKER), { force: true });
}

/**
 * Which packs this script linked into `coreRoot`, by local name.
 *
 * Delegates "which links are mine" to `lib/devLinks.mjs`, which answers it by
 * where the link points rather than by what it is called — see that file for
 * why a name list is the wrong shape for this question.
 */
export async function linkedPacks(coreRoot = coreRootDefault) {
  return devLinkedPacks(coreRoot).map(pack => pack.name);
}

// See `scripts/check-seams.mjs`'s header: reached through a `node_modules/.bin`
// symlink, `process.argv[1]` stays the symlink path while `scriptPath` is
// already resolved, and a plain comparison silently never matches.
function invokedDirectly() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(resolve(invoked)) === scriptPath;
  } catch {
    return resolve(invoked) === scriptPath;
  }
}

if (invokedDirectly()) {
  const argv = process.argv.slice(2);
  const unlinking = argv.includes('--unlink');
  const all = argv.includes('--all');
  const targets = argv.filter(token => !token.startsWith('--'));

  // `npm run links:check`, and the first step of `npm run verify`.
  //
  // `packs:check` cannot do this job: while the link is still in place the
  // barrel and the filesystem genuinely agree, so it passes — the
  // disagreement only shows up on a machine that has already pulled the
  // mistake. The question here is "is anything linked at all", asked
  // immediately before the command someone runs before committing.
  //
  // Running *first* is half the value. Four core test files assume a
  // core-only checkout (`BUNDLED_PACK_ID` is `reference`, one pack is
  // installed, the shop stocks core's items) and go red under any link, where
  // they read as "the pack broke core" rather than "you are still linked".
  // Failing before them means nobody has to make that inference.
  if (argv.includes('--check')) {
    const linked = devLinkedPacks(process.cwd());
    if (linked.length === 0) {
      console.log('links ok: no pack is linked for development');
      process.exit(0);
    }

    // A link whose target is gone gets its own message, because it is a
    // different mistake with a different repair — and because it is the state
    // nothing else in the gate describes. `packs:check` stops the run one step
    // later, but says "the barrel is out of date, run `packs:generate`", which
    // would drop the pack instead of telling anyone a directory moved; running
    // vitest directly says `Failed to load url @moba2d/content-<name>/pack`
    // about every test file in the suite. Both are true and neither is the
    // fact. See `lib/devLinks.mjs`'s header for how this was met.
    const dangling = linked.filter(pack => pack.missing);
    const live = linked.filter(pack => !pack.missing);

    if (dangling.length) {
      console.error(`\n  Broken pack link — the target is gone:`);
      for (const pack of dangling) console.error(`    ${pack.name} -> ${pack.target}  (missing)`);
      console.error(`\n  The pack was moved, renamed or deleted. Until this is settled,`);
      console.error(`  src/generated/installedPacks.ts names a package nothing can resolve,`);
      console.error(`  and every test file fails to collect. Two ways out:`);
      console.error(`\n    npm run pack:link -- <new path to the pack>   re-point it`);
      console.error(`    npm run pack:unlink -- --all                  drop it\n`);
    }

    if (live.length) {
      console.error(`\n  Linked for development: ${live.map(pack => pack.name).join(', ')}`);
      for (const pack of live) console.error(`    ${pack.name} -> ${pack.target}`);
      console.error(
        `\n  src/generated/installedPacks.ts names ${live.length > 1 ? 'them' : 'it'} and is tracked —`
      );
      console.error(`  committing that gives everyone else an unresolvable import.`);
      console.error(`\n  Run \`npm run pack:unlink -- --all\` first.\n`);
    }
    process.exit(1);
  }

  const regenerate = () => {
    const result = spawnSync('npm', ['run', 'packs:generate'], {
      cwd: coreRootDefault,
      stdio: 'inherit',
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  };

  try {
    if (unlinking) {
      const names = all ? await linkedPacks() : targets;
      if (names.length === 0) {
        console.error('\n  usage: npm run pack:unlink -- <name> | --all\n');
        process.exit(2);
      }
      for (const name of names) {
        // A name may also be a path the caller still has; both are accepted,
        // and only the path form can restore the pack's own `@moba2d/core`.
        const asPath = existsSync(resolve(name)) ? resolve(name) : undefined;
        await unlinkPack({
          name: asPath ? localName(await readPackageName(asPath)) : name,
          packDir: asPath,
        });
        console.log(`  unlinked ${name}`);
      }
      regenerate();
    } else {
      if (targets.length === 0) {
        console.error('\n  usage: npm run pack:link -- <path to pack> [<path> …]\n');
        process.exit(2);
      }
      for (const target of targets) {
        const name = await linkPack({ packDir: resolve(target) });
        console.log(`  linked ${name} <- ${resolve(target)}`);
      }
      regenerate();
      console.log(`\n  Next: npm run dev`);
      console.log(`\n  While linked:`);
      console.log(`    - src/generated/installedPacks.ts names the pack, and it is tracked`);
      console.log(`    - core's own \`npm test\` expects a core-only checkout, so four`);
      console.log(`      files go red until you unlink`);
      console.log(`    - \`npm run verify\` refuses to start (links:check)`);
      console.log(`  Run \`npm run pack:unlink -- --all\` before committing.\n`);
    }
  } catch (error) {
    console.error(`\n  ${error.message}\n`);
    process.exit(1);
  }
}
