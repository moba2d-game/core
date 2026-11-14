import { describe, expect, it } from 'vitest';
import { FEED_FADE_MS, computeHudState, sameFeed } from '../../../src/game/hud/hudState';
import { BANNER_TTL_MS, FEED_TTL_MS } from '../../../src/game/combat/Announcer';
import MatchAnnouncer from '../../../src/game/combat/Announcer';
import { MAX_FEED_VICTIMS } from '../../../src/game/hud/killFeedGroups';
import EventManager from '../../../src/managers/EventManager';
import EventType from '../../../src/game/enums/EventType';
import type AttackableUnit from '../../../src/game/gameObject/attackableUnits/AttackableUnit';

/**
 * `HudState.feed`: the announcer's rows and banner, re-told from the
 * player's side — ally/enemy by the player's team, "mine" by reference.
 */
const fakePlayer = (teamId: string) =>
  ({
    avatar: { path: 'me.png', key: 'me', status: 'ready' },
    name: 'Me',
    teamId,
    killCredit: 'champion',
    position: { x: 0, y: 0 },
    isDead: false,
    deathData: null,
    canCast: true,
    shieldAmount: 0,
    stats: {
      health: { value: 60 },
      maxHealth: { value: 100 },
      mana: { value: 40 },
      maxMana: { value: 100 },
    },
    spells: [],
    buffs: [],
  }) as unknown as AttackableUnit & Record<string, unknown>;

const fakeEnemy = (name: string) =>
  ({
    name,
    teamId: 'RED',
    killCredit: 'champion',
    avatar: { path: `${name}.png` },
  }) as unknown as AttackableUnit;

