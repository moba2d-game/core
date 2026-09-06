import { beforeEach, describe, expect, it } from 'vitest';
import EventManager from '../../../src/managers/EventManager';
import EventType from '../../../src/game/enums/EventType';
import MatchAnnouncer, {
  BANNER_MIN_HOLD_MS,
  BANNER_TTL_MS,
  FEED_ROWS,
  FEED_TTL_MS,
  MULTI_KILL_WINDOW_MS,
  announcementTags,
  bannerText,
  deservesBanner,
  multiKillLabel,
  multiKillTier,
  MAX_MULTI_TIER,
  streakLabel,
} from '../../../src/game/combat/Announcer';
import type AttackableUnit from '../../../src/game/gameObject/attackableUnits/AttackableUnit';
import type { UnitDeathEvent } from '../../../src/game/gameObject/attackableUnits/AttackableUnit';

/**
 * The feed's memory: runs, multi-kills, first blood, shutdowns — everything
 * `MatchTally` deliberately does not keep. Driven through the same
 * `ON_DIE` events `die()` emits, with fakes shaped like the fields read.
 */
const unit = (name: string, team: string, credit: 'champion' | 'minion' | 'none' = 'champion') =>
  ({
    name,
    teamId: team,
    killCredit: credit,
    avatar: { path: `${name}.png` },
  }) as unknown as AttackableUnit;

