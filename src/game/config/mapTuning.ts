import {
  CHAMPION_BOUNTY,
  DEFAULT_TURRET_PRESET,
  MINION_BOUNTY,
  DEFAULT_ATTACK_REVEAL_MS,
  DEFAULT_ATTACK_REVEAL_RADIUS,
  MONSTER_BOUNTY,
  MONSTER_CHASE_MARGIN,
  MONSTER_GIVE_UP_DELAY_MS,
  MONSTER_REGEN_DELAY_MS,
  MinionPresets,
  PASSIVE_GOLD_PER_SECOND,
  SELL_REFUND_FRACTION,
  ASSIST_WINDOW_MS,
  ASSIST_GOLD_SHARE,
  KILL_CREDIT_WINDOW_MS,
  STARTING_GOLD,
  TURRET_BOUNTY,
} from './tuningDefaults';
import type {
  ChampionScale,
  ChampionTuning,
  EconomyTuning,
  FountainStats,
  IceTuning,
  MapTuning,
  MonsterScale,
  MonsterTuning,
  MonsterSlotStats,
  NeutralSlot,
  SpawnSlot,
  StructureSlot,
  TerrainTuning,
  VisionTuning,
  TurretStats,
} from '@/content/ContentPack';
// Types only, and that is load-bearing rather than tidy: a type import is
// erased, so this file — pinned to the `pregame` chunk — names the three unit
// classes without any of them reaching the menu. Every *value* it needs comes
// from `./tuningDefaults`, which imports nothing at all.
import type { TurretPresetData } from '@/game/gameObject/structures/Turret';
import type { MonsterPresetData } from '@/game/gameObject/attackableUnits/Monster';
import type { MinionPresetData } from '@/game/gameObject/attackableUnits/Minion';

/**
 * Where a map's numbers meet core's, and the only place they do.
 *
 * ## Three layers, innermost wins
 *
 * ```
 * core default  →  map.tuning.<system>  →  slot.stats
 * ```
 *
 * A monster has a fourth, outermost layer — the pack's own `MonsterBody` —
 * which is why the map layer scales it rather than replacing it: a map cannot
 * know what will fill its slots. Everything else starts from a constant in
 * this repository that a map author can go and read, so those layers are
 * plain overrides.
 *
 * ## Why this is its own module
 *
 * `preset.ts` is 900 lines and its job is *slots to presets*. The arithmetic
 * of merging three layers is a different job with a different test shape —
 * plain objects in, plain objects out, no p5 globals, no `Game`, no content
 * registry — so it is testable on its own and every caller composes tuning
 * through these functions rather than reaching into `MapTuning` by hand.
 *
 * ## The rule every function here keeps
 *
 * **An absent field resolves to what core did before `MapTuning` existed.**
 * `resolve*(undefined, ...)` must reproduce today's numbers exactly, which is
 * what makes "every existing map plays identically" a thing a test can assert
 * once per system instead of a claim.
 */

/** `value` if it is a real number, otherwise `fallback`. */
const num = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * `base` scaled, if a finite multiplier was given.
 *
 * A non-finite multiplier is treated as absent rather than propagated: `NaN`
 * health is a unit that can never be damaged below full and whose bar draws
 * nowhere, which is a far worse outcome than an ignored typo.
 */
const scale = (base: number, multiplier: number | undefined): number =>
  typeof multiplier === 'number' && Number.isFinite(multiplier) ? base * multiplier : base;

const scaleOptional = (
  base: number | undefined,
  multiplier: number | undefined
): number | undefined => (base === undefined ? undefined : scale(base, multiplier));

/**
 * A field that may legitimately stay absent: a slot's absolute wins, else the
 * pack's value scaled, else nothing at all.
 *
 * The "nothing at all" branch is the point. `damage`, `attackInterval` and
 * `aggroRange` are optional on `MonsterPresetData` because `Monster` derives
 * its own defaults for them — `damage` from a share of the camp's health —
 * so resolving an absent one to a number here would silently take that
 * derivation away from every camp that relies on it.
 */
