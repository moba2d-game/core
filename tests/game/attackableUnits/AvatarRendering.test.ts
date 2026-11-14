import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AttackableUnit from '../../../src/game/gameObject/attackableUnits/AttackableUnit';
import Champion from '../../../src/game/gameObject/attackableUnits/Champion';
import AssetManager from '../../../src/managers/AssetManager';
import { createGame, stubGameGlobals } from '../fixtures';

let spies: Record<string, ReturnType<typeof vi.fn>>;
let context: {
  globalAlpha: number;
  save: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  clip: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  strokeStyle?: string;
  fillStyle?: string;
  lineWidth?: number;
};

beforeEach(() => {
  spies = stubGameGlobals();
  context = {
    globalAlpha: 1,
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    clip: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  };
  vi.stubGlobal('drawingContext', context);
});
afterEach(() => vi.unstubAllGlobals());

describe('AttackableUnit avatar transparency', () => {
  it('uses native canvas alpha instead of p5 tint', () => {
    const game = createGame();
    const unit = new AttackableUnit({ game, position: createVector(0, 0) });
    game.setPlayer(unit);
    unit.animatedValues.displaySize = 50;
    unit.animatedValues.alpha = 128;

    unit.drawAvatar();

    expect(spies.tint).not.toHaveBeenCalled();
    expect(context.globalAlpha).toBeCloseTo(128 / 255);
  });

  it('keeps health, mana and shield bars but omits text and ticks in compact mode', () => {
    const game = createGame();
    Object.assign(game.camera, { constantSize: (pixels: number) => pixels });
    const champion = new Champion({ game, position: createVector(50, 50) });
    game.setPlayer(champion);
    champion.stats.health.baseValue = champion.stats.maxHealth.value / 2;
    champion.stats.mana.baseValue = champion.stats.maxMana.value / 2;

    champion.drawHealthBar(true);

    // Backing, health and mana — through the native context, not p5.
    expect(context.fillRect.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(spies.rect).not.toHaveBeenCalled();
    expect(spies.push).not.toHaveBeenCalled();
    expect(spies.text).not.toHaveBeenCalled();
    expect(spies.line).not.toHaveBeenCalled();
  });

  // Every unit on screen pays for its frame every frame. As p5 calls —
  // `push`, `fill([...])`, `stroke([...])`, `circle`, `image`, `pop` — one
  // avatar measured ~0.6ms on a Helio P35; natively it is about half that.
  it('paints the team ring and the dead shade without p5', () => {
    const game = createGame();
    const unit = new AttackableUnit({ game, position: createVector(10, 20) });
    game.setPlayer(unit);
    unit.animatedValues.displaySize = 50;

    unit.drawAvatar();

    for (const name of ['push', 'pop', 'fill', 'stroke', 'circle', 'noStroke']) {
      expect(spies[name], `p5 ${name}()`).not.toHaveBeenCalled();
    }
    // The clip's disc and the ring's: the same circle, traced twice.
    expect(context.arc.mock.calls.map(call => call.slice(0, 3))).toEqual([
      [10, 20, 25],
      [10, 20, 25],
    ]);
    expect(context.stroke).toHaveBeenCalledTimes(1);
    expect(context.strokeStyle).toBe('rgb(0, 255, 0)');
    expect(context.lineWidth).toBe(2);
    expect(context.fill, 'no shade on the living').not.toHaveBeenCalled();
    expect(context.save.mock.calls.length).toBe(context.restore.mock.calls.length);

    unit.die({ reviveAfter: 1000 });
    unit.drawAvatar();
    expect(context.fill).toHaveBeenCalledTimes(1);
    expect(context.fillStyle).toBe('rgba(0, 0, 0, 0.784)');
  });

  it('blits a canvas-backed portrait natively, centred, and leaves anything else to p5', () => {
    const game = createGame();
    const unit = new AttackableUnit({ game, position: createVector(100, 100) });
    game.setPlayer(unit);
    unit.animatedValues.displaySize = 40;
    const canvas = { width: 64, height: 64 };
    const renderable = vi.spyOn(AssetManager, 'renderable');

    renderable.mockReturnValue({ canvas });
    unit.drawAvatar();
    expect(context.drawImage).toHaveBeenCalledWith(canvas, 80, 80, 40, 40);
    expect(spies.image).not.toHaveBeenCalled();

    // A GIF's current frame is something only p5 advances.
    renderable.mockReturnValue({ canvas, gifProperties: {} });
    unit.drawAvatar();
    expect(context.drawImage).toHaveBeenCalledTimes(1);
    expect(spies.image).toHaveBeenCalledTimes(1);
    renderable.mockRestore();
  });

  it('draws the buff row natively and only reaches p5 for a stack count', () => {
    const game = createGame();
    Object.assign(game.camera, { constantSize: (pixels: number) => pixels });
    const champion = new Champion({ game, position: createVector(50, 50) });
    game.setPlayer(champion);
    const canvas = { width: 32, height: 32 };
    const renderable = vi.spyOn(AssetManager, 'renderable').mockReturnValue({ canvas });
    const buff = (stackId: string, stacks: number) =>
      ({ image: { key: stackId }, stackId, stacks }) as never;
    champion.buffs.push(buff('a', 1), buff('b', 1));

    champion.drawHealthBar(true);

    expect(context.drawImage).toHaveBeenCalledTimes(2);
    // 20px icons, side by side, centred on their own cursor.
    expect(context.drawImage.mock.calls[1][1] - context.drawImage.mock.calls[0][1]).toBe(20);
    for (const name of ['push', 'image', 'tint', 'text']) {
      expect(spies[name], `p5 ${name}()`).not.toHaveBeenCalled();
    }

    champion.buffs.push(buff('c', 4));
    champion.drawHealthBar(true);
    expect(spies.text.mock.calls.map(call => call[0])).toEqual([4]);
    expect(spies.image).not.toHaveBeenCalled();
    renderable.mockRestore();
  });
});
