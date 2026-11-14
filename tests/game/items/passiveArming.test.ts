import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGame, indexObjects, stubGameGlobals, type TestGame } from '@/testing';
import Champion from '@/game/gameObject/attackableUnits/Champion';
import Spell from '@/game/gameObject/Spell';
import Buff from '@/game/gameObject/Buff';
import Stun from '@/game/gameObject/buffs/Stun';
import { grantItem } from '@/game/economy/ItemShop';
import { registerSpellForTests, resetSpellRegistryForTests } from '@/game/spellRegistry';
import type { CastSpec } from '@/game/spell/runtime/types';
import type { QualifiedItem } from '@/content/PackRegistry';

/**
 * An item passive is pressed once per life to arm it (`Champion.armPassives`).
 * Found live: a bot holding an on-hit item carried no buff from it at all, and
 * the item did nothing for the rest of that life. The press had been refused —
 * the bot was stunned, or mid-channel, at the frame it bought — but the passive
 * was marked armed before the press ran, so it was never tried again.
 */

const EDGE = 'test_item_edge';

class Edge extends Buff {}

class EdgePassive extends Spell {
  name = 'Edge Passive';
  coolDown = 0;
  manaCost = 0;
  targetingMode = 'SELF' as const;
  get castSpec(): Readonly<CastSpec> {
    return {
      activation: 'PRESS',
      targeting: 'SELF',
      castTimeMs: 0,
      resource: { commitAt: 'start', refundOn: [] },
      cooldown: { startAt: 'start', durationMs: 0 },
    };
  }
  onSpellCast(): void {
    const armed = new Edge(0, this.owner, this.owner);
    armed.stackId = EDGE;
    armed.sourceSpell = this;
    this.owner.addBuff(armed);
  }
}

const item: QualifiedItem = {
  id: 'ref:edge',
  packId: 'ref',
  name: 'Lưỡi',
  icon: 'item_edge',
  cost: 300,
  passive: 'ref:Edge_P',
};

describe('item passive arming', () => {
  let game: TestGame;
  let owner: Champion;

  beforeEach(() => {
    stubGameGlobals();
    resetSpellRegistryForTests();
    registerSpellForTests('ref:Edge_P', EdgePassive);
    game = createGame();
    owner = new Champion({ game, position: createVector(0, 0), teamId: 'blue' });
    game.setPlayer(owner);
    indexObjects(game, [owner]);
  });
  afterEach(() => vi.unstubAllGlobals());

  const armed = () => owner.buffs.some(b => b.stackId === EDGE);

  it('arms on the next frame for a champion free to cast', () => {
    grantItem(owner, item);
    owner.update();
    expect(armed()).toBe(true);
  });

  it('arms once the champion can cast again, if bought while unable to', () => {
    owner.addBuff(new Stun(500, owner, owner));
    owner.update();
    expect(owner.canCast).toBe(false);
    grantItem(owner, item);
    owner.update();
    expect(armed()).toBe(false);

    for (let f = 0; f < 60 && !armed(); f++) owner.update();
    expect(owner.canCast).toBe(true);
    expect(armed()).toBe(true);
  });

  it('arms exactly once per life, not once per frame', () => {
    grantItem(owner, item);
    for (let f = 0; f < 30; f++) owner.update();
    expect(owner.buffs.filter(b => b.stackId === EDGE)).toHaveLength(1);
  });
});
