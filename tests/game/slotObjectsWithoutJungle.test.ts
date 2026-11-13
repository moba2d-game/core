/**
 * A pack's slot objects (a map's rules, its art) are furniture, not jungle.
 * They used to spawn inside `spawnJungle`, so a jungle-off lobby got a map
 * whose walls blocked sight but were never drawn — the art lived in a slot
 * object. And the jungle switch flipped back on added a second copy.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/game/preset', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/game/preset')>();
  return {
    ...real,
    neutralSlotFill: (slot: { role: string }) =>
      slot.role === 'art'
        ? { kind: 'object', build: () => ({ role: 'art' }) }
        : { kind: 'camp', monster: { members: [] } },
  };
});

import Game from '../../src/game/Game';

const host = () => {
  const added: unknown[] = [];
  return {
    added,
    game: {
      neutralSlots: [{ role: 'art', x: 0, y: 0 }, { role: 'wolves', x: 0, y: 0 }],
      objectManager: { addObject: (o: unknown) => added.push(o) },
      monsters: [],
      mapTuning: undefined,
    },
  };
};

describe('slot objects stand whatever the jungle switch says', () => {
  it('spawnSlotObjects adds the pack object', () => {
    const { game, added } = host();
    Game.prototype.spawnSlotObjects.call(game);
    expect(added).toEqual([{ role: 'art' }]);
  });

  it('spawnJungle leaves pack objects alone, so a re-enabled jungle adds no second copy', () => {
    const { game, added } = host();
    Game.prototype.spawnJungle.call(game);
    expect(added).toEqual([]);
  });

  it('boot spawns slot objects outside the jungle check', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../../src/game/Game.ts'), 'utf8');
    const at = src.indexOf('if (pregameConfig.world.jungle) this.spawnJungle();');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at - 400, at)).toMatch(/this\.spawnSlotObjects\(\);/);
  });
});
