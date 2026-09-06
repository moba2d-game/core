#!/usr/bin/env node
/**
 * Every shape this codebase has been *measured* paying for, looked for
 * everywhere at once.
 *
 *   node scripts/perf-scan.mjs                 # core's game tree + linked packs
 *   node scripts/perf-scan.mjs ../lol/spells   # anything you point it at
 *   node scripts/perf-scan.mjs --max 0         # exit 1 on any finding (a gate)
 *
 * ## What this is, and what it is not
 *
 * It is **not** a seam (`src/seams/`). A seam bans a shape outright and fails
 * the build, because the shape is always wrong. Nothing here is always wrong:
 * a two-hundred-primitive body is a *decision*, and the right answer is
 * sometimes "yes, that ability is worth it". So this reports and ranks, exits
 * 0 by default, and takes `--max` when a caller wants it to hold a line.
 *
 * ## Every rule below cost a real measurement to learn
 *
 * The numbers in each rule's `why` came off `tests/e2e/measure-frame-cost.mjs`
 * and `tests/e2e/measure-spell-cost.mjs`, on a ten-champion teamfight. They are
 * quoted so nobody has to re-derive them to decide whether a finding is worth
 * acting on — and so a rule that stops being true can be deleted rather than
 * obeyed forever.
 *
 * ## Why the TypeScript compiler, and not the regex this used to be
 *
 * The first version read the source as text. Three agents fixing the ten
 * abilities it produced found three holes in a day, all of which made it
 * report *less* than the truth:
 *
 *  - It could not follow a call. The three most expensive abilities in the game
 *    each put their real cost one call below `draw()` — a `_drawWall()` helper,
 *    a blade imported from a sibling spell, a crescent fanned across nine ribs
 *    — and all three scanned as **zero findings**.
 *  - A loop bound written `const links = 24` inside a method read as one pass,
 *    because the const scan only matched SCREAMING_CASE at module scope.
 *  - Braceless loops were invisible, and `for (const p of this.particles)
 *    circle(...)` unbraced is an entire rule's whole shape.
 *
 * Every one of those is a thing a parser gets right for free, and patching them
 * by hand was three fixes into an unbounded list — a barrel export, a default
 * export, an alias, a helper that lives in core would each have been the next
 * one. `typescript` is already a dependency of core *and* of every pack (they
 * all run `tsc`), so the compiler API costs nothing to adopt and resolves what
 * no amount of regex can: `victim.stopMovement()` to `AttackableUnit.ts`,
 * `PredefinedFilters.canTakeDamageFromTeam` into core, `super.drawPreview`,
 * a loop bound imported from another file. A program over a pack builds in
 * under a second, which is inside a push hook's budget.
 */
import ts from 'typescript';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packRootFrom } from './lib/packRoot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(HERE, '..');

const walk = (dir, out = []) => {
  // A path may be one file — the push guard hands over changed files, and a
  // reader debugging one spell types its path.
  if (statSync(dir).isFile()) return /\.ts$/.test(dir) ? [dir] : [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'generated') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(name) && !/\.d\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
};

/** p5 calls that put pixels on the canvas, as opposed to setting state. */
const PAINTS = new Set([
  'circle', 'ellipse', 'rect', 'arc', 'line', 'triangle', 'quad', 'point',
  'image', 'text', 'vertex', 'curveVertex', 'bezierVertex', 'square',
]);
/** p5 calls that only change state — cheap alone, not in a loop of two hundred. */
const STATE = new Set([
  'fill', 'stroke', 'noFill', 'noStroke', 'strokeWeight', 'textSize', 'textAlign',
  'textStyle', 'tint', 'push', 'pop', 'translate', 'rotate', 'scale',
]);
/** Array methods whose callback is a loop body in everything but name. */
const ITERATORS = new Set(['forEach', 'map', 'filter', 'flatMap', 'reduce', 'some', 'every']);

/** Methods a frame or a tick calls, which is the only place any of this matters. */
const HOT = /^(draw|drawAvatar|drawBody|drawDir|drawBuffs|drawHealthBar|drawFn|update|onUpdate|onDashUpdate)$/;
const isDrawName = name => name.startsWith('draw');

const nameOf = node => {
  if (!node) return null;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
};

