import { describe, expect, it } from 'vitest';
import { planMatchKits } from '../../src/game/preset';
import { DEFAULT_PREGAME_CONFIG, SLOT_COUNT } from '../../src/game/config/PregameConfig';

/**
 * `MatchPlan.mode` and the brawl's "everyone random" — `planMatchKits` is
 * where a mode's roster half lands.
 */
describe('planMatchKits under a mode', () => {
  const custom = {
    mode: 'custom' as const,
    championName: 'random' as const,
    summonerD: 'Flash',
    summonerF: 'Heal',
    customSlots: Array(SLOT_COUNT).fill('random') as ('random' | string)[],
  };

  it('stamps the plan with the mode it was made under, classic when none was given', () => {
    expect(planMatchKits(DEFAULT_PREGAME_CONFIG).mode).toBe('classic');
    expect(planMatchKits({ ...DEFAULT_PREGAME_CONFIG, mode: 'urf' }).mode).toBe('urf');
  });

  it('keeps a hand-built kit in a mode that does not roll everyone', () => {
    const plan = planMatchKits({ player: custom, ai: { count: 1, bots: [custom] }, mode: 'classic' });
    expect(plan.player.name.startsWith('Tự Ghép Chiêu')).toBe(true);
    expect(plan.bots[0].name.startsWith('Tự Ghép Chiêu')).toBe(true);
  });

  it('rolls a champion for everyone in the brawl, keeping the summoners', () => {
    const plan = planMatchKits({ player: custom, ai: { count: 2, bots: [custom, custom] }, mode: 'brawl' });
    for (const kit of [plan.player, ...plan.bots]) {
      expect(kit.name.startsWith('Tự Ghép Chiêu')).toBe(false);
      expect(kit.championId).toBeDefined();
    }
    expect(plan.player.spellIds).toHaveLength(SLOT_COUNT);
  });
});

describe('planMatchKits in Sinh Đôi', () => {
  const champ = {
    mode: 'champion' as const,
    championName: 'random' as const,
    summonerD: 'Flash',
    summonerF: 'Heal',
    customSlots: Array(SLOT_COUNT).fill('random') as ('random' | string)[],
  };

  it('rolls once per team and gives every member that champion', async () => {
    const { vi } = await import('vitest');
    const spy = vi.spyOn(Math, 'random');
    const plan = planMatchKits({
      player: champ,
      playerTeam: 'BLUE',
      ai: { count: 3, bots: [champ, champ, champ], botTeams: ['RED', 'BLUE', 'RED'] },
      mode: 'twins',
    });
    // Two teams, two rolls: not one per unit.
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
    expect(plan.bots[1].name).toBe(plan.player.name);
    expect(plan.bots[2].name).toBe(plan.bots[0].name);
    expect(plan.bots[2].spellIds.slice(0, 5)).toEqual(plan.bots[0].spellIds.slice(0, 5));
  });
});