const optional = (
  absolute: number | undefined,
  baseValue: number | undefined,
  multiplier: number | undefined
): number | undefined =>
  typeof absolute === 'number' && Number.isFinite(absolute)
    ? absolute
    : scaleOptional(baseValue, multiplier);

// --------------------------------------------------------------- champions

/** What champion respawn was before any of this: a flat 5000ms, no curve. */
export const DEFAULT_CHAMPION_REVIVE_MS = 5_000;

/** Every champion multiplier at rest — one, which is "leave it alone". */
export const DEFAULT_CHAMPION_SCALE: Readonly<Required<ChampionScale>> = Object.freeze({
  healthMult: 1,
  damageMult: 1,
  speedMult: 1,
});

/**
 * How this map scales a champion, over whatever the pack declared.
 *
 * Clamped at zero rather than trusted: a negative multiplier is a champion
 * with negative health, which is a corpse that cannot be killed because it is
 * already dead — and `validate.ts` refusing it at install does not help a
 * locally-built map, which is exactly the kind a person is holding when they
 * type a minus sign by accident.
 */
export function resolveChampionScale(tuning?: MapTuning): Required<ChampionScale> {
  const scale: ChampionScale = tuning?.champions ?? {};
  const at = (value: number | undefined, fallback: number): number =>
    Math.max(0, num(value, fallback));
  return {
    healthMult: at(scale.healthMult, DEFAULT_CHAMPION_SCALE.healthMult),
    damageMult: at(scale.damageMult, DEFAULT_CHAMPION_SCALE.damageMult),
    speedMult: at(scale.speedMult, DEFAULT_CHAMPION_SCALE.speedMult),
  };
}

/**
 * How long a champion stays down, at `matchTimeMs` into the match.
 *
 * `reviveCurve` wins over `reviveTime` when both are present — a map that
 * states a curve has said the more specific thing, and silently averaging the
 * two would be a number nobody wrote.
 */
export function resolveChampionRevive(tuning: MapTuning | undefined, matchTimeMs: number): number {
  const champions: ChampionTuning | undefined = tuning?.champions;
  const curve = champions?.reviveCurve;
  if (curve) {
    const minutes = Math.max(0, matchTimeMs) / 60_000;
    const grown = num(curve.base, DEFAULT_CHAMPION_REVIVE_MS) + num(curve.perMinute, 0) * minutes;
    return Math.max(0, Math.min(grown, num(curve.max, Infinity)));
  }
  return Math.max(0, num(champions?.reviveTime, DEFAULT_CHAMPION_REVIVE_MS));
}

// ----------------------------------------------------------------- economy

/**
 * Core's own economy, stated once so `resolveEconomy` has a base to fall to.
 *
 * Typed as plain numbers rather than left to inference: `Object.freeze` on a
 * literal narrows every field to *that number*, so `startingGold` would be
 * the type `500` and a resolver returning 800 would not typecheck.
 */
export const DEFAULT_ECONOMY: Readonly<Required<EconomyTuning>> = Object.freeze({
  startingGold: STARTING_GOLD,
  passiveGoldPerSecond: PASSIVE_GOLD_PER_SECOND,
  minionBounty: MINION_BOUNTY,
  monsterBounty: MONSTER_BOUNTY,
  championBounty: CHAMPION_BOUNTY,
  turretBounty: TURRET_BOUNTY,
  sellRefund: SELL_REFUND_FRACTION,
  assistWindowMs: ASSIST_WINDOW_MS,
  assistGoldShare: ASSIST_GOLD_SHARE,
  killCreditWindowMs: KILL_CREDIT_WINDOW_MS,
});

export type ResolvedEconomy = Required<EconomyTuning>;

/**
 * The whole economy at once, never a field at a time.
 *
 * Callers take the resolved object and read what they need from it, rather
 * than each asking for its own number — `Wallet.ts`'s own header is the
 * argument for that, and it applies harder here: a map author looking at six
 * numbers together can see whether they still make sense against each other,
 * and six separate resolvers would invite retuning three of them.
 */
