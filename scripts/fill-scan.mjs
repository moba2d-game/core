#!/usr/bin/env node
/**
 * How many pixels does a frame *blend*, and which effect is spending them?
 *
 *   moba2d-fill-scan                     # from a pack: that pack
 *   node scripts/fill-scan.mjs           # from core: its tree + linked packs
 *   node scripts/fill-scan.mjs ./spells  # anything you point it at
 *   node scripts/fill-scan.mjs --max 0   # exit 1 on any finding (a gate)
 *   node scripts/fill-scan.mjs --all     # every filled shape, ranked, not just findings
 *
 * ## The bug this was written from
 *
 * A player reported a phone dropping to 15fps in a six-bot fight while the same
 * fight held 60 on a desktop. Every instrument in this repository said the game
 * was fine, and all of them were right about the thing they measure:
 * `measure-frame-cost` found no CPU regression against its recorded ladder, and
 * `perf-scan` found nothing because **it counts p5 calls, and one `circle()` is
 * one call whether it covers ten pixels or a million**.
 *
 * A phone does not pay per call. It pays per *pixel it blends*, and the answer
 * turned out to be arithmetic nobody had done: one champion's poison trail was
 * blending **1.34x the area of the whole phone screen, every frame** — eight
 * clouds alive at once, each drawing a body disc plus four more discs *inside*
 * it that could not reach past its edge. Half of that was overdraw that told
 * the player nothing.
 *
 * ## What it measures
 *
 * Area, in CSS px², of every shape drawn with a fill in a draw path — then
 * against a phone screen, because a fraction of a screen is a number anyone can
 * argue with and `px²` is not. The default screen is a 844x390 phone at
 * `deviceScaleFactor: 3`, which is what the report is scaled to.
 *
 * ## Three things it deliberately does not do
 *
 * **Alpha is not in the cost.** A 26-alpha disc costs the same as a 240-alpha
 * one — the blend happens per pixel either way. Lowering alpha to "make it
 * cheaper" is the most natural wrong fix here, so this never rewards it.
 *
 * **Strokes are not counted.** A stroke pays its perimeter, which is smaller by
 * a factor of the radius, and converting a fill to a rim or an arc is the
 * standard repair — counting strokes would blunt the signal that suggests it.
 *
 * **It does not resolve a transform stack.** A `translate()` before a shape
 * moves it but does not change its area, and area is the whole question.
 */
import ts from 'typescript';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packRootFrom } from './lib/packRoot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(HERE, '..');
const scriptPath = fileURLToPath(import.meta.url);

/**
 * The screen every figure is reported against: a phone, at the pixel ratio a
 * phone actually has. 844x390 CSS is the viewport `tests/e2e/harness.mjs` uses
 * for its phone runs, and `deviceScaleFactor: 3` is what makes the number
 * frightening — a shape's cost is its CSS area times nine.
 */
const SCREEN_CSS = 844 * 390;

/** Fraction of a screen one shape may blend before it is worth a look. */
const SHAPE_SHARE = 0.12;

/** Fraction of a screen one *effect* may blend across its live instances. */
const EFFECT_SHARE = 0.35;

/** Instances assumed alive at once. One, unless the reader says otherwise. */
let LIVE = Math.max(1, Number(process.env.MOBA2D_FILL_LIVE ?? 1));

/** `--live N` from the CLI, applied before anything is inspected. */
export function assumeLive(count) {
  LIVE = Math.max(1, Number(count) || 1);
}

