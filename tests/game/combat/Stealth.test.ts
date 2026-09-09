/**
 * Stealth has to hide you from everything that picks targets, not just from a
 * champion's right-click.
 *
 * `ActionState.STEALTHED` was read in exactly one place in the whole engine —
 * `BasicAttackController`, so a player could not *order* an attack on a
 * stealthed unit — and nowhere else. Every scan that acquires a target on its
 * own went through `canTakeDamageFromTeam`, which knows about teams, death and
 * targetability but not about being invisible. So Twitch Q dimmed the sprite to
 * alpha 20 and changed nothing: the wave, the camps, the turrets and the bots
 * all kept chasing and hitting a champion nobody could see.
 *
 * The bush rule (`visibleTo`) is deliberately left off the bots — see the note
 * on that filter. Stealth is the other case entirely: it is an ability the
 * player spent a cast and a cooldown on, and a bot that ignores it makes the
 * ability worthless against the only opponents in the match.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AIChampion from '../../../src/game/gameObject/attackableUnits/AIChampion';
import Champion from '../../../src/game/gameObject/attackableUnits/Champion';
import Minion from '../../../src/game/gameObject/attackableUnits/Minion';
import Monster from '../../../src/game/gameObject/attackableUnits/Monster';
import Turret from '../../../src/game/gameObject/structures/Turret';
import Invisible from '../../../src/game/gameObject/buffs/Invisible';
import TrueSight from '../../../src/game/gameObject/buffs/TrueSight';
import Untargetable from '../../../src/game/gameObject/buffs/Untargetable';
import DamageOverTime from '../../../src/game/gameObject/buffs/DamageOverTime';
import StatusFlags from '../../../src/game/enums/StatusFlags';
import TeamId from '../../../src/game/enums/TeamId';
import { Lane, getLaneWaypoints } from '../../../src/game/lanes';
import Spell from '../../../src/game/gameObject/Spell';
import type { CastSpec } from '../../../src/game/spell/runtime/types';
import { createGame, indexObjects, stubGameGlobals, TEST_AVATAR_KEY, type TestGame } from '../fixtures';
import { installSketchMathGlobals, installSpellObjectGlobals, pressSpell } from '../spell/fixtures';

const CAMP = { x: 1_000, y: 1_000, r: 300 };

let game: TestGame;

/** Puts a live stealth on `unit` and settles the status flags it implies. */
const vanish = (unit: Champion) => {
  unit.addBuff(new Invisible(5_000, unit, unit));
  unit.updateBuffs();
  expect(unit.isStealthed).toBe(true);
};

const reveal = (unit: Champion, revealer: Champion) => {
  unit.addBuff(new TrueSight(5_000, revealer, unit));
  unit.updateBuffs();
};

const makeMinion = (teamId: string, x: number, y = 0) =>
  new Minion({
    game,
    teamId,
    position: createVector(x, y),
    waypoints: getLaneWaypoints(Lane.MID, teamId),
    lane: Lane.MID,
  });

const makeCamp = () =>
  new Monster({
    game,
    preset: {
      name: 'Camp',
      avatar: TEST_AVATAR_KEY,
      camp: { ...CAMP },
      speed: 2,
      size: 80,
      attackRange: 50,
      reviveTime: 100,
      health: 300,
    },
  } as ConstructorParameters<typeof Monster>[0]);

