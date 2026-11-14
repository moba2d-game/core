import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGame, stubGameGlobals } from '../fixtures';
import { context } from './helpers';
import MatchDirector from '../../../src/game/MatchDirector';
import { DEFAULT_CHAMPION_LOADOUT } from '../../../src/game/config/PregameConfig';
import Invulnerable from '../../../src/game/gameObject/buffs/Invulnerable';
import AttackableUnit from '../../../src/game/gameObject/attackableUnits/AttackableUnit';

/**
 * The cheat surface: a buff that eats damage, and the three one-shot director
 * calls the Gian lận tab drives.
 *
 * `Invulnerable` is asserted on a bare `AttackableUnit` rather than a champion
 * because `Minion`, `Monster` and `Turret` all reach `takeDamage` through
 * `super` — one buff covers every unit type, and the base class is where that
 * is true.
 */
beforeEach(() => stubGameGlobals());
afterEach(() => vi.unstubAllGlobals());

const hurtable = (): AttackableUnit => {
  const game = createGame();
  const unit = new AttackableUnit({ game: game as never, position: createVector(0, 0) } as never);
  game.setPlayer(unit);
  unit.stats.maxHealth.baseValue = 100;
  unit.stats.health.baseValue = 100;
  return unit;
};

describe('Invulnerable', () => {
  // It shipped once wearing `buff_stasis`, the Zhonya's hourglass. `Stasis`
  // exists in this game and means something else entirely — golden, cannot
  // act, cannot be targeted — so the buff bar was naming the wrong mechanic.
  // `hudState.ts:173` skips any buff with no image, which is how this one
  // stays out of the bar; the ring in `draw()` is the indicator instead.
  it('wears no icon, so it cannot be mistaken for another mechanic', () => {
    const unit = hurtable();
    const buff = new Invulnerable(600000, unit, unit);
    expect(buff.image).toBeFalsy();
  });

  it('eats all damage — and the same unit without it does not', () => {
    const control = hurtable();
    control.takeDamage(40);
    expect(control.stats.health.baseValue).toBe(60);

    const immune = hurtable();
    immune.addBuff(new Invulnerable(600000, immune, immune));
    immune.takeDamage(40);
    expect(immune.stats.health.baseValue).toBe(100);
  });

  it('cannot be killed by a hit larger than its health', () => {
    const unit = hurtable();
    unit.addBuff(new Invulnerable(600000, unit, unit));
    unit.takeDamage(99999);
    expect(unit.isDead).toBe(false);
  });

  // Unlike Stasis, which is invulnerability *plus* crowd control. A player who
  // turns this on to practise a combo must still be able to move and cast.
  it('does not stun or untarget, unlike Stasis', () => {
    const unit = hurtable();
    unit.addBuff(new Invulnerable(600000, unit, unit));
    expect(unit.canMove).toBe(true);
    expect(unit.canCast).toBe(true);
  });
});

