#!/usr/bin/env node
/**
 * Does the picture reach as far as the damage does?
 *
 *   moba2d-reach-scan                     # from a pack: that pack
 *   node scripts/reach-scan.mjs           # from core: its tree + linked packs
 *   node scripts/reach-scan.mjs ./spells  # anything you point it at
 *   node scripts/reach-scan.mjs --max 0   # exit 1 on any finding (a gate)
 *   node scripts/reach-scan.mjs --coverage
 *
 * ## The two bugs this was written from
 *
 * Both were reported from real matches on 2026-09-06, both had been shipped for
 * weeks, and both are invisible to every test in the repo because a test asserts
 * on damage and nobody asserts on pixels.
 *
 *  - A dash-and-slash queried `effectiveRange(RADIUS, owner)` and drew
 *    `RADIUS * 1.12`, then `* 1.16` again while its ultimate was up. The
 *    crescent on screen was up to **30% wider than the wedge that cut**, so the
 *    player aimed at the picture and the ability answered to something else.
 *  - A spinning dash queried `HIT_RADIUS + size / 2` and drew `HIT_RADIUS`. Its
 *    blades were painted **a body-radius short** of what they hit — the same
 *    lie pointing the other way, and it read to the player as an ability whose
 *    reach could not be seen at all.
 *
 * Neither is a bug a reader finds by reading: the query is in `onSpellCast` and
 * the drawing is two hundred lines down in a `SpellObject`, and each half is
 * correct on its own. Only holding them side by side finds it, which is a
 * machine's job.
 *
 * ## What it is, and what it is not
 *
 * Like `perf-scan.mjs`, this is **not** a seam. Drawing past the hit radius is
 * sometimes right — a shockwave that expands outward, a telegraph ring drawn
 * before the hit lands. So it reports, ranks, exits 0, and takes `--max` when a
 * caller wants it to hold a line.
 *
 * ## Precision over recall, deliberately
 *
 * It only speaks when the hit reach and the drawn reach **share a named
 * constant**. The moment a radius is handed to a `SpellObject` through its
 * constructor — which is the *recommended* shape, and what both fixes above did
 * — the two halves no longer share a name and this scan goes quiet.
 *
 * That is the right trade. A scan that guessed across that boundary would flag
 * the corrected code, and a tool that cries at the fix is a tool that gets
 * switched off. `--coverage` prints how much of each tree it could actually see,
 * so the silence is never mistaken for a clean bill of health.
 */
import ts from 'typescript';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packRootFrom } from './lib/packRoot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(HERE, '..');

/** How far apart two radii have to be before it is worth saying so. */
const TOLERANCE = 0.05;

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
  if (ts.isStringLiteral(node)) return node.text;
  return null;
};

/**
 * A leading underscore is a house convention for "private", not a different
 * kind of method: `_drawTelegraph` and `_drawCage` are drawings, and matching
 * only `/^draw/` hid two whole spells' art from this scan and reported both as
 * painting nothing.
 */
const isDrawName = name => /^_*draw/.test(name);

/** Calls that mean this file decides who is hurt, i.e. it has a hit reach at all. */
const HURTS = /^(takeDamage|takeHeal|addBuff|applyDamage|takeTrueDamage)$/;

/** How the draw side reads an expression — see the `unitScale` note in `reachOf`. */
const DRAWN = { unitScale: true };

/** p5 primitives whose width argument is a diameter, and where that argument sits. */
const DIAMETER_ARG = { circle: 2, square: 2, ellipse: 2, arc: 2 };

/** Trig calls whose product with a length is a point on a circle of that length. */
const TRIG = /^(cos|sin|Math\.cos|Math\.sin)$/;

// ── the term algebra ────────────────────────────────────────────────────────
//
// A reach expression reduces to a list of *variants* (a conditional has two),
// each of which is `sum(id * factor) + constant`. Named constants stay named:
// resolving `Q_RADIUS` to 150 up front would throw away the only thing that
// lets the hit half and the draw half be recognised as the same quantity.

const variant = (ids = new Map(), k = 0) => ({ ids, k });

