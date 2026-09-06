import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/managers/AssetManager', () => ({
  default: { get: () => undefined, getAsset: () => undefined, renderable: () => undefined },
}));

import { createGame, stubGameGlobals } from '../fixtures';
import Champion from '../../../src/game/gameObject/attackableUnits/Champion';
import Pet from '../../../src/game/gameObject/attackableUnits/Pet';

/**
 * A summon wears a smaller badge than a champion.
 *
 * The full frame is 125px wide and paints a score box, a mana strip, level
 * ticks, buff icons and status text. A pet has no score to show (it inherits
 * `score = 0` from `Champion` and never changes it), casts nothing so its mana
 * pool is always empty, and dies in seconds — so on a Tibbers or a Shaco box that
 * frame is almost entirely empty chrome, and there can be four of them on
 * screen at once covering the fight they are meant to explain.
 *
 * The compact frame already existed for mobile. This is the same frame, chosen
 * by what the unit *is* rather than by how far the camera happens to be zoomed
 * out.
 */
let spies: Record<string, ReturnType<typeof vi.fn>>;

function makeGame() {
  const game = createGame();
  Object.assign(game.camera, {
    currentScale: 1,
    constantSize: (px: number) => px,
  });
  return game;
}

function champion(game: ReturnType<typeof makeGame>): Champion {
  const unit = new Champion({ game, position: createVector(0, 0) } as never);
  unit.stats.health.baseValue = 50;
  unit.stats.maxHealth.baseValue = 100;
  return unit;
}

function pet(game: ReturnType<typeof makeGame>, ownerUnit: Champion): Pet {
  const unit = new Pet({
    game,
    position: createVector(0, 0),
    ownerUnit,
    lifeTimeMs: 5_000,
  } as never);
  unit.stats.health.baseValue = 50;
  unit.stats.maxHealth.baseValue = 100;
  return unit;
}

beforeEach(() => {
  spies = stubGameGlobals();
});
afterEach(() => vi.unstubAllGlobals());

describe('a pet gets the compact health frame', () => {
  it('draws the narrow bar, not the 125px champion frame', () => {
    const game = makeGame();
    const owner = champion(game);
    game.setPlayer(owner);
    const summon = pet(game, owner);

    summon.drawHealthBar();

    const widths = spies.rect.mock.calls.map(call => call[2]);
    expect(widths.some(w => Math.abs(w - 125) < 0.01)).toBe(false);
    expect(widths.some(w => w <= 60)).toBe(true);
  });

  it('paints no score, because a summon has none to paint', () => {
    const game = makeGame();
    const owner = champion(game);
    game.setPlayer(owner);
    const summon = pet(game, owner);

    summon.drawHealthBar();

    expect(spies.text).not.toHaveBeenCalled();
  });

  it('paints no mana strip when the unit has no mana pool', () => {
    const game = makeGame();
    const owner = champion(game);
    game.setPlayer(owner);
    const summon = pet(game, owner);
    summon.stats.maxMana.baseValue = 0;

    const before = spies.rect.mock.calls.length;
    summon.drawHealthBar();
    const drawn = spies.rect.mock.calls.slice(before);

    // backing + health only; a mana strip would be a third rect at a smaller
    // height sitting below the health one
    expect(drawn.length).toBeLessThanOrEqual(2);
  });

  // The control. Without it the pet assertions above would pass just as well if
  // the full frame had been broken for everyone, which is the likelier mistake.
  it('leaves the champion frame alone', () => {
    const game = makeGame();
    const owner = champion(game);
    game.setPlayer(owner);

    owner.drawHealthBar();
    // The full champion frame paints through the native context; the compact
    // pet frame stays on p5 — so each side reads its own spy.
    const ctxRect = vi.mocked(drawingContext.fillRect);
    const ctxText = vi.mocked(drawingContext.fillText);
    const championWidest = Math.max(...ctxRect.mock.calls.map(call => call[2] as number));
    const championTexts = ctxText.mock.calls.length;

    ctxRect.mockClear();
    ctxText.mockClear();
    spies.rect.mockClear();
    spies.text.mockClear();
    pet(game, owner).drawHealthBar();
    const petWidest = Math.max(...spies.rect.mock.calls.map(call => call[2]));

    // the champion keeps its wide frame and its score; the pet gets neither
    expect(championWidest).toBeGreaterThan(petWidest * 1.8);
    expect(championTexts).toBeGreaterThan(0);
    expect(spies.text).not.toHaveBeenCalled();
    expect(ctxText).not.toHaveBeenCalled();
  });
});

