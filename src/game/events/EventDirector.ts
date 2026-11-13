import Speedup from '@/game/gameObject/buffs/Speedup';
import Nearsight from '@/game/gameObject/buffs/Nearsight';
import StatAmp from '@/game/gameObject/buffs/StatAmp';
import CombatText, { GOLD_TEXT_COLOR } from '@/game/gameObject/helpers/CombatText';
import type { UnitDeathEvent } from '@/game/gameObject/attackableUnits/AttackableUnit';
import type Buff from '@/game/gameObject/Buff';
import type GameObject from '@/game/gameObject/GameObject';
import type { GameObjectGameContext } from '@/game/gameObject/GameObject';
import type Champion from '@/game/gameObject/attackableUnits/Champion';
import { seededRandom } from '../matchSeed';
import {
  FrenzyAura,
  GoldCoin,
  HealingSpring,
  LightningStrike,
  MeteorStrike,
  TreasureChest,
} from './eventObjects';
import {
    drawEventAmbience,
  drawEventBanner,
  drawEventTitle,
  freshEventView,
  type EventView,
} from './eventVfx';
import {
  BOUNTY_BONUS_GOLD,
  CHEST_RADIUS,
  EVENT_MAX_DURATION_MS,
  EVENT_WARNING_MS,
  FRENZY_ABILITY_HASTE,
  FRENZY_ATTACK_SPEED,
  SPRING_COUNT,
  SPRING_MIN_SEPARATION,
  SPRING_RADIUS,
  STORM_AIM_JITTER,
  STORM_STRIKE_INTERVAL_MS,
  STORM_WARNING_MS,
  nearestPoint,
  pickSeparated,
  FOG_VISION_FRACTION,
  GALE_SPEED_PERCENT,
  GOLD_RAIN_COINS,
  METEOR_AIM_JITTER,
  METEOR_COUNT,
  METEOR_WARNING_MS,
  QUICK_REVIVE_FACTOR,
  eventForIndex,
  eventStartMs,
  eventWarnMs,
  mixSeed,
  type Point,
  type RandomEventDef,
  type RandomEventId,
} from './randomEvents';

/** Gió Lốc's buff: a distinct class so its stack never mixes with a spell's Speedup. */
export class GaleBuff extends Speedup {
  name = 'Gió Lốc';
  percent = GALE_SPEED_PERCENT;
}

/** Cuồng Nộ's buff: its own class, so its stack never mixes with an item's or a spell's StatAmp. */
export class FrenzyBuff extends StatAmp {
  name = 'Cuồng Nộ';
  bonuses = {
    attackSpeed: { percentBaseBonus: FRENZY_ATTACK_SPEED },
    abilityHaste: { flatBonus: FRENZY_ABILITY_HASTE },
  };
}

/** Sương Mù's buff: vision shrinks to a share of the wearer's own. */
export class FogBuff extends Nearsight {
  name = 'Sương Mù';
  onCreate(): void {
    this.newVisionRadius = this.targetUnit.stats.visionRadius.baseValue * FOG_VISION_FRACTION;
    super.onCreate();
  }
}

/** What an event needs from the match. `Game` supplies one; tests supply a stub. */
export interface EventWorld {
  readonly game: GameObjectGameContext;
  readonly seed: number;
  /** `Game.matchTimeMs`. */
  now(): number;
  champions(): readonly Champion[];
  spawn(object: GameObject): void;
  /** Points a champion can walk to (`reachablePoints`). Called once per event that needs it. */
  reachable(): readonly Point[];
  /** The middle of the map, where the chest wants to be. */
  center(): Point;
  /** Side of the (square) map, for the one object that spans it. */
  mapSize(): number;
  /** Subscribes to champion deaths; returns the unsubscribe. */
  onDeath?(listener: (event: UnitDeathEvent) => void): () => void;
}

export interface GoalArea {
  x: number;
  y: number;
  r: number;
}

/** Bots are held this tight around the objective: inside the ring, not at its edge (`BotBrain.goalMargin`). */
export const CHEST_GOAL_RADIUS = Math.round(CHEST_RADIUS * 1.18);
export const SPRING_GOAL_RADIUS = Math.round(SPRING_RADIUS * 1.18);

interface EventRun {
  tick(now: number): void;
  /** Called when the event ends, for whatever it subscribed to. */
  end?(): void;
  /** Where this team's bots should go for this event's objective, if it has one. */
  goal?(teamId: unknown): GoalArea | null;
}