export function resolveEconomy(tuning: MapTuning | undefined): ResolvedEconomy {
  const own: EconomyTuning = tuning?.economy ?? {};
  return {
    startingGold: Math.max(0, num(own.startingGold, DEFAULT_ECONOMY.startingGold)),
    passiveGoldPerSecond: Math.max(
      0,
      num(own.passiveGoldPerSecond, DEFAULT_ECONOMY.passiveGoldPerSecond)
    ),
    minionBounty: Math.max(0, num(own.minionBounty, DEFAULT_ECONOMY.minionBounty)),
    monsterBounty: Math.max(0, num(own.monsterBounty, DEFAULT_ECONOMY.monsterBounty)),
    championBounty: Math.max(0, num(own.championBounty, DEFAULT_ECONOMY.championBounty)),
    turretBounty: Math.max(0, num(own.turretBounty, DEFAULT_ECONOMY.turretBounty)),
    // The one economy number with a ceiling as well as a floor. Above 1 an
    // item sells for more than it cost, which is a money printer rather than
    // a generous map: buy, sell, repeat, and the match is decided by whoever
    // clicks fastest.
    sellRefund: Math.min(1, Math.max(0, num(own.sellRefund, DEFAULT_ECONOMY.sellRefund))),
    assistWindowMs: Math.max(0, num(own.assistWindowMs, DEFAULT_ECONOMY.assistWindowMs)),
    // Ceilinged like `sellRefund` and for a related reason: above 1 an assist
    // pays better than the kill it attached to, and the cheapest way to get
    // rich is to stop short of finishing anybody.
    assistGoldShare: Math.min(
      1,
      Math.max(0, num(own.assistGoldShare, DEFAULT_ECONOMY.assistGoldShare))
    ),
    // Floored only, like `assistWindowMs` above and not ceilinged against
    // `MAX_ASSIST_WINDOW_MS`: that ceiling lives on `AttackableUnit`, which is
    // in the `game` chunk, and this module is pinned to `pregame`. A map that
    // asks for more than the participation ledger's own prune keeps simply
    // gets the prune's answer, which is still a window.
    killCreditWindowMs: Math.max(
      0,
      num(own.killCreditWindowMs, DEFAULT_ECONOMY.killCreditWindowMs)
    ),
  };
}

// ----------------------------------------------------------------- turrets

/** One turret's numbers: core's, then the map's, then this slot's. */
export function resolveTurretPreset(
  tuning: MapTuning | undefined,
  slot?: Pick<StructureSlot, 'stats'>
): TurretPresetData {
  const map: TurretStats = tuning?.turrets ?? {};
  const own: TurretStats = slot?.stats ?? {};
  const pick = (key: keyof TurretStats): number =>
    num(own[key], num(map[key], DEFAULT_TURRET_PRESET[key]));

  return {
    health: pick('health'),
    size: pick('size'),
    attackRange: pick('attackRange'),
    attackInterval: pick('attackInterval'),
    damage: pick('damage'),
    rebuildTime: pick('rebuildTime'),
    repairDelay: pick('repairDelay'),
    repairRate: pick('repairRate'),
  };
}

// ---------------------------------------------------------------- fountain

/** What `Fountain`'s own constructor falls back to, stated once. */
export const DEFAULT_FOUNTAIN_STATS = Object.freeze({
  name: 'Bệ Đá Cổ',
  tickInterval: 500,
  healPercent: 0.12,
  manaPercent: 0.12,
  // 0 is "the platform itself" — see `FountainStats.shopRange`. Stated as a
  // sentinel rather than as the platform's radius because this table has no
  // slot in scope, and the one place that does (`Fountain`) is where it is
  // resolved.
  shopRange: 0,
});