/**
 * One program per tsconfig, reused.
 *
 * Building it is the expensive part (~0.9s over a pack, which pulls core in
 * through its own path alias), and every file under one root shares one.
 */
const programs = new Map();
const programFor = startDir => {
  const configPath = ts.findConfigFile(startDir, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) return null;
  if (programs.has(configPath)) return programs.get(configPath);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    // Nothing here reads types, only symbols and syntax, and skipping the lib
    // check is most of the build time.
    skipLibCheck: true,
    noEmit: true,
  });
  const entry = { program, checker: program.getTypeChecker() };
  programs.set(configPath, entry);
  return entry;
};

/**
 * Where a called name is declared, if it is something with a body worth costing.
 *
 * The checker answers this properly when there is one: through an import alias,
 * across a package boundary, up a class hierarchy for a `super` call. Without a
 * program — `scanSource` on a bare string, which is how the tests drive it —
 * it falls back to names declared in the same file, which is all a fixture has.
 */
const declarationOf = (node, ctx) => {
  const target = ts.isPropertyAccessExpression(node.expression)
    ? node.expression.name
    : node.expression;
  if (ctx.checker) {
    let symbol = ctx.checker.getSymbolAtLocation(target);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      // An imported name is an alias; the declaration wanted is what it points at.
      try {
        symbol = ctx.checker.getAliasedSymbol(symbol);
      } catch {
        /* not resolvable — treat as opaque */
      }
    }
    const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (decl && ts.isFunctionLike(decl) && decl.body) return decl;
    return null;
  }
  const local = ctx.locals?.get(nameOf(target));
  return local ?? null;
};

/** Function-ish declarations by name, for the no-program case. */
const localDeclarations = sourceFile => {
  const map = new Map();
  const visit = node => {
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.body) {
      const name = nameOf(node.name);
      if (name && !map.has(name)) map.set(name, node);
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isArrowFunction(node.initializer)) {
      const name = nameOf(node.name);
      if (name && !map.has(name)) map.set(name, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return map;
};

/** A numeric constant, followed through the checker when there is one. */
const numericValue = (node, ctx) => {
  if (!node) return null;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    return node.operator === ts.SyntaxKind.MinusToken
      ? -Number(node.operand.text)
      : Number(node.operand.text);
  }
  let decl = null;
  if (ctx.checker) {
    let symbol = ctx.checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      try {
        symbol = ctx.checker.getAliasedSymbol(symbol);
      } catch {
        /* opaque */
      }
    }
    decl = symbol?.valueDeclaration ?? null;
  } else {
    decl = ctx.constants?.get(nameOf(node)) ?? null;
  }
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
    return numericValue(decl.initializer, { ...ctx, checker: null, constants: null });
  }
  if (decl && ts.isPropertyDeclaration?.(decl) && decl.initializer) {
    return numericValue(decl.initializer, { ...ctx, checker: null, constants: null });
  }
  return null;
};

/** Every `const name = <number>` in the file, for the no-program case. */
const localConstants = sourceFile => {
  const map = new Map();
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isNumericLiteral(node.initializer)) {
      const name = nameOf(node.name);
      if (name && !map.has(name)) map.set(name, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return map;
};

/**
 * How many times a loop runs, when that is knowable.
 *
 * `null` means unknown, and an unknown loop is charged **once** — an
 * underestimate on purpose, so a finding is never an artefact of a guess.
 */
const tripsOf = (node, ctx) => {
  if (ts.isForStatement(node)) {
    const cond = node.condition;
    if (cond && ts.isBinaryExpression(cond)) return numericValue(cond.right, ctx);
    return null;
  }
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    const target = ts.isForOfStatement(node) ? node.expression : null;
    if (target && ts.isArrayLiteralExpression(target)) return target.elements.length;
    return null;
  }
  return null;
};

/**
 * Primitives one call of this body puts on the canvas, loops multiplied out and
 * helpers followed.
 *
 * `seen` is per-branch and put back afterwards, so two sister calls to one
 * helper are both charged while a helper that reaches itself is charged once —
 * a cycle here would hang a tool whose whole promise is that it costs a second.
 */
