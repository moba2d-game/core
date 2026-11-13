import { describe, expect, it, vi } from 'vitest';
import ZoneController from '../../../src/game/zone/ZoneController';
import {
  ZONE_DPS_BASE,
  ZONE_DPS_PER_STAGE,
  ZONE_MIN_RADIUS,
  ZONE_GRACE_MS,
  ZONE_PULSE_MS,
  ZONE_SHRINK_MS,
  ZONE_WARNING_MS,
  zoneAt,
  zoneCircles,
  zoneDps,
  zoneResult,
  zoneShrinkStartMs,
} from '../../../src/game/zone/zoneRules';
import { matchModeFor } from '../../../src/game/config/matchModes';

const MAP = 10000;
const circles = zoneCircles(MAP, 42);

describe('shrink schedule', () => {
  it('starts covering the map, nests each circle, ends at the floor, is seeded', () => {
    const corner = Math.hypot(MAP / 2, MAP / 2);
    expect(circles[0].r).toBeGreaterThanOrEqual(corner - 1e-6);
    for (let i = 1; i < circles.length; i++) {
      const d = Math.hypot(circles[i].x - circles[i - 1].x, circles[i].y - circles[i - 1].y);
      expect(d + circles[i].r).toBeLessThanOrEqual(circles[i - 1].r + 1e-6);
    }
    expect(circles[circles.length - 1].r).toBe(ZONE_MIN_RADIUS);
    expect(zoneCircles(MAP, 42)).toEqual(circles);
    expect(zoneCircles(MAP, 43)).not.toEqual(circles);
  });

  it('warns 10s ahead, shrinks over the shrink time, then holds', () => {
    expect(zoneAt(circles, 0).next).toBeNull();
    const warn = zoneAt(circles, zoneShrinkStartMs(1) - ZONE_WARNING_MS + 1);
    expect(warn.next).toEqual(circles[1]);
    expect(warn.current).toEqual(circles[0]);
    const mid = zoneAt(circles, zoneShrinkStartMs(1) + ZONE_SHRINK_MS / 2);
    expect(mid.stage).toBe(1);
    expect(mid.current.r).toBeCloseTo((circles[0].r + circles[1].r) / 2);
    expect(zoneAt(circles, zoneShrinkStartMs(1) + ZONE_SHRINK_MS).current).toEqual(circles[1]);
    const end = zoneAt(circles, 1e9);
    expect(end.current).toEqual(circles[circles.length - 1]);
    expect(end.msToNextShrink).toBeNull();
  });
});

describe('a lane map is fair at the start', () => {
  // Driftglass: 3200 square, fountains on the middle row 40 px from each edge.
  const LANE = 3200;
  const fountains = [
    { x: 40, y: LANE / 2 },
    { x: LANE - 40, y: LANE / 2 },
  ];
  it('nothing shrinks during the grace period', () => {
    const c = zoneCircles(LANE, 7);
    expect(zoneAt(c, ZONE_GRACE_MS - 1).stage).toBe(0);
    expect(zoneAt(c, ZONE_GRACE_MS - 1).current).toEqual(c[0]);
  });
  it('the first circle keeps both fountains inside, for every seed', () => {
    for (let seed = 0; seed < 200; seed++) {
      const first = zoneCircles(LANE, seed)[1];
      for (const f of fountains) {
        expect(Math.hypot(f.x - first.x, f.y - first.y)).toBeLessThan(first.r);
      }
    }
  });
  it('a hero (100 health) standing out at stage 1 has well over 5 s to walk in', () => {
    expect(100 / zoneDps(1)).toBeGreaterThan(5);
  });
});

const unit = (x: number, y: number) => ({
  position: { x, y },
  isDead: false,
  takeDamage: vi.fn(),
});

describe('zone damage', () => {
  it('hurts only units outside, with labelled TRUE damage that grows by stage', () => {
    const zone = new ZoneController(MAP, 42);
    const t = zoneShrinkStartMs(3) + ZONE_SHRINK_MS;
    const c = zone.state(t).current;
    const inside = unit(c.x, c.y);
    const outside = unit(c.x + c.r + 50, c.y);
    const fighters = [
      { teamId: 'a', isDead: false },
      { teamId: 'b', isDead: false },
    ];
    zone.tick(ZONE_PULSE_MS, t, [inside, outside], fighters);
    expect(inside.takeDamage).not.toHaveBeenCalled();
    expect(outside.takeDamage).toHaveBeenCalledWith(
      (zoneDps(3) * ZONE_PULSE_MS) / 1000,
      undefined,
      'TRUE',
      'Vùng Độc'
    );
    expect(zoneDps(3)).toBe(ZONE_DPS_BASE + 3 * ZONE_DPS_PER_STAGE);
    expect(zoneDps(3)).toBeGreaterThan(zoneDps(1));
  });
});