describe('HudState.feed', () => {
  it('is empty for a context with no announcer', () => {
    const state = computeHudState({ player: fakePlayer('BLUE') } as any)!;
    expect(state.feed).toEqual({ rows: [], banner: null, nowMs: 0 });
  });

  it("retells the feed from the player's side", () => {
    const events = new EventManager();
    let now = 10_000;
    const announcer = new MatchAnnouncer(events, () => now);
    announcer.attach();
    const player = fakePlayer('BLUE');
    const enemy = fakeEnemy('Bot');
    events.emit(EventType.ON_DIE, { unit: enemy, killer: player, credit: 'champion' });
    now += 500;
    events.emit(EventType.ON_DIE, { unit: player, killer: enemy, credit: 'champion' });

    const state = computeHudState({ player, announcer, matchTimeMs: now } as any)!;
    expect(state.feed.rows).toHaveLength(2);
    // Newest first: the death that just happened is the top row.
    const [death, mine] = state.feed.rows;
    expect(death.seq).toBe(2);
    expect(mine.killer?.side).toBe('ally');
    expect(mine.victims).toHaveLength(1);
    expect(mine.victims[0].side).toBe('enemy');
    expect(mine.victims[0].avatar).toBe('Bot.png');
    expect(mine.mine).toBe(true);
    expect(mine.expiresAtMs).toBe(10_000 + FEED_TTL_MS);
    expect(mine.tags).toEqual([{ kind: 'first', label: 'First Blood' }]);
    expect(mine.accent).toBe('first');
    expect(death.tags).toEqual([]);
    expect(death.accent).toBeNull();
    expect(state.feed.banner).toEqual({
      seq: 2,
      kind: 'death',
      // Not a multi-kill, so the banner is drawn at its base size.
      tier: 0,
      title: 'Bạn đã bị hạ',
      subtitle: 'bởi Bot',
    });
  });

  it('paints a run in its own family, over anything else the row carries', () => {
    const events = new EventManager();
    const announcer = new MatchAnnouncer(events, () => 1_000);
    announcer.attach();
    const player = fakePlayer('BLUE');
    const enemy = fakeEnemy('Bot');
    for (let i = 0; i < 3; i++) {
      events.emit(EventType.ON_DIE, { unit: enemy, killer: player, credit: 'champion' });
    }
    const state = computeHudState({ player, announcer, matchTimeMs: 1_000 } as any)!;
    expect(state.feed.rows[0].accent).toBe('streak');
    // The run is one row, so the first blood its opening kill earned is still
    // on it — three separate rows used to show only the newest kill's badges.
    expect(state.feed.rows[0].tags.map(t => t.kind)).toEqual(['first', 'multi', 'streak']);
  });

  it('draws a whole penta as one row, past what the feed shows in kills', () => {
    const events = new EventManager();
    const announcer = new MatchAnnouncer(events, () => 1_000);
    announcer.attach();
    const player = fakePlayer('BLUE');
    const victims = ['Ahri', 'Zed', 'Jinx', 'Kayn', 'Teemo'].map(fakeEnemy);
    for (const victim of victims) {
      events.emit(EventType.ON_DIE, { unit: victim, killer: player, credit: 'champion' });
    }

    const state = computeHudState({ player, announcer, matchTimeMs: 1_000 } as any)!;
    // Five kills, one row: the cap that used to eat the first three is gone.
    expect(state.feed.rows).toHaveLength(1);
    const [row] = state.feed.rows;
    expect(row.killer?.side).toBe('ally');
    // Newest first: whoever just died leads the row.
    expect(row.victims.map(v => v.name)).toEqual(['Teemo', 'Kayn', 'Jinx', 'Zed', 'Ahri']);
    expect(row.overflow).toBe(0);
    // Keyed on the kill that opened it, so the row never re-enters as it grows.
    expect(row.seq).toBe(1);
    expect(row.victims.map(v => v.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(row.tags.map(t => t.label)).toEqual(['First Blood', 'Penta Kill', 'Unstoppable']);
    expect(row.mine).toBe(true);
  });

  it('gives each killer their own row when two runs overlap', () => {
    const events = new EventManager();
    const announcer = new MatchAnnouncer(events, () => 1_000);
    announcer.attach();
    const player = fakePlayer('BLUE');
    const ally = { ...fakeEnemy('Ally'), teamId: 'BLUE' } as unknown as AttackableUnit;
    const [ahri, zed, jinx] = ['Ahri', 'Zed', 'Jinx'].map(fakeEnemy);
    events.emit(EventType.ON_DIE, { unit: ahri, killer: player, credit: 'champion' });
    events.emit(EventType.ON_DIE, { unit: zed, killer: ally, credit: 'champion' });
    events.emit(EventType.ON_DIE, { unit: jinx, killer: player, credit: 'champion' });

    const state = computeHudState({ player, announcer, matchTimeMs: 1_000 } as any)!;
    expect(state.feed.rows).toHaveLength(2);
    // A row holds the place its *first* kill took, so a run does not jump the
    // stack every time it grows — that jump is the flicker being removed here.
    // The ally's later kill is therefore the newer row, above the player's run.
    const [allyKill, ownRun] = state.feed.rows;
    expect(ownRun.victims.map(v => v.name)).toEqual(['Jinx', 'Ahri']);
    expect(allyKill.victims.map(v => v.name)).toEqual(['Zed']);
  });

  it('keeps one banner across a climbing run, so it never stacks a second', () => {
    const events = new EventManager();
    const announcer = new MatchAnnouncer(events, () => 1_000);
    announcer.attach();
    const player = fakePlayer('BLUE');
    const victims = ['Ahri', 'Zed', 'Jinx', 'Kayn', 'Teemo'].map(fakeEnemy);

    const seqs: number[] = [];
    const titles: string[] = [];
    for (const victim of victims) {
      events.emit(EventType.ON_DIE, { unit: victim, killer: player, credit: 'champion' });
      const banner = computeHudState({ player, announcer, matchTimeMs: 1_000 } as any)!.feed
        .banner!;
      seqs.push(banner.seq);
      titles.push(banner.title);
    }

    // The words escalate; the key does not. `KillFeed.vue` transitions on that
    // key, so one banner rewrites itself instead of two sharing the column.
    expect(titles).toEqual([
      'First Blood',
      'Double Kill',
      'Triple Kill',
      'Quadra Kill',
      'Penta Kill',
    ]);
    expect(seqs).toEqual([1, 1, 1, 1, 1]);
  });

  it('gives a new banner its own key when the moment is a different one', () => {
    const events = new EventManager();
    const announcer = new MatchAnnouncer(events, () => 1_000);
    announcer.attach();
    const player = fakePlayer('BLUE');
    const enemy = fakeEnemy('Bot');
    events.emit(EventType.ON_DIE, { unit: fakeEnemy('Ahri'), killer: player, credit: 'champion' });
    const mine = computeHudState({ player, announcer, matchTimeMs: 1_000 } as any)!.feed.banner!;
    // The player's own death is a different moment, not a louder version of
    // the same one, so it takes its own key and does animate in.
    events.emit(EventType.ON_DIE, { unit: player, killer: enemy, credit: 'champion' });
    const death = computeHudState({ player, announcer, matchTimeMs: 1_000 } as any)!.feed.banner!;
    expect(death.kind).toBe('death');
    expect(death.seq).not.toBe(mine.seq);
  });

  it('drops the death banner while the recap is saying the same thing', () => {
    const events = new EventManager();
    const announcer = new MatchAnnouncer(events, () => 1_000);
    announcer.attach();
    const player = fakePlayer('BLUE');
    const enemy = fakeEnemy('Bot');
    events.emit(EventType.ON_DIE, { unit: player, killer: enemy, credit: 'champion' });

    // Without a recap the banner is the only thing that tells the player.
    const alone = computeHudState({ player, announcer, matchTimeMs: 1_000 } as any)!;
    expect(alone.feed.banner?.kind).toBe('death');

    // With one, it is the second copy of a sentence the recap already carries,
    // showing through a panel that is deliberately semi-transparent.
    player.deathRecap = { seq: 1, killerName: 'Bot', entries: [], dealt: [] };
    const withRecap = computeHudState({ player, announcer, matchTimeMs: 1_000 } as any)!;
    expect(withRecap.feed.banner).toBeNull();
    // The row is untouched — the feed still records the death.
    expect(withRecap.feed.rows).toHaveLength(1);
  });

  it('gives every killer in a teamfight a row of their own', () => {
    const events = new EventManager();
    const announcer = new MatchAnnouncer(events, () => 1_000);
    announcer.attach();
    const player = fakePlayer('BLUE');
    const allies = ['A1', 'A2', 'A3', 'A4'].map(
      name => ({ ...fakeEnemy(name), teamId: 'BLUE' }) as unknown as AttackableUnit
    );
    const enemies = ['E1', 'E2', 'E3', 'E4', 'E5'].map(fakeEnemy);
    // Five different killers, one kill each: nothing here is a run, so nothing
    // folds — two killers cannot share a row without losing who killed whom.
    [player, ...allies].forEach((killer, i) => {
      events.emit(EventType.ON_DIE, { unit: enemies[i], killer, credit: 'champion' });
    });

    const state = computeHudState({ player, announcer, matchTimeMs: 1_000 } as any)!;
    // `FEED_ROWS` is the occlusion budget; the rest age out unseen.
    expect(state.feed.rows).toHaveLength(3);
    expect(state.feed.rows.every(row => row.victims.length === 1)).toBe(true);
    // Newest first, and the three that fit are the three most recent.
    expect(state.feed.rows.map(row => row.victims[0].name)).toEqual(['E5', 'E4', 'E3']);
  });

  it('keeps a run that is still growing over three fresher single kills', () => {
    const events = new EventManager();
    let clock = 1_000;
    const announcer = new MatchAnnouncer(events, () => clock);
    announcer.attach();
    const player = fakePlayer('BLUE');
    const allies = ['A1', 'A2', 'A3'].map(
      name => ({ ...fakeEnemy(name), teamId: 'BLUE' }) as unknown as AttackableUnit
    );

    // The player opens a run, three allies each take a kill after it, and then
    // the player adds to their run. Sliced by the kill that *opened* each row,
    // the player's run — the newest thing on the feed — was the row dropped,
    // and it came back with the drop animation the moment an ally's aged out.
    events.emit(EventType.ON_DIE, { unit: fakeEnemy('E1'), killer: player, credit: 'champion' });
    allies.forEach((killer, i) => {
      clock += 100;
      events.emit(EventType.ON_DIE, { unit: fakeEnemy(`E${i + 2}`), killer, credit: 'champion' });
    });
    clock += 100;
    events.emit(EventType.ON_DIE, { unit: fakeEnemy('E5'), killer: player, credit: 'champion' });

    const state = computeHudState({ player, announcer, matchTimeMs: clock } as any)!;
    expect(state.feed.rows).toHaveLength(3);
    const mine = state.feed.rows.find(row => row.mine)!;
    expect(mine.victims.map(v => v.name)).toEqual(['E5', 'E1']);
    // Still drawn where it opened, under the two allies who killed after it:
    // choosing a row on recency must not also reorder the stack every kill.
    expect(state.feed.rows.map(row => row.killer!.name)).toEqual(['A3', 'A2', 'Me']);
  });

  it('counts the run past five faces instead of drawing them', () => {
    const events = new EventManager();
    const announcer = new MatchAnnouncer(events, () => 1_000);
    announcer.attach();
    const player = fakePlayer('BLUE');
    const victims = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8'].map(fakeEnemy);
    for (const victim of victims) {
      events.emit(EventType.ON_DIE, { unit: victim, killer: player, credit: 'champion' });
    }

    const [row] = computeHudState({ player, announcer, matchTimeMs: 1_000 } as any)!.feed.rows;
    // Eight kills drew an 755px row on a 692px window and lost both its ends.
    expect(row.victims).toHaveLength(MAX_FEED_VICTIMS);
    // The five kept are the newest, newest first; the three older ones count.
    expect(row.victims.map(v => v.name)).toEqual(['V8', 'V7', 'V6', 'V5', 'V4']);
    expect(row.overflow).toBe(3);
    // The row still holds its identity, so it never re-enters as it grows.
    expect(row.seq).toBe(1);
  });

  it('holds a run on screen while its newest kill is fresh', () => {
    const events = new EventManager();
    let now = 1_000;
    const announcer = new MatchAnnouncer(events, () => now);
    announcer.attach();
    const player = fakePlayer('BLUE');
    const [ahri, zed] = ['Ahri', 'Zed'].map(fakeEnemy);
    events.emit(EventType.ON_DIE, { unit: ahri, killer: player, credit: 'champion' });
    now += 5_000;
    events.emit(EventType.ON_DIE, { unit: zed, killer: player, credit: 'champion' });

    // The opening kill is 5s old and would have aged out on its own; the row
    // is one moment, so it lives by its newest kill and keeps both faces.
    const state = computeHudState({ player, announcer, matchTimeMs: now } as any)!;
    expect(state.feed.rows).toHaveLength(1);
    expect(state.feed.rows[0].victims.map(v => v.name)).toEqual(['Zed', 'Ahri']);
    expect(state.feed.rows[0].expiresAtMs).toBe(now + FEED_TTL_MS);
  });

  // On a Helio P35 phone the feed cost ~40% of the CPU in a fight (10 -> 16 fps
  // with it frozen): a fade written per HUD tick re-rendered its
  // `<transition-group>`, which measures every row and forces a reflow each time.
  it('is the same feed from tick to tick until something happens, fading included', () => {
    const events = new EventManager();
    let now = 1_000;
    const announcer = new MatchAnnouncer(events, () => now);
    announcer.attach();
    const player = fakePlayer('BLUE');
    events.emit(EventType.ON_DIE, { unit: fakeEnemy('Ahri'), killer: player, credit: 'champion' });
    const at = (t: number) => {
      now = t; // one clock, as in a match
      return computeHudState({ player, announcer, matchTimeMs: t } as any)!.feed;
    };

    // Past the banner (a real change), still before the fade.
    const fresh = at(1_000 + BANNER_TTL_MS + 100);
    expect(fresh.banner).toBeNull();
    // Deep into the fade: nothing a render reads may have moved.
    const fading = at(1_000 + FEED_TTL_MS - FEED_FADE_MS / 2);
    expect(fading.rows).toHaveLength(1);
    expect(sameFeed(fresh, fading)).toBe(true);

    now = 1_000 + FEED_TTL_MS - FEED_FADE_MS / 2;
    events.emit(EventType.ON_DIE, { unit: fakeEnemy('Zed'), killer: player, credit: 'champion' });
    expect(sameFeed(fading, at(now + 50))).toBe(false);
  });

  it('tells the view when the fade starts, so CSS can run it', () => {
    const events = new EventManager();
    const announcer = new MatchAnnouncer(events, () => 2_000);
    announcer.attach();
    const player = fakePlayer('BLUE');
    events.emit(EventType.ON_DIE, { unit: fakeEnemy('Ahri'), killer: player, credit: 'champion' });
    const feed = computeHudState({ player, announcer, matchTimeMs: 2_400 } as any)!.feed;
    expect(feed.nowMs).toBe(2_400);
    // The view starts the fade at expiresAtMs - FEED_FADE_MS, measured from nowMs.
    expect(feed.rows[0].expiresAtMs - FEED_FADE_MS - feed.nowMs).toBe(FEED_TTL_MS - FEED_FADE_MS - 400);
  });
});
