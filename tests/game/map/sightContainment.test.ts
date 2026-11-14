/**
 * The fog's "is this body inside that sight polygon" scan, prepared once.
 *
 * Two promises. The answer is **the same answer** `CollideUtils` gives — the
 * prepared form is a cost change and nothing else, so a unit on a sight
 * polygon's rim is lit or dark exactly as before. And the cost really moved:
 * the polygon is built per scan rather than per candidate, and a revealer that
 * has not moved is not decomposed again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PolyDecomp from 'poly-decomp';
import SAT from '../../../src/libs/SAT';
import CollideUtils from '../../../src/utils/collide.utils';
import FogOfWar from '../../../src/game/gameObject/map/FogOfWar';
import Champion from '../../../src/game/gameObject/attackableUnits/Champion';
import TeamId from '../../../src/game/enums/TeamId';
import { prepareSight, sightContains } from '../../../src/game/gameObject/map/sightContainment';
import { createGame, indexObjects, stubGameGlobals, withWalls, type TestGame } from '../fixtures';

/** Deterministic, so a failure names the same polygon every run. */
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};

/** A star-shaped polygon with ragged radii: concave, simple, like a swept sight. */
const raggedStar = (next: () => number, cx: number, cy: number) => {
  const count = 6 + Math.floor(next() * 18);
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const reach = 80 + next() * 520;
    points.push({ x: cx + Math.cos(angle) * reach, y: cy + Math.sin(angle) * reach });
  }
  return points;
};

describe('sightContains', () => {
  it('answers exactly as CollideUtils.pointPreparedConcave does', () => {
    const next = rng(20261114);
    let inside = 0;
    let checked = 0;
    for (let p = 0; p < 60; p++) {
      const polygon = raggedStar(next, 1000 + next() * 3000, 1000 + next() * 3000);
      const reference = CollideUtils.prepareConcave(polygon);
      const sight = prepareSight(polygon);
      const probes: { x: number; y: number }[] = [];
      // Scattered over the polygon's whole box and a little beyond it.
      for (let i = 0; i < 150; i++) {
        probes.push({
          x: polygon[0].x - 700 + next() * 1400,
          y: polygon[0].y - 700 + next() * 1400,
        });
      }
      // And where a shortcut is most likely to be wrong: on the vertices, on
      // the edges, and a hair either side of both.
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        const t = next();
        const onEdge = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        for (const base of [a, onEdge]) {
          for (const nudge of [0, 1e-7, -1e-7, 1e-3, -1e-3, 0.5, -0.5, 1, -1, 1.5, -1.5]) {
            probes.push({ x: base.x + nudge, y: base.y });
            probes.push({ x: base.x, y: base.y + nudge });
            probes.push({ x: base.x + nudge, y: base.y - nudge });
          }
        }
      }
      for (const probe of probes) {
        const expected = CollideUtils.pointPreparedConcave(probe.x, probe.y, reference);
        expect(
          sightContains(probe.x, probe.y, sight),
          `polygon ${p} at ${probe.x},${probe.y}`
        ).toBe(expected);
        if (expected) inside++;
        checked++;
      }
    }
    // Both answers have to actually occur, or the comparison proves nothing.
    expect(inside).toBeGreaterThan(checked * 0.1);
    expect(checked - inside).toBeGreaterThan(checked * 0.1);
  });
});

describe('the fog scan pays for a sight polygon once', () => {
  let game: TestGame;

  beforeEach(() => {
    stubGameGlobals();
    vi.stubGlobal('createGraphics', () => ({ pixelDensity: vi.fn() }));
    vi.stubGlobal('windowWidth', 800);
    vi.stubGlobal('windowHeight', 600);
    game = createGame();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** A notch of wall beside the observer, so the polygon is genuinely concave. */
  const WALL = [
    { x: 560, y: 440 },
    { x: 600, y: 440 },
    { x: 600, y: 560 },
    { x: 560, y: 560 },
  ];

  const observerWith = (enemies: number) => {
    const observer = new Champion({ game, teamId: TeamId.BLUE });
    observer.position.set(500, 500);
    observer.visionRadius = 400;
    game.setPlayer(observer);
    const bodies: Champion[] = [observer];
    for (let i = 0; i < enemies; i++) {
      const enemy = new Champion({ game, teamId: TeamId.RED });
      enemy.position.set(380 + (i % 5) * 40, 380 + Math.floor(i / 5) * 40);
      bodies.push(enemy);
    }
    withWalls(game, [WALL]);
    indexObjects(game, bodies);
    return observer;
  };

  const polygonsBuiltFor = (enemies: number) => {
    const observer = observerWith(enemies);
    const fog = new FogOfWar(game);
    const built = vi.spyOn(SAT.Polygon.prototype, 'setPoints');
    const { playersInSight } = fog.calculateSightForObject(observer);
    const count = built.mock.calls.length;
    built.mockRestore();
    return { count, seen: playersInSight.length };
  };

  it('builds SAT polygons per polygon, not per candidate', () => {
    const few = polygonsBuiltFor(1);
    const many = polygonsBuiltFor(20);

    // The scan really did look at twenty more bodies...
    expect(many.seen).toBeGreaterThan(few.seen + 10);
    // ...and built nothing extra to do it.
    expect(many.count).toBe(few.count);
  });

  it('does not decompose again for an observer that has not moved', () => {
    const observer = observerWith(6);
    const fog = new FogOfWar(game);
    const decomposed = vi.spyOn(PolyDecomp, 'quickDecomp');

    const first = fog.calculateSightForObject(observer);
    const second = fog.calculateSightForObject(observer);
    expect(second.playersInSight).toEqual(first.playersInSight);
    expect(decomposed).toHaveBeenCalledTimes(1);

    // One step is a new polygon, and a new polygon is decomposed.
    observer.position.set(503, 500);
    fog.calculateSightForObject(observer);
    expect(decomposed).toHaveBeenCalledTimes(2);
  });
});
