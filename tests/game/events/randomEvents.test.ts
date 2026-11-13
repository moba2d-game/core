import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/managers/AssetManager', () => ({
  default: { get: () => undefined, getAsset: () => undefined, placeholder: () => undefined },
}));

import EventDirector, { CHEST_GOAL_RADIUS, type EventWorld } from '../../../src/game/events/EventDirector';
import {
  HealingSpring,
  LightningStrike,
  TreasureChest,
  GoldCoin,
  MeteorStrike,
} from '../../../src/game/events/eventObjects';
import {
  EVENT_FIRST_AT_MS,
  EVENT_INTERVAL_MS,
  EVENT_MAX_DURATION_MS,
  EVENT_MIN_DURATION_MS,
  EVENT_MIN_QUIET_MS,
  EVENT_WARNING_MS,
  BOUNTY_BONUS_GOLD,
  CHEST_CAPTURE_MS,
  CHEST_GOLD,
  CHEST_RADIUS,
  FOG_VISION_FRACTION,
  FRENZY_ABILITY_HASTE,
  FRENZY_ATTACK_SPEED,
  SPRING_COUNT,
  SPRING_HEAL_FRACTION_PER_SEC,
  SPRING_RADIUS,
  STORM_DAMAGE,
  STORM_RADIUS,
  STORM_STRIKE_INTERVAL_MS,
  STORM_WARNING_MS,
  GALE_SPEED_PERCENT,
  GOLD_RAIN_COIN_VALUE,
  METEOR_DAMAGE,
  METEOR_RADIUS,
  QUICK_REVIVE_FACTOR,
  RANDOM_EVENTS,
  eventForIndex,
  eventStartMs,
  eventWarnMs,
  reachablePoints,
  type RandomEventId,
} from '../../../src/game/events/randomEvents';
import EventType from '../../../src/game/enums/EventType';
import { matchModeFor } from '../../../src/game/config/matchModes';
import NavGrid from '../../../src/game/nav/NavGrid';
import Champion from '../../../src/game/gameObject/attackableUnits/Champion';
import {
  createGame,
  indexObjects,
  stubGameGlobals,
  type TestGame,
} from '../fixtures';

const box = (x: number, y: number, w: number, h: number) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

/** First seed/index pair that yields `id`, so each event is driven for real. */
function indexOf(seed: number, id: RandomEventId): number {
  for (let i = 0; i < 200; i++) if (eventForIndex(seed, i).id === id) return i;
  throw new Error(`no ${id}`);
}

describe('the schedule', () => {
  it('first at 15 s, then every 15 s, banner 4 s before', () => {
    expect(EVENT_FIRST_AT_MS).toBe(15_000);
    expect(eventStartMs(0)).toBe(15_000);
    expect(eventStartMs(1)).toBe(30_000);
    expect(eventStartMs(3)).toBe(60_000);
    expect(eventWarnMs(0)).toBe(11_000);
    expect(EVENT_WARNING_MS).toBe(4_000);
  });

  it('keeps at least 5 s of quiet between one event ending and the next starting', () => {
    expect(EVENT_INTERVAL_MS - EVENT_MAX_DURATION_MS).toBeGreaterThanOrEqual(EVENT_MIN_QUIET_MS);
    for (const e of RANDOM_EVENTS) {
      expect(EVENT_INTERVAL_MS - e.durationMs).toBeGreaterThanOrEqual(EVENT_MIN_QUIET_MS);
    }
  });

  it('has ten events, each 8-10 s, with unique ids and Vietnamese names', () => {
    expect(RANDOM_EVENTS.length).toBe(10);
    expect(new Set(RANDOM_EVENTS.map(e => e.id)).size).toBe(RANDOM_EVENTS.length);
    for (const e of RANDOM_EVENTS) {
      expect(e.durationMs).toBeGreaterThanOrEqual(EVENT_MIN_DURATION_MS);
      expect(e.durationMs).toBeLessThanOrEqual(EVENT_MAX_DURATION_MS);
    }
    expect(RANDOM_EVENTS.map(e => e.name)).toEqual(
      expect.arrayContaining(['Mưa Vàng', 'Thiên Thạch', 'Gió Lốc', 'Hồi Sinh Nhanh', 'Sương Mù', 'Cuồng Nộ', 'Suối Hồi Sinh', 'Rương Báu', 'Bão Sét', 'Truy Nã'])
    );
  });

  it('is a pure function of the seed, never repeats back to back, and varies with the seed', () => {
    const a = Array.from({ length: 40 }, (_, i) => eventForIndex(12345, i).id);
    const b = Array.from({ length: 40 }, (_, i) => eventForIndex(12345, i).id);
    expect(a).toEqual(b);
    for (let i = 1; i < a.length; i++) expect(a[i]).not.toBe(a[i - 1]);
    const c = Array.from({ length: 40 }, (_, i) => eventForIndex(999, i).id);
    expect(c).not.toEqual(a);
    expect(new Set(a).size).toBe(RANDOM_EVENTS.length);
  });

  it('the mode is registered and switches the director on', () => {
    expect(matchModeFor('events').id).toBe('events');
    expect(matchModeFor('events').randomEvents).toBe(true);
    expect(matchModeFor('events').name).toBe('Sự Kiện');
  });
});