/** One fountain's numbers: core's, then the map's, then this slot's. */
export function resolveFountainStats(
  tuning: MapTuning | undefined,
  slot?: Pick<SpawnSlot, 'stats'>
): Required<FountainStats> {
  const map: FountainStats = tuning?.fountain ?? {};
  const own: FountainStats = slot?.stats ?? {};
  return {
    name:
      typeof own.name === 'string'
        ? own.name
        : typeof map.name === 'string'
          ? map.name
          : DEFAULT_FOUNTAIN_STATS.name,
    tickInterval: num(own.tickInterval, num(map.tickInterval, DEFAULT_FOUNTAIN_STATS.tickInterval)),
    healPercent: num(own.healPercent, num(map.healPercent, DEFAULT_FOUNTAIN_STATS.healPercent)),
    manaPercent: num(own.manaPercent, num(map.manaPercent, DEFAULT_FOUNTAIN_STATS.manaPercent)),
    shopRange: num(own.shopRange, num(map.shopRange, DEFAULT_FOUNTAIN_STATS.shopRange)),
  };
}

// ----------------------------------------------------------------- minions

/**
 * The minion roster this map plays with.
 *
 * A map that declares `types` **replaces** core's three outright rather than
 * merging into them — see `MinionTuning.types` for why a partial merge has no
 * honest meaning once the map can also add ids core has never heard of.
 *
 * `style` defaults to `'melee'`, which is the safe default rather than the
 * common one: a type that does not say how it fights gets the body that has
 * no projectile and no special art, so a missing field is visible in play
 * rather than being a caster that swings.
 */
export function resolveMinionTypes(
  tuning: MapTuning | undefined
): Record<string, MinionPresetData> {
  const declared = tuning?.minions?.types;
  if (!declared || Object.keys(declared).length === 0) return MinionPresets;

  const types: Record<string, MinionPresetData> = {};
  for (const [id, def] of Object.entries(declared)) {
    types[id] = {
      name: def.name,
      kind: id,
      style: def.style ?? 'melee',
      draw: typeof def.draw === 'function' ? def.draw : undefined,
      goldBounty: def.goldBounty,
      speed: def.speed,
      size: def.size,
      health: def.health,
      damage: def.damage,
      attackInterval: def.attackInterval,
      attackRange: def.attackRange,
      aggroRange: def.aggroRange,
    };
  }
  return types;
}

// ---------------------------------------------------------------- monsters

/**
 * One camp body's numbers, starting from what the pack declared.
 *
 * The order is what makes the two layers mean different things: the map's
 * multipliers scale the pack's number, and only then does the slot's absolute
 * — if it stated one — replace the result outright. A slot that says
 * `health: 400` gets 400, not 400 scaled again by the map's `healthMult`.
 *
 * `damage` and `attackInterval` stay `undefined` when neither layer names
 * them, because `Monster` defaults them itself (`damage` to a share of the
 * camp's health) and a number invented here would silently take that over.
 */
export function resolveMonsterPreset(
  base: MonsterPresetData,
  tuning: MapTuning | undefined,
  slot?: Pick<NeutralSlot, 'stats'>
): MonsterPresetData {
  // Typed as the whole group, not just its multipliers: the leash timers
  // below are read off the same object.
  const map: MonsterTuning = tuning?.monsters ?? {};
  const own: MonsterSlotStats = slot?.stats ?? {};
  const both = (key: keyof MonsterScale, value: number): number =>
    scale(scale(value, map[key]), own[key]);

  return {
    ...base,
    health: num(own.health, both('healthMult', base.health)),
    speed: both('speedMult', base.speed),
    // Scaled by the same multiplier its running pace is, and left `undefined`
    // rather than floored to 0 when the body declares none: a jungle a map has
    // slowed down should not have one camp still strolling at full speed, and
    // "does not wander" has to survive the merge as the absence it is.
    wanderSpeed:
      base.wanderSpeed === undefined ? undefined : both('speedMult', base.wanderSpeed),
    attackRange: num(own.attackRange, base.attackRange),
    reviveTime: num(own.reviveTime, both('reviveTimeMult', base.reviveTime)),
    damage: optional(own.damage, base.damage, map.damageMult),
    attackInterval: optional(undefined, base.attackInterval, map.attackIntervalMult),
    aggroRange: optional(own.aggroRange, base.aggroRange, map.aggroRangeMult),
    temperament: own.temperament ?? base.temperament,
    attackStyle: own.attackStyle ?? base.attackStyle,
    // Whole-object, not merged field by field: a map that restates a rig is
    // describing a different creature, and half of one body's legs on another
    // body's torso is not a thing anyone asked for.
    rig: own.rig ?? base.rig,
    // The three leash/reset timers, each falling through the full stack:
    // slot, then map, then whatever the *pack* declared for this body, then
    // core's own default. The pack layer used to be missing here — a boss
    // that stated a tighter leash than the jungle around it had that
    // statement silently replaced by the module constant, which is the one
    // way a merge can be wrong and still look right in every test that only
    // sets a map.
    chaseMargin: num(
      own.chaseMargin,
      num(map.chaseMargin, num(base.chaseMargin, MONSTER_CHASE_MARGIN))
    ),
    giveUpDelayMs: num(map.giveUpDelayMs, num(base.giveUpDelayMs, MONSTER_GIVE_UP_DELAY_MS)),
    regenDelayMs: num(map.regenDelayMs, num(base.regenDelayMs, MONSTER_REGEN_DELAY_MS)),
  };
}

