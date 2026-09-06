import { describe, expect, it } from 'vitest';
import { mapRuleCount, mapRuleGroups } from '@/game/hud/config/mapRuleLines';
import { DEFAULT_ECONOMY, DEFAULT_FOUNTAIN_STATS } from '@/game/config/mapTuning';
import type { MapTuning } from '@/content/ContentPack';

/**
 * What a map's rules say, for somebody choosing between maps.
 *
 * A map may retune seven whole systems and a player picking one saw its name,
 * its size and a faction count. The rules were shipped, enforced, and only
 * readable by opening the map editor.
 *
 * The design worth pinning here is that **nothing in `mapRuleLines.ts` knows a
 * default**. Every group is resolved twice through the engine's own resolver —
 * once with the map's tuning, once with `undefined` — and only the differences
 * survive. A hand-written table of defaults would be a second copy of
 * `config/mapTuning.ts`, drifting the first time one moved, which is the
 * failure the map-geometry rules were collapsed into one implementation to
 * end.
 */

const linesOf = (tuning: MapTuning | undefined, title: string) =>
  mapRuleGroups(tuning).find(group => group.title === title)?.lines ?? [];

const labels = (tuning: MapTuning | undefined): string[] =>
  mapRuleGroups(tuning).flatMap(group => group.lines.map(line => line.label));

describe('a map that changes nothing', () => {
  it('produces no groups at all', () => {
    // The panel says this in one sentence instead of drawing an empty box, and
    // "plays by the standard rules" is information too.
    expect(mapRuleGroups(undefined)).toEqual([]);
    expect(mapRuleGroups({})).toEqual([]);
    expect(mapRuleCount(undefined)).toBe(0);
  });

  it('stays silent about a field set to exactly what core already does', () => {
    // The whole point of diffing rather than listing: a map author who typed
    // the default back in has declared nothing, and a picker that announced
    // "vàng khởi điểm 500 vàng (thường 500 vàng)" would be noise that trains
    // people to stop reading the list.
    const same: MapTuning = { economy: { startingGold: DEFAULT_ECONOMY.startingGold } };
    expect(mapRuleGroups(same)).toEqual([]);
  });
});

describe('the economy group', () => {
  it('reports only the numbers that moved', () => {
    const lines = linesOf({ economy: { startingGold: 2_000, minionBounty: 20 } }, 'Kinh tế');
    expect(lines).toHaveLength(1);
    expect(lines[0].label).toBe('Vàng khởi điểm');
    expect(lines[0].value).toBe('2000 vàng');
  });

  it('carries what core would have done, beside the map’s number', () => {
    // Not decoration: "2000 vàng" means nothing to a player who does not know
    // the usual figure, and they have no other way to find it out.
    const [line] = linesOf({ economy: { startingGold: 2_000 } }, 'Kinh tế');
    expect(line.standard).toBe(`${DEFAULT_ECONOMY.startingGold} vàng`);
  });
});

describe('units a player can read', () => {
  it('prints durations in seconds, never in milliseconds', () => {
    const [line] = linesOf({ turrets: { repairDelay: 90_000 } }, 'Trụ');
    expect(line.value).toBe('90s');
  });

  it('never lists the retired rebuild clock — husks do not rebuild', () => {
    expect(linesOf({ turrets: { rebuildTime: 90_000 } }, 'Trụ')).toHaveLength(0);
  });

  it('prints a fraction as a percentage', () => {
    const [line] = linesOf({ fountain: { healPercent: 0.4 } }, 'Bệ đá');
    expect(line.value).toBe('40%');
    expect(line.standard).toBe(`${DEFAULT_FOUNTAIN_STATS.healPercent * 100}%`);
  });

  it('prints a multiplier as one', () => {
    const [line] = linesOf({ terrain: { water: { speedMultiplier: 0.5 } } }, 'Địa hình');
    expect(line.label).toBe('Tốc chạy dưới nước');
    expect(line.value).toBe('×0.5');
  });
});

describe('the fields that are not a plain number', () => {
  it('says the shop range in words, because its default is a sentinel', () => {
    // `shopRange` 0 means "the platform itself", so a naive diff would print
    // `0px` as the standard, which says nothing true.
    const [line] = linesOf({ fountain: { shopRange: 1_500 } }, 'Bệ đá');
    expect(line.label).toBe('Tầm mua đồ');
    expect(line.value).toBe('1500px quanh bệ đá');
    expect(line.standard).toBe('phải đứng trong bệ đá');
  });

  it('leaves the shop range out when the map did not set it', () => {
    expect(labels({ fountain: { healPercent: 0.4 } })).not.toContain('Tầm mua đồ');
  });

  it('states a respawn curve whole, since there is no single number to diff', () => {
    const [line] = linesOf(
      { champions: { reviveCurve: { base: 8_000, perMinute: 2_500, max: 60_000 } } },
      'Tướng'
    );
    expect(line.value).toBe('8s + 2.5s/phút, tối đa 60s');
    expect(line.standard).toBe('5s');
  });

  it('reports a monster multiplier against 1, and skips one set to 1', () => {
    // Monsters are the one group with no map-independent resolution to compare
    // against — the numbers come from whichever pack fills the slot — so the
    // multipliers are the diff by construction.
    const lines = linesOf({ monsters: { healthMult: 2, damageMult: 1 } }, 'Quái rừng');
    expect(lines).toHaveLength(1);
    expect(lines[0].value).toBe('×2');
    expect(lines[0].standard).toBe('×1');
  });

  it('names the minion roster a map fields instead of diffing its numbers', () => {
    // `MinionTuning.types` replaces core's three whole or not at all, so a
    // per-number diff would be a wall nobody could hold in their head.
    const [line] = linesOf(
      {
        minions: {
          types: {
            grunt: { name: 'Lính Nặng', style: 'melee', health: 200, damage: 8 },
          },
        },
      },
      'Lính'
    );
    expect(line.label).toBe('Loại lính');
    expect(line.value).toBe('Lính Nặng');
  });
});

describe('the badge on the picker row', () => {
  it('counts every line across every group', () => {
    const tuning: MapTuning = {
      economy: { startingGold: 2_000, passiveGoldPerSecond: 6 },
      terrain: { water: { speedMultiplier: 0.5 } },
    };
    expect(mapRuleCount(tuning)).toBe(3);
  });
});