const plus = (a, b, sign = 1) => {
  const ids = new Map(a.ids);
  for (const [key, f] of b.ids) {
    const next = (ids.get(key) ?? 0) + sign * f;
    if (next === 0) ids.delete(key);
    else ids.set(key, next);
  }
  return variant(ids, a.k + sign * b.k);
};

const times = (a, s) => {
  const ids = new Map();
  for (const [key, f] of a.ids) ids.set(key, f * s);
  return variant(ids, a.k * s);
};

const isNumber = v => v.ids.size === 0;

/** An expression this scan cannot read, kept as a term named for its own text. */
const opaque = expr => {
  const text = expr.getText().replace(/\s+/g, ' ').trim();
  return variant(new Map([[text.length > 60 ? text.slice(0, 57) + '…' : text, 1]]));
};

/** The house shape for a reach constant, and the only orphan worth reporting. */
const NAMED_CONSTANT = /^[A-Z][A-Z0-9_]*$/;

/**
 * Named lengths that are not an *area*, and so are not a drawing problem.
 *
 * Half of this rule's first list was these. A speed compared against a distance
 * is an arrival test (`dist < speed` — "am I there yet"); a step, a gap and a
 * follow distance are spacing; a search, seek, bounce, chain or hunt range picks
 * the *next target* rather than covering ground, and no player has ever wanted a
 * ring drawn around a chain lightning's candidate list. None of them is a claim
 * about how far an ability reaches, which is the only thing this scan is about.
 */
const NOT_AN_AREA = /(SPEED|STEP|GAP|DISTANCE|SEARCH|SEEK|BOUNCE|CHAIN|HUNT|FOLLOW|CLAMP)/;

/** Cross two variant lists, combining each pair. `null` anywhere is unknown. */
const cross = (left, right, combine) => {
  if (!left || !right) return null;
  const out = [];
  for (const a of left) {
    for (const b of right) {
      const merged = combine(a, b);
      if (!merged) return null;
      out.push(merged);
    }
  }
  return out;
};

/**
 * The declaration a name resolves to, and whether it is one this file owns as a
 * *concept* (module level, imported) or merely as a local alias.
 *
 * Local aliases are inlined — `const outer = this.outerRadius` is not a quantity,
 * it is a shorthand. Module-level and imported names are kept as atoms, because
 * they are exactly what the two halves have to agree about.
 */
const lookup = (node, name) => {
  for (let scope = node.parent; scope; scope = scope.parent) {
    const statements = ts.isSourceFile(scope)
      ? scope.statements
      : ts.isBlock(scope) || ts.isCaseClause(scope)
        ? scope.statements
        : null;
    if (statements) {
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const decl of statement.declarationList.declarations) {
          if (nameOf(decl.name) !== name) continue;
          return { decl, moduleLevel: ts.isSourceFile(scope) };
        }
      }
    }
    if (ts.isSourceFile(scope)) break;
  }
  return null;
};

/** The class member `this.<name>` refers to, resolved inside the file. */
const memberNamed = (node, name) => {
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (ts.isClassDeclaration(scope) || ts.isClassExpression(scope)) {
      for (const member of scope.members) {
        if (nameOf(member.name) !== name) continue;
        if (ts.isGetAccessorDeclaration(member) && member.body) return member;
        if (ts.isPropertyDeclaration(member)) return member;
      }
      return null;
    }
  }
  return null;
};

/** The single expression a getter body returns, when it is that simple. */
const returnedExpression = body => {
  let found = null;
  let count = 0;
  const visit = node => {
    if (ts.isReturnStatement(node)) {
      count += 1;
      found = node.expression ?? null;
    }
    if (ts.isFunctionLike(node) && node !== body.parent) return;
    ts.forEachChild(node, visit);
  };
  visit(body);
  return count === 1 ? found : null;
};

/**
 * `expr` as a list of variants, or `null` when something opaque is in the way.
 *
 * Opaque is the honest answer far more often than it looks — a stat read, a
 * helper call, arithmetic on two unknowns — and `null` here is what keeps this
 * scan quiet rather than wrong.
 */