describe('MatchDirector — cheats', () => {
  it('setInvulnerable toggles both ways, and isInvulnerable follows it', () => {
    const { context: ctx, player } = context();
    const director = new MatchDirector(ctx);

    expect(director.isInvulnerable(player)).toBe(false);
    director.setInvulnerable(player, true);
    expect(director.isInvulnerable(player)).toBe(true);

    // Twice on is still once: the buff owns the toggle, so a second press must
    // not stack a second copy that a single "off" would leave behind.
    director.setInvulnerable(player, true);
    director.setInvulnerable(player, false);
    expect(director.isInvulnerable(player)).toBe(false);
  });

  /**
   * `addBuff` refuses on a corpse — right for a stun, wrong for a match
   * setting. Flipping the switch on a champion who happened to be dead did
   * nothing at all: `isInvulnerable` read the missing buff back as false, the
   * checkbox sprang off, and `persist()` wrote the refusal to storage.
   * Reported as "phải đợi tướng đó sống lại mới bật đc?".
   */
  it('turns on for a champion who is dead right now', () => {
    const { context: ctx, player } = context();
    const director = new MatchDirector(ctx);
    // `isDead` is `deathData !== null`; this is a corpse the way the engine
    // makes one, without driving a whole death through `takeDamage`.
    player.deathData = { attacker: undefined, reviveAfter: 5_000 };

    director.setInvulnerable(player, true);

    expect(director.isInvulnerable(player), 'the switch forgot what it was told').toBe(true);
  });

  it('and lands the buff on the first frame after they stand up', () => {
    const { context: ctx, player } = context();
    const director = new MatchDirector(ctx);
    player.deathData = { attacker: undefined, reviveAfter: 5_000 };
    director.setInvulnerable(player, true);
    expect(player.buffs.some(buff => buff instanceof Invulnerable)).toBe(false);

    player.deathData = null;
    director.tick();

    expect(player.buffs.some(buff => buff instanceof Invulnerable && !buff.toRemove)).toBe(true);
  });

  it('puts it back when the buff goes away under a switch still set to on', () => {
    // Death clears buffs, and the buff's own "effectively permanent" ten
    // minutes is a duration a practice room left open outlives. Either way the
    // switch is what the player set; the buff is only how it is spelled.
    const { context: ctx, player } = context();
    const director = new MatchDirector(ctx);
    director.setInvulnerable(player, true);

    for (const buff of [...player.buffs]) buff.deactivateBuff();
    director.tick();

    expect(player.buffs.some(buff => buff instanceof Invulnerable && !buff.toRemove)).toBe(true);
  });

  it('does not put it back on a champion switched off', () => {
    const { context: ctx, player } = context();
    const director = new MatchDirector(ctx);
    director.setInvulnerable(player, true);
    director.setInvulnerable(player, false);

    director.tick();

    expect(director.isInvulnerable(player)).toBe(false);
    expect(player.buffs.some(buff => buff instanceof Invulnerable && !buff.toRemove)).toBe(false);
  });

  /**
   * The panel is always paused, so `AttackableUnit.update()` — which is what
   * actually drops a `toRemove` buff off the list — never runs between two
   * presses of this toggle. Both directions have to answer correctly anyway.
   */
  it('survives being flipped twice inside one paused panel session', () => {
    const { context: ctx, player } = context();
    const director = new MatchDirector(ctx);

    director.setInvulnerable(player, true);
    director.setInvulnerable(player, false);
    director.setInvulnerable(player, true);

    expect(director.isInvulnerable(player)).toBe(true);
    player.stats.health.baseValue = 100;
    player.takeDamage(40);
    expect(player.stats.health.baseValue).toBe(100);
  });

  it('refill restores health and mana from a damaged, drained unit', () => {
    const { context: ctx, player } = context();
    const director = new MatchDirector(ctx);

    player.stats.health.baseValue = 1;
    player.stats.mana.baseValue = 0;
    director.refill(player);

    expect(player.stats.health.baseValue).toBe(player.stats.maxHealth.value);
    expect(player.stats.mana.baseValue).toBe(player.stats.maxMana.value);
  });

  it('clearCooldowns zeroes every ability, and leaves the basic attack mid-swing', () => {
    const { context: ctx, player } = context();
    const director = new MatchDirector(ctx);
    // A real kit, so there are abilities to put on cooldown at all — the bench
    // builds a bare `Champion` with no preset applied.
    director.applyLoadout(player, { ...DEFAULT_CHAMPION_LOADOUT, championName: 'Ahri' });

    for (const spell of player.spells) if (spell) spell.currentCooldown = 3000;
    // `BasicAttack` overrides the setter with an empty one on purpose, so slot
    // 0 never took the 3000 above — which is exactly the point: a cooldown
    // reset must not hand back a swing.
    const attackBefore = player.spells[0].currentCooldown;

    director.clearCooldowns(player);

    expect(player.spells[1].currentCooldown).toBe(0);
    expect(player.spells[0].currentCooldown).toBe(attackBefore);
  });
});

/**
 * `tick` runs every simulation step, and a phone that is behind runs several
 * steps per drawn frame. Re-asserting the cheat used to build the bot roster —
 * a walk of every object in the match — on each of them, in every match,
 * whether or not anybody had ever opened the cheat tab.
 */
describe('MatchDirector.tick when nobody is invulnerable', () => {
  const rosterWalks = (ctx: { objectManager: { objects: unknown[] } }) => {
    const objects = ctx.objectManager.objects;
    let reads = 0;
    Object.defineProperty(ctx.objectManager, 'objects', {
      configurable: true,
      get: () => {
        reads++;
        return objects;
      },
    });
    return () => reads;
  };

  it('does not walk the object list', () => {
    const { context: ctx } = context();
    const director = new MatchDirector(ctx);
    const walks = rosterWalks(ctx as never);

    for (let i = 0; i < 10; i++) director.tick();

    expect(walks()).toBe(0);
  });

  it('nor after the switch has been turned off again', () => {
    const { context: ctx, player } = context();
    const director = new MatchDirector(ctx);
    director.setInvulnerable(player, true);
    director.setInvulnerable(player, true);
    director.setInvulnerable(player, false);
    const walks = rosterWalks(ctx as never);

    director.tick();

    expect(walks()).toBe(0);
  });

  it('but does while one is — the roster is how a bot gets its buff back', () => {
    const { context: ctx, player } = context();
    const director = new MatchDirector(ctx);
    director.setInvulnerable(player, true);
    const walks = rosterWalks(ctx as never);

    director.tick();

    expect(walks()).toBeGreaterThan(0);
  });
});

/**
 * The debug hub's state. Plain fields on the director, deliberately: the panel
 * holds the match paused while a tab is open, so `ObjectManager.update()` never
 * runs, and anything a tab reads has to be readable without it.
 */
describe('debug flags', () => {
  it('starts every layer off', () => {
    const { context: ctx } = context();
    const director = new MatchDirector(ctx);

    expect(director.debug).toMatchObject({
      routes: false,
      terrain: false,
      collision: false,
      vision: false,
      quadtree: false,
    });
  });

  it('routes and navigation.debugRoutes are one value, so N and the panel agree', () => {
    const { context: ctx } = context();
    const navigation = { debugRoutes: false };
    (ctx as { navigation?: unknown }).navigation = navigation;
    const director = new MatchDirector(ctx);

    // The N key's side (`Game.keyPressed` flips the navigation field).
    navigation.debugRoutes = true;
    expect(director.debug.routes).toBe(true);

    // The panel's side.
    director.debug.routes = false;
    expect(navigation.debugRoutes).toBe(false);
  });
});
