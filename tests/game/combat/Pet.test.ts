import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/managers/AssetManager', () => ({
  default: { get: () => undefined, getAsset: () => undefined },
}));

import Pet, {
  PET_LEASH_RANGE,
  PET_SCAN_INTERVAL_MS,
} from '../../../src/game/gameObject/attackableUnits/Pet';
import {
  beginAttribution,
  endAttribution,
  type DamageAttributable,
} from '../../../src/game/combat/DamageAttribution';
import { landBasicAttack } from '../../../src/game/combat/BasicAttack';
import type AttackableUnit from '../../../src/game/gameObject/attackableUnits/AttackableUnit';
import { createGame, createUnit, installSpellObjectGlobals } from '../spell/fixtures';

/**
 * Content-pack-and-repo-split batch 6 task 10, fix round 1: this file used
 * to test `Pet` — a core engine class, not any pack's content — alongside
 * four real spells that summon or build on one (`Shaco_R`, `Shaco_W`,
 * `Jinx_E`, `Annie_R`), in the same file. Only the base class needed any of
 * them: `summon()` below always constructed a bare `new Pet({...})`
 * directly, never a real spell. The four spell-specific describe blocks
 * moved to `packs/riot/tests/spells/Pet.test.ts`, in the pack's own
 * repository — each is a claim about a specific spell's own behaviour
 * (Shaco W's hidden/targetable transitions, Jinx E's chompers matching
 * `docs/abilities/jinx/e.json`, Annie R's recast racing its own cooldown
 * state and the pet's scan interval), not about `Pet` in general, so a
 * fixture could not have stood in for them the way `AttackProfiles.test.ts`'s
 * corpus was reduced elsewhere in this fix round.
 *
 * A pet is a unit, not an effect: it can be killed, it fights on its own, and
 * it does not outlive the champion who paid for it.
 */
installSpellObjectGlobals();

const summon = (overrides: Record<string, unknown> = {}) => {
  const game = createGame();
  const owner = createUnit(game, 0, 'blue');
  const enemy = createUnit(game, 120, 'red');
  enemy.stats.maxHealth.baseValue = 200;
  enemy.stats.health.baseValue = 200;
  game.objectManager.queryObjects = vi.fn(() => [enemy]) as never;

  const pet = new Pet({
    game,
    position: owner.position.copy(),
    teamId: owner.teamId,
    ownerUnit: owner,
    lifeTimeMs: 5000,
    ...overrides,
  } as never);
  return { game, owner, enemy, pet };
};

describe('Pet', () => {
  it('picks its own fight and orders a real basic attack', () => {
    const { enemy, pet } = summon();

    vi.stubGlobal('deltaTime', PET_SCAN_INTERVAL_MS);
    pet.update();
    vi.stubGlobal('deltaTime', 16);

    expect(pet.basicAttack.target).toBe(enemy);
  });

  it('inherits its summoner’s team, so it never turns on them', () => {
    const { owner, pet } = summon();
    expect(pet.teamId).toBe(owner.teamId);
  });

  it('drops the target and comes home once it is past the leash', () => {
    const { pet } = summon();

    pet.position.set(PET_LEASH_RANGE + 200, 0);
    expect(pet.leashed).toBe(true);

    vi.stubGlobal('deltaTime', PET_SCAN_INTERVAL_MS);
    pet.update();
    vi.stubGlobal('deltaTime', 16);

    expect(pet.basicAttack.target).toBeFalsy();
    // Walking back, not teleporting: the destination is short of the owner.
    expect(pet.destination).toBeTruthy();
    expect(pet.destination!.x).toBeLessThan(pet.position.x);
  });

  it('expires on its own clock, once', () => {
    const { pet } = summon({ lifeTimeMs: 1000 });
    const gift = vi.spyOn(pet, 'onExpire');

    vi.stubGlobal('deltaTime', 1200);
    pet.update();
    pet.update();
    vi.stubGlobal('deltaTime', 16);

    expect(pet.toRemove).toBe(true);
    expect(gift).toHaveBeenCalledTimes(1);
  });

  it('dies with its summoner rather than outliving them', () => {
    const { owner, pet } = summon();
    const gift = vi.spyOn(pet, 'onExpire');

    owner.die({ reviveAfter: 5000 });
    pet.update();

    expect(pet.toRemove).toBe(true);
    expect(gift).toHaveBeenCalledOnce();
  });

  it('pays its parting effect when it is killed too, not only when it times out', () => {
    const { pet } = summon();
    const gift = vi.spyOn(pet, 'onExpire');

    pet.die({ reviveAfter: 0 });
    pet.update();

    expect(gift).toHaveBeenCalledOnce();
    expect(pet.toRemove).toBe(true);
  });
});