interface Timing {
  index: number;
  startMs: number;
  endMs: number;
  seed: number;
}

export interface EventBanner {
  phase: 'warning' | 'active';
  id: RandomEventId;
  title: string;
  subtitle: string;
  secondsLeft: number;
  color: readonly [number, number, number];
}

function goldRain(world: EventWorld, t: Timing): EventRun {
  const rng = seededRandom(mixSeed(t.seed, t.index, 1));
  const points = world.reachable();
  const step = (t.endMs - t.startMs - 2_000) / GOLD_RAIN_COINS;
  const drops: { at: number; p: Point }[] = [];
  for (let k = 0; k < GOLD_RAIN_COINS && points.length > 0; k++) {
    drops.push({ at: t.startMs + k * step, p: points[Math.floor(rng() * points.length)] });
  }
  let next = 0;
  return {
    tick(now) {
      while (next < drops.length && now >= drops[next].at) {
        const { p } = drops[next++];
        world.spawn(
          new GoldCoin({
            game: world.game,
            x: p.x,
            y: p.y,
            now: () => world.now(),
            champions: () => world.champions(),
          })
        );
      }
    },
  };
}

function meteors(world: EventWorld, t: Timing): EventRun {
  const rng = seededRandom(mixSeed(t.seed, t.index, 2));
  const points = world.reachable();
  const step = (t.endMs - t.startMs - METEOR_WARNING_MS) / METEOR_COUNT;
  const rolls = Array.from({ length: METEOR_COUNT }, () => [rng(), rng(), rng()]);
  let next = 0;
  return {
    tick(now) {
      while (next < METEOR_COUNT && now >= t.startMs + next * step) {
        const k = next++;
        const [u1, u2, u3] = rolls[k];
        let x: number | undefined;
        let y: number | undefined;
        const alive = world.champions().filter(c => !c.isDead);
        if (k % 2 === 1 && alive.length > 0) {
          const target = alive[Math.floor(u1 * alive.length)];
          const angle = u2 * Math.PI * 2;
          x = target.position.x + Math.cos(angle) * u3 * METEOR_AIM_JITTER;
          y = target.position.y + Math.sin(angle) * u3 * METEOR_AIM_JITTER;
        } else if (points.length > 0) {
          const p = points[Math.floor(u1 * points.length)];
          x = p.x;
          y = p.y;
        }
        if (x === undefined || y === undefined) continue;
        world.spawn(
          new MeteorStrike({ game: world.game, x, y, now: () => world.now(), champions: () => world.champions() })
        );
      }
    },
  };
}

/** Keeps one live buff of its kind on every living champion until the event ends. */
function buffEveryone(
  world: EventWorld,
  t: Timing,
  make: (champion: Champion, durationMs: number) => Buff
): EventRun {
  const applied = new WeakMap<Champion, Buff>();
  return {
    tick(now) {
      for (const champion of world.champions()) {
        if (champion.isDead) continue;
        const held = applied.get(champion);
        if (held && !held.toRemove && champion.buffs.includes(held)) continue;
        const buff = make(champion, Math.max(1, t.endMs - now));
        applied.set(champion, buff);
        champion.addBuff(buff);
      }
    },
  };
}

function quickRevive(world: EventWorld): EventRun {
  const halved = new WeakSet<object>();
  return {
    tick() {
      for (const champion of world.champions()) {
        const death = champion.deathData;
        if (!death || halved.has(death)) continue;
        halved.add(death);
        death.reviveAfter *= QUICK_REVIVE_FACTOR;
      }
    },
  };
}

const timed = (world: EventWorld, t: Timing) => ({
  game: world.game,
  now: () => world.now(),
  champions: () => world.champions(),
  endsAtMs: t.endMs,
});

function frenzy(world: EventWorld, t: Timing): EventRun {
  const everyone = buffEveryone(world, t, (c, ms) => new FrenzyBuff(ms, c, c));
  world.spawn(new FrenzyAura({ ...timed(world, t), extent: world.mapSize() }));
  return everyone;
}

function springs(world: EventWorld, t: Timing): EventRun {
  const rng = seededRandom(mixSeed(t.seed, t.index, 3));
  const spots = pickSeparated(world.reachable(), rng, SPRING_COUNT, SPRING_MIN_SEPARATION);
  for (const p of spots) world.spawn(new HealingSpring({ ...timed(world, t), x: p.x, y: p.y }));
  return {
    tick() {},
    goal(teamId) {
      // The spring nearest the team's living champions.
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (const c of world.champions()) {
        if (c.teamId !== teamId || c.isDead) continue;
        cx += c.position.x;
        cy += c.position.y;
        n++;
      }
      if (n === 0) return null;
      const spot = nearestPoint(spots, { x: cx / n, y: cy / n });
      return spot ? { x: spot.x, y: spot.y, r: SPRING_GOAL_RADIUS } : null;
    },
  };
}