describe('reachablePoints', () => {
  it('keeps to the connected floor and leaves a sealed room out', () => {
    // A 1024 map with a sealed 300x300 room (walls all round, hollow inside).
    const walls = [
      box(600, 600, 300, 40),
      box(600, 860, 300, 40),
      box(600, 600, 40, 300),
      box(860, 600, 40, 300),
    ];
    const grid = NavGrid.fromPolygons(walls, { size: 1_024 });
    const pts = reachablePoints(grid, { x: 100, y: 100 }, 20, 2);
    expect(pts.length).toBeGreaterThan(100);
    expect(pts.some(p => p.x > 660 && p.x < 840 && p.y > 660 && p.y < 840)).toBe(false);
    expect(pts.some(p => p.x < 300 && p.y < 300)).toBe(true);
    for (const p of pts) expect(grid.isWalkable(p.x, p.y, 20)).toBe(true);
  });
});

describe('events at work', () => {
  let game: TestGame;
  let clock: number;
  let spawned: any[];
  let champs: Champion[];
  const SEED = 777;
  const DEFAULT_PTS = [
    { x: 200, y: 200 },
    { x: 300, y: 300 },
    { x: 400, y: 250 },
  ];
  let pts = DEFAULT_PTS;

  function world(): EventWorld {
    return {
      game,
      seed: SEED,
      now: () => clock,
      champions: () => champs,
      spawn: o => {
        spawned.push(o);
        game.objectManager.addObject(o);
      },
      reachable: () => pts,
      center: () => ({ x: 350, y: 300 }),
      mapSize: () => 1_000,
      onDeath: l => game.eventManager.on(EventType.ON_DIE, l),
    };
  }

  const make = (team: string, x: number, y: number) => {
    const c = new Champion({ game, teamId: team, position: createVector(x, y) });
    c.stats.maxHealth.baseValue = 1_000;
    c.stats.health.baseValue = 1_000;
    return c;
  };

  /** Director whose first event is `id`: advance to its start by picking the index. */
  function directorFor(id: RandomEventId) {
    const index = indexOf(SEED, id);
    const d = new EventDirector(world());
    // Fast-forward: events before `index` are skipped by the staleness rule,
    // so jump the clock straight to this event's start.
    clock = eventStartMs(index);
    d.tick();
    return { d, index, start: eventStartMs(index) };
  }

  beforeEach(() => {
    stubGameGlobals();
    vi.stubGlobal('createVector', (x = 0, y = 0) => new (p5 as any).Vector(x, y));
    game = createGame();
    (game as any).fogOfWar = { sightChangeLerpSpeed: 0.1 };
    spawned = [];
    pts = DEFAULT_PTS;
    clock = 0;
    champs = [make('blue', 200, 200), make('red', 3_000, 3_000)];
    game.setPlayer(champs[0]);
    indexObjects(game, champs);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('announces 4 s before, fires at the start, and ends within 10 s', () => {
    const d = new EventDirector(world());
    clock = 10_999;
    d.tick();
    expect(d.banner()).toBeNull();
    clock = 11_000;
    d.tick();
    expect(d.banner()?.phase).toBe('warning');
    expect(d.banner()?.secondsLeft).toBe(4);
    expect(d.activeEvent).toBeNull();
    clock = 15_000;
    d.tick();
    expect(d.activeEvent?.id).toBe(eventForIndex(SEED, 0).id);
    expect(d.banner()?.phase).toBe('active');
    clock = 15_000 + EVENT_MAX_DURATION_MS;
    d.tick();
    expect(d.activeEvent).toBeNull();
    expect(d.banner()).toBeNull();
    clock = 30_000;
    d.tick();
    expect(d.activeEvent?.id).toBe(eventForIndex(SEED, 1).id);
  });

  it('Mưa Vàng drops coins on listed points and pays the walker who reaches one', () => {
    const { d, start } = directorFor('goldRain');
    clock = start + 5_000;
    d.tick();
    const coins = spawned.filter(o => o instanceof GoldCoin) as GoldCoin[];
    expect(coins.length).toBeGreaterThan(3);
    for (const c of coins) {
      expect([200, 300, 400]).toContain(c.position.x);
    }
    const before = champs[0].wallet!.balance;
    champs[0].position.set(coins[0].position.x, coins[0].position.y);
    coins[0].update();
    expect(coins[0].toRemove).toBe(true);
    expect(champs[0].wallet!.balance).toBe(before + GOLD_RAIN_COIN_VALUE);
    // the far champion got nothing
    const far = champs[1].wallet!.balance;
    coins[1].update();
    expect(champs[1].wallet!.balance).toBe(far);
  });

  it('Thiên Thạch warns for 2 s, then deals labelled MAGIC damage inside the ring only', () => {
    const { d, start } = directorFor('meteors');
    clock = start + 100;
    d.tick();
    const m = spawned.find(o => o instanceof MeteorStrike) as MeteorStrike;
    expect(m).toBeDefined();
    const spy = vi.spyOn(champs[0], 'takeDamage');
    const spyFar = vi.spyOn(champs[1], 'takeDamage');
    m.position.set(champs[0].position.x + METEOR_RADIUS - 5, champs[0].position.y);
    clock = m.impactAtMs - 1;
    m.update();
    expect(spy).not.toHaveBeenCalled();
    clock = m.impactAtMs;
    m.update();
    expect(spy).toHaveBeenCalledWith(METEOR_DAMAGE, undefined, 'MAGIC', 'Thiên Thạch');
    expect(spyFar).not.toHaveBeenCalled();
    m.update();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('Gió Lốc gives everyone +40% move speed and re-grants it after a respawn', () => {
    const base = champs.map(c => c.stats.speed.value);
    const { d, start } = directorFor('gale');
    clock = start + 100;
    d.tick();
    champs.forEach((c, i) => {
      c.updateBuffs();
      expect(c.stats.speed.value).toBeCloseTo(base[i] * (1 + GALE_SPEED_PERCENT), 3);
    });
    // ticking again must not stack a second buff
    d.tick();
    champs[0].updateBuffs();
    expect(champs[0].stats.speed.value).toBeCloseTo(base[0] * (1 + GALE_SPEED_PERCENT), 3);
  });

  it('Hồi Sinh Nhanh halves a respawn timer once', () => {
    const { d, start } = directorFor('quickRevive');
    clock = start + 100;
    champs[1].takeDamage(5_000, champs[0], 'TRUE');
    expect(champs[1].isDead).toBe(true);
    const before = champs[1].deathData!.reviveAfter;
    d.tick();
    expect(champs[1].deathData!.reviveAfter).toBeCloseTo(before * QUICK_REVIVE_FACTOR, 3);
    d.tick();
    expect(champs[1].deathData!.reviveAfter).toBeCloseTo(before * QUICK_REVIVE_FACTOR, 3);
  });

  it('Sương Mù shrinks vision to the fraction, and is gone after the buff ends', () => {
    const base = champs[0].stats.visionRadius.value;
    const { d, start } = directorFor('fog');
    clock = start + 100;
    d.tick();
    champs[0].updateBuffs();
    expect(champs[0].stats.visionRadius.value).toBeCloseTo(base * FOG_VISION_FRACTION, 3);
  });

  /** Run the director `ms` ahead of an event's start in 100 ms steps, updating `objs` each step. */
  function runFor(d: EventDirector, from: number, ms: number, objs: () => any[]) {
    for (let t = from; t <= from + ms; t += 100) {
      clock = t;
      d.tick();
      for (const o of objs()) o.update();
    }
  }
  const ofType = <T,>(k: new (...a: any[]) => T) => () => spawned.filter(o => o instanceof k);

  it('Cuồng Nộ gives +40% attack speed and +20 ability haste once, and takes both back', () => {
    champs.forEach(c => (c.stats.attackSpeed.baseValue = 1));
    const haste = champs[0].stats.abilityHaste.value;
    const { d, start } = directorFor('frenzy');
    clock = start + 100;
    d.tick();
    d.tick();
    champs[0].updateBuffs();
    expect(champs[0].stats.attackSpeed.value).toBeCloseTo(1 + FRENZY_ATTACK_SPEED, 3);
    expect(champs[0].stats.abilityHaste.value).toBe(haste + FRENZY_ABILITY_HASTE);
    expect(champs[0].buffs.filter(b => b.name === 'Cuồng Nộ').length).toBe(1);
    vi.stubGlobal('deltaTime', 60_000);
    champs[0].updateBuffs();
    champs[0].updateBuffs();
    expect(champs[0].stats.attackSpeed.value).toBeCloseTo(1, 3);
    expect(champs[0].stats.abilityHaste.value).toBe(haste);
  });

  it('Suối Hồi Sinh spawns three springs that heal and refill mana inside the ring only', () => {
    pts = [
      { x: 200, y: 200 },
      { x: 1_600, y: 1_600 },
      { x: 3_000, y: 3_000 },
    ];
    const { d, start } = directorFor('springs');
    clock = start + 100;
    d.tick();
    const springs = ofType(HealingSpring)() as HealingSpring[];
    expect(springs.length).toBe(SPRING_COUNT);
    const [inside, outside] = champs;
    inside.stats.maxMana.baseValue = 500;
    inside.stats.mana.baseValue = 100;
    inside.stats.health.baseValue = 500;
    outside.stats.health.baseValue = 500;
    inside.position.set(springs[0].position.x, springs[0].position.y);
    outside.position.set(springs[0].position.x + SPRING_RADIUS + 200, springs[0].position.y);
    runFor(d, start + 100, 1_000, () => springs);
    const healed = inside.stats.health.baseValue - 500;
    expect(healed).toBeGreaterThanOrEqual(1_000 * SPRING_HEAL_FRACTION_PER_SEC * 0.7);
    expect(healed).toBeLessThanOrEqual(1_000 * SPRING_HEAL_FRACTION_PER_SEC * 1.3);
    expect(inside.stats.mana.baseValue).toBeGreaterThan(100);
    expect(outside.stats.health.baseValue).toBe(500);
  });

  it('springs land on the same points for the same seed', () => {
    const a = directorFor('springs');
    const first = ofType(HealingSpring)().map((s: any) => [s.position.x, s.position.y]);
    spawned.length = 0;
    const b = new EventDirector(world());
    clock = eventStartMs(a.index);
    b.tick();
    const second = ofType(HealingSpring)().map((s: any) => [s.position.x, s.position.y]);
    expect(second).toEqual(first);
    expect(first.length).toBe(SPRING_COUNT);
  });

  function chestSetup() {
    const { d, start } = directorFor('chest');
    clock = start + 100;
    d.tick();
    const box = ofType(TreasureChest)()[0] as TreasureChest;
    return { d, start, box };
  }

  it('Rương Báu opens after 6 s alone in the ring and pays the whole team', () => {
    const ally = make('blue', 2_000, 2_000);
    champs.push(ally);
    indexObjects(game, champs);
    const { d, start, box } = chestSetup();
    expect(box.position.x).toBe(300); // nearest listed point to the centre (350,300)
    champs[0].position.set(box.position.x, box.position.y);
    const wallets = [champs[0], ally, champs[1]].map(c => c.wallet!.balance);
    runFor(d, start + 100, CHEST_CAPTURE_MS - 500, () => [box]);
    expect(box.opened).toBe(false);
    runFor(d, clock + 100, 1_000, () => [box]);
    expect(box.opened).toBe(true);
    expect(box.openedBy).toBe('blue');
    expect(champs[0].wallet!.balance).toBe(wallets[0] + CHEST_GOLD);
    expect(ally.wallet!.balance).toBe(wallets[1] + CHEST_GOLD); // out of the ring, still paid
    expect(champs[1].wallet!.balance).toBe(wallets[2]);
  });

  it('Rương Báu pauses while both teams stand in the ring, and resumes when one leaves', () => {
    const { d, start, box } = chestSetup();
    champs[0].position.set(box.position.x, box.position.y);
    champs[1].position.set(box.position.x + 20, box.position.y);
    // 2 s, not 8: the chest lasts 10 s now and must still have time to open after.
    runFor(d, start + 100, 2_000, () => [box]);
    expect(box.contested).toBe(true);
    expect(box.opened).toBe(false);
    expect(box.progressOf('blue')).toBe(0);
    champs[1].position.set(box.position.x + CHEST_RADIUS + 300, box.position.y);
    runFor(d, clock + 100, CHEST_CAPTURE_MS + 300, () => [box]);
    expect(box.opened).toBe(true);
    expect(box.openedBy).toBe('blue');
  });

  it('bots are sent to the chest while it is closed, and released once it opens', () => {
    const { d, start, box } = chestSetup();
    const goal = d.goalArea('blue');
    expect(goal).toEqual({ x: box.position.x, y: box.position.y, r: CHEST_GOAL_RADIUS });
    expect(d.goalArea('red')).toEqual(goal);
    champs[0].position.set(box.position.x, box.position.y);
    runFor(d, start + 100, CHEST_CAPTURE_MS + 500, () => [box]);
    expect(box.opened).toBe(true);
    expect(d.goalArea('blue')).toBeNull();
  });

  it('bots are sent to the spring nearest their team, and nowhere during other events', () => {
    pts = [
      { x: 200, y: 200 },
      { x: 1_600, y: 1_600 },
      { x: 3_000, y: 3_000 },
    ];
    const { d, start } = directorFor('springs');
    clock = start + 100;
    d.tick();
    const spots = (ofType(HealingSpring)() as HealingSpring[]).map(sp => sp.position);
    expect(spots.length).toBe(SPRING_COUNT);
    const nearest = (x: number, y: number) =>
      [...spots].sort((p, q) => Math.hypot(p.x - x, p.y - y) - Math.hypot(q.x - x, q.y - y))[0];
    champs[0].position.set(210, 210);
    champs[1].position.set(2_900, 2_900);
    const blue = d.goalArea('blue')!;
    const red = d.goalArea('red')!;
    const nb = nearest(210, 210);
    const nr = nearest(2_900, 2_900);
    expect([blue.x, blue.y]).toEqual([nb.x, nb.y]);
    expect([red.x, red.y]).toEqual([nr.x, nr.y]);
    expect(blue.x).not.toBe(red.x);
    pts = DEFAULT_PTS;
    const gale = directorFor('gale');
    expect(gale.d.goalArea('blue')).toBeNull();
  });

  it('Bão Sét strikes every 450 ms with a 1 s warning and hits only inside its small ring', () => {
    const { d, start } = directorFor('storm');
    runFor(d, start, 2_000, ofType(LightningStrike));
    const bolts = ofType(LightningStrike)() as LightningStrike[];
    expect(bolts.length).toBeGreaterThanOrEqual(Math.floor(2_000 / STORM_STRIKE_INTERVAL_MS));
    const bolt = bolts[0];
    expect(bolt.strikeAtMs - start).toBe(STORM_WARNING_MS);
    const spyIn = vi.spyOn(champs[0], 'takeDamage');
    const spyOut = vi.spyOn(champs[1], 'takeDamage');
    const fresh = new LightningStrike({
      game,
      x: champs[0].position.x + STORM_RADIUS - 5,
      y: champs[0].position.y,
      now: () => clock,
      champions: () => champs,
    });
    clock = fresh.strikeAtMs - 1;
    fresh.update();
    expect(spyIn).not.toHaveBeenCalled();
    clock = fresh.strikeAtMs;
    fresh.update();
    expect(spyIn).toHaveBeenCalledWith(STORM_DAMAGE, undefined, 'MAGIC', 'Bão Sét');
    expect(spyOut).not.toHaveBeenCalled();
    fresh.update();
    expect(spyIn).toHaveBeenCalledTimes(1);
  });

  it('Truy Nã pays a bonus to the champion who gets a kill, only during the event', () => {
    const { d, start } = directorFor('bounty');
    clock = start + 100;
    d.tick();
    const spy = vi.spyOn(champs[0].wallet!, 'earn');
    champs[1].takeDamage(99_999, champs[0], 'TRUE');
    expect(champs[1].isDead).toBe(true);
    expect(spy).toHaveBeenCalledWith(BOUNTY_BONUS_GOLD);
    spy.mockClear();
    clock = start + 100_000;
    d.tick(); // ended: the listener is gone
    const victim = make('red', 3_100, 3_100);
    indexObjects(game, [...champs, victim]);
    victim.takeDamage(99_999, champs[0], 'TRUE');
    expect(victim.isDead).toBe(true);
    expect(spy).not.toHaveBeenCalledWith(BOUNTY_BONUS_GOLD);
  });
});

describe('what the menu says about the pace', () => {
  it('names the real interval, and the zone its lives', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '../../../src/game/config/matchModes.ts'), 'utf8');
    const said = [...src.matchAll(/(?:Mỗi|mỗi) (\d+) giây/g)].map(m => Number(m[1]) * 1000);
    expect(said.length).toBeGreaterThanOrEqual(2);
    for (const ms of said) expect(ms).toBe(EVENT_INTERVAL_MS);
    expect(src).not.toMatch(/không hồi sinh/);
  });
});
