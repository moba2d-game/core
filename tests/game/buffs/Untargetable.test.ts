import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/managers/AssetManager', () => ({
  default: { get: () => undefined, getAsset: () => undefined, renderable: () => undefined },
}));

import AttackableUnit from '../../../src/game/gameObject/attackableUnits/AttackableUnit';
import Untargetable from '../../../src/game/gameObject/buffs/Untargetable';
import { createGame, stubGameGlobals } from '../fixtures';

/**
 * The rings say "you cannot click this". They must never say "something is
 * standing here".
 *
 * `Pet.setHidden` pairs this buff with `Invisible` on every trap and every
 * hiding summon in the game, and a stealthed body fades to alpha 20 — so a
 * fixed ring alpha drew three bright circles around a unit whose entire
 * purpose was to be unfindable. A buried box was a ring of light on an empty
 * patch of ground.
 */
let spies: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  spies = stubGameGlobals();
});
afterEach(() => vi.unstubAllGlobals());

const ringAlphas = (): number[] =>
  spies.stroke.mock.calls.map(call => call[3] as number).filter(alpha => alpha !== undefined);

describe('the untargetable rings fade with the body they surround', () => {
  const ringed = (alpha: number) => {
    const game = createGame();
    const unit = new AttackableUnit({ game, position: createVector(0, 0) } as never);
    unit.animatedValues.alpha = alpha;
    unit.animatedValues.displaySize = 50;
    const buff = new Untargetable(1_000, unit, unit);
    spies.stroke.mockClear();
    spies.circle.mockClear();
    buff.draw();
    return { rings: spies.circle.mock.calls.length, alphas: ringAlphas() };
  };

  it('paints them at full strength on a body in plain sight', () => {
    const { rings, alphas } = ringed(255);

    expect(rings).toBe(3);
    expect(Math.max(...alphas)).toBeCloseTo(130, 5);
  });

  it('paints them at the stealth alpha on a hidden body', () => {
    // 20 is what `AttackableUnit.update` fades a stealthed unit to.
    const { rings, alphas } = ringed(20);

    expect(rings).toBe(3);
    expect(Math.max(...alphas)).toBeLessThan(12);
  });

  it('draws nothing at all once the body is fully transparent', () => {
    const { rings } = ringed(0);

    expect(rings).toBe(0);
  });
});
