import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { context, type PracticeBench } from '../practice/helpers';
import MatchDirector from '../../../src/game/MatchDirector';
import Champion from '../../../src/game/gameObject/attackableUnits/Champion';
import Monster from '../../../src/game/gameObject/attackableUnits/Monster';
import Spell from '../../../src/game/gameObject/Spell';
import Buff from '../../../src/game/gameObject/Buff';
import BuffAddType from '../../../src/game/enums/BuffAddType';
import { contentCatalog } from '../../../src/content/catalog';
import {
  applyMomentOverlay,
  captureCheckpoint,
  restoreCheckpoint,
  type CheckpointWorld,
} from '../../../src/game/checkpoint/Checkpoint';
import { sanitizeMomentOverlay } from '../../../src/game/config/savedMoments';
import { grantItem } from '../../../src/game/economy/ItemShop';

/** Same in-memory storage the director suites use — `persist()` runs on mutations. */
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

/**
 * A kit spell with everything a checkpoint records: a cooldown, the
 * `stackCount` contract, and plain scalar fields of its own — the shape a
 * pack's stacking ability has, without core naming one.
 */
class ProbeSpell extends Spell {
  name = 'ProbeSpell';
  coolDown = 8000;
  protected targetingMode = 'SELF' as const;
  chargeMs = 0;
  armed = false;
  private _count = 0;
  get stackCount(): number {
    return this._count;
  }
  setStackCount(count: number): boolean {
    this._count = count;
    return true;
  }
}

/** A timed effect with its own scalar, for the reconstruction round trip. */
class ProbeBuff extends Buff {
  name = 'ProbeBuff';
  power = 0;
}

/** A stacked family: several live instances sharing one stack identity. */
class StackedBuff extends Buff {
  name = 'StackedBuff';
  buffAddType = BuffAddType.STACKS_AND_OVERLAPS;
  maxStacks = 5;
}

/** One probe item per call, fresh pack id each time, `contract.test.ts`'s trick. */
let probeSeed = 0;
const seedItem = (): string => {
  const packId = `ckprobe${probeSeed++}`;
  contentCatalog().installData({
    manifest: { id: packId, version: '1.0.0', coreRange: '*' },
    items: {
      boots: { id: 'boots', name: 'Giày Thử', icon: 'spell_basic_attack', cost: 300 },
    },
  } as never);
  return `${packId}:boots`;
};

interface Bench {
  world: CheckpointWorld;
  bench: PracticeBench;
  director: MatchDirector;
}

/** The camp-suite fixture, one body at a time. */
const makeWolf = (game: unknown, camp: { x: number; y: number; r: number }): Monster =>
  new Monster({
    game,
    preset: {
      name: 'Wolf',
      // Null avatar, the monsterTier fixture's trick: construction skips the
      // asset registry, so the suite passes with whatever packs CI installed.
      avatar: null,
      camp,
      speed: 2,
      size: 40,
      attackRange: 50,
      reviveTime: 100,
      health: 100,
    },
  } as ConstructorParameters<typeof Monster>[0]);

/**
 * The practice bench plus the four fields `CheckpointWorld` adds over the
 * director context: match clocks, a wave clock with real fields, and the
 * LAN slot. The director is real, so `toPregameConfig()` and `bots()` are
 * the production answers.
 */
