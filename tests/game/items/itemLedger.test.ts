import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGame, indexObjects, stubGameGlobals, type TestGame } from '../fixtures';
import Champion from '@/game/gameObject/attackableUnits/Champion';
import Spell from '@/game/gameObject/Spell';
import Buff from '@/game/gameObject/Buff';
import Shield from '@/game/gameObject/buffs/Shield';
import StatAmp from '@/game/gameObject/buffs/StatAmp';
import { grantItem } from '@/game/economy/ItemShop';
import { registerSpellForTests, resetSpellRegistryForTests } from '@/game/spellRegistry';
import {
  BASIC_ATTACK_ATTRIBUTION,
  beginAttribution,
  endAttribution,
  resetAttributionForTests,
} from '@/game/combat/DamageAttribution';
import { applyOnHitEffects } from '@/game/combat/OnHit';
import { itemTotalLines } from '@/game/combat/ItemLedger';
import { computeHudState } from '@/game/hud/hudState';
import type { CastSpec } from '@/game/spell/runtime/types';
import type { QualifiedItem } from '@/content/PackRegistry';

/**
 * "thêm cơ chế đếm sát thương của item … cả lượng hồi máu, lượng giáp, nói
 * chung là item cho chỉ số gì tăng theo thời gian thì cũng hiển thị hết".
 * Every number here goes through the real funnel (`takeDamage`, `takeHeal`,
 * a shield's absorb, `update()`'s regeneration), never the tally directly.
 */

class ItemPassive extends Spell {
  name = 'Item Passive';
  coolDown = 0;
  manaCost = 0;
  targetingMode = 'SELF' as const;
  get castSpec(): Readonly<CastSpec> {
    return {
      activation: 'PRESS',
      targeting: 'SELF',
      resource: { commitAt: 'start', refundOn: [] },
      cooldown: { startAt: 'release', durationMs: 0 },
    };
  }
}

const item = (over: Partial<QualifiedItem> = {}): QualifiedItem => ({
  id: 'ref:blade',
  packId: 'ref',
  name: 'Kiếm Lửa',
  icon: 'item_blade',
  cost: 300,
  ...over,
});