const costOf = (node, ctx, seen = new Set()) => {
  if (!node) return 0;
  let total = 0;

  const loopBody = (() => {
    if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      return node.statement;
    }
    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) return node.statement;
    return null;
  })();
  if (loopBody) return (tripsOf(node, ctx) ?? 1) * costOf(loopBody, ctx, seen);

  if (ts.isCallExpression(node)) {
    const name = nameOf(node.expression);
    // `.forEach(cb)` and friends: the callback is a loop body in all but name.
    if (
      name &&
      ITERATORS.has(name) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.arguments.length
    ) {
      const cb = node.arguments[0];
      const body = ts.isArrowFunction(cb) || ts.isFunctionExpression(cb) ? cb.body : null;
      const target = node.expression.expression;
      const trips = ts.isArrayLiteralExpression(target) ? target.elements.length : 1;
      return trips * costOf(body, ctx, seen);
    }
    if (name && (PAINTS.has(name) || STATE.has(name))) return 1;
    const decl = declarationOf(node, ctx);
    if (decl) {
      const key = decl.getSourceFile().fileName + ':' + decl.pos;
      if (!seen.has(key)) {
        seen.add(key);
        total += costOf(decl.body, ctx, seen);
        seen.delete(key);
      }
    }
    for (const arg of node.arguments) total += costOf(arg, ctx, seen);
    return total;
  }

  ts.forEachChild(node, child => {
    total += costOf(child, ctx, seen);
  });
  return total;
};

