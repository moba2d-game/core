/**
 * The three walks that run for every object on every simulation step build no
 * closure to do it.
 *
 * A phone that is behind runs several simulation steps per drawn frame, so
 * "once per object per step" is the hottest multiplier in the game:
 * `ObjectManager.update` over every object, `Champion.update` over every
 * champion, `Spell.update` over every spell every champion carries — about a
 * hundred of those in a ten-champion fight. Each used to allocate an arrow
 * function per iteration purely to pass a body to a helper (`attributed`,
 * `forEach`).
 *
 * A source scan, because the mistake is a shape and has no behaviour to
 * observe: the helper form and the written-out form do the same thing. What
 * the bracket *does* is held by `tests/game/combat/DamageAttribution.test.ts`.
 * Comments are stripped first, or the scan would flag its own explanation.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = (path: string) =>
  readFileSync(join(__dirname, '../../src', path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** The body of the method starting at `signature`, up to the method's closing brace. */
const methodBody = (text: string, signature: string) => {
  const start = text.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const end = text.indexOf('\n  }\n', start);
  expect(end, `${signature} has no end`).toBeGreaterThan(start);
  return text.slice(start, end);
};

describe('per-object, per-tick walks allocate no closure', () => {
  it('ObjectManager.update brackets each object without one', () => {
    const body = methodBody(source('game/managers/ObjectManager.ts'), '\n  update(): void {');
    const perObject = body.slice(0, body.indexOf('toRemove'));
    expect(perObject).toContain('o.update?.()');
    expect(perObject).not.toMatch(/=>/);
  });

  it('Spell.update brackets its runtime without one', () => {
    const body = methodBody(source('game/gameObject/Spell.ts'), '\n  update(): void {');
    expect(body).toContain('this.runtime.update(deltaTime)');
    expect(body).not.toMatch(/=>/);
  });

  it('Spell.runtime, read four times per spell per tick, is a field read and nothing else', () => {
    const body = methodBody(
      source('game/gameObject/Spell.ts'),
      '\n  private get runtime(): SpellRuntime {'
    );
    expect(body).toContain('this.spellRuntime');
    expect(body).not.toMatch(/=>/);
    const lines = body.split('\n').filter(line => line.trim() !== '');
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it('Champion.update walks its spells without one', () => {
    const body = methodBody(
      source('game/gameObject/attackableUnits/Champion.ts'),
      '\n  update() {'
    );
    expect(body).toMatch(/spells\[i\]\.update\(\)/);
    expect(body).not.toMatch(/=>/);
  });
});