function chest(world: EventWorld, t: Timing): EventRun {
  const spot = nearestPoint(world.reachable(), world.center());
  if (!spot) return { tick() {} };
  const box = new TreasureChest({ ...timed(world, t), x: spot.x, y: spot.y });
  world.spawn(box);
  return {
    tick() {},
    goal() {
      return box.opened || box.toRemove ? null : { x: spot.x, y: spot.y, r: CHEST_GOAL_RADIUS };
    },
  };
}

function storm(world: EventWorld, t: Timing): EventRun {
  const rng = seededRandom(mixSeed(t.seed, t.index, 4));
  const points = world.reachable();
  const total = Math.floor((t.endMs - t.startMs - STORM_WARNING_MS) / STORM_STRIKE_INTERVAL_MS);
  const rolls = Array.from({ length: total }, () => [rng(), rng(), rng()]);
  let next = 0;
  return {
    tick(now) {
      while (next < total && now >= t.startMs + next * STORM_STRIKE_INTERVAL_MS) {
        const [u1, u2, u3] = rolls[next];
        let x: number | undefined;
        let y: number | undefined;
        if (next % 2 === 1) {
          let alive = 0;
          for (const c of world.champions()) if (!c.isDead) alive++;
          if (alive > 0) {
            let pick = Math.floor(u1 * alive);
            for (const c of world.champions()) {
              if (c.isDead || pick-- > 0) continue;
              const angle = u2 * Math.PI * 2;
              x = c.position.x + Math.cos(angle) * u3 * STORM_AIM_JITTER;
              y = c.position.y + Math.sin(angle) * u3 * STORM_AIM_JITTER;
              break;
            }
          }
        }
        if (x === undefined && points.length > 0) {
          const p = points[Math.floor(u1 * points.length)];
          x = p.x;
          y = p.y;
        }
        next++;
        if (x === undefined || y === undefined) continue;
        world.spawn(
          new LightningStrike({ game: world.game, x, y, now: () => world.now(), champions: () => world.champions() })
        );
      }
    },
  };
}

/** Truy Nã: a champion kill booked to a champion of the other team pays a bonus. */
function bounty(world: EventWorld): EventRun {
  const stop = world.onDeath?.(event => {
    if (event.credit !== 'champion') return;
    const killer = event.creditedTo ?? event.killer;
    if (!killer || killer.killCredit !== 'champion' || killer.teamId === event.unit.teamId) return;
    const wallet = (killer as Champion).wallet;
    if (!wallet) return;
    wallet.earn(BOUNTY_BONUS_GOLD);
    CombatText.show(killer, 'gold', BOUNTY_BONUS_GOLD, [...GOLD_TEXT_COLOR]);
  });
  return { tick() {}, end: stop };
}

function beginRun(def: RandomEventDef, world: EventWorld, t: Timing): EventRun {
  switch (def.id) {
    case 'goldRain':
      return goldRain(world, t);
    case 'meteors':
      return meteors(world, t);
    case 'gale':
      return buffEveryone(world, t, (c, ms) => {
        const buff = new GaleBuff(ms, c, c);
        buff.percent = GALE_SPEED_PERCENT;
        return buff;
      });
    case 'quickRevive':
      return quickRevive(world);
    case 'fog':
      return buffEveryone(world, t, (c, ms) => new FogBuff(ms, c, c));
    case 'frenzy':
      return frenzy(world, t);
    case 'springs':
      return springs(world, t);
    case 'chest':
      return chest(world, t);
    case 'storm':
      return storm(world, t);
    case 'bounty':
      return bounty(world);
  }
}

/**
 * Runs the schedule: warns, begins, ticks and ends events. One tick per
 * simulation step, from `Game.fixedUpdate`, host and offline only — a LAN
 * client's damage is a no-op and its wallet is the host's, so it runs none
 * of this (it can still derive the same banner from the seed).
 */
export default class EventDirector {
  private nextIndex = 0;
  private readonly view: EventView = freshEventView();
  private active: (Timing & { def: RandomEventDef; run: EventRun }) | null = null;

  constructor(private readonly world: EventWorld) {}