/** Every hot method in a file, with its declaration. */
const hotMethods = sourceFile => {
  const found = [];
  const visit = node => {
    if ((ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) && node.name) {
      const name = nameOf(node.name);
      const body = ts.isMethodDeclaration(node)
        ? node.body
        : ts.isArrowFunction(node.initializer ?? {}) || ts.isFunctionExpression(node.initializer ?? {})
          ? node.initializer.body
          : null;
      if (name && HOT.test(name) && body) found.push({ name, body, node });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

/** Every loop inside a body, shallowly described. */
const loopsIn = body => {
  const loops = [];
  const visit = node => {
    if (
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      loops.push(node.statement);
    }
    if (
      ts.isCallExpression(node) &&
      ITERATORS.has(nameOf(node.expression) ?? '') &&
      node.arguments.length &&
      (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))
    ) {
      loops.push(node.arguments[0].body);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return loops;
};

/** Does any node under `root` satisfy `test`? */
const contains = (root, test) => {
  let hit = false;
  const visit = node => {
    if (hit) return;
    if (test(node)) {
      hit = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  if (root) visit(root);
  return hit;
};

const callsNamed = names => node =>
  ts.isCallExpression(node) && names.has(nameOf(node.expression) ?? '');

export const RULES = [
  {
    id: 'hand-rolled-particles',
    why:
      "a per-instance array painted from inside draw() is a particle system that " +
      "ObjectManager's draw budget cannot ration. DamageOverTime was one: 30 of " +
      "them on a wave took the frame from 4.66ms to 14.29ms, and the ration that " +
      'exists for exactly that was blind to it. Use ParticleSystem (see Speedup).',
    find: ctx => {
      const { source } = ctx;
      // Already one, or already using one — nothing to say.
      if (
        contains(source, n =>
          (ts.isIdentifier(n) && /^(ParticleSystem|PredefinedParticleSystems)$/.test(n.text)) ||
          (ts.isPropertyAccessExpression(n) && /^(ParticleSystem|PredefinedParticleSystems)$/.test(n.name.text))
        )
      ) {
        return [];
      }
      // Painting a loop over an array is ordinary and usually right — a row of
      // marks, a chain of segments. What makes it a *particle system* is that
      // the array is spawned into on a clock and aged out of. Both halves are
      // required; either alone is a shape half the spells use correctly.
      const spawnsWithClock = contains(
        source,
        n =>
          ts.isCallExpression(n) &&
          nameOf(n.expression) === 'push' &&
          n.arguments.some(
            a =>
              ts.isObjectLiteralExpression(a) &&
              a.properties.some(p => /^(age|life|lifeTime|ttl|maxAge)$/.test(nameOf(p.name) ?? ''))
          )
      );
      const agesThem = contains(
        source,
        n =>
          (ts.isBinaryExpression(n) &&
            n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
            /^(age|life|ttl)/.test(nameOf(n.left) ?? '')) ||
          (ts.isPostfixUnaryExpression(n) && /^(age|life|ttl)/.test(nameOf(n.operand) ?? ''))
      );
      if (!spawnsWithClock || !agesThem) return [];
      const out = [];
      for (const method of ctx.methods) {
        if (!isDrawName(method.name)) continue;
        const over = loopsIn(method.body).some(
          body =>
            contains(body, callsNamed(PAINTS)) &&
            contains(body.parent ?? body, n => ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword)
        );
        if (over) {
          out.push(`${method.name}() paints a spawned-and-aged array of its own`);
          break;
        }
      }
      return out;
    },
  },
  {
    id: 'heavy-draw',
    why:
      'p5 costs 6-10x the raw canvas call underneath it, so primitive count is ' +
      'the cost. One pet at ~200 primitives a frame measured 388us a call and ' +
      '2.1% of CPU on its own. Cut the count, or bake the static half the way ' +
      'Fountain.bakeArt does.',
    find: ctx => {
      const out = [];
      for (const method of ctx.methods) {
        if (!isDrawName(method.name)) continue;
        const cost = costOf(method.body, ctx, new Set([method.body.getSourceFile().fileName + ':' + method.node.pos]));
        if (cost >= 60) {
          out.push({ note: `${method.name}() is ~${cost} p5 calls per frame`, weight: cost });
        }
      }
      return out;
    },
  },
  {
    id: 'blend-mode-per-instance',
    why:
      'blendMode() sets globalCompositeOperation, which additive-blends every ' +
      'primitive after it and cannot batch. Two switches per instance per frame ' +
      'is two per *body* once an AoE puts the effect on a whole wave.',
    find: ctx => {
      // Additive blending is legitimate and most casts use it once, on one
      // object, for a moment. It becomes a cost when the switch is paid **per
      // body**: an effect riding a unit is drawn once per wearer, so an AoE
      // that puts it on a wave pays for it forty times a frame.
      const perTarget = contains(
        ctx.source,
        n =>
          (ts.isPropertyAccessExpression(n) &&
            n.expression.kind === ts.SyntaxKind.ThisKeyword &&
            n.name.text === 'targetUnit') ||
          (ts.isHeritageClause(n) && /Buff\b/.test(n.getText()))
      );
      const out = [];
      const isBlend = callsNamed(new Set(['blendMode']));
      for (const method of ctx.methods) {
        if (!isDrawName(method.name) || !contains(method.body, isBlend)) continue;
        const inLoop = loopsIn(method.body).some(body => contains(body, isBlend));
        if (!perTarget && !inLoop) continue;
        let n = 0;
        const count = node => {
          if (isBlend(node)) n++;
          ts.forEachChild(node, count);
        };
        count(method.body);
        out.push(
          `${method.name}() switches blendMode ${n}x ${inLoop ? 'inside a loop' : 'per wearer'}`
        );
      }
      return out;
    },
  },
  {
    id: 'alloc-in-draw-loop',
    why:
      'an allocation inside a per-frame loop is garbage at 60fps, and GC pauses ' +
      'are what a fight feels as a stutter rather than as a lower average.',
    find: ctx => {
      const out = new Set();
      for (const method of ctx.methods) {
        for (const body of loopsIn(method.body)) {
          const kinds = [];
          if (contains(body, n => ts.isNewExpression(n))) kinds.push('new');
          if (contains(body, n => ts.isTemplateExpression(n))) kinds.push('template string');
          if (contains(body, n => ts.isArrayLiteralExpression(n) && n.elements.length > 0)) {
            kinds.push('array literal');
          }
          if (kinds.length) out.add(`${method.name}() allocates in a loop (${kinds.join(', ')})`);
        }
      }
      return [...out];
    },
  },
  {
    id: 'query-in-draw',
    why:
      'queryObjects is the single biggest simulation cost in a teamfight (~7% of ' +
      'CPU, ~37 calls a tick). Issuing one from draw() runs it at frame rate on ' +
      'top of that, and a draw has no business asking the world a question.',
    find: ctx =>
      ctx.methods
        .filter(m => isDrawName(m.name) && contains(m.body, callsNamed(new Set(['queryObjects']))))
        .map(m => `${m.name}() calls queryObjects`),
  },
  {
    id: 'text-in-draw-loop',
    why:
      'text() is the most expensive p5 primitive there is - 2.275us against 0.30 ' +
      'for the raw fillText, the worst ratio of any call measured. In a loop it ' +
      'is the first thing to move off p5 or out of the frame.',
    find: ctx => {
      const out = new Set();
      const isText = callsNamed(new Set(['text']));
      for (const method of ctx.methods) {
        if (!isDrawName(method.name)) continue;
        if (loopsIn(method.body).some(body => contains(body, isText))) {
          out.add(`${method.name}() draws text in a loop`);
        }
      }
      return [...out];
    },
  },
];

const runRules = ctx => {
  const out = [];
  for (const rule of RULES) {
    for (const found of rule.find(ctx)) {
      const { note, weight = 0 } = typeof found === 'string' ? { note: found } : found;
      out.push({ rule: rule.id, note, weight });
    }
  }
  return out;
};

/**
 * Every finding in one source file, without touching the disk.
 *
 * The unit a test drives. Parsed standalone, so there is no checker and calls
 * resolve only to names declared in the same text — which is all a fixture has,
 * and is exactly the gap `scanTree` closes with a real program.
 */
export function scanSource(source, fileName = 'inline.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const methods = hotMethods(sourceFile);
  if (methods.length === 0) return [];
  return runRules({
    source: sourceFile,
    methods,
    checker: null,
    locals: localDeclarations(sourceFile),
    constants: localConstants(sourceFile),
  });
}

/** Every finding under `root`, each tagged with the file it came from. */
export function scanTree(root, labelFrom = resolve(CORE, '..')) {
  const out = [];
  if (!existsSync(root)) return out;
  const files = walk(root);
  if (files.length === 0) return out;
  const built = programFor(dirname(files[0]));
  for (const file of files) {
    const sourceFile = built?.program.getSourceFile(file);
    if (!sourceFile) {
      // Outside the program (not in its tsconfig) — still worth scanning, just
      // without cross-file resolution.
      for (const finding of scanSource(readFileSync(file, 'utf8'), file)) {
        out.push({ ...finding, file: relative(labelFrom, file) });
      }
      continue;
    }
    const methods = hotMethods(sourceFile);
    if (methods.length === 0) continue;
    const findings = runRules({
      source: sourceFile,
      methods,
      checker: built.checker,
      locals: null,
      constants: null,
    });
    for (const finding of findings) out.push({ ...finding, file: relative(labelFrom, file) });
  }
  return out;
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
  // A flag's *value* is not a path: `--max 20` used to leave "20" in the target
  // list, and the scan then died trying to read a directory called 20.
  const consumed = new Set();
  argv.forEach((arg, i) => {
    if (arg.startsWith('--')) consumed.add(i).add(i + 1);
  });
  const targets = argv.filter((arg, i) => !consumed.has(i));
  const maxArg = argv.indexOf('--max');
  const max = maxArg === -1 ? null : Number(argv[maxArg + 1]);

  const roots = targets.length
    ? targets.map(t => resolve(t))
    : defaultRoots([join(CORE, 'src/game/gameObject')]);

  const findings = roots.flatMap(root => scanTree(root));
  const byRule = new Map();
  for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);

  console.log(`\nperf-scan: ${findings.length} finding(s) across ${roots.length} tree(s)\n`);
  for (const rule of RULES) {
    console.log(`   ${String((byRule.get(rule.id) ?? []).length).padStart(4)}  ${rule.id}`);
  }
  console.log('');

  for (const rule of RULES) {
    const rows = byRule.get(rule.id) ?? [];
    if (rows.length === 0) continue;
    console.log(`── ${rule.id} (${rows.length})`);
    console.log(`   ${rule.why.replace(/(.{78}\s)/g, '$1\n   ')}\n`);
    // Worst first where a rule can say what worst means, then alphabetical, so
    // the top of a section is the place to start and two runs read the same.
    rows.sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
    for (const row of rows) console.log(`   ${row.file}\n     ${row.note}`);
    console.log('');
  }
  if (findings.length === 0) console.log('  nothing to report.\n');

  if (max !== null && findings.length > max) {
    console.error(`perf-scan: ${findings.length} findings, over the --max of ${max}`);
    process.exit(1);
  }
}
