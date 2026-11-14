import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Turret, { DEFAULT_TURRET_PRESET } from '@/game/gameObject/structures/Turret';
import Champion from '@/game/gameObject/attackableUnits/Champion';
import Minion from '@/game/gameObject/attackableUnits/Minion';
import Monster from '@/game/gameObject/attackableUnits/Monster';
import Invisible from '@/game/gameObject/buffs/Invisible';
import Untargetable from '@/game/gameObject/buffs/Untargetable';
import { PredefinedFilters } from '@/game/managers/ObjectManager';
import { Circle } from '@/libs/quadtree';
import TeamId from '@/game/enums/TeamId';
import { Lane, getLaneWaypoints } from '@/game/lanes';
import { createGame, indexObjects, stubGameGlobals, type TestGame } from '../fixtures';

/**
 * **A turret's scan keeps its circle and its predicate between scans, and
 * still asks the question it always asked.**
 *
 * A tower with nothing to shoot rescans every tick, and each scan used to
 * build a `Circle`, a filter array, a type list and three closures. They are
 * the turret's own now. The reference below is the `PredefinedFilters` chain
 * `findTarget` was written with, kept here verbatim: the candidate list the
 * turret hands `pickAggroTarget` has to be that chain's answer, in its order,
 * for every kind of body the chain had an opinion about.
 */
describe("a turret's target scan", () => {
  let game: TestGame;

  beforeEach(() => {
    stubGameGlobals();
    game = createGame();
    game.setPlayer(new Champion({ game, teamId: 'player-uuid', position: createVector(5000, 5000) }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const minion = (teamId: string, x: number, y = 0) =>
    new Minion({
      game,
      teamId,
      position: createVector(x, y),
      waypoints: getLaneWaypoints(Lane.MID, teamId),
      lane: Lane.MID,
    });
  const champion = (teamId: string, x: number, y = 0) =>
    new Champion({ game, teamId, position: createVector(x, y) });
  const monster = (x: number, y: number) =>
    new Monster({
      game,
      preset: {
        name: 'Camp',
        camp: { x, y, r: 100 },
        home: { x, y },
        speed: 2,
        size: 60,
        attackRange: 80,
        reviveTime: 100_000,
        health: 400,
        damage: 5,
      },
    } as ConstructorParameters<typeof Monster>[0]);

  /** The query `findTarget` issued before the scan state moved onto the turret. */
  const reference = (turret: Turret) =>
    game.objectManager.queryObjects({
      area: new Circle({ x: turret.position.x, y: turret.position.y, r: turret.attackRange }),
      filters: [
        PredefinedFilters.includeTypes([Champion, Minion, Monster]),
        PredefinedFilters.canTakeDamageFromTeam(turret.teamId),
        PredefinedFilters.visibleTo(turret),
        PredefinedFilters.excludeStealthed,
      ],
    });

  /** What the turret's own scan found: the first query `findTarget` makes. */
  const scanned = (turret: Turret) => {
    const spy = vi.spyOn(game.objectManager, 'queryObjects');
    turret.findTarget();
    const first = spy.mock.results[0]?.value as unknown[];
    const call = spy.mock.calls[0]?.[0] as { area: Circle; filters: unknown };
    spy.mockRestore();
    return { found: first, area: call.area, filters: call.filters };
  };

  /** One of everything the four filters disagreed about, in and out of range. */
  const board = () => {
    const turret = new Turret({ game, position: createVector(0, 0), teamId: TeamId.BLUE });
    const range = DEFAULT_TURRET_PRESET.attackRange;
    const hidden = champion(TeamId.RED, 140, 60);
    hidden.addBuff(new Invisible(5_000, hidden, hidden));
    hidden.updateBuffs();
    const ghost = champion(TeamId.RED, -150, 40);
    ghost.addBuff(new Untargetable(5_000, ghost, ghost));
    ghost.updateBuffs();
    const corpse = minion(TeamId.RED, 90, -120);
    corpse.die(turret);
    const units = [
      turret,
      minion(TeamId.RED, 300),
      champion(TeamId.RED, 80, 10),
      minion(TeamId.BLUE, 120, 30),
      champion(TeamId.BLUE, -60, -40),
      monster(-200, 150),
      new Turret({ game, position: createVector(200, -200), teamId: TeamId.RED }),
      hidden,
      ghost,
      corpse,
      minion(TeamId.RED, -260, -90),
      champion('solo', 30, 220),
      minion(TeamId.RED, range + 30, 0),
      minion(TeamId.RED, range + 400, 0),
      champion(TeamId.RED, 0, -(range - 5)),
    ];
    indexObjects(game, units);
    return { turret, units };
  };

  it('finds exactly what the filter chain it replaced finds, in the same order', () => {
    const { turret } = board();
    const expected = reference(turret);
    expect(expected.length).toBeGreaterThan(3);
    expect(scanned(turret).found).toEqual(expected);
  });

  it('follows a changed range and a changed side on the very next scan', () => {
    const { turret } = board();
    scanned(turret);

    turret.attackRange = 200;
    expect(scanned(turret).found).toEqual(reference(turret));

    turret.attackRange = DEFAULT_TURRET_PRESET.attackRange + 500;
    turret.teamId = TeamId.RED;
    const flipped = reference(turret);
    expect(flipped.some(unit => unit.teamId === TeamId.BLUE)).toBe(true);
    expect(scanned(turret).found).toEqual(flipped);
  });

  it('asks with the same circle and the same filter list every scan', () => {
    const { turret } = board();
    const first = scanned(turret);
    const second = scanned(turret);
    expect(second.area).toBe(first.area);
    expect(second.filters).toBe(first.filters);
    expect(first.area).toMatchObject({ x: 0, y: 0, r: DEFAULT_TURRET_PRESET.attackRange });
  });

  it('does not share that circle between two turrets', () => {
    const a = new Turret({ game, position: createVector(0, 0), teamId: TeamId.BLUE });
    const b = new Turret({ game, position: createVector(900, 0), teamId: TeamId.RED });
    indexObjects(game, [a, b]);
    expect(scanned(a).area).not.toBe(scanned(b).area);
  });
});