const walk = (dir, out = []) => {
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

const nameOf = node => {
  if (!node) return null;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
};

const isDrawName = name => /^_*draw/.test(name);

/** Shapes whose area this scan knows how to compute, and where the size sits. */
const SHAPES = {
  circle: { size: [2], area: ([d]) => Math.PI * (d / 2) ** 2 },
  square: { size: [2], area: ([s]) => s * s },
  ellipse: { size: [2, 3], area: ([w, h]) => (Math.PI * w * (h ?? w)) / 4 },
  // Args 4 and 5 are the sweep: an `arc` from `a` to `a + 1.5` covers a quarter
  // of its ellipse, and costing it as the whole one read a row of decorative
  // sweeps as the most expensive art in the game.
  arc: { size: [2, 3], sweep: [4, 5], area: ([w, h]) => (Math.PI * w * (h ?? w)) / 4 },
  rect: { size: [2, 3], area: ([w, h]) => Math.abs(w * (h ?? w)) },
};

/** `cos`/`sin` never exceed one, which is all this needs to bound an offset. */
const BOUNDED_BY_ONE = /^(cos|sin|Math\.cos|Math\.sin|noise)$/;

// ── numbers ─────────────────────────────────────────────────────────────────

/**
 * The range `expr` can take, as `{ lo, hi }`, or `null` when that is not
 * knowable.
 *
 * An **interval**, not a single maximum, and the first version was the single
 * maximum. That is wrong the moment a subtraction appears: the largest value of
 * `a - b` is `max(a) - min(b)`, and taking `max(a) - max(b)` produced radii
 * like `r=-288` — seven of them in the first real run, each one a nonsense
 * finding a reader would have had to disprove by hand.
 *
 * Bounds rather than values because that is the honest thing to rank by:
 * `cos(a) * off` is somewhere in `±off`, `random(0, 9)` is somewhere in `0..9`,
 * and a loop counter is at most its last trip. "How much can this cost" is the
 * question a budget asks.
 */
const rangeOf = (expr, ctx, depth = 0) => {
  if (!expr || depth > 14) return null;
  const on = node => rangeOf(node, ctx, depth + 1);
  const at = n => ({ lo: n, hi: n });
  const span = (...values) => ({ lo: Math.min(...values), hi: Math.max(...values) });

  if (ts.isParenthesizedExpression(expr)) return on(expr.expression);
  if (ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) return on(expr.expression);
  if (ts.isNumericLiteral(expr)) return at(Number(expr.text));
  if (ts.isPrefixUnaryExpression(expr)) {
    const inner = on(expr.operand);
    if (!inner) return null;
    return expr.operator === ts.SyntaxKind.MinusToken
      ? { lo: -inner.hi, hi: -inner.lo }
      : inner;
  }
  if (ts.isConditionalExpression(expr)) {
    // **Use the guard.** `t > 0.82 ? 1 - (t - 0.82) / 0.18 : 1` is an ease that
    // never leaves 0..1, but an interval that ignores the condition reads `t`
    // as 0..1 inside the branch, `(t - 0.82) / 0.18` as -4.56..1, and the whole
    // thing as **5.56** — which multiplied a 100px radius into a 556px one and
    // put a fade at the top of the report. Guarded eases are the normal shape
    // of animation code here, so the condition is worth reading.
    const narrowed = narrowFrom(expr.condition, ctx, depth);
    const a = rangeOf(expr.whenTrue, narrowed.whenTrue, depth + 1);
    const b = rangeOf(expr.whenFalse, narrowed.whenFalse, depth + 1);
    if (!a || !b) return null;
    return span(a.lo, a.hi, b.lo, b.hi);
  }
  if (ts.isBinaryExpression(expr)) {
    const kind = expr.operatorToken.kind;
    if (kind === ts.SyntaxKind.QuestionQuestionToken) return on(expr.left) ?? on(expr.right);
    const a = on(expr.left);
    const b = on(expr.right);
    if (!a || !b) return null;
    if (kind === ts.SyntaxKind.PlusToken) return { lo: a.lo + b.lo, hi: a.hi + b.hi };
    if (kind === ts.SyntaxKind.MinusToken) return { lo: a.lo - b.hi, hi: a.hi - b.lo };
    if (kind === ts.SyntaxKind.AsteriskToken) {
      return span(a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi);
    }
    if (kind === ts.SyntaxKind.SlashToken) {
      if (b.lo <= 0 && b.hi >= 0) return null;
      return span(a.lo / b.lo, a.lo / b.hi, a.hi / b.lo, a.hi / b.hi);
    }
    return null;
  }
  if (ts.isCallExpression(expr)) {
    const called = expr.expression.getText().trim();
    if (BOUNDED_BY_ONE.test(called)) return { lo: -1, hi: 1 };
    const parts = expr.arguments.map(on);
    if (/^(Math\.)?(max|min)$/.test(called) && parts.length > 0 && parts.every(Boolean)) {
      return /max$/.test(called)
        ? { lo: Math.max(...parts.map(v => v.lo)), hi: Math.max(...parts.map(v => v.hi)) }
        : { lo: Math.min(...parts.map(v => v.lo)), hi: Math.min(...parts.map(v => v.hi)) };
    }
    if (/^random$/.test(called) && parts.length > 0 && parts.every(Boolean)) {
      const ends = parts.flatMap(v => [v.lo, v.hi]);
      return parts.length === 1 ? span(0, ...ends) : span(...ends);
    }
    if (/^(Math\.)?abs$/.test(called) && parts[0]) {
      const inner = parts[0];
      const reachesZero = inner.lo <= 0 && inner.hi >= 0;
      return span(reachesZero ? 0 : Math.min(Math.abs(inner.lo), Math.abs(inner.hi)),
        Math.max(Math.abs(inner.lo), Math.abs(inner.hi)));
    }
    // A reach helper is transparent; a clamp is its own limits.
    if (/^effectiveRange$/.test(called)) return parts[0] ?? null;
    if (/^(constrain|clamp)$/.test(called) && parts[1] && parts[2]) {
      return span(parts[1].lo, parts[1].hi, parts[2].lo, parts[2].hi);
    }
    // **Everything else is unknown, not "the span of its arguments".** That
    // fallback looked conservative and was the opposite: `constrain(age / MS,
    // 0, 1)` spanned `age / MS`, so a head drawn at `8 + power * 6` — six
    // pixels — was reported at r=2104, 42 screens. A bound that is an artefact
    // of a guess is worse than no bound.
    return null;
  }
  if (ts.isIdentifier(expr)) {
    if (ctx.narrow?.has(expr.text)) return ctx.narrow.get(expr.text);
    if (ctx.loopMax.has(expr.text)) return span(0, ctx.loopMax.get(expr.text));
    // **Lexical scope, not a file-wide table.** Draw methods are full of short
    // local names — `d`, `r`, `w`, `reach` — and a flat map resolved one
    // method's `const d` to another method's, which read a 35px disc as r=833
    // and put it at the top of the report. Nearest declaration wins, exactly as
    // the language says.
    const initialiser = lookupLocal(expr, expr.text);
    return initialiser ? rangeOf(initialiser, ctx, depth + 1) : null;
  }
  if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const key = expr.name.text;
    if (ctx.seen.has(key)) return null;
    // **Only the enclosing class, never another one in the file.** A file holds
    // several classes and they reuse the same field names, so falling back to
    // whichever class was read first resolved a missile's `size = 46` to
    // another object's field and reported a 35px disc as r=833 — six screens of
    // fill that does not exist. A field this file cannot see (inherited from a
    // base class in core, most often) is *unknown*, and unknown is the right
    // answer: `null` here costs one missed row, the fallback cost a page of
    // fiction. `own` already includes values handed in at a `new <ThisClass>`
    // site, which is the one legitimate cross-class case.
    const written = ctx.own?.get(key);
    if (!written) return null;
    ctx.seen.add(key);
    const out = rangeOf(written, ctx, depth + 1);
    ctx.seen.delete(key);
    return out;
  }
  return null;
};

