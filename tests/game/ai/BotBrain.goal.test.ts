import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Champion, {
  type ChampionPresetData,
} from '../../../src/game/gameObject/attackableUnits/Champion';
import AIChampion from '../../../src/game/gameObject/attackableUnits/AIChampion';
import {
  ASSIST_RANGE,
  BotBrain,
  GROUP_PX,
  ROAM_RADIUS,
  type Posture,
} from '../../../src/game/ai/BotBrain';
import {
  TeamBlackboard,
  type GoalArea,
  type SeenEnemy,
  type TeamView,
} from '../../../src/game/ai/TeamBlackboard';
import type { LaneState } from '../../../src/game/ai/LaneObjectives';
import { createGame, indexObjects, stubGameGlobals, type TestGame } from '../fixtures';
import { driveTicks, FRAMES_PER_THINK } from './botTrajectory';
import { THINK_INTERVAL_MS } from '../../../src/game/ai/BotBrain';

/**
 * A map that names a place for bots to be (the poison zone's safe circle).
 * Everything here is trajectory, not destination: the bug it guards was a bot
 * that walked off toward a fountain in the poison, and teams that never met.
 */

const PRESET: ChampionPresetData = {
  name: 'Test',
  spells: [],
  attack: { damage: 10, attacksPerSecond: 1, range: 100 },
};
const BLUE = 'team-blue';
const RED = 'team-red';
const GOAL: GoalArea = { x: 2000, y: 2000, r: 900 };
const insideGoal = (p: { x: number; y: number }, goal = GOAL) =>
  Math.hypot(p.x - goal.x, p.y - goal.y) <= goal.r;

const spawn = (game: TestGame, team: string, x: number, y: number) =>
  new AIChampion({ game, position: createVector(x, y), teamId: team, preset: PRESET });

const view = (over: Partial<TeamView> = {}): TeamView => ({
  allies: [],
  enemies: [],
  focusTarget: null,
  rally: null,
  memory: new Map<Champion, SeenEnemy>(),
  lanes: new Map<string, LaneState>(),
  laneAssignments: new Map<Champion, string>(),
  enemyTurrets: [],
  ...over,
});

const centroid = (units: readonly Champion[]) => ({
  x: units.reduce((sum, unit) => sum + unit.position.x, 0) / units.length,
  y: units.reduce((sum, unit) => sum + unit.position.y, 0) / units.length,
});