describe('MatchAnnouncer', () => {
  let events: EventManager;
  let now: number;
  let announcer: MatchAnnouncer;
  let vera: AttackableUnit;
  let bot: AttackableUnit;
  let other: AttackableUnit;

  const kill = (killer: AttackableUnit | undefined, victim: AttackableUnit) =>
    events.emit(EventType.ON_DIE, {
      unit: victim,
      killer,
      credit: victim.killCredit,
    } satisfies UnitDeathEvent);

  beforeEach(() => {
    events = new EventManager();
    now = 60_000;
    announcer = new MatchAnnouncer(events, () => now);
    announcer.attach();
    vera = unit('Vera', 'BLUE');
    bot = unit('Bot', 'RED');
    other = unit('Other', 'RED');
  });

  it('announces a champion death and nothing else', () => {
    kill(vera, unit('Lính', 'RED', 'minion'));
    expect(announcer.recent(now)).toHaveLength(0);
    kill(vera, bot);
    const [row] = announcer.recent(now);
    expect(row.killer?.name).toBe('Vera');
    expect(row.victim.name).toBe('Bot');
    expect(row.victim.avatar).toBe('Bot.png');
    expect(row.killerUnit).toBe(vera);
    expect(row.victimUnit).toBe(bot);
  });

  it('names the summoner, not the summon, when a pet lands the kill', () => {
    // `die()` books the kill to the owner, so the feed has to say the same
    // thing the scoreboard does. Announced off the clone, the row would read
    // "Không rõ hạ Bot" — a `Pet`'s own `killCredit` is `'none'`, so it does
    // not even count as a champion kill.
    const clone = unit('Phân thân', 'BLUE', 'none');
    events.emit(EventType.ON_DIE, {
      unit: bot,
      killer: clone,
      creditedTo: vera,
      credit: bot.killCredit,
    } satisfies UnitDeathEvent);

    const [row] = announcer.recent(now);
    expect(row.killer?.name).toBe('Vera');
    expect(row.killerUnit).toBe(vera);
    expect(announcer.streakOf(vera)).toBe(1);
  });

  it('gives first blood to the first champion-on-champion kill, once', () => {
    kill(unit('Trụ', 'BLUE', 'none'), bot);
    expect(announcer.recent(now)[0].firstBlood).toBe(false);
    kill(vera, other);
    kill(vera, bot);
    expect(announcer.recent(now).map(r => r.firstBlood)).toEqual([false, true, false]);
  });

  it('counts kills inside the window as one multi-kill, and starts over after it', () => {
    // Heard as they happen: the third kill is past the feed's own memory of
    // the first, so `recent` alone could not show all three.
    const multis: number[] = [];
    announcer.onAnnounce(a => multis.push(a.multi));
    kill(vera, bot);
    now += 3_000;
    kill(vera, other);
    now += MULTI_KILL_WINDOW_MS + 1;
    kill(vera, bot);
    expect(multis).toEqual([1, 2, 1]);
    expect(multiKillLabel(2)).toBe('Double Kill');
    expect(multiKillLabel(5)).toBe('Penta Kill');
    expect(multiKillLabel(6)).toBe('Hexa Kill');
    // Past the words, one name for the rest of the run rather than "Penta"
    // repeated — and the banner stops growing where the words stop changing.
    expect(multiKillLabel(9)).toBe('Legendary Kill');
    expect(multiKillTier(1)).toBe(0);
    expect(multiKillTier(3)).toBe(3);
    expect(multiKillTier(20)).toBe(MAX_MULTI_TIER);
  });

  it('keeps a run going until the runner dies, and calls ending a long one a shutdown', () => {
    kill(vera, bot);
    kill(vera, other);
    kill(vera, bot);
    expect(announcer.streakOf(vera)).toBe(3);
    kill(bot, vera);
    const last = announcer.recent(now).at(-1)!;
    expect(last.shutdown).toBe(3);
    expect(announcer.streakOf(vera)).toBe(0);
    expect(last.streak).toBe(1);
  });

  it('does not call a short run a shutdown', () => {
    kill(vera, bot);
    kill(bot, vera);
    expect(announcer.recent(now)[1].shutdown).toBe(0);
  });

  it('lets a turret end a run without starting one', () => {
    kill(vera, bot);
    kill(vera, bot);
    kill(vera, bot);
    kill(unit('Trụ', 'RED', 'none'), vera);
    const last = announcer.recent(now).at(-1)!;
    expect(last.killer?.name).toBe('Trụ');
    expect(last.streak).toBe(0);
    expect(last.multi).toBe(0);
    expect(last.shutdown).toBe(3);
  });

  it('shows a bounded, ageing feed', () => {
    for (let i = 0; i < FEED_ROWS + 3; i++) kill(vera, bot);
    expect(announcer.recent(now)).toHaveLength(FEED_ROWS);
    now += FEED_TTL_MS + 1;
    expect(announcer.recent(now)).toHaveLength(0);
  });

  it('holds a banner only briefly, and only for a moment worth one', () => {
    kill(other, bot); // first blood — a moment for everyone
    expect(announcer.banner(now, vera)?.firstBlood).toBe(true);
    now += BANNER_TTL_MS + 1;
    kill(other, bot); // an ordinary kill between two other people
    expect(announcer.banner(now, vera)).toBeNull();
    kill(vera, bot);
    expect(announcer.banner(now, vera)?.killerUnit).toBe(vera);
    now += BANNER_TTL_MS + 1;
    expect(announcer.banner(now, vera)).toBeNull();
  });

  it('holds the loudest moment, not the newest one', () => {
    // Three kills inside a second is an ordinary exchange in a 1v10 practice
    // fight, and the banner used to be whichever landed last: the Double Kill
    // was overwritten by a stranger's first blood a beat later.
    kill(vera, bot);
    now += 200;
    kill(vera, other); // Vera's Double Kill — the loudest thing on the screen
    now += 200;
    kill(unit('Ally', 'BLUE'), unit('Third', 'RED')); // someone else's kill, still a moment
    expect(announcer.banner(now, vera)?.multi).toBe(2);
  });

  it('makes an equal moment wait its turn before taking the centre', () => {
    const ally = unit('Ally', 'BLUE');
    kill(ally, bot); // first blood — the whole screen's moment
    now += BANNER_MIN_HOLD_MS - 100;
    kill(ally, unit('Second', 'RED'));
    // Still the first one: the second is no louder and the first has not had
    // its moment yet. This is the flicker — a banner replaced before it has
    // finished arriving — and it is the only thing the hold exists to stop.
    expect(announcer.banner(now, vera)?.firstBlood).toBe(true);

    now += 200; // now past the hold, measured between the two kills
    kill(ally, unit('Third', 'RED'));
    expect(announcer.banner(now, vera)?.firstBlood).toBe(false);
  });

  it('lets the player\'s own kill through against a stranger\'s', () => {
    const ally = unit('Ally', 'BLUE');
    kill(vera, bot); // yours: quiet, but yours
    kill(ally, other); // a stranger's, at the same instant
    expect(announcer.banner(now, vera)?.killerUnit).toBe(vera);
  });

  it('receives a host announcement on its own clock', () => {
    const client = new MatchAnnouncer(undefined, () => 5_000);
    client.receive(
      {
        seq: 9,
        atMs: 999_999,
        killer: { name: 'Vera', avatar: '', team: 'BLUE' },
        victim: { name: 'Bot', avatar: '', team: 'RED' },
        firstBlood: false,
        multi: 2,
        streak: 2,
        shutdown: 0,
        kid: 'u1',
        vid: 'u2',
      },
      { killerUnit: vera }
    );
    const [row] = client.recent(5_000);
    expect(row.atMs).toBe(5_000);
    expect(row.killerUnit).toBe(vera);
    expect((row as { kid?: string }).kid).toBeUndefined();
  });

  it('announces an objective without moving anybody’s run', () => {
    const turret = unit('Trụ', 'RED', 'none');
    (turret as { announceAs?: string }).announceAs = 'turret';
    kill(vera, bot); // a real kill first, so a run exists to be disturbed
    kill(vera, turret);

    const rows = announcer.recent(now);
    const last = rows.at(-1)!;
    expect(last.objective).toBe('turret');
    expect(last.victim.name).toBe('Trụ');
    expect(last.killer?.name).toBe('Vera');
    // The whole point: a turret is not somebody's Double Kill.
    expect(last.multi).toBe(0);
    expect(last.streak).toBe(0);
    expect(last.firstBlood).toBe(false);
    expect(announcer.streakOf(vera)).toBe(1);
    // And it does not hold the centre of the screen — a match has a dozen.
    expect(deservesBanner(last, null)).toBe(false);
  });

  it('interrupts for an epic camp, on both sides', () => {
    const dragon = unit('Rồng', 'NEUTRAL', 'minion');
    (dragon as { announceAs?: string }).announceAs = 'epic';
    kill(vera, dragon);

    const last = announcer.recent(now).at(-1)!;
    expect(last.objective).toBe('epic');
    expect(deservesBanner(last, null)).toBe(true);
    // The objective is the headline; who landed it is the detail.
    expect(bannerText(last, null)).toEqual({
      kind: 'objective',
      title: 'Rồng',
      subtitle: 'Vera hạ gục',
    });
  });

  it('stops listening once detached', () => {
    announcer.detach();
    kill(vera, bot);
    expect(announcer.recent(now)).toHaveLength(0);
  });

  describe('rewindTo', () => {
    it('drops the erased future: rows, banner, and the spree run', () => {
      now = 1_000;
      kill(vera, bot);
      now = 2_000;
      kill(vera, other);
      expect(announcer.streakOf(vera)).toBe(2);
      announcer.rewindTo(1_500);
      expect(announcer.buffered(1_500)).toHaveLength(1);
      expect(announcer.banner(1_500, vera)?.atMs).toBe(1_000);
      expect(announcer.streakOf(vera)).toBe(1);
      now = 3_000;
      kill(vera, other);
      expect(announcer.banner(3_000, vera)?.streak).toBe(2);
    });

    it('a rewind erasing nothing changes nothing', () => {
      now = 1_000;
      kill(vera, bot);
      announcer.rewindTo(1_000);
      expect(announcer.streakOf(vera)).toBe(1);
      expect(announcer.buffered(1_000)).toHaveLength(1);
    });

    it('first blood is untaken again when its moment is erased', () => {
      now = 1_000;
      kill(vera, bot);
      announcer.rewindTo(500);
      now = 2_000;
      kill(bot, vera);
      const rows = announcer.buffered(now);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.firstBlood).toBe(true);
    });

    it('and stays taken when it was drawn before the target', () => {
      now = 1_000;
      kill(vera, bot);
      now = 2_000;
      kill(vera, other);
      announcer.rewindTo(1_500);
      now = 3_000;
      kill(vera, other);
      const rows = announcer.buffered(now);
      expect(rows[rows.length - 1]?.firstBlood).toBe(false);
    });
  });

});