/** The widest this can get, for a size. `null` when it is never positive. */
const boundOf = (expr, ctx, depth = 0) => {
  const range = rangeOf(expr, ctx, depth);
  return range === null ? null : range.hi;
};

/** How far from the origin this can sit, for an offset. */
const magnitudeOf = (expr, ctx) => {
  const range = rangeOf(expr, ctx);
  return range === null ? null : Math.max(Math.abs(range.lo), Math.abs(range.hi));
};

/**
 * Every name this file can resolve to a number, and every value a `this.x` is
 * ever given.
 *
 * `fields` takes *any* write — a class property initialiser, an assignment in a
 * constructor, or `cloud.radius = CLOUD_RADIUS` at the site that builds it. A
 * radius handed in from outside is the shape this codebase is full of (it is
 * the fix `reach-scan` asks for), so a scan that only read initialisers would
 * be blind to exactly the well-written effects.
 */
const readNames = sourceFile => {
  const constants = new Map();
  const fields = new Map();
  const perClass = new Map();
  const classesByName = new Map();
  const indexClasses = node => {
    if (ts.isClassDeclaration(node) && node.name) classesByName.set(node.name.text, node);
    ts.forEachChild(node, indexClasses);
  };
  indexClasses(sourceFile);
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.initializer && nameOf(node.name)) {
      if (!constants.has(nameOf(node.name))) constants.set(nameOf(node.name), node.initializer);
    }
    if (ts.isPropertyDeclaration(node) && node.initializer && nameOf(node.name)) {
      if (!fields.has(nameOf(node.name))) fields.set(nameOf(node.name), node.initializer);
      const owner = enclosingClass(node);
      if (owner) {
        if (!perClass.has(owner)) perClass.set(owner, new Map());
        const own = perClass.get(owner);
        if (!own.has(nameOf(node.name))) own.set(nameOf(node.name), node.initializer);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      const key = node.left.name.text;
      if (!fields.has(key)) fields.set(key, node.right);
      // `this.radius = …` belongs to the class it is written in; `cloud.radius
      // = …` belongs to whatever class `cloud` was constructed from, which is
      // how a well-written effect receives its size (`reach-scan` asks for
      // exactly this shape). Both land on the same per-class map.
      const owner =
        node.left.expression.kind === ts.SyntaxKind.ThisKeyword
          ? enclosingClass(node)
          : classConstructedInto(node.left.expression, classesByName);
      if (owner) {
        if (!perClass.has(owner)) perClass.set(owner, new Map());
        const own = perClass.get(owner);
        if (!own.has(key)) own.set(key, node.right);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { constants, fields, perClass };
};

/**
 * The class `receiver` was constructed from, when that is visible here.
 *
 * `const blast = new Blast(owner); blast.radius = R;` — the write belongs to
 * `Blast`, not to whatever class the statement happens to sit in.
 */
const classConstructedInto = (receiver, classesByName) => {
  if (!ts.isIdentifier(receiver)) return null;
  for (let scope = receiver.parent; scope; scope = scope.parent) {
    const statements = ts.isSourceFile(scope)
      ? scope.statements
      : ts.isBlock(scope)
        ? scope.statements
        : null;
    if (statements) {
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const decl of statement.declarationList.declarations) {
          if (nameOf(decl.name) !== receiver.text) continue;
          const init = decl.initializer;
          if (init && ts.isNewExpression(init) && ts.isIdentifier(init.expression)) {
            return classesByName.get(init.expression.text) ?? null;
          }
          return null;
        }
      }
    }
    if (ts.isSourceFile(scope)) break;
  }
  return null;
};