/**
 * The one summon that must not wear the badge.
 *
 * A decoy exists to be mistaken for the champion that made it, and everything
 * the block above is proud of — a narrow bar, no score, a clock under the feet
 * — is a label saying "this one is the fake". `disguisedAsChampion` hands the
 * frame back.
 */
describe('a decoy wears the champion frame instead', () => {
  it('draws the full frame and its score, the same as the body it copies', () => {
    const game = makeGame();
    const owner = champion(game);
    game.setPlayer(owner);
    const decoy = pet(game, owner);
    decoy.disguisedAsChampion = true;

    const ctxRect = vi.mocked(drawingContext.fillRect);
    const ctxText = vi.mocked(drawingContext.fillText);
    ctxRect.mockClear();
    ctxText.mockClear();

    decoy.drawHealthBar();

    // The champion frame paints through the native context; the summon badge
    // never leaves p5, so reading the two spies separates them cleanly.
    const widest = Math.max(...ctxRect.mock.calls.map(call => call[2] as number));
    expect(widest).toBeGreaterThan(120);
    expect(ctxText).toHaveBeenCalled();
    expect(spies.rect).not.toHaveBeenCalled();
  });

  it('compacts to the champion width too, so the zoom never gives it away', () => {
    const game = makeGame();
    const owner = champion(game);
    game.setPlayer(owner);
    const ordinary = pet(game, owner);
    const decoy = pet(game, owner);
    decoy.disguisedAsChampion = true;

    ordinary.drawHealthBar(true);
    const summonBar = Math.max(...spies.rect.mock.calls.map(call => call[2]));
    spies.rect.mockClear();
    decoy.drawHealthBar(true);
    const decoyBar = Math.max(...spies.rect.mock.calls.map(call => call[2]));

    // At mobile zoom every unit wears the compact frame, and a summon's is
    // deliberately narrower than a champion's. A decoy asks for the champion's
    // — whatever that currently is — rather than restating a number.
    expect(summonBar).toBeLessThan(decoyBar);
  });

  it('paints no lifetime clock under its feet', () => {
    const game = makeGame();
    const owner = champion(game);
    game.setPlayer(owner);
    const ordinary = pet(game, owner);
    const decoy = pet(game, owner);
    decoy.disguisedAsChampion = true;

    ordinary.draw();
    const withClock = spies.rect.mock.calls.length;
    spies.rect.mockClear();
    decoy.draw();

    // Everything the ordinary summon painted through p5 is the badge plus the
    // clock; the decoy paints neither, so the gap is the whole of both.
    expect(withClock).toBeGreaterThan(0);
    expect(spies.rect).not.toHaveBeenCalled();
  });
});

/**
 * A hidden summon is a trap, and the frame around it was giving every one of
 * them away — worst of all `Untargetable`'s three pulsing rings, which
 * `setHidden` pairs with `Invisible` and which used to be painted at a fixed
 * alpha while the body under them faded to 20.
 */
describe('a hidden summon paints nothing but its own picture', () => {
  it('draws no health frame, no clock and no buffs while it is hidden', () => {
    const game = makeGame();
    const owner = champion(game);
    game.setPlayer(owner);
    const trap = pet(game, owner);

    trap.draw();
    expect(spies.rect, 'the control: in the open it paints its badge').toHaveBeenCalled();

    trap.setHidden(true);
    expect(trap.hidden).toBe(true);
    spies.rect.mockClear();
    const buffs = vi.spyOn(trap, 'drawBuffs');

    trap.draw();

    expect(spies.rect).not.toHaveBeenCalled();
    expect(buffs).not.toHaveBeenCalled();
  });
});
