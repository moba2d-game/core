#!/usr/bin/env node
/**
 * How much of the time an ability's own power state is up.
 *
 *   moba2d-duty-scan                 # core's packs, worst first
 *   moba2d-duty-scan ../lol/spells   # one tree
 *   moba2d-duty-scan --max 20        # hold a line
 *
 * ## Why this exists
 *
 * `checkCooldowns` caps how long an ability makes you wait, because this game
 * is a practice room. Twenty-four cooldowns were cut to fit that cap — and
 * cutting a cooldown without touching the *duration* raises how much of the
 * time the effect is up, mechanically, without anyone deciding it should. One
 * ability went from 70% up to 87.5%. Nothing was permanently on, but that is
 * the direction it moves, and the number nobody was looking at is the one that
 * decides whether an ability is an ability or a stat with a keypress.
 *
 * The pass that followed found four inflated abilities. Reading the files by
 * hand had found two of them; this found the other two, which is the whole
 * argument for it existing.
 *
 * ## It reports, it does not gate — the same call `perf-scan` makes
 *
 * A duty cycle is a decision. Sixty percent is generous for an ultimate and
 * miserly for a passive stance, and some of the highest numbers here are not
 * power states at all but *windows* — how long you have to spend an empowered
 * attack — where being generous is the point. So this ranks and exits 0, and
 * `--max` is there for a tree that wants to hold a line.
 *
 * ## Three things a naive duration/cooldown ratio gets wrong
 *
 * All three were found by reading the files this ranked highest, which is the
 * only way any of them would have been found:
 *
 *  - **The cooldown that counts is the one bound to `coolDown`.** Not whichever
 *    constant has COOLDOWN in its name: one ability's is a 700ms *internal*
 *    proc timer and another's is a cooldown *refund*. Ranked by name alone they
 *    read as 857% and 625% up, and both are fine.
 *  - **`cooldown: { startAt: 'end' }` means the clock starts when the effect
 *    ends**, so the cycle is duration + cooldown. Two ultimates read as 180%
 *    and 150% up — impossible numbers — and are 64% and 60%.
 *  - **A duration on a debuff is not the caster's uptime.** A four-second
 *    poison on a four-second cooldown is not an ability that is always on; it
 *    is an ability that is always available. Only durations that land on the
 *    caster count.
 */
import ts from 'typescript';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packRootFrom } from './lib/packRoot.mjs';

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const walkAst = (node, visit) => {
  visit(node);
  ts.forEachChild(node, child => walkAst(child, visit));
};

/**
 * A number, following identifiers through the file's own constants and doing
 * the arithmetic — `8 * SECOND` is a duration, not an unknown. No checker and
 * no tsconfig: nothing here has to resolve a name across a file boundary.
 */
const numericValueOf = (expression, constants, seen = new Set()) => {
  if (!expression) return null;
  let node = expression;
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) node = node.expression;
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ''));
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return null; // a constant defined in terms of itself
    seen.add(node.text);
    return numericValueOf(constants.get(node.text), constants, seen);
  }
  if (ts.isBinaryExpression(node)) {
    const left = numericValueOf(node.left, constants, seen);
    const right = numericValueOf(node.right, constants, seen);
    if (left === null || right === null) return null;
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.AsteriskToken:
        return left * right;
      case ts.SyntaxKind.PlusToken:
        return left + right;
      case ts.SyntaxKind.MinusToken:
        return left - right;
      case ts.SyntaxKind.SlashToken:
        return right === 0 ? null : left / right;
      default:
        return null;
    }
  }
  return null;
};

/** `this.owner`, `owner`, `this.caster` — whoever cast it. */
const isCaster = node =>
  !!node &&
  ((ts.isPropertyAccessExpression(node) && /^(owner|caster)$/.test(node.name.text)) ||
    (ts.isIdentifier(node) && /^(owner|caster)$/.test(node.text)));

/** Nothing shorter than this is a state worth calling "up". */
const MIN_DURATION_MS = 500;

export function scanSource(source, fileName = 'duty.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const constants = new Map();
  walkAst(sourceFile, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      constants.set(node.name.text, node.initializer);
    }
  });

  let cooldownMs = null;
  let startAt = 'start';
  walkAst(sourceFile, node => {
    if (
      ts.isPropertyDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'coolDown'
    ) {
      const ms = numericValueOf(node.initializer, constants);
      if (ms !== null) cooldownMs = ms;
    }
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'startAt' &&
      ts.isStringLiteral(node.initializer)
    ) {
      startAt = node.initializer.text;
    }
  });
  if (cooldownMs === null || cooldownMs <= 0) return null;

  // What lands on the caster: `new Something(DURATION, source, this.owner)`.
  const durations = new Map();
  walkAst(sourceFile, node => {
    if (!ts.isNewExpression(node) || !node.arguments || node.arguments.length < 3) return;
    if (!isCaster(node.arguments[2])) return;
    const first = node.arguments[0];
    const ms = numericValueOf(first, constants);
    if (ms === null || ms < MIN_DURATION_MS) return;
    const name = ts.isIdentifier(first) ? first.text : `${ms}ms`;
    if ((durations.get(name) ?? 0) < ms) durations.set(name, ms);
  });
  // A toggle or a channel states its own length instead of wearing a buff.
  walkAst(sourceFile, node => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'maxDurationMs') {
      const ms = numericValueOf(node.initializer, constants);
      if (ms !== null && ms >= MIN_DURATION_MS) durations.set('maxDurationMs', ms);
    }
  });
  if (durations.size === 0) return null;

  const [name, durationMs] = [...durations].sort((a, b) => b[1] - a[1])[0];
  const cycleMs = startAt === 'end' ? durationMs + cooldownMs : cooldownMs;
  return { name, durationMs, cooldownMs, startAt, uptime: durationMs / cycleMs };
}