/**
 * What a comparison tells us about the name in it, per branch.
 *
 * Only the one shape that matters: `<name> <op> <number>`. Anything else hands
 * both branches the context unchanged, which is the old behaviour.
 */
const narrowFrom = (condition, ctx, depth) => {
  const unchanged = { whenTrue: ctx, whenFalse: ctx };
  if (!condition || !ts.isBinaryExpression(condition)) return unchanged;
  const ops = {
    [ts.SyntaxKind.GreaterThanToken]: 'gt',
    [ts.SyntaxKind.GreaterThanEqualsToken]: 'gt',
    [ts.SyntaxKind.LessThanToken]: 'lt',
    [ts.SyntaxKind.LessThanEqualsToken]: 'lt',
  };
  const op = ops[condition.operatorToken.kind];
  if (!op || !ts.isIdentifier(condition.left)) return unchanged;
  const name = condition.left.text;
  const known = rangeOf(condition.left, { ...ctx, narrow: new Map() }, depth + 1);
  const limit = rangeOf(condition.right, ctx, depth + 1);
  if (!known || !limit || limit.lo !== limit.hi) return unchanged;
  const at = limit.lo;
  const above = { lo: Math.max(known.lo, at), hi: known.hi };
  const below = { lo: known.lo, hi: Math.min(known.hi, at) };
  if (above.lo > above.hi || below.lo > below.hi) return unchanged;
  const withName = range => ({ ...ctx, narrow: new Map([...(ctx.narrow ?? []), [name, range]]) });
  return op === 'gt'
    ? { whenTrue: withName(above), whenFalse: withName(below) }
    : { whenTrue: withName(below), whenFalse: withName(above) };
};

