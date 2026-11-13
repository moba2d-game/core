/**
 * Icy ground: momentum on walking, per unit of time, off by default.
 *
 * The negative cases carry the weight, as in `terrainSpeed.test.ts`: a map that
 * says nothing about ice must leave `move()` bit-identical, and a dash must be
 * exactly what it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TerrainMap from '../../../src/game/gameObject/map/TerrainMap';
import Champion from '../../../src/game/gameObject/attackableUnits/Champion';
import Dash from '../../../src/game/gameObject/buffs/Dash';
import type { ActiveMap, IceTuning, TerrainZone } from '../../../src/content/ContentPack';
import { validatePack } from '../../../src/content/validate';
import { createGame, indexObjects, stubGameGlobals, type TestGame } from '../fixtures';

const SPEED = 4;
const TICK_MS = 1000 / 60;

const zone = (extra: Partial<TerrainZone> = {}): TerrainZone => ({
  id: 'floe',
  name: 'Băng',
  render: { fill: '#bfe' },
  polygons: [
    [
      { x: 0, y: 0 },
      { x: 1_000, y: 0 },
      { x: 1_000, y: 2_000 },
      { x: 0, y: 2_000 },
    ],
  ],
  ...extra,
});

const mapWith = (extra: Partial<ActiveMap> = {}): ActiveMap => ({
  id: 'ice',
  name: 'Ice',
  size: 2_000,
  factions: [{ id: 'blue' }, { id: 'red' }],
  terrain: { wall: [], bush: [], water: [] },
  slots: { spawn: [], minion: [], structure: [], neutral: [] },
  ...extra,
});

let game: TestGame;

/** A walker of `speed` px per tick at (x, y), standing still. */
const walker = (x: number, y: number, speed = SPEED) => {
  const champion = new Champion({ game, teamId: 'blue' });
  champion.stats.speed.baseValue = speed;
  champion.position.set(x, y);
  champion.destination.set(x, y);
  return champion;
};

const step = (unit: Champion, tickMs: number) => {
  vi.stubGlobal('deltaTime', tickMs);
  unit.move();
};

/** Walk toward a far point for `walkMs`, then let go; position after `totalMs`. */
const runThenStop = (tickMs: number, walkMs: number, totalMs: number, ice: IceTuning = {}) => {
  const walkTicks = Math.round(walkMs / tickMs);
  const totalTicks = Math.round(totalMs / tickMs);
  game = createGame(2_000);
  game.terrainMap = new TerrainMap(game, mapWith({ ice: { everywhere: true, ...ice } }));
  // Same real speed (px per second) at any tick length: speed is px per tick.
  const unit = walker(100, 1_000, (SPEED * tickMs) / TICK_MS);
  unit.onIce = true;
  unit.destination.set(1_900, 1_000);
  for (let i = 0; i < walkTicks; i++) step(unit, tickMs);
  unit.destination.set(unit.position.x, unit.position.y);
  for (let i = walkTicks; i < totalTicks; i++) step(unit, tickMs);
  return unit;
};

beforeEach(() => {
  stubGameGlobals();
  vi.stubGlobal('frameCount', 1);
  game = createGame(2_000);
  game.setPlayer(new Champion({ game, teamId: 'player-uuid' }));
});
afterEach(() => vi.unstubAllGlobals());