describe('the words', () => {
  const vera = unit('Vera', 'BLUE');
  const bot = unit('Bot', 'RED');
  const base = {
    seq: 1,
    atMs: 0,
    killer: { name: 'Vera', avatar: '', team: 'BLUE' },
    victim: { name: 'Bot', avatar: '', team: 'RED' },
    firstBlood: false,
    multi: 1,
    streak: 1,
    shutdown: 0,
    killerUnit: vera,
    victimUnit: bot,
  };

  it('tags a row with what made it special, each in its own colour family', () => {
    expect(announcementTags(base)).toEqual([]);
    expect(
      announcementTags({ ...base, firstBlood: true, multi: 3, streak: 5, shutdown: 4 })
    ).toEqual([
      { kind: 'first', label: 'First Blood' },
      { kind: 'multi', label: 'Triple Kill' },
      { kind: 'shutdown', label: 'Shutdown' },
      { kind: 'streak', label: 'Unstoppable' },
    ]);
  });

  it('names a run by its tier, and calls everything from eight on legendary', () => {
    expect([2, 3, 4, 5, 6, 7, 8, 12].map(streakLabel)).toEqual([
      '',
      'Killing Spree',
      'Rampage',
      'Unstoppable',
      'Dominating',
      'Godlike',
      'Legendary',
      'Legendary',
    ]);
  });

  it("speaks from the player's side", () => {
    expect(bannerText(base, vera)).toEqual({ kind: 'kill', title: 'Hạ gục', subtitle: 'Bot' });
    expect(bannerText({ ...base, multi: 2, firstBlood: true }, vera)).toEqual({
      kind: 'multi',
      title: 'Double Kill',
      subtitle: 'Bot · First Blood',
    });
    expect(bannerText(base, bot)).toEqual({
      kind: 'death',
      title: 'Bạn đã bị hạ',
      subtitle: 'bởi Vera',
    });
    const bystander = unit('Third', 'BLUE');
    expect(bannerText({ ...base, firstBlood: true }, bystander)).toEqual({
      kind: 'first',
      title: 'First Blood',
      subtitle: 'Vera hạ Bot',
    });
  });

  it('lets a run make the headline when nothing louder did', () => {
    expect(bannerText({ ...base, streak: 3 }, vera)).toEqual({
      kind: 'streak',
      title: 'Killing Spree',
      subtitle: 'Bot',
    });
    // A burst outranks the run; the run still rides along.
    expect(bannerText({ ...base, streak: 5, multi: 2 }, vera)).toEqual({
      kind: 'multi',
      title: 'Double Kill',
      subtitle: 'Bot · Unstoppable',
    });
    const bystander = unit('Third', 'BLUE');
    expect(bannerText({ ...base, streak: 8 }, bystander)).toEqual({
      kind: 'streak',
      title: 'Legendary',
      subtitle: 'Vera',
    });
  });

  it("interrupts for your own kills, and for other people's moments only", () => {
    const bystander = unit('Third', 'BLUE');
    expect(deservesBanner(base, vera)).toBe(true);
    expect(deservesBanner(base, bot)).toBe(true);
    expect(deservesBanner(base, bystander)).toBe(false);
    expect(deservesBanner({ ...base, multi: 3 }, bystander)).toBe(true);
    expect(deservesBanner({ ...base, streak: 5 }, bystander)).toBe(true);
    expect(deservesBanner({ ...base, streak: 2 }, bystander)).toBe(false);
    // Past the last tier the name stops changing, so the shouting stops too.
    expect(deservesBanner({ ...base, streak: 9 }, bystander)).toBe(false);
  });
});