/**
 * The nearest `const <name> = …` visible from `node`, walking outward.
 *
 * Blocks then the file, which is what a reader does and what the language
 * does. Module scope is included on purpose: a spell's tuning constants live
 * there and are exactly what a radius is built from.
 */
const lookupLocal = (node, name) => {
  for (let scope = node.parent; scope; scope = scope.parent) {
    const statements = ts.isSourceFile(scope) || ts.isBlock(scope) ? scope.statements : null;
    if (statements) {
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const decl of statement.declarationList.declarations) {
          if (nameOf(decl.name) === name && decl.initializer) return decl.initializer;
        }
      }
    }
    if (ts.isSourceFile(scope)) break;
  }
  return null;
};

/** The class a node is written inside, for scoping `this.x`. */
const enclosingClass = node => {
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (ts.isClassDeclaration(scope) || ts.isClassExpression(scope)) return scope;
    if (ts.isSourceFile(scope)) return null;
  }
  return null;
};

/** Loop counters bound to their last trip, so a body is costed at its widest. */
const loopBounds = (node, ctx) => {
  const out = new Map();
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (ts.isForStatement(scope) && scope.initializer && scope.condition) {
      const decl = ts.isVariableDeclarationList(scope.initializer)
        ? scope.initializer.declarations[0]
        : null;
      const counter = decl ? nameOf(decl.name) : null;
      if (counter && ts.isBinaryExpression(scope.condition)) {
        const limit = boundOf(scope.condition.right, { ...ctx, loopMax: out }, 0);
        if (limit !== null) out.set(counter, Math.max(0, limit - 1));
      }
    }
    if (ts.isSourceFile(scope)) break;
  }
  return out;
};

/** How many times a shape at `node` is painted per call of its draw method. */
const repeats = (node, ctx) => {
  let times = 1;
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (ts.isForStatement(scope) && scope.condition && ts.isBinaryExpression(scope.condition)) {
      const limit = boundOf(scope.condition.right, ctx, 0);
      times *= limit === null ? 1 : Math.max(1, Math.round(limit));
    } else if (ts.isForOfStatement(scope) || ts.isForInStatement(scope)) {
      // An unknown collection is charged once — an overestimate here would be
      // an artefact of a guess, and this report is meant to be argued with.
      times *= 1;
    }
    if (ts.isSourceFile(scope)) break;
  }
  return times;
};

// ── the fills ───────────────────────────────────────────────────────────────

