import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Monster, { DEATH_LIMP_MS } from '../../../src/game/gameObject/attackableUnits/Monster';
import Champion from '../../../src/game/gameObject/attackableUnits/Champion';
import type { Creature } from '../../../src/game/render/creature/creature';
import { createGame, stubGameGlobals, TEST_AVATAR_KEY, type TestGame } from '../fixtures';

/**
 * What a camp with a procedural body does after it dies.
 *
 * Before this, nothing: `Monster.draw` returned on `isDead` and the body was
 * gone on the frame it lost its last health. That is fine for a sprite, which
 * reads as a pickup blinking out, and wrong for a rig — eight legs planted on
 * the ground do not blink out, and a body that plainly *was* standing there
 * suddenly not being there reads as a rendering fault rather than as a death.
 *
 * The timing constant is imported, so retuning the fade is not editing a test.
 */

const CAMP = { x: 1_000, y: 1_000, r: 300 };
/** Every frame in this file, matching `stubGameGlobals`' own `deltaTime`. */
const FRAME_MS = 16;

let game: TestGame;
let spies: Record<string, ReturnType<typeof vi.fn>>;

const RIG = {
  body: { kind: 'chain' as const, widths: [1, 0.95, 0.8, 0.6, 0.35] },
  legs: { count: 6 },
};

const makeCamp = (overrides: Record<string, unknown> = {}) =>
  new Monster({
    game,
    preset: {
      name: 'Camp',
      avatar: TEST_AVATAR_KEY,
      camp: { ...CAMP },
      speed: 2,
      size: 80,
      attackRange: 50,
      reviveTime: 100_000,
      health: 300,
      damage: 12,
      rig: RIG,
      ...overrides,
    },
  } as ConstructorParameters<typeof Monster>[0]);

/** The rig hanging off a camp — private, and the only place the corpse lives. */
const rigOf = (camp: Monster): Creature => (camp as unknown as { creature: Creature }).creature;

const drawFrames = (camp: Monster, ms: number) => {
  for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) camp.draw();
};

/** Walk the camp about so its legs are planted and its spine is not straight. */
const settle = (camp: Monster) => {
  for (let i = 0; i < 40; i++) {
    camp.position.set(CAMP.x + i * 3, CAMP.y);
    camp.draw();
  }
};

const feet = (camp: Monster) =>
  rigOf(camp).legRig!.legs.map(leg => ({ x: leg.footX, y: leg.footY }));

/**
 * `AttackableUnit.drawBody` clips its avatar through the raw 2D context, which
 * `stubGameGlobals` does not stand in for — nothing else in core's tests draws
 * a live unit. A recorder is enough: this file only ever asks whether the
 * corpse painted, never what it painted with.
 */
const stubDrawingContext = () =>
  vi.stubGlobal('drawingContext', {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    clip: vi.fn(),
    // The team ring and the dead shade `drawAvatar` paints around the body.
    stroke: vi.fn(),
    fill: vi.fn(),
    drawImage: vi.fn(),
    // The spine body's outline: `drawSpineBody` traces it here, not through
    // p5's `beginShape`, so this is what says "the body was painted".
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    ellipse: vi.fn(),
    bezierCurveTo: vi.fn(),
    globalAlpha: 1,
  });

/** The spine body's outline calls: one bezier a ring point, every painted frame. */
const bodyOutline = () =>
  (drawingContext as unknown as { bezierCurveTo: ReturnType<typeof vi.fn> }).bezierCurveTo;

beforeEach(() => {
  spies = stubGameGlobals();
  stubDrawingContext();
  game = createGame();
  game.setPlayer(new Champion({ game, teamId: 'player-uuid' }));
});
afterEach(() => vi.unstubAllGlobals());

describe('a camp with a rig does not blink out', () => {
  it('keeps painting its body after it dies', () => {
    const camp = makeCamp();
    settle(camp);
    camp.die({ reviveAfter: 100_000 });

    bodyOutline().mockClear();
    drawFrames(camp, DEATH_LIMP_MS / 2);

    expect(bodyOutline(), 'the corpse stopped drawing the frame it died').toHaveBeenCalled();
  });

  it('and stops once it has faded', () => {
    const camp = makeCamp();
    settle(camp);
    camp.die({ reviveAfter: 100_000 });

    drawFrames(camp, DEATH_LIMP_MS + FRAME_MS * 2);
    bodyOutline().mockClear();
    drawFrames(camp, DEATH_LIMP_MS);

    expect(
      bodyOutline(),
      'the corpse is still being painted long after it faded'
    ).not.toHaveBeenCalled();
  });

  /**
   * The reason `Creature.limp` exists rather than `follow`. `LegRig` steps
   * whenever a foot has fallen far enough behind its hip and cannot tell a body
   * being dragged by a death animation from one walking somewhere, so a corpse
   * driven through `follow` keeps taking steps while it fades.
   */
  it('leaves its feet exactly where they were standing', () => {
    const camp = makeCamp();
    settle(camp);
    const planted = feet(camp);

    camp.die({ reviveAfter: 100_000 });
    drawFrames(camp, DEATH_LIMP_MS * 0.9);

    expect(feet(camp)).toEqual(planted);
  });

  it('curls the body it dies with', () => {
    const camp = makeCamp();
    settle(camp);
    const spine = rigOf(camp).spine!;
    const before = spine.angles[spine.angles.length - 1];

    camp.die({ reviveAfter: 100_000 });
    drawFrames(camp, DEATH_LIMP_MS * 0.9);

    expect(Math.abs(spine.angles[spine.angles.length - 1] - before)).toBeGreaterThan(0.2);
  });
});

describe('a camp with no rig is unchanged', () => {
  it('is gone on the frame it dies, as every camp used to be', () => {
    const camp = makeCamp({ rig: undefined });
    camp.draw();
    camp.die({ reviveAfter: 100_000 });

    spies.circle.mockClear();
    spies.image.mockClear();
    drawFrames(camp, DEATH_LIMP_MS);

    expect(spies.circle).not.toHaveBeenCalled();
    expect(spies.image).not.toHaveBeenCalled();
  });
});
