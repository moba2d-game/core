/**
 * Everything a content pack may import as a type.
 *
 * Types and values leave core by different doors, and the reason is what a
 * pack becomes: its own package, compiled against core's `.d.ts` and handed
 * core's runtime objects. A type-only import survives that intact — it is
 * erased before anything runs, so it creates no second copy of a class and no
 * `instanceof` that answers wrong. A *value* import would create exactly
 * those, which is why `ContentApi` exists and why nothing here is a value.
 *
 * So: `import type { CastContext } from '@/content/types'` is correct and
 * always will be; `import { Slow } from '@/game/gameObject/buffs/Slow'` is
 * not, and the `pack-core-boundary` seam fails the pack's own build over it.
 */
export type {
  ActivationPattern,
  ActiveSpec,
  AttackOrderPolicy,
  CancelReason,
  CastContext,
  CastSpec,
  ChannelSpec,
  ChargeActivation,
  ChargeCastSpec,
  ChargeSpec,
  CooldownPolicy,
  CooldownStartPoint,
  InterruptPolicy,
  ResourceCommitPoint,
  ResourcePolicy,
  SpellRuntimeState,
  TargetingMode,
  Vec2,
} from '@/game/spell/runtime/types';

/**
 * More type-only gaps, found the same way the rest of this barrel was:
 * measured against what the spell tree actually imports, not guessed —
 * first by reading the import surface directly, then by the compiler itself
 * once packs/riot/spells/ was real (each remaining `Cannot find name` under
 * `tsc -p tsconfig.strict-core.json` named one more). `ContentApi`-surface
 * checks (now `coreSpellsApiSurface.test.ts`) only ever asserted VALUE
 * coverage — its own doc comment says type-only imports are skipped, on
 * purpose, because a type is erased and has no runtime object to be
 * "reachable" through — so none of these ever had to justify themselves
 * against that scan. They still needed a home once packs/riot/spells/ could
 * no longer reach into core directly at all: `BasicAttackHit` is the
 * `ON_ATTACK_HIT` payload shape (15 files, all read-only);
 * `BasicAttackController` names the field a bot reads off
 * `this.owner.basicAttack` (one skillshot, purely as a cast target, never
 * constructed); `GameObjectRuntimeContext` is a lantern-throw ability's helper's `game`
 * parameter type; `KillCredit` is a clone spell's clone declaring how a kill on it
 * should be scored; `TargetingRequest` is the shape every `UNIT`-targeting
 * spell's `targetingRequest` field returns (20 files); the rest
 * (`ExecuteFallback`/`ExecuteSpell`, `DynamicWall`, `BeamGeometry`,
 * `WallContact`, `AssetHandle`) are one or two spells each, named in the
 * commit that added them rather than repeated here.
 */
export type { BasicAttackHit } from '@/game/combat/BasicAttack';
export type { OnHitEvent } from '@/game/combat/OnHit';
export type { default as BasicAttackController } from '@/game/combat/BasicAttackController';
export type { GameObjectRuntimeContext } from '@/game/gameObject/GameObject';
export type { KillCredit } from '@/game/combat/MatchTally';
export type { TargetingRequest } from '@/game/spell/targeting/TargetResolver';
export type { ExecuteFallback, ExecuteSpell } from '@/game/combat/ExecuteTargeting';
export type { DynamicWall } from '@/game/gameObject/map/DynamicTerrain';
export type { BeamGeometry } from '@/game/gameObject/spellObjects/BeamSpellObject';
export type { WallContact } from '@/game/gameObject/map/TerrainField';
export type { AssetHandle } from '@/managers/AssetManager';

/**
 * Two more type-only gaps, added for Task 4 of the pack/SDK split —
 * contract vocabulary rather than spell vocabulary, which is why they land
 * here and not in `src/testing`. `MatchRules` is what a synthetic
 * match-rules object (built to exercise a rules variant without starting a
 * real match) gets typed as; `GameObject` is the base class type this
 * module has, until now, only re-exported the runtime-context shape of
 * (`GameObjectRuntimeContext`, above) — code holding a plain array of game
 * objects has had no published element type to name it with.
 */
export type { MatchRules } from '@/game/config/PregameConfig';
/**
 * The third argument to `takeDamage`. A pack names it when its ability is not
 * magic — a physical on-hit, a true-damage execute — and omits it otherwise.
 */
export type { DamageType } from '@/game/combat/Mitigation';
export type { default as GameObject } from '@/game/gameObject/GameObject';

export type { ContentApi } from './ContentApi';
export type {
  ChampionAttack,
  ChampionEntry,
  ContentPack,
  ContentPackCode,
  ContentPackData,
  ContentPackFactory,
  Faction,
  ChampionTuning,
  EconomyTuning,
  FountainStats,
  FountainTuning,
  IceTuning,
  LaneDefinition,
  MapDefinition,
  MapGeometry,
  MapGeometryLoader,
  MapGeometrySource,
  MapSummary,
  MapTuning,
  MinionSlot,
  MinionStyle,
  MinionTuning,
  MinionTypeDef,
  MonsterAbility,
  MonsterDef,
  MonsterRoam,
  MonsterScale,
  MonsterSlotStats,
  MonsterTemperament,
  MonsterTuning,
  NeutralKind,
  NeutralSlot,
  PackManifest,
  SlotObjectFactory,
  SpawnSlot,
  SpellClass,
  SpellDisplayData,
  SpellLoader,
  SpellSource,
  StructureKind,
  StructureSlot,
  TerrainLayerTuning,
  TerrainTuning,
  TurretStats,
  TurretTuning,
  WaveStage,
} from './ContentPack';