/**
 * Every filled shape in a draw path, with the area it can cover.
 *
 * p5's fill state is a mode, not an argument, so it is tracked the way a reader
 * tracks it: in source order, `fill()` turns it on and `noFill()` turns it off.
 *
 * **`push()`/`pop()` are a real stack and must be modelled.** The first version
 * ignored them on the theory that a fill set before a `push` still applies
 * inside it — true, and beside the point, because `pop()` *restores* the fill
 * that was in force before its `push`. Every spell in three packs is written in
 * `push()`/`pop()` pairs, so ignoring them left the scan believing a fill was
 * still on for the whole rest of a method after a `pop` had turned it off, and
 * it costed stroked decoration as though it were solid.
 */
const filledShapes = sourceFile => {
  const { constants, fields, perClass } = readNames(sourceFile);
  const out = [];

  const inDraw = node => {
    for (let scope = node.parent; scope; scope = scope.parent) {
      if (ts.isMethodDeclaration(scope) || ts.isFunctionDeclaration(scope)) {
        const name = nameOf(scope.name);
        return name && isDrawName(name) ? name : null;
      }
    }
    return null;
  };

  const methods = new Map();
  const collect = node => {
    if (
      (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.body &&
      isDrawName(nameOf(node.name) ?? '')
    ) {
      methods.set(node, nameOf(node.name));
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  for (const [method, methodName] of methods) {
    let filled = false;
    const stack = [];
    const ordered = [];
    const gather = node => {
      if (ts.isCallExpression(node)) ordered.push(node);
      ts.forEachChild(node, gather);
    };
    gather(method.body);
    ordered.sort((a, b) => a.pos - b.pos);

    for (const call of ordered) {
      const called = nameOf(call.expression);
      if (called === 'push') {
        stack.push(filled);
        continue;
      }
      if (called === 'pop') {
        filled = stack.length > 0 ? stack.pop() : filled;
        continue;
      }
      if (called === 'fill') {
        filled = true;
        continue;
      }
      if (called === 'noFill') {
        filled = false;
        continue;
      }
      const shape = SHAPES[called];
      if (!shape || !filled) continue;

      const own = perClass.get(enclosingClass(method)) ?? new Map();
      const base = { constants, fields, own, seen: new Set(), loopMax: new Map() };
      const ctx = { ...base, seen: new Set(), loopMax: loopBounds(call, base) };
      const sizes = shape.size.map(i => boundOf(call.arguments[i], ctx));
      if (sizes[0] === null || sizes[0] === undefined || sizes[0] <= 0) continue;
      let area = shape.area(sizes.map(v => (v === null || v <= 0 ? sizes[0] : v)));
      if (shape.sweep) {
        const from = boundOf(call.arguments[shape.sweep[0]], ctx);
        const to = boundOf(call.arguments[shape.sweep[1]], ctx);
        const swept = from === null || to === null ? null : Math.abs(to - from);
        // Unknown sweep is charged as a half turn rather than a whole one: an
        // arc nobody can read is not evidence of a full disc.
        area *= swept === null ? 0.5 : Math.min(1, swept / (Math.PI * 2));
      }
      if (!Number.isFinite(area) || area <= 0) continue;

      // How far the shape's own centre can sit from the method's origin —
      // enough to tell "inside that other disc" from "somewhere else".
      const offsetX = magnitudeOf(call.arguments[0], ctx);
      const offsetY = magnitudeOf(call.arguments[1], ctx);
      const offset =
        offsetX === null || offsetY === null ? null : Math.hypot(offsetX, offsetY);

      out.push({
        method: methodName,
        primitive: called,
        area,
        radius: called === 'circle' ? sizes[0] / 2 : Math.sqrt(area / Math.PI),
        offset,
        times: repeats(call, ctx),
        line: sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1,
      });
    }
  }
  return out;
};

/**
 * How many of this effect are on screen at once — **asked for, never guessed.**
 *
 * The first version derived it: an object's `lifeTime` over the smallest
 * interval-shaped constant in the file. It read a trail correctly and then read
 * a single cage as **83 alive** and one ultimate as **145**, because a file's
 * small constants are mostly animation steps and a `lifeTime` field may belong
 * to a different object in the same file. Every one of those rows was fiction,
 * and a fiction at the top of a ranked report discredits the true rows under it.
 *
 * `perf-scan` learned the same thing the expensive way and its note is the rule
 * followed here: **per-instance is what gates**, and a saturated figure nobody
 * can reach is not evidence. So this reports one instance, and `--live N`
 * multiplies it when the reader knows the count — which they do, from the
 * ability's own lifetime over its drop interval. The trail that started all of
 * this is 1800ms of cloud life over a 220ms drop: `--live 8`.
 */

export const RULES = [
  {
    id: 'fill-inside-fill',
    why:
      'a filled shape drawn inside another filled shape is overdraw: every one ' +
      'of its pixels is blended twice to say what the shape underneath already ' +
      'said. It is the cheapest win there is — deleting it changes nothing on ' +
      'screen except the frame time. Four puff discs painted inside their own ' +
      "cloud's body were 53% of one champion's entire fill cost.",
  },
  {
    id: 'large-fill',
    why:
      'one shape blending a large share of the screen. Area is what a mobile ' +
      'GPU pays and alpha does not reduce it, so the repair is the art, never ' +
      'the colour: a band, a rim or an arc states the same edge for a fraction ' +
      'of the pixels, which is the trade the fountain’s widest disc already made.',
  },
  {
    id: 'effect-over-budget',
    why:
      'everything this effect fills, in one instance, against the screen. Pass ' +
      '--live N (an ability\'s lifetime over its drop interval) to see what its ' +
      'live instances cost together: a trail is the shape that bites, because ' +
      'one cloud looks cheap and eight of them are alive at once.',
  },
];

/** Findings for one parsed file. */
const inspect = (sourceFile, label) => {
  const shapes = filledShapes(sourceFile);
  if (shapes.length === 0) return { findings: [], shapes: [] };
  const findings = [];

  const share = area => area / SCREEN_CSS;
  const pct = value => `${(value * 100).toFixed(0)}%`;

  // Pure overdraw: a filled shape that cannot reach past a bigger one beside it.
  const byMethod = new Map();
  for (const shape of shapes) {
    byMethod.set(shape.method, [...(byMethod.get(shape.method) ?? []), shape]);
  }
  for (const [method, group] of byMethod) {
    const widest = group.reduce((a, b) => (b.radius > a.radius ? b : a));
    for (const shape of group) {
      if (shape === widest || shape.offset === null) continue;
      if (shape.offset + shape.radius > widest.radius * 1.02) continue;
      const wasted = shape.area * shape.times;
      if (share(wasted) < 0.01) continue;
      findings.push({
        rule: 'fill-inside-fill',
        weight: wasted,
        note:
          `${method}() line ${shape.line}: ${shape.times > 1 ? `${shape.times}x ` : ''}` +
          `${shape.primitive} r=${shape.radius.toFixed(0)} sits inside the r=` +
          `${widest.radius.toFixed(0)} fill on line ${widest.line} — ` +
          `${pct(share(wasted))} of a screen, blended twice for nothing`,
      });
    }
  }

  for (const shape of shapes) {
    const area = shape.area * shape.times;
    if (share(area) < SHAPE_SHARE) continue;
    findings.push({
      rule: 'large-fill',
      weight: area,
      note:
        `${shape.method}() line ${shape.line}: ${shape.times > 1 ? `${shape.times}x ` : ''}` +
        `${shape.primitive} r=${shape.radius.toFixed(0)} blends ${pct(share(area))} of a screen`,
    });
  }

  const total = shapes.reduce((sum, shape) => sum + shape.area * shape.times, 0) * LIVE;
  if (share(total) >= EFFECT_SHARE) {
    findings.push({
      rule: 'effect-over-budget',
      weight: total,
      note:
        `${shapes.length} filled shape${shapes.length === 1 ? '' : 's'}` +
        `${LIVE > 1 ? ` x ${LIVE} live` : ''} = ${pct(share(total))} of a screen per frame`,
    });
  }

  return { findings, shapes, total, label };
};

export function scanSource(source, fileName = 'inline.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  return inspect(sourceFile, fileName).findings;
}

export function scanTree(root, labelFrom = resolve(CORE, '..')) {
  const out = [];
  const effects = [];
  if (!existsSync(root)) return { findings: out, effects };
  for (const file of walk(realpathSync(root))) {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const label = relative(labelFrom, file);
    const result = inspect(sourceFile, label);
    for (const finding of result.findings) out.push({ ...finding, file: label });
    if (result.total > 0) effects.push({ file: label, total: result.total, live: result.live });
  }
  return { findings: out, effects };
}

function packTrees(packRoot) {
  return ['spells', 'monsters'].map(dir => join(packRoot, dir)).filter(existsSync);
}

function defaultRoots() {
  let packRoot = null;
  try {
    packRoot = packRootFrom(process.cwd());
  } catch {
    packRoot = null;
  }
  if (packRoot) return packTrees(packRoot);
  const linked = join(CORE, 'node_modules', '@moba2d');
  const siblings = existsSync(linked)
    ? readdirSync(linked)
        .filter(name => name.startsWith('content-'))
        .flatMap(name => packTrees(join(linked, name)))
    : [];
  return [join(CORE, 'src/game/gameObject'), ...siblings];
}

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
  const consumed = new Set();
  argv.forEach((arg, i) => {
    if (arg === '--max' || arg === '--live') consumed.add(i).add(i + 1);
    else if (arg.startsWith('--')) consumed.add(i);
  });
  const targets = argv.filter((arg, i) => !consumed.has(i));
  const maxArg = argv.indexOf('--max');
  const max = maxArg === -1 ? null : Number(argv[maxArg + 1]);
  const showAll = argv.includes('--all');
  const liveArg = argv.indexOf('--live');
  if (liveArg !== -1) assumeLive(argv[liveArg + 1]);

  const roots = targets.length ? targets.map(t => resolve(t)) : defaultRoots();
  const findings = [];
  const effects = [];
  for (const root of roots) {
    const result = scanTree(root);
    findings.push(...result.findings);
    effects.push(...result.effects);
  }

  const byRule = new Map();
  for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);

  console.log(`\nfill-scan: ${findings.length} finding(s) across ${roots.length} tree(s)`);
  console.log(`  budget: one 844x390 phone screen (x3 device pixels) = 1.00 screen\n`);
  for (const rule of RULES) {
    console.log(`   ${String((byRule.get(rule.id) ?? []).length).padStart(4)}  ${rule.id}`);
  }
  console.log('');

  for (const rule of RULES) {
    const rows = byRule.get(rule.id) ?? [];
    if (rows.length === 0) continue;
    console.log(`── ${rule.id} (${rows.length})`);
    console.log(`   ${rule.why.replace(/(.{78}\s)/g, '$1\n   ')}\n`);
    rows.sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
    for (const row of rows) console.log(`   ${row.file}\n     ${row.note}`);
    console.log('');
  }
  if (findings.length === 0) console.log('  nothing to report.\n');

  if (showAll) {
    console.log('── every effect, by what one frame of it blends');
    effects.sort((a, b) => b.total - a.total);
    for (const effect of effects.slice(0, 30)) {
      console.log(
        `   ${(effect.total / SCREEN_CSS).toFixed(2).padStart(6)} screens  ${effect.file}` +
          ''
      );
    }
    console.log('');
  }

  if (max !== null && findings.length > max) {
    console.error(`fill-scan: ${findings.length} findings, over the --max of ${max}`);
    process.exit(1);
  }
}