/**
 * **A summon is its summoner's ability, still running** — and for a long time
 * it was not, in two ways that cancelled each other out into silence.
 *
 * A jester box shot for a flat 7 while the tooltip over it promised `7 (+n)`,
 * because the box deals the bolt and the box owns nothing: no items, no ability
 * power, a multiplier of exactly 1. And even handed the summoner's stats it
 * would still not have scaled, because `abilityPowerScales()` answers from the
 * *attribution*, and nothing stamped one on a pet — so everything a summon did
 * from its own `update()` was not ability damage at all.
 *
 * Both halves are needed for the number to move, so both are asserted here.
 */
describe('a summon deals its summoner’s ability damage', () => {
  const CAST: DamageAttributable = Object.freeze({
    name: 'Hộp Hề',
    damageScalesWithAbilityPower: true,
  });

  /** A pet whose whole life is one hit, dealt from its own update. */
  class Bomb extends Pet {
    victim: AttackableUnit | null = null;

    update(): void {
      this.victim?.takeDamage(10, this, 'MAGIC');
      this.toRemove = true;
    }
  }

  /** Summoned the way a cast summons one: inside the cast's own attribution. */
  const summonUnderCast = (abilityPower: number) => {
    const game = createGame();
    const owner = createUnit(game, 0, 'blue');
    owner.stats.abilityPower.baseValue = abilityPower;
    // The manager's draw pass asks every object whether it is allied, which
    // asks the game who the player is.
    game.setPlayer(owner);
    const enemy = createUnit(game, 120, 'red');
    enemy.stats.maxHealth.baseValue = 500;
    enemy.stats.health.baseValue = 500;

    const previous = beginAttribution(CAST);
    const bomb = new Bomb({
      game,
      position: owner.position.copy(),
      teamId: owner.teamId,
      ownerUnit: owner,
      lifeTimeMs: 5_000,
    } as never);
    endAttribution(previous);
    bomb.victim = enemy;

    return { game, owner, enemy, bomb };
  };

  it('reads the summoner’s ability power, not its own empty stat block', () => {
    const { game, enemy, bomb } = summonUnderCast(1);
    game.objectManager.addObject(bomb);

    // Through the manager, because the bracket that carries the attribution
    // into `update()` is the manager's — calling `bomb.update()` by hand would
    // prove nothing about the path the game actually takes. Twice: an added
    // object joins the list on the next tick.
    game.objectManager.update();
    game.objectManager.update();

    // 10 × (1 + 1.0), by hand: the box's authored number and the summoner's
    // ability power, which is the whole claim the tooltip makes.
    expect(500 - enemy.stats.health.value).toBe(20);
  });

  it('still deals its authored number for a summoner who has bought nothing', () => {
    const { game, enemy, bomb } = summonUnderCast(0);
    game.objectManager.addObject(bomb);

    game.objectManager.update();
    game.objectManager.update();

    expect(500 - enemy.stats.health.value).toBe(10);
  });

  /**
   * The other half of stamping a cast onto a pet: its *swings* must not inherit
   * it. A decoy clone's basic attacks scale on attack damage and would
   * otherwise have started drawing from its summoner's ability power as well —
   * one build buying both halves. `combat/BasicAttack.ts` states the fact
   * rather than inheriting whatever is ambient.
   */
  it('but its basic attacks are still swings, not ability damage', () => {
    const { owner, enemy, bomb } = summonUnderCast(1);
    // Bought attack damage as well, because the swing is physical: without a
    // bonus to read, `physicalPowerMultiplier` is 1 whatever the attribution
    // says and the test could not tell the two apart.
    owner.stats.attackDamage.flatBonus = 40;

    const previous = beginAttribution(bomb.attributedTo);
    landBasicAttack(bomb, enemy, 10, false);
    endAttribution(previous);

    // Armour is zero on a bare test unit, so the swing arrives whole.
    expect(500 - enemy.stats.health.value).toBe(10);
  });
});