  get activeEvent(): RandomEventDef | null {
    return this.active?.def ?? null;
  }

  /** Where `teamId`'s bots should go for the running event's objective; null when it has none. */
  goalArea(teamId: unknown): GoalArea | null {
    return this.active?.run.goal?.(teamId) ?? null;
  }

  /** Index of the next event that has not started yet. */
  get upcomingIndex(): number {
    return this.nextIndex;
  }

  tick(): void {
    const now = this.world.now();
    if (this.active && now >= this.active.endMs) {
      this.active.run.end?.();
      this.active = null;
      this.nextIndex++;
    }
    if (!this.active) {
      // A clock that jumped past whole events (a restored moment) skips them
      // rather than firing a stale one.
      while (now >= eventStartMs(this.nextIndex) + EVENT_MAX_DURATION_MS) this.nextIndex++;
      const startMs = eventStartMs(this.nextIndex);
      if (now >= startMs) {
        const def = eventForIndex(this.world.seed, this.nextIndex);
        const timing: Timing = {
          index: this.nextIndex,
          startMs,
          endMs: startMs + def.durationMs,
          seed: this.world.seed,
        };
        this.active = { ...timing, def, run: beginRun(def, this.world, timing) };
        this.view.labelSecond = -1;
      }
    }
    this.active?.run.tick(now);
  }

  banner(): EventBanner | null {
    const now = this.world.now();
    if (this.active) {
      const { def, endMs } = this.active;
      return {
        phase: 'active',
        id: def.id,
        title: def.name,
        subtitle: def.blurb,
        secondsLeft: Math.max(0, Math.ceil((endMs - now) / 1000)),
        color: def.color,
      };
    }
    const startMs = eventStartMs(this.nextIndex);
    if (now >= eventWarnMs(this.nextIndex) && now < startMs) {
      const def = eventForIndex(this.world.seed, this.nextIndex);
      return {
        phase: 'warning',
        id: def.id,
        title: `Sắp có: ${def.name}`,
        subtitle: def.blurb,
        secondsLeft: Math.max(0, Math.ceil((startMs - now) / 1000)),
        color: def.color,
      };
    }
    return null;
  }

  /**
   * Fills the reusable `view` for this frame; false when there is nothing to
   * say. No allocation but the label string, rebuilt once per second.
   */
  private fillView(): EventView | null {
    const now = this.world.now();
    const v = this.view;
    let def: RandomEventDef;
    if (this.active) {
      def = this.active.def;
      const { startMs, endMs } = this.active;
      v.phase = 'active';
      v.title = def.name;
      v.progress = (now - startMs) / (endMs - startMs);
      v.secondsLeft = Math.max(0, Math.ceil((endMs - now) / 1000));
      v.activeAgeMs = now - startMs;
      v.ageMs = now - (startMs - EVENT_WARNING_MS);
      v.leftMs = endMs - now;
    } else {
      const startMs = eventStartMs(this.nextIndex);
      if (!(now >= eventWarnMs(this.nextIndex) && now < startMs)) return null;
      def = eventForIndex(this.world.seed, this.nextIndex);
      v.phase = 'warning';
      v.title = `Sắp có: ${def.name}`;
      v.progress = (now - (startMs - EVENT_WARNING_MS)) / EVENT_WARNING_MS;
      v.secondsLeft = Math.max(0, Math.ceil((startMs - now) / 1000));
      v.activeAgeMs = -1;
      v.ageMs = now - (startMs - EVENT_WARNING_MS);
      v.leftMs = 1e9;
    }
    v.id = def.id;
    v.subtitle = def.blurb;
    v.color = def.color;
    if (v.labelSecond !== v.secondsLeft || !v.label.startsWith(v.title)) {
      v.label = `${v.title}  ${v.secondsLeft}s`;
      v.labelSecond = v.secondsLeft;
    }
    return v;
  }

  /** Screen-space banner and the big title that opens an event. */
  drawBanner(): void {
    const view = this.fillView();
    if (!view) return;
    drawEventBanner(view);
    drawEventTitle(view);
  }

  /** Light screen-space ambience for the running event (`tier` = `stressTier`). */
  drawAmbience(tier: 0 | 1 | 2): void {
    const active = this.active;
    if (!active || tier >= 2) return;
    const now = this.world.now();
    const k = Math.min((now - active.startMs) / 600, (active.endMs - now) / 600, 1);
    drawEventAmbience(active.def.id, now, k, tier);
  }
}
