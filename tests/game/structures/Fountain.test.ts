import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Champion from '../../../src/game/gameObject/attackableUnits/Champion';
import Fountain, { SHOP_RING_FADE } from '../../../src/game/gameObject/structures/Fountain';
import TeamId from '../../../src/game/enums/TeamId';
import { createGame, indexObjects, stubGameGlobals } from '../fixtures';

describe('Fountain', () => {
  beforeEach(() => stubGameGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('restores health and mana only for champions on its own team', () => {
    const game = createGame();
    const ally = new Champion({
      game,
      position: createVector(100, 100),
      teamId: TeamId.BLUE,
    });
    const enemy = new Champion({
      game,
      position: createVector(100, 100),
      teamId: TeamId.RED,
    });
    game.setPlayer(ally);
    indexObjects(game, [ally, enemy]);

    ally.stats.health.baseValue = 10;
    ally.stats.mana.baseValue = 10;
    enemy.stats.health.baseValue = 10;
    enemy.stats.mana.baseValue = 10;

    const fountain = new Fountain({
      game,
      preset: {
        name: 'Blue Fountain',
        x: 100,
        y: 100,
        r: 150,
        teamId: TeamId.BLUE,
        tickInterval: 500,
        healPercent: 0.5,
        manaPercent: 0.5,
      },
    });

    expect(fountain.championsInside()).toEqual([ally]);
    fountain.update();

    expect(ally.stats.health.baseValue).toBeGreaterThan(10);
    expect(ally.stats.mana.baseValue).toBeGreaterThan(10);
    expect(enemy.stats.health.baseValue).toBe(10);
    expect(enemy.stats.mana.baseValue).toBe(10);
  });

  /**
   * The ring that says how far the shop reaches.
   *
   * Nothing in a match said it. On the default map that was fine — the reach
   * *is* the platform, and the platform is drawn — but a map that widens it
   * (`FountainStats.shopRange`) left a player to learn the rule by opening the
   * shop and reading whether the tiles were grey. The reported version of that:
   * "in-game cũng không có visual gì biết tầm mua đồ tới đâu".
   *
   * A ring is the obvious fix and clutter is the obvious objection, so what is
   * asserted here is the three gates that answer the objection. The drawing
   * itself is p5 calls and no test runs those; `shopRingAlpha` is the decision,
   * split out so it can be one.
   */
  describe('the shop reach ring', () => {
    const fountainAt = (r: number, shopRange: number | undefined, game: ReturnType<typeof createGame>) =>
      new Fountain({
        game,
        preset: {
          name: 'Blue Fountain',
          x: 0,
          y: 0,
          r,
          teamId: TeamId.BLUE,
          ...(shopRange === undefined ? {} : { shopRange }),
        },
      });

    const gameWithPlayerAt = (x: number, teamId: string = TeamId.BLUE) => {
      const game = createGame();
      const player = new Champion({ game, position: createVector(x, 0), teamId });
      game.setPlayer(player);
      indexObjects(game, [player]);
      return game;
    };

    // On a phone's GPU canvas a frame costs by the draw operation. Forty
    // dashes as forty `arc()` strokes made this ring a tenth of every draw
    // call in a ten-champion fight (Helio P35, 43 of ~420); the dashes are
    // forty subpaths of one stroke now.
    it('strokes all its dashes in one draw operation', () => {
      const spies = stubGameGlobals();
      const fountain = fountainAt(150, 600, gameWithPlayerAt(0));
      const ctx = drawingContext;
      const strokesBefore = vi.mocked(ctx.stroke).mock.calls.length;

      (fountain as unknown as { drawShopReach(): void }).drawShopReach();

      expect(vi.mocked(ctx.stroke).mock.calls.length - strokesBefore).toBe(1);
      expect(spies.arc, 'p5 arc() strokes each dash on its own').not.toHaveBeenCalled();
      const dashes = vi.mocked(ctx.arc).mock.calls;
      expect(dashes).toHaveLength(40);
      expect(vi.mocked(ctx.moveTo).mock.calls).toHaveLength(40);
      // Every dash is on the reach itself, and covers just over half its step.
      expect(dashes.every(call => call[2] === 600)).toBe(true);
      const step = (Math.PI * 2) / 40;
      expect((dashes[7][4] as number) - (dashes[7][3] as number)).toBeCloseTo(step * 0.55, 9);
    });

    it('is not drawn at all on a map that never widened the reach', () => {
      // The platform's own edge already is this circle. A second one drawn on
      // top of it is a new line that says nothing — and every ordinary map is
      // this case, which is why "won't it clutter the map" is answered here.
      const game = gameWithPlayerAt(0);
      expect(fountainAt(150, undefined, game).shopRingAlpha()).toBe(0);
      expect(fountainAt(150, 150, game).shopRingAlpha()).toBe(0);
    });

    it('is not drawn on the other team’s fountain', () => {
      // A ring across the map is decoration: it answers a question nobody
      // standing there is asking.
      const game = gameWithPlayerAt(0, TeamId.RED);
      expect(fountainAt(150, 600, game).shopRingAlpha()).toBe(0);
    });

    it('is solid once the player is inside the reach', () => {
      // Including the stretch between the platform edge and the reach, which
      // is exactly where the old wording sent people walking further in for
      // no reason.
      expect(fountainAt(150, 600, gameWithPlayerAt(0)).shopRingAlpha()).toBe(1);
      expect(fountainAt(150, 600, gameWithPlayerAt(400)).shopRingAlpha()).toBe(1);
      expect(fountainAt(150, 600, gameWithPlayerAt(600)).shopRingAlpha()).toBe(1);
    });

    it('fades in over the approach and is gone before it', () => {
      const at = (x: number) => fountainAt(150, 600, gameWithPlayerAt(x)).shopRingAlpha();
      const fadeEnds = 600 * SHOP_RING_FADE;

      expect(at(fadeEnds + 1), 'still visible from across the map').toBe(0);
      expect(at(fadeEnds - 1)).toBeGreaterThan(0);
      // Monotone: walking in never makes it dimmer, which is what stops it
      // reading as a flicker rather than an approach.
      const half = at((600 + fadeEnds) / 2);
      expect(half).toBeGreaterThan(at(fadeEnds - 1));
      expect(half).toBeLessThan(1);
    });

    it('is inside the box that decides whether the fountain is drawn at all', () => {
      // The trap this file's neighbours keep hitting: an object that paints
      // past its own radius and a display box sized to the radius means the
      // whole fountain — ring included — is culled while a corner of the ring
      // is still on screen.
      const box = fountainAt(150, 900, gameWithPlayerAt(0)).getDisplayBoundingBox();
      expect(box.w / 2).toBeGreaterThanOrEqual(900);
    });
  });
});
