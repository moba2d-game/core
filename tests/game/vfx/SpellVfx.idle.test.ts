/**
 * An idle `SpellVfx` costs nothing per tick.
 *
 * `Spell.update` calls `update` once per spell per simulation step, and
 * `dispose` once per spell per step for as long as its caster is dead. Nearly
 * all of those calls find nothing playing, and each used to build a `Map`
 * iterator to learn that — two for `dispose`. On a phone running several
 * simulation steps per drawn frame that is a few hundred throwaway iterators a
 * frame from a ten-champion fight.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import SpellVfx from '../../../src/game/vfx/SpellVfx';
import type { CastContext } from '../../../src/game/spell/runtime/types';

const context = {} as CastContext;

/** Counts every way the class walks a `Map`. */
const countMapWalks = () => {
  const walks = { count: 0 };
  const proto = Map.prototype as unknown as Record<PropertyKey, unknown>;
  for (const key of ['values', 'entries', 'keys', 'forEach', Symbol.iterator] as const) {
    const original = proto[key] as (...args: unknown[]) => unknown;
    vi.spyOn(proto as never, key as never).mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      walks.count++;
      return original.apply(this, args);
    } as never);
  }
  return walks;
};

afterEach(() => vi.restoreAllMocks());

describe('SpellVfx with nothing playing', () => {
  it('update walks nothing', () => {
    const vfx = new SpellVfx();
    const walks = countMapWalks();
    for (let i = 0; i < 5; i++) vfx.update(16);
    expect(walks.count).toBe(0);
  });

  it('dispose walks nothing', () => {
    const vfx = new SpellVfx();
    const walks = countMapWalks();
    for (let i = 0; i < 5; i++) vfx.dispose();
    expect(walks.count).toBe(0);
  });
});

describe('SpellVfx with something playing', () => {
  const handle = () => ({ update: vi.fn(), draw: vi.fn(), dispose: vi.fn(), complete: false });
  const sound = () => ({ play: vi.fn(), stop: vi.fn() });

  it('still updates it, and still drops it once it completes', () => {
    const effect = handle();
    const vfx = new SpellVfx({ impact: () => effect });
    vfx.impact(context);

    vfx.update(16);
    expect(effect.update).toHaveBeenCalledWith(16);
    expect(effect.dispose).not.toHaveBeenCalled();

    effect.complete = true;
    vfx.update(16);
    expect(effect.dispose).toHaveBeenCalledOnce();

    vfx.update(16);
    expect(effect.update).toHaveBeenCalledTimes(2);
  });

  it('dispose still stops a looping sound that has no effect beside it', () => {
    const loop = sound();
    const vfx = new SpellVfx({}, { channelLoop: () => loop });
    vfx.channel(context);

    vfx.dispose();
    expect(loop.stop).toHaveBeenCalledOnce();

    // The loop phase is forgotten too, so the next channel starts it again.
    vfx.channel(context);
    expect(loop.play).toHaveBeenCalledTimes(2);
  });

  it('dispose still disposes an effect that has no sound beside it', () => {
    const effect = handle();
    const vfx = new SpellVfx({ castStart: () => effect });
    vfx.castStart(context);

    vfx.dispose();
    expect(effect.dispose).toHaveBeenCalledOnce();
    vfx.dispose();
    expect(effect.dispose).toHaveBeenCalledOnce();
  });
});
