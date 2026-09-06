/**
 * Every clock in `BotBrain` is an absolute stamp on `matchTimeMs`. A rewind
 * pulls that clock backwards, so a stamp from the erased future would gate
 * its decision shut until time caught back up — the reported shape was a
 * roomful of bots standing still, basic-attacking only at melee range, and
 * holding every spell for a minute. `rewindTo` is the cure; these pin it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ChampionPresetData,
} from '../../../src/game/gameObject/attackableUnits/Champion';
import AIChampion from '../../../src/game/gameObject/attackableUnits/AIChampion';
import { BotBrain } from '../../../src/game/ai/BotBrain';
import { TeamBlackboard, rewindBlackboardFor } from '../../../src/game/ai/TeamBlackboard';
import { createGame, stubGameGlobals, type TestGame } from '../fixtures';

const PRESET: ChampionPresetData = {
  name: 'Test',
  spells: [],
  attack: { damage: 10, attacksPerSecond: 1, range: 100 },
};

const spawnBot = (game: TestGame) =>
  new AIChampion({ game, position: createVector(0, 0), teamId: 'team-blue', preset: PRESET });

/** The private clock fields, reached the way the match never should. */
type BrainClocks = {
  lastThinkAtMs: number;
  lastCastAtMs: number;
  lastDamagedAtMs: number;
  pushBlockedUntilMs: number;
  pendingRecast?: unknown;
};

describe('BotBrain.rewindTo', () => {
  beforeEach(() => stubGameGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('pulls future stamps back so every gate opens at the target time', () => {
    const game = createGame();
    const brain = new BotBrain(spawnBot(game));
    const clocks = brain as unknown as BrainClocks;
    clocks.lastThinkAtMs = 90_000;
    clocks.lastCastAtMs = 92_000;
    clocks.lastDamagedAtMs = 91_000;
    clocks.pushBlockedUntilMs = 95_000;
    clocks.pendingRecast = { nextAtMs: 93_000 };

    brain.rewindTo(30_000);

    expect(clocks.lastThinkAtMs).toBeLessThanOrEqual(30_000);
    expect(clocks.lastCastAtMs).toBe(Number.NEGATIVE_INFINITY);
    expect(clocks.lastDamagedAtMs).toBe(Number.NEGATIVE_INFINITY);
    expect(clocks.pushBlockedUntilMs).toBe(Number.NEGATIVE_INFINITY);
    expect(clocks.pendingRecast).toBeUndefined();
  });

  it('leaves a stamp already in the past alone', () => {
    const game = createGame();
    const brain = new BotBrain(spawnBot(game));
    const clocks = brain as unknown as BrainClocks;
    clocks.lastThinkAtMs = 10_000;
    clocks.lastCastAtMs = 12_000;

    brain.rewindTo(30_000);

    expect(clocks.lastThinkAtMs).toBe(10_000);
    expect(clocks.lastCastAtMs).toBe(12_000);
  });
});

describe('TeamBlackboard.rewind', () => {
  it('forgets the board built in the erased future', () => {
    const board = new TeamBlackboard();
    const inner = board as unknown as { builtAtMs: number; views: Map<unknown, unknown> };
    inner.builtAtMs = 90_000;
    inner.views.set('team-blue', { allies: [] });

    board.rewind();

    expect(inner.builtAtMs).toBe(Number.NEGATIVE_INFINITY);
    expect(inner.views.size).toBe(0);
    expect(board.viewFor('team-blue').allies).toEqual([]);
  });

  it('is a no-op for a host that never built one', () => {
    expect(() => rewindBlackboardFor({})).not.toThrow();
  });
});