describe('ice: momentum', () => {
  beforeEach(() => {
    game.terrainMap = new TerrainMap(game, mapWith({ ice: { everywhere: true } }));
  });

  it('accelerates toward full speed instead of snapping to it', () => {
    const unit = walker(100, 1_000);
    unit.onIce = true;
    unit.destination.set(1_900, 1_000);

    step(unit, TICK_MS);
    const first = unit.position.x - 100;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(SPEED * 0.25);

    for (let i = 0; i < 300; i++) step(unit, TICK_MS);
    expect(Math.hypot(unit.iceVx, unit.iceVy)).toBeGreaterThan(SPEED * 0.99);
    expect(Math.hypot(unit.iceVx, unit.iceVy)).toBeLessThanOrEqual(SPEED + 1e-9);
  });

  it('slides after being stopped, then comes to rest', () => {
    const unit = walker(100, 1_000);
    unit.onIce = true;
    unit.destination.set(1_900, 1_000);
    for (let i = 0; i < 240; i++) step(unit, TICK_MS);
    const stoppedAt = unit.position.x;
    unit.stopMovement();

    step(unit, TICK_MS);
    expect(unit.position.x).toBeGreaterThan(stoppedAt + SPEED * 0.9);

    for (let i = 0; i < 600; i++) step(unit, TICK_MS);
    // ~ speed * frictionMs / tick: about 4px * 48 ticks, nowhere near zero.
    expect(unit.position.x - stoppedAt).toBeGreaterThan(100);
    expect(unit.iceVx).toBe(0);
    // Settled: nothing waiting on "destination reached" waits forever.
    expect(unit.destination.x).toBe(unit.position.x);
  });

  it('takes time to turn around', () => {
    const unit = walker(1_000, 1_000);
    unit.onIce = true;
    unit.destination.set(1_900, 1_000);
    for (let i = 0; i < 120; i++) step(unit, TICK_MS);
    unit.destination.set(100, 1_000);
    for (let i = 0; i < 10; i++) step(unit, TICK_MS);
    expect(unit.iceVx).toBeGreaterThan(0);
    for (let i = 0; i < 300; i++) step(unit, TICK_MS);
    expect(unit.iceVx).toBeLessThan(-SPEED * 0.9);
  });

  it('is the same slide at 30 and 60 ticks per second', () => {
    const at60 = runThenStop(TICK_MS, 1_000, 2_500);
    const at30 = runThenStop(2 * TICK_MS, 1_000, 2_500);
    expect(at30.position.x).toBeCloseTo(at60.position.x, 3);
    const at144 = runThenStop(1000 / 144, 1_000, 2_500);
    expect(Math.abs(at144.position.x - at60.position.x)).toBeLessThan(1);
  });

  it('reaches a goal and settles at it, so a navigating bot arrives', () => {
    const unit = walker(100, 1_000);
    unit.onIce = true;
    unit.destination.set(500, 1_000);
    for (let i = 0; i < 1_200; i++) step(unit, TICK_MS);
    expect(Math.abs(unit.position.x - 500)).toBeLessThan(SPEED * 3);
    expect(unit.iceVx).toBe(0);
    expect(unit.position.dist(unit.destination)).toBeLessThan(unit.moveSpeed);
  });

  it('never exceeds the unit speed, and a slow bites at once', () => {
    const unit = walker(100, 1_000);
    unit.onIce = true;
    unit.destination.set(1_900, 1_000);
    for (let i = 0; i < 300; i++) step(unit, TICK_MS);
    unit.terrainSpeedFactor = 0.5;
    step(unit, TICK_MS);
    expect(Math.hypot(unit.iceVx, unit.iceVy)).toBeLessThanOrEqual(SPEED * 0.5 + 1e-9);
  });

  it('leaves a dash exactly as it was and starts from rest after it', () => {
    const dasher = walker(100, 1_000);
    dasher.onIce = true;
    dasher.destination.set(1_900, 1_000);
    for (let i = 0; i < 200; i++) step(dasher, TICK_MS);

    const dash = new Dash(3_000, dasher, dasher);
    dash.dashDestination = dasher.position.copy().add(300, 0);
    dasher.buffs.push(dash);
    expect(dash.overridesMovement).toBe(true);
    const before = dasher.position.x;
    dasher.destination.set(before + 300, 1_000);
    step(dasher, TICK_MS);
    // The unit's own step is the plain walking step toward the dash target.
    expect(dasher.position.x - before).toBeCloseTo(SPEED, 6);
    expect(dasher.iceVx).toBe(0);
  });

  it('loses momentum at once when it cannot move', () => {
    const unit = walker(100, 1_000);
    unit.onIce = true;
    unit.destination.set(1_900, 1_000);
    for (let i = 0; i < 100; i++) step(unit, TICK_MS);
    expect(unit.iceVx).not.toBe(0);
    Object.defineProperty(unit, 'canMove', { get: () => false });
    unit.update();
    expect(unit.iceVx).toBe(0);
  });
});