describe('per-item match totals', () => {
  let game: TestGame;
  let owner: Champion;
  let enemy: Champion;

  beforeEach(() => {
    stubGameGlobals();
    resetAttributionForTests();
    resetSpellRegistryForTests();
    game = createGame();
    owner = new Champion({ game, position: createVector(0, 0), teamId: 'blue' });
    enemy = new Champion({ game, position: createVector(100, 0), teamId: 'red' });
    for (const u of [owner, enemy]) {
      u.stats.maxHealth.baseValue = 10_000;
      u.stats.health.baseValue = 10_000;
      u.stats.armor.baseValue = 0;
      u.stats.magicResist.baseValue = 0;
    }
    game.setPlayer(owner);
    indexObjects(game, [owner, enemy]);
    registerSpellForTests('ref:Blade_P', ItemPassive);
  });
  afterEach(() => {
    resetAttributionForTests();
    vi.unstubAllGlobals();
  });

  /** Runs `body` as the item's own passive would: inside its attribution. */
  const asItem = (body: () => void) => {
    const passive = owner.items.find(i => i?.def.id === 'ref:blade')!.passive!;
    const previous = beginAttribution(passive);
    try {
      body();
    } finally {
      endAttribution(previous);
    }
  };

  it('counts damage the item’s own effects land, including a burn it applied that ticks later', () => {
    grantItem(owner, item({ passive: 'ref:Blade_P' }));
    asItem(() => enemy.takeDamage(40, owner, 'TRUE'));
    let burn!: Buff;
    asItem(() => (burn = new Buff(5_000, owner, enemy)));
    // Later, from the buff's own bracket (how `AttackableUnit` ticks a buff).
    const previous = beginAttribution(burn);
    enemy.takeDamage(25, owner, 'TRUE');
    endAttribution(previous);
    // A plain hit is not the item's.
    enemy.takeDamage(100, owner, 'TRUE');

    expect(owner.tally.totalsFor('ref:blade')?.damage).toBe(65);
    expect(owner.tally.damageDealt).toBe(165);
  });

  it('counts a heal the item cast, by what landed, for the healer', () => {
    grantItem(owner, item({ passive: 'ref:Blade_P' }));
    owner.stats.health.baseValue = 9_970;
    asItem(() => owner.takeHeal(100, owner));
    expect(owner.tally.totalsFor('ref:blade')?.healing).toBe(30);
  });

  it('counts what an item’s shield actually stopped, not what it was worth', () => {
    grantItem(owner, item({ passive: 'ref:Blade_P' }));
    let shield!: Shield;
    asItem(() => {
      shield = new Shield(5_000, owner, owner);
      shield.amount = 80;
      owner.addBuff(shield);
    });
    owner.takeDamage(50, enemy, 'TRUE');
    expect(owner.tally.totalsFor('ref:blade')?.shielding).toBe(50);
  });

  it('splits what armour blocked by each item’s share of the armour', () => {
    grantItem(owner, item({ id: 'ref:plate', name: 'Giáp Tấm', stats: { armor: 30 } }));
    grantItem(owner, item({ id: 'ref:vest', name: 'Áo Lưới', stats: { armor: 10 } }));
    // 40 from the two items + 40 the champion has anyway = 80.
    owner.stats.armor.baseValue = 40;
    expect(owner.stats.armor.value).toBe(80);

    const before = owner.stats.health.baseValue;
    owner.takeDamage(180, enemy, 'PHYSICAL');
    const blocked = 180 - (before - owner.stats.health.baseValue);
    expect(blocked).toBeGreaterThan(0);

    expect(owner.tally.totalsFor('ref:plate')?.mitigated).toBeCloseTo(blocked * (30 / 80), 0);
    expect(owner.tally.totalsFor('ref:vest')?.mitigated).toBeCloseTo(blocked * (10 / 80), 0);
    // True damage ignores armour, so it credits nothing.
    owner.takeDamage(100, enemy, 'TRUE');
    expect(owner.tally.totalsFor('ref:plate')?.mitigated).toBeCloseTo(blocked * (30 / 80), 0);
  });

  it('credits life steal healing to the item that sold the life steal', () => {
    grantItem(owner, item({ id: 'ref:fang', name: 'Nanh', stats: { lifesteal: 0.2 } }));
    owner.stats.health.baseValue = 5_000;
    enemy.takeDamage(100, owner, 'PHYSICAL');
    expect(owner.tally.totalsFor('ref:fang')?.healing).toBe(20);
  });

  it('credits regeneration by the item’s share of the regen stat, and nothing at full health', () => {
    grantItem(owner, item({ id: 'ref:heart', name: 'Tim', stats: { healthRegen: 0.18 } }));
    const total = owner.stats.healthRegen.value;
    owner.update();
    expect(owner.tally.totalsFor('ref:heart')).toBeNull();

    owner.stats.health.baseValue = 5_000;
    for (let i = 0; i < 60; i++) owner.update();
    const healed = owner.stats.health.baseValue - 5_000;
    expect(healed).toBeGreaterThan(0);
    expect(owner.tally.totalsFor('ref:heart')?.healing).toBeCloseTo(healed * (0.18 / total), 1);
  });

  it('counts an on-hit an item armed, without letting ability power touch it', () => {
    grantItem(owner, item({ passive: 'ref:Blade_P' }));
    class Edge extends Buff {
      onHit(hit: { victim: Champion }): void {
        hit.victim.takeDamage(7, this.targetUnit, 'TRUE');
      }
    }
    asItem(() => owner.addBuff(new Edge(0, owner, owner)));
    // Lots of ability power: the swing's attribution must still be the swing.
    owner.stats.abilityPower.baseValue = 1;
    const before = enemy.stats.health.baseValue;
    const swing = beginAttribution(BASIC_ATTACK_ATTRIBUTION);
    applyOnHitEffects({ attacker: owner, victim: enemy, damage: 10, ranged: false, crit: false } as never);
    endAttribution(swing);

    expect(before - enemy.stats.health.baseValue).toBe(7);
    expect(owner.tally.totalsFor('ref:blade')?.damage).toBe(7);
  });

  it('credits mana regeneration to the item that sold it', () => {
    grantItem(owner, item({ id: 'ref:tome', name: 'Sách', stats: { manaRegen: 0.1 } }));
    owner.stats.maxMana.baseValue = 1_000;
    owner.stats.mana.baseValue = 0;
    const total = owner.stats.manaRegen.value;
    for (let i = 0; i < 60; i++) owner.update();
    expect(owner.tally.totalsFor('ref:tome')?.mana).toBeCloseTo(60 * total * (0.1 / total), 1);
  });

  it('starts over with the match', () => {
    grantItem(owner, item({ passive: 'ref:Blade_P' }));
    asItem(() => enemy.takeDamage(40, owner, 'TRUE'));
    owner.tally.reset();
    expect(owner.tally.totalsFor('ref:blade')).toBeNull();
  });

  it('shows it on the item’s tooltip, zeros left out, with stacks the item built up', () => {
    grantItem(owner, item({ passive: 'ref:Blade_P' }));
    asItem(() => enemy.takeDamage(1_234, owner, 'TRUE'));
    asItem(() => {
      const amp = new StatAmp(60_000, owner, owner);
      amp.bonuses = { attackDamage: { flatBonus: 3 } };
      owner.addBuff(amp);
      amp.stacks = 4;
    });

    const slot = computeHudState(game as never)!.items[0];
    const labels = slot.totals.map(l => `${l.amount} ${l.label}`);
    expect(labels[0]).toBe(`${(1234).toLocaleString('vi-VN')} sát thương gây ra`);
    expect(labels.some(l => l.includes('máu đã hồi'))).toBe(false);
    expect(labels.some(l => l.startsWith('+12') && l.includes('cộng dồn ×4'))).toBe(true);
    expect(itemTotalLines(null)).toEqual([]);
  });
});
