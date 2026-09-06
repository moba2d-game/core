/**
 * The unit-level half of the rewind family: every stamp on `matchTimeMs`
 * that survives a rewind un-tells the erased future. The bot clocks and the
 * announcer have their own suites; these pin the unit ledger sweep and the
 * death camera's clamp.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Champion, {
  type ChampionPresetData,
} from '../../src/game/gameObject/attackableUnits/Champion';
import type { DamageLogEntry } from '../../src/game/gameObject/attackableUnits/AttackableUnit';
import { DeathCamera } from '../../src/game/render/deathCamera';
import { createGame, stubGameGlobals } from './fixtures';

const PRESET: ChampionPresetData = {
  name: 'Test',
  spells: [],
  attack: { damage: 10, attacksPerSecond: 1, range: 100 },
};

const entry = (atMs: number): DamageLogEntry => ({
  atMs,
  amount: 10,
  hits: 1,
  type: 'PHYSICAL',
  attackerName: 'Test',
  attackerId: 'test',
});

describe('AttackableUnit.rewindClocks', () => {
  beforeEach(() => stubGameGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('drops future stamps and keeps past ones', () => {
    const game = createGame();
    const unit = new Champion({ game, position: createVector(0, 0), teamId: 'blue', preset: PRESET });
    const other = new Champion({ game, position: createVector(0, 0), teamId: 'red', preset: PRESET });
    const inner = unit as unknown as {
      _revealedUntilMs: number;
      _assistLedger: Map<unknown, number>;
    };
    unit.lastCombatMs = 90_000;
    inner._revealedUntilMs = 95_000;
    inner._assistLedger.set(other, 20_000);
    inner._assistLedger.set(unit, 80_000);
    unit.recentDamageLog.push(entry(10_000), entry(85_000));
    unit.recentDamageDealtLog.push(entry(88_000));

    unit.rewindClocks(30_000);

    expect(unit.lastCombatMs).toBe(-Infinity);
    expect(inner._revealedUntilMs).toBe(0);
    expect(inner._assistLedger.get(other)).toBe(20_000);
    expect(inner._assistLedger.has(unit)).toBe(false);
    expect(unit.recentDamageLog.map(row => row.atMs)).toEqual([10_000]);
    expect(unit.recentDamageDealtLog).toHaveLength(0);
  });

  it('touches nothing when every stamp predates the target', () => {
    const game = createGame();
    const unit = new Champion({ game, position: createVector(0, 0), teamId: 'blue', preset: PRESET });
    unit.lastCombatMs = 10_000;
    unit.recentDamageLog.push(entry(5_000));

    unit.rewindClocks(30_000);

    expect(unit.lastCombatMs).toBe(10_000);
    expect(unit.recentDamageLog).toHaveLength(1);
  });
});

describe('DeathCamera under a rewind', () => {
  it('clamps a death stamp from the erased future instead of waiting it out', () => {
    let now = 90_000;
    const camera = new DeathCamera({
      isDead: () => true,
      deathPoint: () => ({ x: 0, y: 0 }),
      allies: () => [],
      nowMs: () => now,
      follow: () => {},
    });
    camera.tick();
    now = 30_000;
    camera.tick();
    expect((camera as unknown as { deathAtMs: number }).deathAtMs).toBe(30_000);
  });
});