describe('nothing acquires a target it cannot see', () => {
  beforeEach(() => {
    stubGameGlobals();
    game = createGame();
    game.setPlayer(new Champion({ game, teamId: 'player-uuid' }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a minion walks past a stealthed champion', () => {
    const minion = makeMinion(TeamId.BLUE, 0);
    const champion = new Champion({ game, teamId: 'solo', position: createVector(60, 0) });
    indexObjects(game, [minion, champion]);

    expect(minion.findTarget()?.unit).toBe(champion);

    vanish(champion);
    expect(minion.findTarget()).toBeNull();
  });

  it('a jungle camp drops a target that vanishes mid-fight', () => {
    // Camps no longer wake on proximity at all, so the stealth-relevant rule is
    // the other end: a camp already fighting a champion lets go the moment it
    // can no longer see them (updateAttack's isStealthed check).
    const camp = makeCamp();
    const champion = new Champion({ game, teamId: 'other' });
    champion.position.set(CAMP.x + 40, CAMP.y);
    indexObjects(game, [camp, champion]);
    camp.aggroOn(champion);
    expect(camp.phase).toBe(Monster.PHASES.ATTACK);

    vanish(champion);
    camp.updateAttack();
    expect(camp.phase).toBe(Monster.PHASES.BACK_TO_CAMP);
    expect(camp.targetLock).toBeNull();
  });

  it('a turret holds its fire', () => {
    const turret = new Turret({ game, position: createVector(0, 0), teamId: TeamId.BLUE });
    const champion = new Champion({ game, teamId: 'solo', position: createVector(120, 0) });
    indexObjects(game, [turret, champion]);

    expect(turret.findTarget()?.unit).toBe(champion);

    vanish(champion);
    expect(turret.findTarget()).toBeNull();
  });

  it('a bot loses interest too — the ability is spent on the bots more than anything', () => {
    const bot = new AIChampion({ game, teamId: 'bot', position: createVector(0, 0) });
    const champion = new Champion({ game, teamId: 'solo', position: createVector(150, 0) });
    indexObjects(game, [bot, champion]);

    expect(bot.findAttackTarget()).toBe(champion);

    vanish(champion);
    expect(bot.findAttackTarget()).toBeNull();
  });

  it('sees it again the moment true sight strips the stealth', () => {
    const minion = makeMinion(TeamId.BLUE, 0);
    const champion = new Champion({ game, teamId: 'solo', position: createVector(60, 0) });
    indexObjects(game, [minion, champion]);

    vanish(champion);
    expect(minion.findTarget()).toBeNull();

    reveal(champion, minion as never);
    expect(champion.isStealthed).toBe(false);
    expect(minion.findTarget()?.unit).toBe(champion);
  });
});

describe('a target that vanishes mid-fight is let go', () => {
  beforeEach(() => {
    stubGameGlobals();
    game = createGame();
    game.setPlayer(new Champion({ game, teamId: 'player-uuid' }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a minion drops the lock rather than keeping it until the next scan', () => {
    const minion = makeMinion(TeamId.BLUE, 0);
    const champion = new Champion({ game, teamId: 'solo', position: createVector(60, 0) });
    indexObjects(game, [minion, champion]);
    minion.targetLock = champion;
    minion.phase = Minion.PHASES.ATTACK;

    vanish(champion);
    minion.updateAttack();

    expect(minion.targetLock).toBeNull();
  });

  it('a camp goes home rather than swinging at nothing', () => {
    const camp = makeCamp();
    const champion = new Champion({ game, teamId: 'other' });
    champion.position.set(CAMP.x + 40, CAMP.y);
    indexObjects(game, [camp, champion]);
    camp.aggroOn(champion);
    camp._attackCooldown = 0;
    const health = champion.stats.health.value;

    vanish(champion);
    camp.updateAttack();

    expect(camp.targetLock).toBeNull();
    expect(champion.stats.health.value).toBe(health);
  });
});

/**
 * **A hit gives you away** — the other half of stealth, and the half this
 * engine did not have.
 *
 * Everything above is the *observer* side: nothing acquires what it cannot
 * see. With no rule on the acting side, a champion who vanished stayed
 * untargetable while standing in a fight and swinging: not a repositioning
 * tool, a permanent immunity to being answered.
 *
 * The rule used to be League's — any cast reveals you — and it was replaced
 * because of what it did to the abilities that announce nothing: a jester who
 * blinked away was given up by the box and the decoy the blink is cast to set
 * up. `combat/StealthBreak.ts` has the rule that replaced it and the one seam
 * that is not the damage funnel.
 */
describe('a hit gives a hidden champion away', () => {
  /** A cast with nothing in it, so the press itself is what is under test. */
  class Poke extends Spell {
    name = 'Poke';
    coolDown = 0;
    manaCost = 0;
    lockoutMs = 0;

    get castSpec(): CastSpec {
      return {
        activation: 'PRESS',
        targeting: 'SELF',
        castTimeMs: 0,
        resource: { commitAt: 'start', refundOn: [] },
        cooldown: { startAt: 'start', durationMs: this.lockoutMs },
      };
    }

    onSpellCast(): void {}
  }

  /** The shape every vanishing ability has: the cast is what hides you. */
  class Vanish extends Poke {
    name = 'Vanish';

    onSpellCast(): void {
      this.owner.addBuff(new Invisible(5_000, this.owner, this.owner));
    }
  }

  beforeEach(() => {
    stubGameGlobals();
    installSpellObjectGlobals();
    installSketchMathGlobals();
    game = createGame();
    game.setPlayer(new Champion({ game, teamId: 'player-uuid' }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const hidden = (teamId: string, x = 0): Champion => {
    const champion = new Champion({ game, teamId, position: createVector(x, 0) });
    champion.stats.attackRange.baseValue = 300;
    vanish(champion);
    return champion;
  };

  /** Settle the flags the way a frame would, then read. */
  const stillHidden = (champion: Champion): boolean => {
    champion.updateBuffs();
    return champion.isStealthed;
  };

  it('a swing ends it — at the swing, not at the hit', () => {
    const champion = hidden('solo');
    const victim = new Champion({ game, teamId: 'other', position: createVector(120, 0) });
    indexObjects(game, [champion, victim]);

    // `launch` is the commit. A ranged attacker's bolt is still in the air
    // here, which is exactly the stretch the victim is trying to read.
    champion.basicAttack.launch(victim, champion.basicAttack.reachTo(victim));

    expect(stillHidden(champion)).toBe(false);
  });

  it('damage the hidden champion deals ends it', () => {
    const champion = hidden('solo');
    const victim = new Champion({ game, teamId: 'other', position: createVector(120, 0) });
    indexObjects(game, [champion, victim]);

    victim.takeDamage(20, champion, 'MAGIC');

    expect(stillHidden(champion)).toBe(false);
  });

  it('damage the hidden champion takes ends it too', () => {
    const champion = hidden('solo');
    const enemy = new Champion({ game, teamId: 'other', position: createVector(120, 0) });
    indexObjects(game, [champion, enemy]);

    champion.takeDamage(20, enemy, 'MAGIC');

    expect(stillHidden(champion)).toBe(false);
  });

  /**
   * The whole reason the rule moved off the cast seam: **dropping a box is not
   * being found**. Reported against the jester, whose blink is cast to set up
   * exactly the two abilities that were giving it away.
   */
  it('a cast that damages nobody leaves it alone', () => {
    const champion = hidden('solo');
    indexObjects(game, [champion]);

    expect(pressSpell(new Poke(champion))).toBe(true);

    expect(stillHidden(champion)).toBe(true);
  });

  it('the cast that grants the stealth does not undo its own work', () => {
    const champion = new Champion({ game, teamId: 'solo' });
    indexObjects(game, [champion]);

    expect(pressSpell(new Vanish(champion))).toBe(true);

    expect(stillHidden(champion)).toBe(true);
  });

  /** A caller asking for nothing is not a hit, on either end of it. */
  it('a zero-damage call reveals nobody', () => {
    const champion = hidden('solo');
    const victim = new Champion({ game, teamId: 'other', position: createVector(120, 0) });
    indexObjects(game, [champion, victim]);
    vanish(victim);

    victim.takeDamage(0, champion, 'MAGIC');

    expect(stillHidden(champion)).toBe(true);
    expect(stillHidden(victim)).toBe(true);
  });

  /**
   * **A poison ticking is nobody acting**, so it reveals neither end of itself:
   * not the poisoner who applied it and has since vanished, and not the victim,
   * who would otherwise be unable to use any stealth at all while burning.
   *
   * Driven through `updateBuffs()` rather than by calling `takeDamage`, because
   * the carve-out rides the attribution the buff's own tick is bracketed in —
   * a hand-rolled call would be testing a path the game never takes.
   */
  it('a poison tick reveals neither the poisoner nor the burning champion', () => {
    const poisoner = hidden('solo');
    const victim = new Champion({ game, teamId: 'other', position: createVector(120, 0) });
    indexObjects(game, [poisoner, victim]);
    vanish(victim);

    const poison = new DamageOverTime(5_000, poisoner, victim);
    poison.damagePerTick = 10;
    poison.tickInterval = 100;
    victim.addBuff(poison);

    const before = victim.stats.health.value;
    vi.stubGlobal('deltaTime', 200);
    victim.updateBuffs();
    vi.stubGlobal('deltaTime', 16);

    expect(victim.stats.health.value, 'the poison never ticked').toBeLessThan(before);
    expect(stillHidden(poisoner)).toBe(true);
    expect(stillHidden(victim)).toBe(true);
  });

  /** …but applying one is an act, and so is anything else either of them does. */
  it('still reveals when the same damage is dealt as an ordinary hit', () => {
    const champion = hidden('solo');
    const victim = new Champion({ game, teamId: 'other', position: createVector(120, 0) });
    indexObjects(game, [champion, victim]);

    victim.takeDamage(10, champion, 'MAGIC');

    expect(stillHidden(champion)).toBe(false);
  });

  /**
   * The exemption in `StealthBreak.breakableByDamage`, in the shape it exists
   * for: one buff carrying a stealth *and* untargetability, which is a champion
   * who is not on the map rather than one who is hiding on it. A burn applied
   * before the leap is enough to reach `takeDamage`, and ending the buff would
   * take the action lock with it and drop him out of his own ultimate.
   */
  it('leaves a stealth that also makes its owner untargetable alone', () => {
    const champion = new Champion({ game, teamId: 'solo' });
    indexObjects(game, [champion]);
    const skyward = new Untargetable(5_000, champion, champion);
    skyward.statusFlagsToEnable = StatusFlags.Stealthed | StatusFlags.Stunned;
    champion.addBuff(skyward);
    champion.updateBuffs();
    expect(champion.isStealthed).toBe(true);

    champion.takeDamage(20, undefined, 'MAGIC');

    expect(stillHidden(champion)).toBe(true);
    expect(champion.targetable).toBe(false);
  });
});