// ----------------------------------------------------------------- terrain

/** Movement multipliers per region layer, and whether either is worth a pass. */
export interface ResolvedTerrainTuning {
  bush: number;
  water: number;
  /**
   * False when both are 1, which is every map that existed before this. The
   * whole per-frame cost of the terrain-speed mechanic is gated on it, so a
   * map that declares nothing pays one boolean and no queries.
   */
  affectsSpeed: boolean;
}

// ------------------------------------------------------------------ vision

/**
 * What core does when a map says nothing: League's own numbers, stated once.
 * `combat/AttackReveal.ts` is where they come from and why.
 */
export const DEFAULT_VISION_TUNING = Object.freeze({
  attackRevealMs: DEFAULT_ATTACK_REVEAL_MS,
  attackRevealRadius: DEFAULT_ATTACK_REVEAL_RADIUS,
});

export type ResolvedVisionTuning = Required<VisionTuning>;

export function resolveVisionTuning(tuning: MapTuning | undefined): ResolvedVisionTuning {
  const vision: VisionTuning = tuning?.vision ?? {};
  return {
    // Clamped at 0 rather than left free: a negative duration is a reveal that
    // has already expired, which is the same thing as "off" written in a way
    // nothing else in the codebase would recognise.
    attackRevealMs: Math.max(0, num(vision.attackRevealMs, DEFAULT_VISION_TUNING.attackRevealMs)),
    attackRevealRadius: Math.max(
      0,
      num(vision.attackRevealRadius, DEFAULT_VISION_TUNING.attackRevealRadius)
    ),
  };
}

export function resolveTerrainTuning(tuning: MapTuning | undefined): ResolvedTerrainTuning {
  const terrain: TerrainTuning = tuning?.terrain ?? {};
  const bush = Math.max(0, num(terrain.bush?.speedMultiplier, 1));
  const water = Math.max(0, num(terrain.water?.speedMultiplier, 1));
  return { bush, water, affectsSpeed: bush !== 1 || water !== 1 };
}

// --------------------------------------------------------------------- ice

export const DEFAULT_ICE_ACCEL_MS = 350;
export const DEFAULT_ICE_FRICTION_MS = 800;

export interface ResolvedIce {
  everywhere: boolean;
  accelMs: number;
  frictionMs: number;
}

/** Floors the time constants: 0 would divide by zero and mean "no ice" anyway. */
export function resolveIce(ice: IceTuning | undefined): ResolvedIce {
  return {
    everywhere: ice?.everywhere === true,
    accelMs: Math.max(1, num(ice?.accelMs, DEFAULT_ICE_ACCEL_MS)),
    frictionMs: Math.max(1, num(ice?.frictionMs, DEFAULT_ICE_FRICTION_MS)),
  };
}