const makeWorld = (): Bench => {
  const bench = context();
  const director = new MatchDirector(bench.context);
  const world = Object.assign(bench.context, {
    matchTimeMs: 60_000,
    matchSeed: 4242,
    director,
    net: null,
    minionSpawner: {
      minions: [] as { toRemove: boolean }[],
      enabled: true,
      setEnabled() {},
      _elapsedMs: 90_000,
      _nextWaveIn: 7_000,
      waveCount: 3,
      _queue: [{ lane: 'mid' }],
    },
  }) as unknown as CheckpointWorld;
  return { world, bench, director };
};

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkpoint capture → mutate → restore', () => {
  it('puts position, pools, gold, cooldowns, spell scalars and stacks back', () => {
    const { world, bench } = makeWorld();
    const player = bench.player;
    const spell = new ProbeSpell(player);
    player.spells[1] = spell;

    player.position.set(640, 1280);
    player.stats.health.baseValue = 61;
    player.stats.mana.baseValue = 40;
    player.wallet?.earn(1450);
    const goldThen = player.wallet?.balance ?? 0;
    spell.currentCooldown = 2500;
    spell.setStackCount(88);
    spell.chargeMs = 1200;
    spell.armed = true;

    const checkpoint = captureCheckpoint(world, 'Mốc 1');
    expect(checkpoint.summary).toContain('vàng');

    // The fight goes badly.
    player.position.set(9, 9);
    player.stats.health.baseValue = 5;
    player.stats.mana.baseValue = 1;
    player.wallet?.earn(9999);
    spell.currentCooldown = 0;
    spell.setStackCount(0);
    spell.chargeMs = 0;
    spell.armed = false;
    world.matchTimeMs = 300_000;

    expect(restoreCheckpoint(world, checkpoint)).toBe(true);

    expect(player.position.x).toBe(640);
    expect(player.position.y).toBe(1280);
    // The reposition is a blink, not a slide — the render origin snapped.
    expect(player.renderOriginX).toBe(640);
    expect(player.stats.health.value).toBeCloseTo(61, 5);
    expect(player.stats.mana.value).toBeCloseTo(40, 5);
    expect(player.wallet?.balance).toBe(goldThen);
    expect(spell.currentCooldown).toBe(2500);
    expect(spell.stackCount).toBe(88);
    expect(spell.chargeMs).toBe(1200);
    expect(spell.armed).toBe(true);
    expect(world.matchTimeMs).toBe(60_000);
  });

  it('rebuilds the buff set — scalars, a stacked family, and the source-spell link', () => {
    const { world, bench } = makeWorld();
    const player = bench.player;
    const spell = new ProbeSpell(player);
    player.spells[1] = spell;

    const timed = new ProbeBuff(9000, player, player);
    timed.power = 42;
    timed.timeElapsed = 3000;
    timed.sourceSpell = spell;
    player.addBuff(timed);
    for (let i = 0; i < 3; i++) player.addBuff(new StackedBuff(6000, player, player));

    const checkpoint = captureCheckpoint(world, 'Mốc buff');

    // Everything expires or is dispelled.
    for (const buff of player.buffs.slice()) buff.deactivateBuff();
    player.buffs.length = 0;

    restoreCheckpoint(world, checkpoint);

    const probes = player.buffs.filter(buff => buff instanceof ProbeBuff) as ProbeBuff[];
    const stacked = player.buffs.filter(buff => buff instanceof StackedBuff);
    expect(probes).toHaveLength(1);
    expect(probes[0].power).toBe(42);
    expect(probes[0].timeElapsed).toBe(3000);
    expect(probes[0].duration).toBe(9000);
    expect(probes[0].sourceSpell).toBe(spell);
    expect(probes[0].toRemove).toBe(false);
    expect(stacked).toHaveLength(3);
  });

  it('rebuilds the bag by slot, and a missing pack degrades to an empty slot', () => {
    const { world, bench } = makeWorld();
    const player = bench.player;
    const goodId = seedItem();
    grantItem(player, contentCatalog().item(goodId)!);
    expect(player.items[0]?.def.id).toBe(goodId);

    const checkpoint = captureCheckpoint(world, 'Mốc túi');
    expect(checkpoint.setup.items.player).toEqual([goodId]);

    // Sold everything since.
    for (let slot = 0; slot < player.items.length; slot++) player.unequipItem(slot);

    restoreCheckpoint(world, checkpoint);
    expect(player.items[0]?.def.id).toBe(goodId);
    expect(player.items[1]).toBeFalsy();

    // A save that names an id nothing installs: that slot stays empty, the
    // rest of the bag still lands — skip-and-carry-on, the template policy.
    checkpoint.units[0].bagSlots[0] = 'nothing:here';
    checkpoint.units[0].bagSlots[1] = goodId;
    restoreCheckpoint(world, checkpoint);
    expect(player.items[0]).toBeFalsy();
    expect(player.items[1]?.def.id).toBe(goodId);
  });

  it('restores camps in place — health, position, and a body mid-revive', () => {
    const { world, bench } = makeWorld();
    const camp = { x: 1000, y: 1000, r: 300 };
    const wolfA = makeWolf(bench.game, camp);
    const wolfB = makeWolf(bench.game, camp);
    world.monsters.push(wolfA, wolfB);

    wolfA.stats.health.baseValue = 40;
    wolfB.stats.health.baseValue = 0;
    wolfB.deathData = { reviveAfter: 9_000 };

    const checkpoint = captureCheckpoint(world, 'Mốc rừng');

    wolfA.stats.health.baseValue = 100;
    wolfA.position.set(50, 50);
    wolfB.deathData = null;
    wolfB.stats.health.baseValue = 100;

    restoreCheckpoint(world, checkpoint);

    expect(wolfA.stats.health.value).toBeCloseTo(40, 5);
    expect(wolfA.position.x).toBe(1000);
    expect(wolfB.isDead).toBe(true);
    expect(wolfB.deathData?.reviveAfter).toBe(9_000);
  });

  it('degrades to fresh camps when the standing bodies no longer match', () => {
    const { world, bench } = makeWorld();
    const camp = { x: 1000, y: 1000, r: 300 };
    world.monsters.push(makeWolf(bench.game, camp), makeWolf(bench.game, camp));

    const checkpoint = captureCheckpoint(world, 'Mốc rừng cũ');

    // A body left the list entirely (a pack change, cross-session). The
    // bench's `spawnJungle` is a no-op, so the rebuilt jungle cannot match
    // either — the restore must leave it fresh rather than guess.
    world.monsters.pop();
    expect(() => restoreCheckpoint(world, checkpoint)).not.toThrow();
    expect(world.monsters).toHaveLength(0);
  });

  it('restore while dead clears the death state', () => {
    const { world, bench } = makeWorld();
    const player = bench.player;
    player.stats.health.baseValue = 80;

    const checkpoint = captureCheckpoint(world, 'Mốc sống');

    // Down, with a long clock — the shape `die()` leaves behind, set
    // directly so the bench needs no announcer or camera.
    player.stats.health.baseValue = 0;
    player.deathData = { reviveAfter: 12_000 };
    expect(player.isDead).toBe(true);

    restoreCheckpoint(world, checkpoint);

    expect(player.isDead).toBe(false);
    expect(player.deathData).toBeNull();
    expect(player.stats.health.value).toBeCloseTo(80, 5);
  });

  it('restores a recorded death as a death, clock included', () => {
    const { world, bench } = makeWorld();
    const player = bench.player;
    player.stats.health.baseValue = 0;
    player.deathData = { reviveAfter: 4200 };

    const checkpoint = captureCheckpoint(world, 'Mốc chết');

    player.deathData = null;
    player.stats.health.baseValue = 100;

    restoreCheckpoint(world, checkpoint);

    expect(player.isDead).toBe(true);
    expect(player.deathData?.reviveAfter).toBe(4200);
    expect(player.stats.health.baseValue).toBe(0);
  });

  it('leaves the tally alone — a rewind undoes the fight, not the diary', () => {
    const { world, bench } = makeWorld();
    const player = bench.player;
    const checkpoint = captureCheckpoint(world, 'Mốc');

    player.tally.kills = 3;
    player.tally.deaths = 2;

    restoreCheckpoint(world, checkpoint);

    expect(player.tally.kills).toBe(3);
    expect(player.tally.deaths).toBe(2);
  });

  it('rewinds the wave clock and clears the field', () => {
    const { world } = makeWorld();
    const spawner = world.minionSpawner as unknown as {
      minions: { toRemove: boolean }[];
      _elapsedMs: number;
      _nextWaveIn: number;
      waveCount: number;
      _queue: unknown[];
    };

    const checkpoint = captureCheckpoint(world, 'Mốc sóng');

    spawner._elapsedMs = 200_000;
    spawner._nextWaveIn = 1;
    spawner.waveCount = 9;
    spawner._queue.push({}, {});
    const straggler = { toRemove: false };
    spawner.minions.push(straggler);

    restoreCheckpoint(world, checkpoint);

    expect(spawner._elapsedMs).toBe(90_000);
    expect(spawner._nextWaveIn).toBe(7_000);
    expect(spawner.waveCount).toBe(3);
    expect(spawner._queue).toHaveLength(0);
    expect(straggler.toRemove).toBe(true);
  });

  it('lays a serialized overlay over a fresh world — numbers cross, buffs do not', () => {
    const first = makeWorld();
    const player1 = first.bench.player;
    const spell1 = new ProbeSpell(player1);
    player1.spells[1] = spell1;

    first.world.matchTimeMs = 111_000;
    player1.position.set(777, 888);
    player1.stats.health.baseValue = 33;
    player1.wallet?.earn(2000);
    const gold = player1.wallet?.balance ?? 0;
    spell1.setStackCount(55);
    spell1.chargeMs = 700;
    spell1.currentCooldown = 3000;
    player1.addBuff(new ProbeBuff(5000, player1, player1));

    const checkpoint = captureCheckpoint(first.world, 'Qua phiên');
    // Through JSON and the sanitizer — the exact road a persisted moment
    // travels between sessions.
    const overlay = sanitizeMomentOverlay(JSON.parse(JSON.stringify(checkpoint.overlay)));

    const second = makeWorld();
    const player2 = second.bench.player;
    const spell2 = new ProbeSpell(player2);
    player2.spells[1] = spell2;

    applyMomentOverlay(second.world, overlay);

    expect(second.world.matchTimeMs).toBe(111_000);
    expect(player2.position.x).toBe(777);
    expect(player2.position.y).toBe(888);
    expect(player2.stats.health.value).toBeCloseTo(33, 5);
    expect(player2.wallet?.balance).toBe(gold);
    expect(spell2.stackCount).toBe(55);
    expect(spell2.chargeMs).toBe(700);
    expect(spell2.currentCooldown).toBe(3000);
    // The stated limitation, asserted: running timed effects stay behind.
    expect(player2.buffs).toHaveLength(0);
  });

  it('refuses outright in a LAN match', () => {
    const { world } = makeWorld();
    const checkpoint = captureCheckpoint(world, 'Mốc');
    world.matchTimeMs = 500_000;

    (world as { net: unknown }).net = { link: { lost: false } };

    expect(restoreCheckpoint(world, checkpoint)).toBe(false);
    expect(world.matchTimeMs).toBe(500_000);
  });
});