/**
 * The instance type of every class `api` hands out.
 *
 * A pack receives constructors — `api.Spell`, `api.buffs.Slow` — and needs
 * their *instance* types to write a field or a parameter. Without these it
 * derives each one itself, at the top of every file that wants one:
 *
 *     type AttackableUnit = InstanceType<ContentApi['units']['AttackableUnit']>;
 *
 * Measured on `@moba2d/content-lol`: 221 of those lines still being read
 * after the dead ones were deleted, spelling out 18 distinct types, 120 of
 * them that same `AttackableUnit`. Each is correct and each was invented
 * independently, which is the real cost — the shape of it teaches a new pack
 * author that naming a core type is supposed to be hard.
 *
 * **Derived from `ContentApi`, never re-exported from `@/game/...`.** A
 * direct re-export would be a second declaration of the same thing, free to
 * say something `api` does not the day a member is narrowed; deriving keeps
 * one source of truth and makes these strictly a shorter spelling of what a
 * pack would have written. It also adds no reach: every one of them was
 * already nameable through `ContentApi`, which this module already publishes.
 *
 * `tests/content/contentTypes.test.ts` pins the buff list against `BUFFS`
 * itself, so a new buff class cannot land without a pack being able to name
 * it.
 */
import type { ContentApi } from './ContentApi';

// The spell hierarchy, and the delivery primitives a skillshot extends.
export type Spell = InstanceType<ContentApi['Spell']>;
export type SpellObject = InstanceType<ContentApi['SpellObject']>;
export type MissileSpellObject = InstanceType<ContentApi['MissileSpellObject']>;
export type AreaSpellObject = InstanceType<ContentApi['AreaSpellObject']>;
export type BeamSpellObject = InstanceType<ContentApi['BeamSpellObject']>;
export type HomingMissileSpellObject = InstanceType<ContentApi['HomingMissileSpellObject']>;
export type AoePulse = InstanceType<ContentApi['AoePulse']>;

// Units. `AttackableUnit` is the one a spell names most: it is what a hit
// lands on, what a filter narrows to, and what a buff is applied to.
export type AttackableUnit = InstanceType<ContentApi['units']['AttackableUnit']>;
export type Champion = InstanceType<ContentApi['units']['Champion']>;
export type Pet = InstanceType<ContentApi['units']['Pet']>;
export type Monster = InstanceType<ContentApi['units']['Monster']>;
export type StatModifier = InstanceType<ContentApi['units']['StatModifier']>;
export type StatsModifier = InstanceType<ContentApi['units']['StatsModifier']>;

// Buffs — the whole of `BUFFS`, kept complete by contentTypes.test.ts.
export type Buff = InstanceType<ContentApi['buffs']['Buff']>;
export type Airborne = InstanceType<ContentApi['buffs']['Airborne']>;
export type Charm = InstanceType<ContentApi['buffs']['Charm']>;
export type Chilled = InstanceType<ContentApi['buffs']['Chilled']>;
export type DamageOverTime = InstanceType<ContentApi['buffs']['DamageOverTime']>;
export type DamageReflect = InstanceType<ContentApi['buffs']['DamageReflect']>;
export type Dash = InstanceType<ContentApi['buffs']['Dash']>;
export type Disarm = InstanceType<ContentApi['buffs']['Disarm']>;
export type Fear = InstanceType<ContentApi['buffs']['Fear']>;
export type Ground = InstanceType<ContentApi['buffs']['Ground']>;
export type HealCut = InstanceType<ContentApi['buffs']['HealCut']>;
export type ShieldCut = InstanceType<ContentApi['buffs']['ShieldCut']>;
export type Invisible = InstanceType<ContentApi['buffs']['Invisible']>;
export type Invulnerable = InstanceType<ContentApi['buffs']['Invulnerable']>;
export type Nearsight = InstanceType<ContentApi['buffs']['Nearsight']>;
export type Phasing = InstanceType<ContentApi['buffs']['Phasing']>;
export type Root = InstanceType<ContentApi['buffs']['Root']>;
export type Shield = InstanceType<ContentApi['buffs']['Shield']>;
export type Silence = InstanceType<ContentApi['buffs']['Silence']>;
export type Slow = InstanceType<ContentApi['buffs']['Slow']>;
export type Speedup = InstanceType<ContentApi['buffs']['Speedup']>;
export type Stasis = InstanceType<ContentApi['buffs']['Stasis']>;
export type StatAmp = InstanceType<ContentApi['buffs']['StatAmp']>;
export type Stun = InstanceType<ContentApi['buffs']['Stun']>;
export type Taunt = InstanceType<ContentApi['buffs']['Taunt']>;
export type TrueSight = InstanceType<ContentApi['buffs']['TrueSight']>;
export type Untargetable = InstanceType<ContentApi['buffs']['Untargetable']>;

// Helpers a spell constructs for its own VFX.
export type ParticleSystem = InstanceType<ContentApi['helpers']['ParticleSystem']>;
export type TrailSystem = InstanceType<ContentApi['helpers']['TrailSystem']>;
export type CombatText = InstanceType<ContentApi['helpers']['CombatText']>;

// Quadtree shapes, which every area query is expressed in.
export type Circle = InstanceType<ContentApi['utils']['Quadtree']['Circle']>;
export type Rectangle = InstanceType<ContentApi['utils']['Quadtree']['Rectangle']>;
export type { TurretPassive } from '@/game/gameObject/structures/Turret';