const reachOf = (expr, depth = 0, opts = {}) => {
  if (!expr || depth > 12) return null;
  const on = node => reachOf(node, depth + 1, opts);

  if (ts.isParenthesizedExpression(expr)) return on(expr.expression);
  if (ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) {
    return on(expr.expression);
  }
  if (ts.isNumericLiteral(expr)) return [variant(new Map(), Number(expr.text))];
  if (ts.isPrefixUnaryExpression(expr) && ts.isNumericLiteral(expr.operand)) {
    const value = Number(expr.operand.text);
    return [variant(new Map(), expr.operator === ts.SyntaxKind.MinusToken ? -value : value)];
  }

  if (ts.isConditionalExpression(expr)) {
    const a = on(expr.whenTrue);
    const b = on(expr.whenFalse);
    if (!a || !b) return null;
    return [...a, ...b];
  }

  if (ts.isBinaryExpression(expr)) {
    const kind = expr.operatorToken.kind;
    const left = on(expr.left);
    if (kind === ts.SyntaxKind.QuestionQuestionToken) {
      return left ?? on(expr.right);
    }
    const right = on(expr.right);
    if (kind === ts.SyntaxKind.PlusToken) return cross(left, right, (a, b) => plus(a, b));
    if (kind === ts.SyntaxKind.MinusToken) return cross(left, right, (a, b) => plus(a, b, -1));
    if (kind === ts.SyntaxKind.AsteriskToken) {
      if (opts.unitScale) {
        // The curve half may not reduce at all — `eased` expands to
        // `1 - (1 - t) * (1 - t)`, which is two unknowns multiplied and comes
        // back `null`. The length half still says how far the mark goes.
        const named = list =>
          list?.some(v => [...v.ids.keys()].some(key => NAMED_CONSTANT.test(key)));
        if (left && !right && named(left)) return left;
        if (right && !left && named(right)) return right;
      }
      return cross(left, right, (a, b) => {
        if (isNumber(b)) return times(a, b.k);
        if (isNumber(a)) return times(b, a.k);
        // `RADIUS * 2 * eased` in a draw. `eased` is an animation curve running
        // to 1, so the mark does reach `RADIUS * 2`. Dropping the whole term
        // instead made one splash's main ring invisible to this scan and left a
        // decorative inner ring standing as the widest thing drawn — reported
        // as "hits 2.2x past its own edge", which it does not. Draw side only:
        // an unreadable factor on a *hit* radius really is unknown.
        if (opts.unitScale) {
          // Which side is the length and which is the curve: the length is the
          // one carrying a named constant. `eased` expands to `1 - (1-t)*(1-t)`,
          // so requiring a bare atom here was not enough — a ring written
          // `SPLASH_RADIUS * 2 * eased` stayed unreadable.
          const named = v => [...v.ids.keys()].some(key => NAMED_CONSTANT.test(key));
          if (named(a) && !named(b)) return a;
          if (named(b) && !named(a)) return b;
        }
        return null;
      });
    }
    if (kind === ts.SyntaxKind.SlashToken) {
      return cross(left, right, (a, b) => (isNumber(b) && b.k !== 0 ? times(a, 1 / b.k) : null));
    }
    return null;
  }

  if (ts.isCallExpression(expr)) {
    const called = nameOf(expr.expression);
    // A reach helper is transparent: it scales by a stat this scan cannot see,
    // but it scales *both* halves the same way when both go through it.
    if (called === 'effectiveRange') return on(expr.arguments[0]);
    // `max`/`min` of two reaches is a branch, same as a conditional.
    if (called === 'max' || called === 'min') {
      const parts = expr.arguments.map(arg => on(arg));
      if (parts.some(part => !part)) return null;
      return parts.flat();
    }
    return [opaque(expr)];
  }

  if (ts.isPropertyAccessExpression(expr) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
    // `this.range` stays named whatever it was initialised to. A spell's cast
    // range is a *kind* of quantity, and inlining it to the number behind it
    // threw that away — `this.range + ORB_SIZE` then read as an ordinary reach
    // rather than as the pre-filter it is, and two correct spells were reported.
    if (expr.name.text === 'range') return [variant(new Map([['this.range', 1]]))];
    const member = memberNamed(expr, expr.name.text);
    if (member && ts.isGetAccessorDeclaration(member)) {
      const returned = returnedExpression(member.body);
      return returned ? on(returned) : null;
    }
    if (member && ts.isPropertyDeclaration(member) && member.initializer) {
      return on(member.initializer);
    }
    // Constructor-assigned, so its value came from outside this class. An atom
    // named for the field: two halves of one class that both read `this.radius`
    // agree by construction, which is the whole point of passing it in.
    return [variant(new Map([[`this.${expr.name.text}`, 1]]))];
  }

  if (ts.isIdentifier(expr)) {
    const resolved = lookup(expr, expr.text);
    if (resolved && !resolved.moduleLevel && resolved.decl.initializer) {
      return on(resolved.decl.initializer);
    }
    return [variant(new Map([[expr.text, 1]]))];
  }

  // A stat, a vector component, a call this scan does not model: name it after
  // its own source text and carry it as a term.
  //
  // Returning `null` here instead is what made the scan miss the second of the
  // two bugs above. `HIT_RADIUS + (stats.size.value ?? 0) / 2` reduced the
  // unreadable half to *nothing* — `??` fell through to its right-hand `0` — and
  // the hit came out the same width as the drawing. An unknown term that still
  // knows it exists is what lets `drawn-narrower` say "the hit adds this and
  // nothing is painted at it".
  return [opaque(expr)];
};

