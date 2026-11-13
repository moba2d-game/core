import { describe, expect, it } from 'vitest';
import EventManager from '../../../src/managers/EventManager';
import EventType from '../../../src/game/enums/EventType';
import MatchAnnouncer, { announcementTags } from '../../../src/game/combat/Announcer';
import {
  BOUNTY_BASE_GOLD,
  BOUNTY_MAX_GOLD,
  BOUNTY_MIN_STREAK,
  BOUNTY_PER_STREAK_GOLD,
  bountyForKill,
  bountyGold,
  wantedOf,
} from '../../../src/game/combat/Bounty';
import type AttackableUnit from '../../../src/game/gameObject/attackableUnits/AttackableUnit';

const unit = (name: string, team: string) =>
  ({ name, teamId: team, killCredit: 'champion', avatar: { path: '' } }) as unknown as AttackableUnit;

describe('Truy Nã pricing', () => {
  it('pays nothing below the minimum run and scales with it up to a cap', () => {
    expect(bountyGold(BOUNTY_MIN_STREAK - 1)).toBe(0);
    expect(bountyGold(3)).toBe(BOUNTY_BASE_GOLD);
    expect(bountyGold(5)).toBe(BOUNTY_BASE_GOLD + 2 * BOUNTY_PER_STREAK_GOLD);
    expect(bountyGold(500)).toBe(BOUNTY_MAX_GOLD);
  });

  it('only an enemy champion collects, and only when the mode is on', () => {
    const a = unit('A', 'BLUE');
    const b = unit('B', 'RED');
    const mate = unit('M', 'BLUE');
    expect(bountyForKill(true, b, a, 4)).toBe(bountyGold(4));
    expect(bountyForKill(false, b, a, 4)).toBe(0);
    expect(bountyForKill(true, a, mate, 4)).toBe(0);
    expect(bountyForKill(true, b, null, 4)).toBe(0);
  });

  it('wanted is the live champion with the highest run of at least 3', () => {
    const runs = new Map<string, number>([['a', 2], ['b', 4], ['c', 6], ['d', 5]]);
    const us = ['a', 'b', 'c', 'd'].map(id => ({ id, isDead: id === 'c' }));
    expect(wantedOf(us, u => runs.get(u.id) ?? 0)?.id).toBe('d');
    expect(wantedOf(us.slice(0, 1), u => runs.get(u.id) ?? 0)).toBeNull();
  });
});

describe('Truy Nã announcements', () => {
  const setup = (enabled: boolean) => {
    const events = new EventManager();
    const announcer = new MatchAnnouncer(events, () => 1000);
    announcer.bountyEnabled = enabled;
    announcer.attach();
    const kill = (killer: AttackableUnit, victim: AttackableUnit) =>
      events.emit(EventType.ON_DIE, { unit: victim, killer, credit: 'champion' });
    return { announcer, kill };
  };

  it('stamps the head price from the victim’s run and tags the feed row', () => {
    const { announcer, kill } = setup(true);
    const vera = unit('Vera', 'BLUE');
    const foe = unit('Foe', 'RED');
    for (let i = 0; i < 3; i++) kill(vera, unit(`v${i}`, 'RED'));
    expect(announcer.streakOf(vera)).toBe(3);
    kill(foe, vera);
    const row = announcer.recent(1000).at(-1)!;
    expect(row.bounty).toBe(bountyGold(3));
    expect(announcementTags(row).some(t => t.kind === 'bounty')).toBe(true);
  });

  it('does nothing outside the mode', () => {
    const { announcer, kill } = setup(false);
    const vera = unit('Vera', 'BLUE');
    for (let i = 0; i < 3; i++) kill(vera, unit(`v${i}`, 'RED'));
    kill(unit('Foe', 'RED'), vera);
    expect(announcer.recent(1000).at(-1)!.bounty).toBeUndefined();
  });
});
