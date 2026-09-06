import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Turret, {
  DEFAULT_TURRET_PRESET,
  TurretBolt,
} from '../../../src/game/gameObject/structures/Turret';
import Minion from '../../../src/game/gameObject/attackableUnits/Minion';
import Champion from '../../../src/game/gameObject/attackableUnits/Champion';
import TeamId from '../../../src/game/enums/TeamId';
import { Lane, getLaneWaypoints } from '../../../src/game/lanes';
import { PredefinedFilters } from '../../../src/game/managers/ObjectManager';
import { createGame, indexObjects, stubGameGlobals, type TestGame } from '../fixtures';

/**
 * The husk model: destroyed stays destroyed for the match.
 *
 * A turret at 0 HP used to run a rebuild clock and stand back up on its own.
 * Now the body stays in the world as rubble — in `Game.turrets`, in the
 * object list — with its death clock pinned to `Infinity`, and only
 * `respawn()` (the seam the "Mốc đã lưu" rewind and `MatchDirector`'s reset
 * use) revives it. That permanence is what makes a destroyed tower
 * *restorable*: a rewind writes the moment's numbers onto the same live
 * instance, exactly the way a jungle camp's persistent corpse already works.
 *
 * Deliberately its own file rather than more of `Turret.test.ts`: that suite
 * imports a pack's map data and is excluded on a checkout without the pack,
 * and the husk rules must hold on every checkout.
 */
describe('the turret husk', () => {
  let game: TestGame;

  const makeTurret = (teamId: string, x = 0, y = 0) =>
    new Turret({ game, position: createVector(x, y), teamId });

  const makeMinion = (teamId: string, x: number, y = 0) =>
    new Minion({
      game,
      teamId,
      position: createVector(x, y),
      waypoints: getLaneWaypoints(Lane.MID, teamId),
      lane: Lane.MID,
    });

  beforeEach(() => {
    stubGameGlobals();
    game = createGame();
    game.setPlayer(new Champion({ game, teamId: 'player-uuid' }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('falls into rubble and stands back up when the rebuild clock runs out', () => {
    const turret = makeTurret(TeamId.BLUE, 400, 400);
    expect(turret.reviveTime).toBe(DEFAULT_TURRET_PRESET.rebuildTime);

    turret.takeDamage(DEFAULT_TURRET_PRESET.health, undefined);
    expect(turret.isDead).toBe(true);
    expect(turret.toRemove).toBe(false);
    expect(turret.deathData?.reviveAfter).toBe(DEFAULT_TURRET_PRESET.rebuildTime);

    // 2500 ticks at the stubbed 16ms is 40 simulated seconds — past the 30s
    // rebuild, so the tower is back where it stood, at full health.
    for (let i = 0; i < 2500; i++) turret.update();
    expect(turret.isDead).toBe(false);
    expect(turret.toRemove).toBe(false);
    expect(turret.stats.health.value).toBe(DEFAULT_TURRET_PRESET.health);
  });

  it("normalizes a caller's own clock onto the preset's — the LAN client path", () => {
    const turret = makeTurret(TeamId.BLUE);
    // What `ClientSession.applyUnitSnap` does on a host "dead" snapshot: a
    // far-future clock that would leave a client's rubble standing an hour
    // under a host whose tower is long back.
    turret.die({ reviveAfter: 3_600_000 });
    expect(turret.deathData?.reviveAfter).toBe(DEFAULT_TURRET_PRESET.rebuildTime);
  });

  it('never fires while dead, whatever stands in range', () => {
    const turret = makeTurret(TeamId.BLUE);
    const minion = makeMinion(TeamId.RED, 200);
    indexObjects(game, [turret, minion]);
    turret.takeDamage(DEFAULT_TURRET_PRESET.health, undefined);
    turret._attackCooldown = 0;

    turret.update();

    expect(turret.target).toBeNull();
    expect(game.objectManager._objectToBeAdd.some(o => o instanceof TurretBolt)).toBe(false);
  });

  it('fails the standard dead exclusions every acquiring scan already runs', () => {
    const husk = makeTurret(TeamId.BLUE, 10, 0);
    husk.takeDamage(DEFAULT_TURRET_PRESET.health, undefined);

    // A wave's aggro, a champion's acquisition and a spell's search all
    // filter through `canTakeDamageFromTeam`/`excludeDead`; a husk fails the
    // same predicates a corpse does, so nothing needs a turret special case.
    expect(PredefinedFilters.canTakeDamageFromTeam(TeamId.RED)(husk)).toBe(false);
    expect(PredefinedFilters.excludeDead(husk)).toBe(false);
    // Rubble blocks nobody's walking, and lights no fog.
    expect(husk.collidesWithUnits).toBe(false);
    expect(PredefinedFilters.includeDead(husk)).toBe(true);
  });

  it('pays the killing blow once, and a husk cannot be paid again', () => {
    const turret = makeTurret(TeamId.BLUE);
    const killer = new Champion({ game, teamId: 'solo', position: createVector(600, 0) });
    indexObjects(game, [turret, killer]);
    const before = killer.wallet?.balance ?? 0;

    turret.takeDamage(DEFAULT_TURRET_PRESET.health, killer);
    expect(turret.isDead).toBe(true);
    expect(killer.wallet?.balance).toBe(before + turret.goldBounty);

    // A stray swing on rubble pays nothing and changes nothing.
    turret.takeDamage(1_000, killer);
    expect(killer.wallet?.balance).toBe(before + turret.goldBounty);
    expect(turret.isDead).toBe(true);
  });

  it('respawn() still rebuilds in place — the seam rewind and reset use', () => {
    const turret = makeTurret(TeamId.BLUE, 400, 400);
    turret.takeDamage(DEFAULT_TURRET_PRESET.health, undefined);

    turret.respawn();

    expect(turret.deathData).toBeNull();
    expect(turret.stats.health.value).toBe(DEFAULT_TURRET_PRESET.health);
    expect(turret.position).toMatchObject({ x: 400, y: 400 });
  });

  it('a revived tower hangs its passives again, and only on the transition', () => {
    let hung = 0;
    const turret = new Turret({
      game,
      position: createVector(0, 0),
      teamId: TeamId.BLUE,
      preset: {
        ...DEFAULT_TURRET_PRESET,
        passives: [{ name: 'Probe', onSpawn: () => hung++ }],
      },
    });
    expect(hung).toBe(1);

    turret.takeDamage(DEFAULT_TURRET_PRESET.health, undefined);
    turret.respawn();
    expect(hung).toBe(2);

    // A sweep that calls respawn on a living tower must not double-stack.
    turret.respawn();
    expect(hung).toBe(2);
  });
});