// ── where the two halves live ───────────────────────────────────────────────

const enclosingMethodName = node => {
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (ts.isMethodDeclaration(scope) || ts.isGetAccessorDeclaration(scope)) {
      return nameOf(scope.name);
    }
    if (ts.isFunctionDeclaration(scope) && scope.name) return scope.name.text;
  }
  return null;
};

const inDrawPath = node => {
  const name = enclosingMethodName(node);
  return !!name && isDrawName(name);
};

/** Every radius this file uses to decide who is hit. */
const hitReaches = source => {
  const out = [];
  const visit = node => {
    // `new Circle({ x, y, r: <reach> })` — the shape almost every area hit uses.
    if (ts.isNewExpression(node) && nameOf(node.expression) === 'Circle') {
      const arg = node.arguments?.[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const property of arg.properties) {
          if (nameOf(property.name) !== 'r') continue;
          if (!ts.isPropertyAssignment(property)) continue;
          if (inDrawPath(property)) continue;
          out.push({ expr: property.initializer, how: 'query radius' });
        }
      }
    }
    // `hypot(...) <= <reach>` and friends: a hand-rolled range check.
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      const comparison =
        kind === ts.SyntaxKind.LessThanToken ||
        kind === ts.SyntaxKind.LessThanEqualsToken ||
        kind === ts.SyntaxKind.GreaterThanToken ||
        kind === ts.SyntaxKind.GreaterThanEqualsToken;
      if (comparison && !inDrawPath(node)) {
        const flip =
          kind === ts.SyntaxKind.GreaterThanToken || kind === ts.SyntaxKind.GreaterThanEqualsToken;
        const distanceSide = flip ? node.right : node.left;
        const reachSide = flip ? node.left : node.right;
        const isDistance =
          ts.isCallExpression(distanceSide) &&
          /^(hypot|dist|mag)$/.test(nameOf(distanceSide.expression) ?? '');
        if (isDistance) out.push({ expr: reachSide, how: 'distance check' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
};

/**
 * Constant scaling applied *around* an expression by its parents.
 *
 * `(cos(a) * d) / 2` is a spoke drawn to `d / 2`, and matching the product
 * alone read it as `d` — twice its length. One pack's dial-shaped field, whose
 * every spoke is written that way, came back as painted at 2x what it hits.
 */
const outerScale = start => {
  let scale = 1;
  let current = start;
  for (let up = current.parent; up; up = up.parent) {
    if (ts.isParenthesizedExpression(up)) {
      current = up;
      continue;
    }
    if (!ts.isBinaryExpression(up)) break;
    const kind = up.operatorToken.kind;
    const isMul = kind === ts.SyntaxKind.AsteriskToken;
    const isDiv = kind === ts.SyntaxKind.SlashToken;
    if (!isMul && !isDiv) break;
    // `n / arm` is not a scale of the arm, it is something else entirely.
    if (isDiv && up.right === current) break;
    const other = up.left === current ? up.right : up.left;
    const value = reachOf(other, 0, DRAWN);
    if (!value || value.length !== 1 || !isNumber(value[0]) || value[0].k === 0) break;
    scale *= isDiv ? 1 / value[0].k : value[0].k;
    current = up;
  }
  return scale;
};


/**
 * Every radius this file actually paints at — including the two the *engine*
 * paints on its behalf.
 *
 * `Spell.range` is the big one: the base class draws a cast-range indicator at
 * it whether or not a spell overrides `drawPreview`, so an ability whose hit
 * radius *is* its range is telegraphed by the engine and this scan must not
 * call it invisible. Missing that read 60-odd item auras and cast ranges as
 * findings on the first run.
 */
const drawnReaches = source => {
  const out = [];
  const visit = node => {
    // `range = <reach>` on a spell: the engine's own range ring.
    if (ts.isPropertyDeclaration(node) && nameOf(node.name) === 'range' && node.initializer) {
      const reach = reachOf(node.initializer, 0, DRAWN);
      if (reach) out.push({ variants: reach, how: 'the cast-range ring' });
      // Under both names, because a hit that reads `this.range` now keeps that
      // name rather than the constant behind it.
      out.push({ variants: [variant(new Map([['this.range', 1]]))], how: 'the cast-range ring' });
    }
    if (ts.isCallExpression(node) && inDrawPath(node)) {
      const called = nameOf(node.expression);
      // `super.drawPreview(r)` / `this.drawPreview(r)` — the same ring, aimed by hand.
      if (called === 'drawPreview' && node.arguments.length > 0) {
        const reach = reachOf(node.arguments[0], 0, DRAWN);
        if (reach) out.push({ variants: reach, how: 'the cast-range ring' });
      }
      const index = DIAMETER_ARG[called];
      if (index !== undefined && node.arguments.length > index) {
        const reach = reachOf(node.arguments[index], 0, DRAWN);
        if (reach) out.push({ variants: reach.map(v => times(v, 0.5)), how: `${called}()` });
      }
    }
    // `cos(a) * R` puts a point R away from the middle — how a blade, a spoke or
    // a fanned vertex says how far it goes.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
      if (!inDrawPath(node)) {
        ts.forEachChild(node, visit);
        return;
      }
      const sides = [
        [node.left, node.right],
        [node.right, node.left],
      ];
      for (const [maybeTrig, maybeReach] of sides) {
        const trig =
          ts.isCallExpression(maybeTrig) && TRIG.test(maybeTrig.expression.getText().trim());
        if (!trig) continue;
        const reach = reachOf(maybeReach, 0, DRAWN);
        if (reach) {
          const scale = outerScale(node);
          out.push({ variants: reach.map(v => times(v, scale)), how: 'cos/sin arm' });
        }
        break;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
};

/**
 * Ids this file hands to something else, and so is no longer answerable for.
 *
 * Two ways, and only counting the first read a whole family of correct spells
 * as findings: a constructor argument (`new Blast(owner, RADIUS)`) and a
 * property written after the fact (`blast.radius = BLAST_RADIUS`), which is
 * just as much a hand-off and is the shape a `SpellObject` with a long
 * constructor tends to use.
 */
const handedOn = (source, hitExprs) => {
  const ids = new Set();
  // The hit expression is not a hand-off — `effectiveRange(RADIUS, owner)` is
  // the query itself, and counting its argument would exempt every ability.
  const inHit = node => hitExprs.some(hit => node.pos >= hit.pos && node.end <= hit.end);
  const take = node => {
    const reach = reachOf(node);
    for (const v of reach ?? []) for (const key of v.ids.keys()) ids.add(key);
  };
  const visit = node => {
    if (!inHit(node)) {
      // Any call, not only `new`. `showImpact(victim, SPLASH_RADIUS * 2)` sets
      // the radius of the pulse that draws it; `line(0, -HALF_WIDTH, 0,
      // HALF_WIDTH)` states a bar's reach with straight edges. Following only
      // constructors read both as a radius nobody paints. Between them this is
      // the whole of "is it visible": what is left after it is a constant that
      // appears **nowhere but the query**, which is a claim worth making — and
      // it is why this rule needs no table of drawing primitives of its own.
      if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && node.arguments) {
        for (const arg of node.arguments) take(arg);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left)
      ) {
        take(node.right);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return ids;
};

const hasDrawMethod = source => {
  let found = false;
  const visit = node => {
    if (found) return;
    if (ts.isMethodDeclaration(node) && isDrawName(nameOf(node.name) ?? '')) found = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const hurts = source => {
  let found = false;
  const visit = node => {
    if (found) return;
    if (ts.isCallExpression(node) && HURTS.test(nameOf(node.expression) ?? '')) found = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const fmt = n => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, ''));

// ── the rules ───────────────────────────────────────────────────────────────

export const RULES = [
  {
    id: 'drawn-wider-than-it-hits',
    why:
      'the picture promises reach the damage does not have, so a player who aims ' +
      'at the edge of the effect is aiming at nothing. The ability this rule was ' +
      'written from drew its crescent at RADIUS * 1.12, and * 1.16 again under ' +
      'its ultimate — up to 30% past the wedge that actually cut.',
  },
  {
    id: 'drawn-narrower-than-it-hits',
    why:
      'the effect hits past its own edges, which reads as a hitbox that lies. ' +
      'The ability this rule was written from queried HIT_RADIUS + size / 2 and ' +
      'drew HIT_RADIUS: its blades were a body-radius short of what they cut, ' +
      'and the reach could not be read off the screen at all.',
  },
  {
    id: 'reach-never-painted',
    why:
      'nothing on screen is drawn at the radius that decides the damage, and the ' +
      'radius is not handed to anything else either — so the size of this hit is ' +
      'not visible anywhere. Draw it, or pass it to the object that does.',
  },
];

/** Findings for one parsed file, plus what the scan could and could not see. */
const inspect = source => {
  const findings = [];
  const seen = { hits: 0, comparable: 0 };
  if (!hurts(source)) return { findings, seen };

  const hits = hitReaches(source);
  seen.hits = hits.length;
  if (hits.length === 0) return { findings, seen };

  const draws = drawnReaches(source);
  const passed = handedOn(
    source,
    hits.map(hit => hit.expr)
  );

  // The widest thing painted, per named quantity. Inner decoration — a torn
  // edge at 0.34, a hub at 0.3 — is not a claim about reach; the outermost mark
  // is, and that is what a player reads the size of an effect off.
  const widestDrawn = new Map();
  const drawnIds = new Set();
  for (const draw of draws) {
    for (const v of draw.variants) {
      for (const [key, factor] of v.ids) {
        drawnIds.add(key);
        if (!widestDrawn.has(key) || factor > widestDrawn.get(key).factor) {
          widestDrawn.set(key, { factor, how: draw.how });
        }
      }
    }
  }

  const reported = new Set();
  for (const hit of hits) {
    const variants = reachOf(hit.expr);
    if (!variants) continue;
    const text = hit.expr.getText().replace(/\s+/g, ' ');

    // **A sum of two named lengths is a bounding query, not a hit radius.**
    // `Q_LENGTH / 2 + Q_THICKNESS` is how every line-shaped ability in these
    // packs finds candidates before its real rectangle test runs, and the
    // circle it names is deliberately bigger than anything it will hit. Four
    // of the first run's findings were this shape and all four were wrong.
    // A `HIT_RADIUS + size / 2` survives it: a body-size read is not a named
    // length, and that sum really is the reach.
    const boundingQuery = variants.some(
      v =>
        [...v.ids].filter(([key, f]) => f > 0 && NAMED_CONSTANT.test(key)).length >= 2 ||
        // **A cast range plus anything is a pre-filter, never a hit radius.**
        // `this.range + collisionRadius` and `this.range + stats.size.value` are
        // how a targeted spell collects candidates before narrowing them with
        // the real test; the ring the engine already draws at `range` is the
        // honest picture and the sum is not a reach at all.
        (v.ids.size >= 2 && [...v.ids.keys()].some(key => /(^|\.)range$/.test(key)))
    );
    if (boundingQuery) continue;

    // The widest branch of the hit, so a spell is never charged for drawing its
    // own biggest case.
    const hitFactors = new Map();
    for (const v of variants) {
      for (const [key, factor] of v.ids) {
        if (!hitFactors.has(key) || factor > hitFactors.get(key)) hitFactors.set(key, factor);
      }
    }
    if (hitFactors.size === 0) continue;

    const shared = [...hitFactors.keys()].filter(key => drawnIds.has(key));
    if (shared.length > 0) seen.comparable += 1;

    for (const key of shared) {
      const hitFactor = hitFactors.get(key);
      const drawn = widestDrawn.get(key);
      if (hitFactor <= 0 || drawn.factor <= 0) continue;
      const ratio = drawn.factor / hitFactor;
      const signature = `${key}:${fmt(ratio)}`;
      if (reported.has(signature)) continue;
      if (ratio > 1 + TOLERANCE) {
        reported.add(signature);
        findings.push({
          rule: 'drawn-wider-than-it-hits',
          weight: ratio,
          note:
            `${drawn.how} paints ${key} x${fmt(drawn.factor)} but the ${hit.how} is ` +
            `x${fmt(hitFactor)} — ${fmt(ratio)}x wider on screen than it hits (${text})`,
        });
      } else if (ratio < 1 - TOLERANCE) {
        reported.add(signature);
        findings.push({
          rule: 'drawn-narrower-than-it-hits',
          weight: 1 / ratio,
          note:
            `${drawn.how} paints ${key} x${fmt(drawn.factor)} but the ${hit.how} is ` +
            `x${fmt(hitFactor)} — hits ${fmt(1 / ratio)}x past its own edge (${text})`,
        });
      }
    }

    // A term the hit adds and the drawing has no answer for. Only when the two
    // halves already share a name, so this cannot fire on a radius that simply
    // travels somewhere else — and only for an *area* query. A targeted check
    // adds the victim's own body radius so a fat body is still reachable
    // (`LATCH_RADIUS + target.collisionRadius`); nobody is meant to see that,
    // and reporting it was noise on the first run.
    if (shared.length > 0 && hit.how === 'query radius') {
      const missing = [...hitFactors.keys()].filter(key => !drawnIds.has(key));
      if (missing.length > 0) {
        const signature = `missing:${missing.join(',')}`;
        if (!reported.has(signature)) {
          reported.add(signature);
          findings.push({
            rule: 'drawn-narrower-than-it-hits',
            weight: 1.5,
            note:
              `the ${hit.how} adds ${missing.join(' + ')} that nothing is drawn at ` +
              `(${text})`,
          });
        }
      }
    }
    if (shared.length > 0) continue;

    // Shares nothing with the drawing. Only a finding when the file paints at
    // all and never passes the radius on — otherwise it is delegated, which is
    // the shape the fixes for both original bugs used.
    if (!hasDrawMethod(source)) continue;
    // Areas only, and named ones. A `dist <= X` is a *test* — "close enough to
    // hook", "am I there yet" — and nothing about it belongs on screen; an
    // unreadable expression that happens to be unpainted says nothing anyone
    // can act on. This rule is here to name the radius a reader should go and
    // draw, so it speaks only where there is one.
    if (hit.how !== 'query radius') continue;
    const orphans = [...hitFactors.keys()].filter(
      key =>
        NAMED_CONSTANT.test(key) &&
        !NOT_AN_AREA.test(key) &&
        !passed.has(key)
    );
    if (orphans.length === 0) continue;
    const signature = `orphan:${orphans.join(',')}`;
    if (reported.has(signature)) continue;
    reported.add(signature);
    findings.push({
      rule: 'reach-never-painted',
      weight: 1,
      note: `${orphans.join(' + ')} decides the ${hit.how} and is drawn nowhere (${text})`,
    });
  }

  return { findings, seen };
};

/** Every finding in one source file, without touching the disk. */
export function scanSource(source, fileName = 'inline.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  return inspect(sourceFile).findings;
}

/** Every finding under `root`, each tagged with the file it came from. */
export function scanTree(root, labelFrom = resolve(CORE, '..')) {
  const out = [];
  const coverage = { files: 0, withHits: 0, comparable: 0 };
  if (!existsSync(root)) return { findings: out, coverage };
  // A linked pack is reached through `node_modules/@moba2d/content-*`; report
  // it by where it actually lives, or every path in the output is the symlink.
  const realRoot = realpathSync(root);
  for (const file of walk(realRoot)) {
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const { findings, seen } = inspect(sourceFile);
    coverage.files += 1;
    if (seen.hits > 0) coverage.withHits += 1;
    if (seen.comparable > 0) coverage.comparable += 1;
    for (const finding of findings) out.push({ ...finding, file: relative(labelFrom, file) });
  }
  return { findings: out, coverage };
}

/**
 * What to scan when nobody said.
 *
 * Two answers, because there are two callers. Run from core it means core's own
 * game tree plus every pack linked beside it; run from a pack — through the
 * `moba2d-reach-scan` bin, which is the whole reason this ships as one — it
 * means *that* pack, found by walking up to the nearest `package.json` that
 * depends on `@moba2d/core` rather than by counting `..` segments or looking
 * for a directory called `packs`. A separated pack repository has neither.
 */
function defaultRoots() {
  let packRoot = null;
  try {
    packRoot = packRootFrom(process.cwd());
  } catch {
    // Core's own repository, or somewhere with no pack above it.
    packRoot = null;
  }
  if (packRoot) {
    return ['spells', 'monsters', 'items'].map(dir => join(packRoot, dir)).filter(existsSync);
  }
  // Whatever is linked beside core, read from the links themselves — core does
  // not get to know any pack's name (`tests/content/vocabularyBoundary.test.ts`).
  const linked = join(CORE, 'node_modules', '@moba2d');
  const siblings = existsSync(linked)
    ? readdirSync(linked)
        .filter(name => name.startsWith('content-'))
        .flatMap(name => ['spells', 'monsters'].map(dir => join(linked, name, dir)))
        .filter(existsSync)
    : [];
  return [join(CORE, 'src/game/gameObject'), ...siblings];
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
  const consumed = new Set();
  argv.forEach((arg, i) => {
    if (arg === '--max') consumed.add(i).add(i + 1);
    else if (arg.startsWith('--')) consumed.add(i);
  });
  const targets = argv.filter((arg, i) => !consumed.has(i));
  const maxArg = argv.indexOf('--max');
  const max = maxArg === -1 ? null : Number(argv[maxArg + 1]);
  const showCoverage = argv.includes('--coverage');

  const roots = targets.length ? targets.map(t => resolve(t)) : defaultRoots();

  const findings = [];
  const totals = { files: 0, withHits: 0, comparable: 0 };
  const perRoot = [];
  for (const root of roots) {
    const result = scanTree(root);
    findings.push(...result.findings);
    perRoot.push({ root, ...result.coverage });
    totals.files += result.coverage.files;
    totals.withHits += result.coverage.withHits;
    totals.comparable += result.coverage.comparable;
  }

  const byRule = new Map();
  for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);

  console.log(`\nreach-scan: ${findings.length} finding(s) across ${roots.length} tree(s)\n`);
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

  console.log(
    `  coverage: ${totals.comparable} of ${totals.withHits} files with a hit radius ` +
      `could be checked against their own drawing (${totals.files} scanned).\n` +
      '  The rest hand the radius to a SpellObject, which is the recommended\n' +
      '  shape and out of this scan’s reach by design.\n'
  );
  if (showCoverage) {
    for (const row of perRoot) {
      console.log(
        `   ${relative(resolve(CORE, '..'), row.root)}: ${row.comparable}/${row.withHits} comparable, ${row.files} files`
      );
    }
    console.log('');
  }

  if (max !== null && findings.length > max) {
    console.error(`reach-scan: ${findings.length} findings, over the --max of ${max}`);
    process.exit(1);
  }
}