describe('a map with a goal area', () => {
  beforeEach(() => stubGameGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('walks a bot that is outside the area back in', () => {
    const game = createGame();
    const bot = spawn(game, BLUE, 200, 200);
    game.setPlayer(bot);
    indexObjects(game, [bot]);
    const board = view({ allies: [bot], rally: { x: 200, y: 200 }, goal: GOAL });

    const trace = driveTicks(new BotBrain(bot), bot, board, 80);

    expect(trace.postures[0]).toBe('REACH_AREA');
    expect(insideGoal(trace.samples[trace.samples.length - 1].position)).toBe(true);
    // ...and stays: no walking back out once it is in.
    const home = trace.from(60);
    expect(home.samples.every(sample => insideGoal(sample.position))).toBe(true);
  });

  it('does not walk a hurt bot into the poison on its way to a fountain', () => {
    const game = createGame();
    const bot = spawn(game, BLUE, 2300, 2000);
    game.setPlayer(bot);
    indexObjects(game, [bot]);
    (game as unknown as { fountains: unknown[] }).fountains = [
      { teamId: BLUE, position: createVector(200, 200), radius: 150 },
    ];
    bot.stats.health.baseValue = bot.stats.maxHealth.value * 0.1;
    const board = view({ allies: [bot], rally: { x: 2300, y: 2000 }, goal: GOAL });

    const trace = driveTicks(new BotBrain(bot), bot, board, 60);

    expect(trace.samples.every(sample => insideGoal(sample.position))).toBe(true);
    expect(trace.distancesFrom({ x: 200, y: 200 }).every(d => d > 1_500)).toBe(true);
  });

  it('a hurt bot shelters near its ally, away from the enemy it has seen', () => {
    const game = createGame();
    const bot = spawn(game, BLUE, 2000, 2000);
    const mate = spawn(game, BLUE, 1500, 2000);
    const foe = new Champion({ game, position: createVector(2700, 2000), teamId: RED, preset: PRESET });
    game.setPlayer(bot);
    indexObjects(game, [bot, mate, foe]);
    (game as unknown as { fountains: unknown[] }).fountains = [
      { teamId: BLUE, position: createVector(200, 200), radius: 150 },
    ];
    bot.stats.health.baseValue = bot.stats.maxHealth.value * 0.1;
    const memory = new Map<Champion, SeenEnemy>([
      [foe, { unit: foe, atMs: 0, pos: { x: 2700, y: 2000 }, vel: { x: 0, y: 0 } }],
    ]);
    const board = view({ allies: [bot, mate], enemies: [foe], memory, rally: { x: 1750, y: 2000 }, goal: GOAL });
    const trace = driveTicks(new BotBrain(bot), bot, board, 40);
    const end = trace.samples[trace.samples.length - 1].position;
    expect(insideGoal(end)).toBe(true);
    // Never closer to the enemy than it started.
    expect(trace.distancesFrom({ x: 2700, y: 2000 }).every(d => d >= 690)).toBe(true);
  });

  it('two idle teams of two converge and stay together', () => {
    const game = createGame();
    const blue = [spawn(game, BLUE, 600, 1000), spawn(game, BLUE, 600, 1250)];
    const red = [spawn(game, RED, 3400, 1000), spawn(game, RED, 3400, 1250)];
    game.setPlayer(blue[0]);
    indexObjects(game, [...blue, ...red]);
    const area: GoalArea = { x: 2000, y: 1100, r: 2300 };
    const brains = new Map([...blue, ...red].map(bot => [bot, new BotBrain(bot)] as const));
    for (const brain of brains.values()) brain.sees = () => false; // fog: nobody perceives anybody

    const viewOf = (own: Champion[], other: Champion[]): TeamView =>
      view({ allies: own, enemies: other, rally: centroid(own), goal: area });
    let closest = Number.POSITIVE_INFINITY;
    let widest = 0;
    const ticks = 160; // 40 s
    for (let tick = 0; tick < ticks; tick += 1) {
      const nowMs = tick * THINK_INTERVAL_MS;
      for (const [own, other] of [
        [blue, red],
        [red, blue],
      ] as const) {
        const board = viewOf(own, other);
        for (const bot of own) {
          const brain = brains.get(bot)!;
          const posture = brain.evaluatePosture(board, nowMs, null);
          brain.drive(posture, board, null, nowMs);
        }
      }
      for (const bot of [...blue, ...red]) {
        const dx = bot.destination.x - bot.position.x;
        const dy = bot.destination.y - bot.position.y;
        const away = Math.hypot(dx, dy);
        const step = Math.min(away, bot.moveSpeed * FRAMES_PER_THINK);
        if (away > 0) bot.position.set(bot.position.x + (dx / away) * step, bot.position.y + (dy / away) * step);
      }
      for (const a of blue) for (const b of red) closest = Math.min(closest, a.position.dist(b.position));
      widest = Math.max(
        widest,
        blue[0].position.dist(blue[1].position),
        red[0].position.dist(red[1].position)
      );
    }

    expect(closest).toBeLessThan(ASSIST_RANGE);
    expect(widest).toBeLessThan(GROUP_PX * 2 + ROAM_RADIUS);
  });

  it('a bot joins an ally that is fighting from further than the normal assist range', () => {
    const game = createGame();
    const bot = spawn(game, BLUE, 2000, 2000);
    const mate = spawn(game, BLUE, 2000, 3000);
    const foe = new Champion({ game, position: createVector(2000, 3900), teamId: RED, preset: PRESET });
    game.setPlayer(bot);
    indexObjects(game, [bot, mate, foe]);
    const area: GoalArea = { x: 2000, y: 2500, r: 3000 };
    mate.basicAttack.order(foe);
    const board = (goal?: GoalArea) =>
      view({ allies: [bot, mate], enemies: [foe], focusTarget: foe, rally: centroid([bot, mate]), goal });
    // 900px from the fighter's target: out of ASSIST_RANGE, inside the widened one.
    const brain = new BotBrain(bot);
    brain.sees = () => false;
    expect(brain.evaluatePosture(board(area), 0, null)).toBe('ENGAGE');
    expect(brain.evaluatePosture(board(), 0, null)).toBe('ROAM');
  });

  it('is exactly the old behaviour on a map with none', () => {
    const game = createGame();
    const bot = spawn(game, BLUE, 200, 200);
    game.setPlayer(bot);
    indexObjects(game, [bot]);
    const rally = { x: 200, y: 200 };
    const trace = driveTicks(new BotBrain(bot), bot, view({ allies: [bot], rally }), 20);
    const seen = new Set<Posture>(trace.postures);
    expect([...seen]).toEqual(['ROAM']);
    for (const sample of trace.samples) {
      expect(Math.hypot(sample.position.x - rally.x, sample.position.y - rally.y)).toBeLessThanOrEqual(
        ROAM_RADIUS + 1
      );
    }
  });
});

describe('TeamBlackboard reads the goal once per snapshot', () => {
  beforeEach(() => stubGameGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('hands each team its own area, from the match clock it was given', () => {
    const game = createGame();
    const bot = spawn(game, BLUE, 0, 0);
    const foe = spawn(game, RED, 100, 0);
    game.setPlayer(bot);
    indexObjects(game, [bot, foe]);
    const asked: [unknown, number][] = [];
    const host = {
      objectManager: (game as unknown as { objectManager: { objects: never[] } }).objectManager,
      botGoalArea: (teamId: unknown, nowMs: number) => {
        asked.push([teamId, nowMs]);
        return teamId === BLUE ? GOAL : null;
      },
    };
    const board = new TeamBlackboard();
    board.refreshIfStale(host, 300_000, () => false);
    board.refreshIfStale(host, 300_100, () => false); // inside the TTL: not asked again
    expect(board.viewFor(BLUE).goal).toEqual(GOAL);
    expect(board.viewFor(RED).goal).toBeNull();
    expect(asked.every(([, at]) => at === 300_000)).toBe(true);
    expect(asked).toHaveLength(2);
  });
});
