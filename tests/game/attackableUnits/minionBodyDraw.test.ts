import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Minion, {
  type MinionBodyView,
  type MinionPresetData,
} from '@/game/gameObject/attackableUnits/Minion';
import { resolveMinionTypes } from '@/game/config/mapTuning';
import type { MinionTypeDef } from '@/content/ContentPack';
import { createGame, stubGameGlobals, type TestGame } from '../fixtures';

/**
 * A map's minion type may bring its own body (`MinionTypeDef.draw`).
 *
 * What is held here is the seam, not a picture: the hook is called in place of
 * the built-in body and gets a plain view, a type without one is drawn exactly
 * as before, and a hook that throws costs the pack its art rather than the
 * player the frame.
 */

const DEF: MinionTypeDef = {
  name: 'Probe',
  style: 'melee',
  speed: 2,
  size: 40,
  health: 100,
  damage: 5,
  attackInterval: 1_000,
  attackRange: 40,
  aggroRange: 300,
};

let game: TestGame;

/** `arc` calls on the native context — the built-in soldier is three discs, so this is "did core draw a body". */
const arcs = () =>
  (drawingContext as unknown as { arc: ReturnType<typeof vi.fn> }).arc.mock.calls.length;

const spawn = (def: MinionTypeDef): Minion => {
  const preset: MinionPresetData = resolveMinionTypes({ minions: { types: { probe: def } } }).probe;
  return new Minion({
    game,
    position: createVector(0, 0),
    teamId: 'red',
    lane: 'mid',
    waypoints: [
      { x: 0, y: 0 },
      { x: 400, y: 0 },
    ],
    preset,
  } as ConstructorParameters<typeof Minion>[0]);
};

beforeEach(() => {
  stubGameGlobals();
  game = createGame();
  game.matchTimeMs = 4_200;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a minion type with its own body', () => {
  it('is drawn by its hook and not by the built-in soldier', () => {
    const views: MinionBodyView[] = [];
    const draw = vi.fn((_ctx: CanvasRenderingContext2D, view: MinionBodyView) => {
      views.push({ ...view });
    });
    const minion = spawn({ ...DEF, draw });
    vi.spyOn(minion, 'drawHealthBar').mockImplementation(() => {});

    minion.draw();

    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw.mock.calls[0][0]).toBe(drawingContext);
    expect(arcs()).toBe(0);
    expect(views[0]).toMatchObject({
      size: 40,
      style: 'melee',
      thin: false,
      timeMs: 4_200,
      charge: 0,
      reach: 0,
    });
    expect(views[0].colors.body).toMatch(/^rgb/);
    expect(views[0].colors.trim).toMatch(/^rgb/);
    expect(views[0].colors.bar).toMatch(/^rgb/);
    expect(views[0].seed).toBeGreaterThanOrEqual(0);
  });

  it('is told when the crowd is being thinned, and still draws itself', () => {
    const seen: boolean[] = [];
    const minion = spawn({ ...DEF, draw: (_ctx, view) => void seen.push(view.thin) });
    vi.spyOn(minion, 'drawHealthBar').mockImplementation(() => {});

    minion.draw({ thinCrowd: true });

    expect(seen).toEqual([true]);
    expect(arcs()).toBe(0);
  });

  it('reports the wind-up and the swing', () => {
    const seen: Array<{ charge: number; reach: number }> = [];
    const minion = spawn({
      ...DEF,
      draw: (_ctx, { charge, reach }) => void seen.push({ charge, reach }),
    });
    vi.spyOn(minion, 'drawHealthBar').mockImplementation(() => {});

    minion._windupMs = minion.windupFor() / 2;
    minion.draw();
    minion._windupMs = 0;
    minion._recoverMs = 60;
    minion.draw();

    expect(seen[0].charge).toBeCloseTo(0.5);
    expect(seen[0].reach).toBeLessThan(0);
    expect(seen[1].charge).toBe(0);
    expect(seen[1].reach).toBeGreaterThan(0);
  });

  it('keeps the hit flash, the buffs and the health bar as core draws them', () => {
    const minion = spawn({ ...DEF, draw: () => {} });
    const bar = vi.spyOn(minion, 'drawHealthBar').mockImplementation(() => {});
    const buffs = vi.spyOn(minion, 'drawBuffs').mockImplementation(() => {});
    minion.hitFlashMs = 80;
    minion.hitFlashTotalMs = 80;

    minion.draw();

    expect(bar).toHaveBeenCalledTimes(1);
    expect(buffs).toHaveBeenCalledTimes(1);
    expect(arcs()).toBe(1); // the flash disc, and nothing else of core's
  });
});

describe('a minion type without one', () => {
  it('is the built-in soldier, as before', () => {
    const minion = spawn(DEF);
    vi.spyOn(minion, 'drawHealthBar').mockImplementation(() => {});

    minion.draw();

    expect(arcs()).toBe(3);
  });
});

describe('a hook that throws', () => {
  it('does not throw out of draw, falls back to the built-in body, and is not asked again', () => {
    const draw = vi.fn(() => {
      throw new Error('pack art bug');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = spawn({ ...DEF, draw });
    const second = spawn({ ...DEF, draw });
    vi.spyOn(first, 'drawHealthBar').mockImplementation(() => {});
    vi.spyOn(second, 'drawHealthBar').mockImplementation(() => {});

    expect(() => first.draw()).not.toThrow();
    expect(arcs()).toBe(3);
    expect(() => first.draw()).not.toThrow();
    expect(() => second.draw()).not.toThrow();

    expect(draw).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(arcs()).toBe(9);
  });
});