describe('ice: where it is', () => {
  it('is off by default: no flag written, move() is the old snap', () => {
    const terrainMap = new TerrainMap(game, mapWith());
    game.terrainMap = terrainMap;
    const unit = walker(100, 1_000);
    unit.onIce = false;
    indexObjects(game, [unit]);
    terrainMap.update();
    expect(terrainMap.hasIce).toBe(false);
    expect(unit.onIce).toBe(false);

    unit.destination.set(1_900, 1_000);
    step(unit, TICK_MS);
    expect(unit.position.x).toBeCloseTo(100 + SPEED, 9);
    unit.destination.set(unit.position.x + 2, 1_000);
    step(unit, TICK_MS);
    expect(unit.position.x).toBeCloseTo(100 + SPEED + 2, 9);
  });

  it('does not run a query on a map with ice declared but no ice anywhere', () => {
    const terrainMap = new TerrainMap(game, mapWith({ ice: { accelMs: 100 }, zones: [zone()] }));
    expect(terrainMap.hasIce).toBe(false);
  });

  it('whole-map ice marks every walker', () => {
    const terrainMap = new TerrainMap(game, mapWith({ ice: { everywhere: true } }));
    game.terrainMap = terrainMap;
    const unit = walker(1_500, 1_500);
    indexObjects(game, [unit]);
    terrainMap.update();
    expect(unit.onIce).toBe(true);
  });

  it('an ice zone marks only the units inside it, and clears on leaving', () => {
    const terrainMap = new TerrainMap(game, mapWith({ zones: [zone({ ice: true })] }));
    game.terrainMap = terrainMap;
    const inside = walker(500, 500);
    const outside = walker(1_500, 500);
    indexObjects(game, [inside, outside]);
    terrainMap.update();
    expect(inside.onIce).toBe(true);
    expect(outside.onIce).toBe(false);

    inside.position.set(1_500, 500);
    terrainMap.update();
    expect(inside.onIce).toBe(false);
    inside.destination.set(1_900, 500);
    inside.iceVx = 3;
    step(inside, TICK_MS);
    expect(inside.iceVx).toBe(0);
    expect(inside.position.x).toBeCloseTo(1_500 + SPEED, 9);
  });

  it('a zone without the flag is plain ground', () => {
    const terrainMap = new TerrainMap(game, mapWith({ zones: [zone()] }));
    expect(terrainMap.hasIce).toBe(false);
  });
});

describe('ice: validation', () => {
  const pack = (ice: unknown, zoneIce?: unknown) => ({
    manifest: { id: 'ref', version: '1.0.0', coreRange: '^1' },
    maps: [
      {
        id: 'arena',
        name: 'Arena',
        size: 4000,
        factions: [{ id: 'solo' }],
        ice,
        geometry: {
          terrain: { wall: [], bush: [], water: [] },
          zones:
            zoneIce === undefined ? undefined : [{ ...zone(), ice: zoneIce }],
          slots: { spawn: [], minion: [], structure: [], neutral: [] },
        },
      },
    ],
  });

  it('accepts well-formed ice and refuses nonsense', () => {
    expect(validatePack(pack({ everywhere: true, accelMs: 300, frictionMs: 900 }, true)).ok).toBe(true);
    expect(validatePack(pack(undefined)).ok).toBe(true);
    expect(validatePack(pack({ accelMs: 0 })).ok).toBe(false);
    expect(validatePack(pack({ everywhere: 'yes' })).ok).toBe(false);
    expect(validatePack(pack(7)).ok).toBe(false);
    expect(validatePack(pack(undefined, 'yes')).ok).toBe(false);
  });
});