export function scanTree(root) {
  const rows = [];
  const walk = dir => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts') && !path.includes('.test.')) {
        const row = scanSource(readFileSync(path, 'utf8'), path);
        if (row) rows.push({ file: path, ...row });
      }
    }
  };
  walk(root);
  return rows;
}

/**
 * What to scan when nobody said.
 *
 * Two answers, because since `pack-link` started writing `.bin` shims there are
 * two callers. Run from core it means core's own tree plus every pack linked
 * beside it, discovered from the links themselves — core does not get to know
 * any pack's name (`tests/content/vocabularyBoundary.test.ts`), and a
 * hardcoded list was also silently wrong from anywhere else. Run from a pack —
 * through the bin, which is the whole reason this ships as one — it means
 * *that* pack, found by walking up to the nearest `package.json` that depends
 * on `@moba2d/core` rather than by counting `..` segments or looking for a
 * directory called `packs`: a separated pack repository has neither.
 */
function packTrees(packRoot) {
  return ['spells', 'monsters'].map(dir => join(packRoot, dir)).filter(existsSync);
}

function linkedPackTrees() {
  const linked = join(CORE, 'node_modules', '@moba2d');
  if (!existsSync(linked)) return [];
  return readdirSync(linked)
    .filter(name => name.startsWith('content-'))
    .flatMap(name => packTrees(join(linked, name)));
}

function defaultRoots(coreTrees) {
  let packRoot = null;
  try {
    packRoot = packRootFrom(process.cwd());
  } catch {
    // Core's own repository, or somewhere with no pack above it.
    packRoot = null;
  }
  if (packRoot) return packTrees(packRoot);
  return [...coreTrees, ...linkedPackTrees()];
}

// `realpathSync`, not a bare `resolve()`: reached through the
// `node_modules/.bin/` symlink, `process.argv[1]` stays the symlink path while
// `import.meta.url` is already resolved, so the two never compare equal and the
// whole block below silently never runs — no output, no error, exit 0. See
// `scripts/check-seams.mjs`'s own header, where this cost a day. It went live
// for all three scans the moment `pack-link` started writing their `.bin`
// shims, so a linked pack could reach them at all.
const scriptPath = fileURLToPath(import.meta.url);
const invokedDirectly = (() => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(resolve(invoked)) === scriptPath;
  } catch {
    return resolve(invoked) === scriptPath;
  }
})();

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  // A flag's *value* is not a path. `--max 20` used to leave "20" in the target
  // list and the scan died trying to read a directory called 20.
  const valueOf = name => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? null : argv[at + 1];
  };
  const consumed = new Set();
  argv.forEach((arg, i) => {
    if (arg.startsWith('--')) consumed.add(i).add(i + 1);
  });
  const targets = argv.filter((arg, i) => !consumed.has(i));
  const max = valueOf('max') === null ? null : Number(valueOf('max'));
  const floor = valueOf('floor') === null ? 0.5 : Number(valueOf('floor'));

  const roots = targets.length ? targets.map(t => resolve(t)) : defaultRoots([]);

  const rows = roots.flatMap(root => scanTree(root)).sort((a, b) => b.uptime - a.uptime);
  const shown = rows.filter(row => row.uptime >= floor);

  console.log(`\nduty-scan: ${rows.length} abilities put a timed state on their own caster\n`);
  console.log('  uptime  duration  cooldown  startAt   ability');
  for (const row of shown) {
    console.log(
      `  ${(row.uptime * 100).toFixed(0).padStart(5)}% ` +
        `${(row.durationMs / 1000).toFixed(1).padStart(8)}s ` +
        `${(row.cooldownMs / 1000).toFixed(1).padStart(8)}s  ` +
        `${row.startAt.padEnd(8)}  ${row.file.replace(/^.*?([^/]+\/spells\/)/, '$1')} (${row.name})`
    );
  }
  if (shown.length === 0) console.log('  nothing at or above the floor.');
  const median = rows.length ? rows[Math.floor(rows.length / 2)].uptime : 0;
  console.log(
    `\n  >=75%: ${rows.filter(r => r.uptime >= 0.75).length}   ` +
      `>=60%: ${rows.filter(r => r.uptime >= 0.6).length}   ` +
      `median ${(median * 100).toFixed(0)}%\n`
  );

  if (max !== null && rows.filter(r => r.uptime >= 0.75).length > max) {
    console.error(`duty-scan: more than ${max} abilities at or above 75% uptime`);
    process.exit(1);
  }
}