describe('win condition', () => {
  it('last team with a living champion wins; simultaneous wipe is a draw', () => {
    const team = (a1: boolean, a2: boolean, b: boolean) => [
      { teamId: 'a', isDead: a1 },
      { teamId: 'a', isDead: a2 },
      { teamId: 'b', isDead: b },
    ];
    expect(zoneResult(team(false, false, false))).toBeNull();
    expect(zoneResult(team(true, false, false))).toBeNull();
    expect(zoneResult(team(true, false, true))).toEqual({ winner: 'a' });
    expect(zoneResult(team(true, true, false))).toEqual({ winner: 'b' });
    expect(zoneResult(team(true, true, true))).toEqual({ draw: true });
    expect(zoneResult([{ teamId: 'a', isDead: false }])).toBeNull();
  });

  it('the controller stops hurting once the match is decided', () => {
    const zone = new ZoneController(MAP, 42);
    const far = unit(-99999, -99999);
    zone.tick(1, 0, [], [
      { teamId: 'a', isDead: false },
      { teamId: 'b', isDead: true },
    ]);
    expect(zone.result).toEqual({ winner: 'a' });
    zone.tick(ZONE_PULSE_MS, 0, [far], []);
    expect(far.takeDamage).not.toHaveBeenCalled();
  });

  it('is registered as a mode', () => {
    expect(matchModeFor('zone').zone).toBe(true);
  });
});

describe('zone lives', () => {
  it('revives quickly twice, then not at all', async () => {
    const { zoneReviveAfter, ZONE_LIVES, ZONE_NO_REVIVE_MS, ZONE_REVIVE_BASE_MS } = await import(
      '../../../src/game/zone/zoneRules'
    );
    expect(ZONE_LIVES).toBe(3);
    expect(zoneReviveAfter(1)).toBe(ZONE_REVIVE_BASE_MS);
    expect(zoneReviveAfter(2)).toBeGreaterThan(zoneReviveAfter(1));
    expect(zoneReviveAfter(2)).toBeLessThan(15_000);
    expect(zoneReviveAfter(3)).toBe(ZONE_NO_REVIVE_MS);
  });

  it('revives inside the circle when the spawn has been left outside it', async () => {
    const { zoneRevivePoint, ZONE_REVIVE_DEPTH } = await import('../../../src/game/zone/zoneRules');
    const circle = { x: 1000, y: 1000, r: 500 };
    const inside = zoneRevivePoint({ x: 1100, y: 1000 }, circle);
    expect(inside).toEqual({ x: 1100, y: 1000 });
    const pulled = zoneRevivePoint({ x: 0, y: 1000 }, circle);
    expect(Math.hypot(pulled.x - 1000, pulled.y - 1000)).toBeCloseTo(500 * ZONE_REVIVE_DEPTH);
    expect(pulled.x).toBeLessThan(1000);
  });

  it('a champion down with a life left keeps its team in the match', async () => {
    const { default: Game } = await import('../../../src/game/Game');
    const { default: Champion } = await import(
      '../../../src/game/gameObject/attackableUnits/Champion'
    );
    const champ = (team: string, deaths: number, dead: boolean) => {
      const c = Object.create(Champion.prototype);
      Object.defineProperty(c, 'isDead', { value: dead });
      c.teamId = team;
      c.zoneDeaths = deaths;
      return c;
    };
    const seen: { teamId: string; isDead: boolean }[][] = [];
    const host = {
      zone: { tick: (_s: number, _t: number, _v: unknown, f: { teamId: string; isDead: boolean }[]) => seen.push(f) },
      objectManager: { objects: [champ('a', 1, true), champ('b', 0, false), champ('a', 3, true)] },
      fps: 60,
      matchTimeMs: 0,
    };
    (Game.prototype as any).tickZone.call(host);
    expect(seen[0].map(f => f.isDead)).toEqual([false, false, true]);
  });
});
