import type { ContentApi } from './ContentApi';
import type { TurretPassive } from '@/game/gameObject/structures/Turret';
import type {
  CreatureRigSpec,
  MonsterAbility,
  MonsterAttackStyle,
  MonsterRoam,
  MonsterTemperament,
} from '@/game/gameObject/attackableUnits/Monster';
import type { MinionStyle } from '@/game/gameObject/attackableUnits/Minion';
import type GameObject from '@/game/gameObject/GameObject';
import type { GameObjectRuntimeContext } from '@/game/gameObject/GameObject';

/**
 * Re-exported so a pack may `import type { MonsterAbility } from '@/content/types'`.
 *
 * `MonsterTemperament` and `MonsterRoam` ride the same door for the same
 * reason and are declared in the same place: core is what *implements* them
 * — a pack naming a fourth temperament would be naming behaviour that does
 * not exist — so the vocabulary is core's, while which one a given camp has
 * is the pack's to say.
 */
export type { MonsterAbility, MonsterAttackStyle, MonsterRoam, MonsterTemperament };

/** Re-exported beside the monster vocabularies, and core's for the same reason. */
import type { ChampionAI } from '@/game/ai/ChampionAI';
/** A pack's per-champion bot opinions. See `ContentPackCode.championAI`. */
export type { ChampionAI, AIContext, SpellSituation } from '@/game/ai/ChampionAI';
export type { MinionStyle };

/**
 * What a content pack is, and why the code half is a function.
 *
 * A pack's contract splits into a data half (`ContentPackData` — manifest,
 * champions, spell display, monsters, maps: read to draw a picker) and a code
 * half (`ContentPackCode` — spells, monster abilities: real engine classes).
 * `ContentPack`, the union every existing reader still names, is their
 * intersection.
 *
 * The code half stays a factory taking core's API, because the alternative is
 * a pack that bundles its own copy of `Spell`, `SpellObject` and the buffs —
 * and then there are two classes of every name in the process. `instanceof`
 * stops answering, `Z_INDEX_MAP` is looked up by base-class identity so a
 * pack's spell object matches no key and falls to z-index 99 on top of every
 * champion, and the buff registry exists twice. One core, handed in.
 *
 * The reason the split exists at all: reading a pack's *data* — its champion
 * list, a map to offer in a picker — used to mean building that whole engine
 * surface first, because the one function a pack exported needed the api to
 * run. A menu screen that only wants names and icons now never has to.
 *
 * The same shape also loads at runtime, which is the whole point:
 *
 *     Stage 1  import code from '@moba2d/content-lol'         -> code(api)
 *     Stage 2  const { default: code } = await import(url)     -> code(api)
 *
 * so batch 2 changes `install.ts` and nothing a pack author wrote.
 */
export type ContentPackFactory = (api: ContentApi) => ContentPackCode;

export interface PackManifest {
  /** A bare identifier. It becomes the prefix in every `<packId>:<localId>`. */
  id: string;
  /**
   * What the pack calls itself where a human reads it — the shop's per-pack
   * shelf headings. Optional, and the id stands in when absent, so no
   * existing pack owed an edit the day this field appeared.
   */
  name?: string;
  version: string;
  /** Which core versions this pack was built against. */
  coreRange: string;
  /**
   * The base a pack's own asset keys are namespaced under, or absent for a
   * pack that ships no art tree of its own.
   *
   * **Same question `qualify()` already answered, asked one field over.**
   * `ChampionEntry.image`, `MonsterBody.avatar` and `SpellDisplayData.iconKey`
   * are each documented "pack-relative" — a bare, local key the pack author
   * writes without knowing what any other installed pack calls its own art
   * (`'champ_yasuo'`, never `'riot:champ_yasuo'`). Two packs can each declare
   * a champion whose portrait is locally `'hero'`, and nothing before this
   * field told those two apart: both keys landed in one flat `AssetManager`
   * namespace, so whichever pack's `assets:generate` ran last — or merely
   * loaded last — silently won every collision. The fix is the identical
   * shape `qualify(packId, localId)` already uses everywhere else in this
   * file (spell ids, champion ids, monster ids, map ids): `PackRegistry.writeData`
   * rewrites `image`/`avatar`/`iconKey` into `<assets>:<localKey>` the same
   * way it rewrites `id`/`spells`/`recall`, and `AssetManager` resolves that
   * qualified form against exactly the one pack's own registered asset
   * manifest — see `AssetManager.registerPackAssets`'s own doc comment for
   * the resolve side of this same crossing. A second, independent
   * convention (say, folding the base into the key string by hand, the way
   * `packs/reference/spells/*.ts`'s `'reference_vera_q'` keys do today by
   * accident of their own folder name) was rejected on purpose: a codebase
   * with two ways to spell "which pack does this belong to" has neither.
   *
   * **Optional, not required, and the two states mean different things.**
   * `undefined` is not "this pack forgot to declare its assets" — it is
   * "this pack's `image`/`avatar`/`iconKey` strings, if it has any, are
   * already keys in *core's* flat namespace and must resolve there
   * unqualified." The reference pack is exactly this today: its five files
   * still live under core's own `assets/images/reference/`, so qualifying
   * its `iconKey`s here would turn a working `'reference_vera_q'` into a
   * broken `'reference:reference_vera_q'` that resolves nowhere. Setting
   * this field is what a pack does *after* moving its art into its own tree
   * (`packs/<id>/assets/`, generated by `assets:generate --tree=<id>`) —
   * the League pack's own manifest sets `assets: 'lol'` for exactly that
   * reason, once its 378 files stopped living in core's tree.
   *
   * Always equal to `id` in every pack this repository ships. A pack's
   * asset namespace and its content namespace are the same question, and a
   * separately-settable string here would let a future pack quietly desync
   * them for no reason a reader could ever recover — this field exists
   * anyway, rather than every asset-resolving call site reusing `id`
   * directly, so "does this pack ship real art" is a single yes/no a reader
   * (and `PackRegistry.writeData`) can see at a glance instead of having to
   * ask "does a `packs/<id>/assets/` directory happen to exist."
   */
  assets?: string;
}

/** A spell class. Loose on purpose — `spellRegistry.SpellClass` is `any` too. */
export type SpellClass = new (...args: never[]) => unknown;

/** A spell class that has not been fetched yet. Resolved at most once. */
export type SpellLoader = () => Promise<SpellClass>;

/**
 * How a pack hands over a spell.
 *
 * A class outright for a small pack; a thunk for a large one. The Riot pack is
 * 240 spells behind `src/generated/spellModules.ts`'s dynamic imports, and
 * handing those over eagerly would put every spell in the game into the first
 * chunk a match downloads — a chunking optimisation this codebase already made
 * once, on purpose, and which nothing in a type would have caught being undone.
 */
export type SpellSource = SpellClass | SpellLoader;

/**
 * Marks a `SpellLoader` explicitly, rather than asking `PackRegistry` to guess.
 *
 * The obvious discriminator — a class has a `prototype`, a loader does not —
 * is only half true: an arrow-function loader indeed has none (an arrow
 * function can never be a class, full stop), but a pack author who writes an
 * ordinary `function` expression as a loader gets one too, and it would be
 * misread as the spell class itself. `PackRegistry` trusts the no-`prototype`
 * case unconditionally and otherwise requires this mark before treating a
 * function as a loader; wrap a `function`-expression loader in `lazy()` and it
 * is read correctly.
 */
const SPELL_LOADER_MARK: unique symbol = Symbol('moba2d.content.spellLoader');

export function lazy(load: SpellLoader): SpellSource {
  return Object.assign(load, { [SPELL_LOADER_MARK]: true as const });
}

/**
 * True when `source` is a loader — a bare arrow function (which structurally
 * can never be a class) or anything wrapped by `lazy()`. Exported for
 * `PackRegistry`, the only reader of `SPELL_LOADER_MARK`.
 */
export function isSpellLoader(source: SpellSource): source is SpellLoader {
  if (typeof source !== 'function') return false;
  if (source.prototype === undefined) return true;
  return (source as unknown as Record<symbol, unknown>)[SPELL_LOADER_MARK] === true;
}

/**
 * An item, as a pack declares it.
 *
 * Three optional grants and none of them is a new mechanism: `stats` is a
 * `StatsModifier`, `passive` is a spell armed once per life exactly like
 * `ChampionEntry.passive`, and `active` is a spell bound to a key exactly like
 * a kit slot. See `game/items/Item.ts` for why an item is a *parallel* row
 * rather than a longer kit.
 *
 * An item with none of the three is legal and inert — a component a bigger
 * item is built out of is exactly that, and refusing it here would mean a pack
 * could not express a build path.
 */
export interface ItemDef {
  /** A bare identifier, local to this pack. */
  id: string;
  name: string;
  /** Pack-relative asset key. Required: an item with no icon is unbuyable in a shop. */
  icon: string;
  /** What it costs. `0` is legal — a starting item, or a quest reward. */
  cost: number;
  /** One line, player-facing. What holding it does. */
  description?: string;
  /**
   * Flat bonuses while held. Keys are `ItemStatKey` — an allow-list, not every
   * field on `StatsModifier`; see that constant's own doc comment for why
   * `health` and `size` are deliberately not on it.
   */
  stats?: Record<string, number>;
  /** Local spell id, armed once per life while this is held. */
  passive?: string;
  /** Local spell id, bound to this item's inventory hotkey. */
  active?: string;
  /**
   * Local item ids this one is built out of — the recipe. Absent for a
   * component, which is most cheap items.
   *
   * **`cost` stays the total**, what this costs from nothing. What the player
   * pays when the parts are already in the bag is `cost` minus what those
   * parts cost, worked out by `ItemShop.priceFor`, so a pack declares each
   * price exactly once. Declaring a separate combine cost as well would be
   * writing one fact twice, and the two drift the first time anyone retunes.
   *
   * The list may name the same component twice — two of one thing is an
   * ordinary recipe — and every id must be an item in this same pack. A cycle
   * is refused, as is a total under the sum of its parts, which would make
   * combining pay the player.
   */
  buildsFrom?: string[];
}

export interface ChampionEntry {
  id: string;
  name: string;
  /** Pack-relative asset key, or null for a champion with no portrait yet. */
  image: string | null;
  /** Local spell ids, in slot order. */
  spells: string[];
  /** Local id of this champion's way home. Absent on a map that grants none. */
  recall?: string;
  /**
   * Local id of this champion's passive, or absent — which is most champions.
   *
   * A spell the champion *has* rather than one it casts: core presses it once
   * per life and binds it to no key. It is deliberately not a fifth entry in
   * `spells` — that array is the kit's hotkey layout and the thing a player
   * rearranges in the loadout editor, and a passive has neither a key nor a
   * slot to be moved into. See `Champion.passive`.
   *
   * The id still has to name a spell in this pack, and its `spellDisplay`
   * entry is what the HUD reads, so a passive is described to the player
   * exactly the way an ability is.
   */
  passive?: string;
  /**
   * Whether the pregame screen may offer this as a champion.
   *
   * `false` is the normal answer for a shelf — a group of loose abilities, or
   * a one-ability stub that exists only to widen the random pool. Core used to
   * decide this by testing whether the portrait key started with `champ_`,
   * which is a naming convention no pack has any reason to share.
   */
  playable: boolean;
  /** Basic-attack profile. Omitted means core's `DEFAULT_CHAMPION_ATTACK`. */
  attack?: ChampionAttack;
  /**
   * How much punishment this champion takes before it dies. Absent means
   * core's default, which is what every champion was before this field —
   * see `ChampionDefence`.
   */
  defence?: ChampionDefence;
  /**
   * True for the one roster row whose `spells` are this pack's own D/F
   * options — the summoner-spell shelf, not a champion. `playable: false`
   * cannot mark it on its own: every partial champion stub (a one-ability
   * shelf kept only to widen the random pool) is `playable: false` too, and
   * matching this shelf by its display name would break the same way
   * `playable` itself used to (see that field's own doc comment) the moment
   * a translation changed the label. Declared, like `playable`, so core can
   * find the D/F shelf without naming a single spell of its own.
   */
  summonerShelf?: boolean;
  /**
   * A tail, a cloak, a length of hair — something that streams behind this
   * champion as it moves and settles when it stops.
   *
   * Cosmetic and nothing else: it has no hitbox, no collision and no bearing
   * on anything the match reads. It is the same chain `render/creature/spine.ts`
   * builds a segmented monster out of, mounted on a champion's own position,
   * so a pack states a shape and core owns every number that makes it move.
   *
   * Absent means today's picture, unchanged.
   */
  trail?: ChampionTrailSpec;
}

/**
 * What a champion's trail is, and deliberately **not** a whole `CreatureRigSpec`.
 *
 * A camp's rig may replace its sprite and grow it legs; a champion's trail may
 * do neither. Reusing the larger type would offer packs a `legs` block and a
 * `body: 'orb'` that core would then have to refuse one at a time, and a field
 * that exists only to be rejected is worse than no field. These are exactly
 * the `chain` body's own knobs, and core resolves them through the same
 * clamping path — see `resolveRig`.
 */
export interface ChampionTrailSpec {
  /**
   * Half-width at each vertebra, head first, as a multiple of the champion's
   * body radius. Its length is the vertebra count.
   */
  widths: number[];
  /** Gap between vertebrae, in body radii. Default 0.9. */
  spacing?: number;
  /** How far one vertebra may bend from the one ahead, radians. Default 0.45. */
  bend?: number;
  color?: [number, number, number];
  glow?: number;
}

/**
 * One spell's display fields, as data.
 *
 * Field-for-field the same shape `src/generated/spellCatalog.ts` produces, and
 * that is not a coincidence: the pregame screen renders a whole roster without
 * loading a single spell class, and it can only keep doing that if a pack's
 * spells arrive as data too. A pack repo generates this with its own
 * `spell-catalog` command (spec §9) exactly the way core generates its own.
 *
 * `iconKey` is a plain string, not core's generated `AssetKey` union — a
 * pack's art is its own and its keys type-check inside its own build.
 */
export interface SpellDisplayData {
  name: string;
  /** Vietnamese HTML — `<span class="damage">`/`.buff`/`.time`/plain `<span>`. */
  description: string;
  iconKey: string | null;
  /** The spell's own tuning number, before match rules. */
  coolDownMs: number;
  /** The spell's own tuning number, before match rules. */
  manaCost: number;
  /** `castSpec.cooldown.durationMs` — what a countdown runs before CDR. */
  specCoolDownMs: number;
}

/** A champion's basic-attack profile. Absent means core's default. */
export interface ChampionAttack {
  damage: number;
  attacksPerSecond: number;
  range: number;
  /**
   * World units per second the basic-attack bolt flies, for a ranged
   * champion (`range` above the melee threshold). Absent, core's
   * `DEFAULT_CHAMPION_ATTACK` speed applies. This is where a pack gives its
   * marksmen the near-hitscan crack and its enchanters the slow lob the
   * source game tunes per champion — see `DEFAULT_CHAMPION_ATTACK`'s own
   * doc comment for the scale this number lives on.
   */
  boltUnitsPerSecond?: number;
}

/**
 * A champion's durability profile — the twin of `ChampionAttack`, and for a
 * long time the missing one.
 *
 * A pack could say a champion swings for 17 at 1.1/s from 130 away, and could
 * say nothing at all about what happens when it is swung at. Every champion in
 * every pack was 100 health, no armour, no magic resist, so a bruiser and a
 * marksman were the same body — while a *minion* was 140 health. The shop then
 * multiplied damage without touching either number, and the profile a
 * teamfight actually needed did not exist to be tuned.
 *
 * Every field is optional and absent means core's `DEFAULT_CHAMPION_DEFENCE`,
 * which is exactly what champions had before this existed — so a pack that
 * declares nothing plays exactly as it did.
 *
 * **Resistances are the lever this is mostly for, not `health`.** A pack has
 * one flat health pool and two multipliers over it, and the two behave
 * differently for everything that heals or shields: 45 abilities across the
 * shipped packs restore a flat number, and those keep their worth behind
 * armour (a 40-point shield behind 100 armour is 80 effective points, exactly
 * the multiplier the pool itself gets) while a raised pool quietly shrinks all
 * 45 of them and nothing in core can compensate. Resistances also cannot run
 * away: `100 / (100 + r)` is asymptotic, so no amount of armour is immunity,
 * whereas health is linear and has no brake at all.
 */
export interface ChampionDefence {
  /** Maximum health. Absent, core's default pool applies. */
  health?: number;
  /** Health regenerated per frame, the scale `Stats.healthRegen` uses. */
  healthRegen?: number;
  /** Resistance to `PHYSICAL` damage, on `combat/Mitigation.ts`'s curve. */
  armor?: number;
  /** Resistance to `MAGIC` damage, same curve. */
  magicResist?: number;
}

/**
 * One body of a camp — a camp is a **composition** of these, not N identical
 * copies of one. A wolf pit is a Greater Wolf plus two Wolves, visibly
 * different sprites and sizes; collapsing that to `count: 3` of one body was
 * this field's first (wrong) shape — see `MonsterDef`'s own doc comment.
 *
 * `offset` places a body relative to its slot's centre — `NeutralSlot`
 * carries only where the *camp* sits, never an individual body, so a
 * multi-body camp needs its own internal layout. `{0, 0}` is the common case
 * for a camp of one (a jungle boss, a buff camp, a small camp).
 */
export interface MonsterBody {
  name: string;
  /** Pack-relative asset key. */
  avatar: string;
  speed: number;
  size: number;
  attackRange: number;
  reviveTime: number;
  health: number;
  /** Per swing. Defaults to a share of `health` when omitted. */
  damage?: number;
  /** ms between swings. Defaults to 1500 when omitted. */
  attackInterval?: number;
  /** Champions this close wake the camp. Defaults to `attackRange + 120`. */
  aggroRange?: number;
  /**
   * How this body's basic attack is drawn, and how its damage travels.
   *
   * Absent means core derives one from `attackRange`: a body that fights by
   * touching you claws, anything with real reach spits. That default is what
   * lets every camp written before this field stop dealing damage from
   * nowhere without a single pack being edited — declare it only when the
   * derived answer is wrong, which for this pack means the dragon.
   */
  attackStyle?: MonsterAttackStyle;
  /**
   * `[r, g, b]` for that art. Absent means the amber the old swing flash
   * used, so an undeclared body looks like it always did, only legible.
   */
  attackColor?: number[];
  /**
   * Legs that plant on the ground and step, and optionally a body drawn from
   * code instead of a sprite — so a pack can ship a creature it has no art for.
   *
   * Absent means today's picture, unchanged. Nothing here is ever *derived*
   * from another field the way `attackStyle` is from `attackRange`: growing
   * legs on a camp that never asked for them would rewrite the look of every
   * pack at once. See `game/render/creature/creatureSpec.ts` for the fields.
   */
  rig?: CreatureRigSpec;
  /**
   * How this body answers a champion. Absent means `'aggressive'` — every
   * camp written before this field existed, unchanged.
   */
  temperament?: MonsterTemperament;
  /**
   * Where this body may wander. Absent means the camp circle.
   *
   * Deliberately declared here and **not** overridable per map slot, unlike
   * the numbers beside it: a roam region that disagrees with where the map
   * actually put the water is not a playstyle, it is a broken camp.
   */
  roam?: MonsterRoam;
  /**
   * External forces do not move this body — collision separation, and any
   * displacement someone else applies (a hook, a pull, a knock-back).
   * Absent means `speed === 0`, which is what every body written before this
   * field relied on.
   *
   * It exists because those were one flag and the pair a boss usually wants
   * is not expressible with one: a pit boss that **walks** — so it answers a
   * champion who backs off a step — but **holds its ground**, so it cannot be
   * dragged out of the pit it is guarding. It may still be slowed, stunned,
   * rooted or knocked up; what it refuses is being *relocated*.
   */
  anchored?: boolean;
  /**
   * How fast this body drifts around its roam region while nothing is
   * happening. Absent, or zero, means it holds its spot — which is what every
   * camp written before this field does.
   *
   * Beside `roam` and for the same reason: *where* a body may wander and
   * *whether* it does are one decision, taken by whoever knows what the
   * creature is. It is separate from `speed`, which is what it moves at once
   * something is after it.
   */
  wanderSpeed?: number;
  /**
   * How far past its own ground this body will follow. Absent means
   * `MONSTER_CHASE_MARGIN`; a map may replace it for every camp at once
   * (`MonsterTuning.chaseMargin`) and a slot for one camp.
   *
   * A body declares it when its leash is part of what it *is* rather than
   * part of the jungle's feel — a pit boss that should never end up in a
   * lane says so here, and stays right whatever jungle a map drops it into.
   */
  chaseMargin?: number;
  /** Grace before this body turns for home. Absent means
   *  `MONSTER_GIVE_UP_DELAY_MS`. */
  giveUpDelayMs?: number;
  /** Quiet time after being hurt before it heals. Absent means
   *  `MONSTER_REGEN_DELAY_MS`. */
  regenDelayMs?: number;
  /** Removed on death instead of respawning — see `MonsterPresetData`. */
  ephemeral?: boolean;
  /** This body's position relative to the slot's `{x, y}`. */
  offset: { x: number; y: number };
}

/**
 * A monster, as a pack declares it — enough for `Game.spawnJungle()` to build
 * every real `Monster` a neutral slot needs once its `role` has resolved to
 * one of these.
 *
 * `members` replaces an earlier shape that put one flat set of tuning plus a
 * `count` directly on `MonsterDef` — collapsing a wolf pit (a Greater Wolf
 * and two Wolves: different avatars, different sizes, different health) into
 * three identical bodies. `monstersFilling(role)` answering with
 * **alternatives** — several packs offering something for the same role,
 * install order deciding — is a different question from **composition** —
 * what a single camp is made of — and `count` conflated the two. A camp of
 * three wolves is one `MonsterDef` with three `MonsterBody` entries, the way
 * it actually was before position and identity were split apart.
 *
 * Deliberately **not** `abilities` on `MonsterBody` — those are engine code
 * (`MonsterAbility` callbacks), the same reason a champion's kit is a spell
 * *id* here and never a class. A monster's abilities arrive through the
 * pack's code half instead — `ContentPackCode.monsterAbilities`, keyed by
 * local monster id exactly the way `spells` is keyed by local spell id — and
 * `preset.ts`'s `monsterBodyPreset` merges them back on by reading
 * `contentRegistry().abilitiesFor(monster.id)`, never by importing a
 * specific pack's file. This pack's one boss monster is the first
 * and, as of this writing, only monster that supplies any.
 */
/**
 * How much a camp matters to a team. `'camp'` (the default) is farm — a bot
 * clears it when it has nothing better to do. `'epic'` is an objective: one
 * body a whole team is called to when the numbers are right, and the bot
 * brain's `OBJECTIVE` posture exists for it. Core's word, not the source
 * game's: which monster is the dragon is the pack's business.
 */
export type MonsterTier = 'camp' | 'epic';

export interface MonsterDef {
  id: string;
  name: string;
  /** Slot roles this monster can occupy. Free strings; core only matches. */
  fills: string[];
  /** Farm or objective — see `MonsterTier`. Absent means `'camp'`. */
  tier?: MonsterTier;
  /** What this camp is made of. Never empty — a camp of one is one entry. */
  members: MonsterBody[];
}

export interface Faction {
  id: string;
}

/**
 * A map's own numbers, overriding core's.
 *
 * ## Why a map may say this at all
 *
 * A map used to be geometry and slots, so every number that makes a match
 * *feel* like anything — how hard a turret hits, how far a camp chases, how
 * fast the fountain heals — was a constant in a core TypeScript file. A new
 * map could only ever be a new *shape* of the same game. This is the whole
 * feature: a map states its own numbers, drawn in the editor, carried in its
 * own export, with nobody having to open the engine.
 *
 * ## Absent means today's number, everywhere
 *
 * Every field here and below is optional, and a missing one resolves to
 * exactly what core used before this type existed. That is not politeness,
 * it is what makes the whole subsystem testable: `tuning: undefined` has a
 * provable no-op state, so every existing map plays bit-identically and the
 * test for that is one assertion per system rather than a re-balanced suite.
 *
 * ## Why it lives on `MapSummary` and not in `MapGeometry`
 *
 * `ActiveMap = MapSummary & MapGeometry`, so `Game` and `preset.ts` receive
 * it with no change to that type; `PackRegistry.maps()` returns the summary,
 * so a picker can tell the player what is unusual about a map *before*
 * downloading its polygons; and a few hundred bytes has no business behind
 * the lazy geometry loader, where editing one number would invalidate a
 * cached chunk measured in hundreds of kilobytes.
 *
 * Per-slot overrides are the exception and live on the slots themselves —
 * see `StructureSlot.stats` — because that is where the slot is.
 */
export interface MapTuning {
  champions?: ChampionTuning;
  economy?: EconomyTuning;
  turrets?: TurretTuning;
  fountain?: FountainTuning;
  minions?: MinionTuning;
  monsters?: MonsterTuning;
  terrain?: TerrainTuning;
  vision?: VisionTuning;
}

/**
 * What giving yourself away costs.
 *
 * League's rule is one sentence and two numbers — a unit-targeted attack out of
 * the fog lights a 300 radius around the attacker for 2 seconds
 * (`combat/AttackReveal.ts` quotes it) — and those two numbers are the whole of
 * how much a map's brushes are worth.
 *
 * Both ends are real maps. `attackRevealMs: 0` turns brush into genuine
 * stealth: you can fight out of it and never be seen, which makes a map of
 * dense hedges a map about ambushes with no counterplay but walking in.
 * `attackRevealMs: 5000` makes one swing a commitment, and brush a place to
 * wait rather than a place to fight from. Neither is core's answer; both are a
 * map's to make.
 */
export interface VisionTuning {
  /**
   * How long an attacker stays lit after a unit-targeted action. Default 2000.
   * 0 disables the reveal entirely.
   */
  attackRevealMs?: number;
  /**
   * How much of the map around them is lit with them. Default 300.
   *
   * Not merely cosmetic: this is what decides whether the partner waiting in
   * the same brush is revealed too, which is most of what the rule feels like.
   */
  attackRevealRadius?: number;
}

/**
 * What things are worth, and how fast gold arrives.
 *
 * **One group, and it has to be one group.** `Wallet.ts` says it plainly of
 * its own constants: an economy is a set of numbers that only mean anything
 * *relative to each other*, and one of them living somewhere else is how the
 * set gets retuned by halves. So bounties sit here rather than beside the
 * unit they belong to — `turretBounty` is not in `TurretTuning` even though
 * every other turret number is, because what a turret is *worth* is a
 * statement about the economy and what it *does* is a statement about the
 * turret.
 *
 * This is the biggest lever a map has for changing pace without changing a
 * single shape: a short skirmish map wants a full purse at the fountain and
 * fast passive income, a long macro map wants neither.
 *
 * `sellRefund` was once absent from this list, on the argument that the shop
 * *panel* prints the refund as well as the shop paying it, and the panel is
 * HUD code with no map in scope. That argument was simply wrong, and worth
 * recording as wrong: both readers — `sellItem`, which pays it, and
 * `sellRows`, which prints it — already take a `ShopHost`, and a host is the
 * channel that crosses from the match into both. Nothing needed threading
 * through `MatchConfigSource` at all; the fraction rides the object that was
 * already being passed.
 */
export interface EconomyTuning {
  /** What a champion leaves the fountain with. Default 500. */
  startingGold?: number;
  /** Gold per second, to everyone, for existing. Default 2. */
  passiveGoldPerSecond?: number;
  /** Default 20. */
  minionBounty?: number;
  /** Default 32. */
  monsterBounty?: number;
  /** Default 200. */
  championBounty?: number;
  /** Default 150. */
  turretBounty?: number;
  /**
   * What selling an item pays back, as a fraction of its cost. Default 0.7.
   *
   * The other half of the economy's grip on how freely a build can change:
   * at 0.7 a wrong purchase costs 30% to undo, which is what makes committing
   * to a build a decision. A map that wants experimenting to be free says 1,
   * and one that wants a purchase to be final says 0.
   *
   * Clamped to 0…1 where it is resolved. Above 1 is a money printer — buy,
   * sell, repeat — and below 0 is a sale that charges you.
   */
  sellRefund?: number;
  /**
   * How long after hurting somebody you still count as having helped kill
   * them. Default 10000. 0 turns assists off entirely.
   *
   * The lever for what a team fight is worth: a short window makes a kill the
   * property of whoever landed the last two hits, a long one pays everybody
   * who committed to the fight at all.
   */
  assistWindowMs?: number;
  /**
   * What an assist pays, as a share of the killer's bounty. Default 0.5.
   *
   * Paid *on top of* that bounty rather than carved out of it, so a map that
   * raises this makes grouping better without making solo kills worse.
   * Clamped to 0…1 where it is resolved.
   */
  assistGoldShare?: number;
  /**
   * How long an enemy champion's hit still claims your death when something
   * else finishes you. Default 10000. 0 turns the rule off, and the last hit
   * decides every kill again.
   *
   * A champion who dies to a turret, a minion or a camp inside this window
   * hands the kill and the bounty to the last enemy champion who hurt them —
   * League's own rule. Separate from `assistWindowMs` so that turning assists
   * off does not also hand kills back to minions.
   */
  killCreditWindowMs?: number;
}

/**
 * Champion respawn, and only respawn.
 *
 * Champion *stats* are deliberately not here: a map that rewrites champions
 * is a different feature with a much larger blast radius. Respawn is a match
 * rule, not a stat, which is why it is the one that made it in.
 */
/**
 * Champion numbers as **multipliers**, at the map level.
 *
 * Multipliers rather than absolutes, and for exactly `MonsterScale`'s reason:
 * the base is whatever pack fills the roster, and a map cannot know it. Sixty
 * champions each declare their own health and damage, so "every champion has
 * 400 health" is a statement a map has no business making — while "everybody
 * is twice as durable here" is one it can make about *itself*, and one that
 * changes how the map plays more than any other single number.
 *
 * The three that were picked, and why the list stops there: durability, output,
 * and pace are the axes a map is actually trying to move. Armour, attack speed
 * and ability power are all reachable *through* those three for the purposes a
 * map has, and each extra multiplier is another interaction to reason about
 * when a map turns out to play badly.
 */
export interface ChampionScale {
  /** Multiplies whatever the pack declared as this champion's health. */
  healthMult?: number;
  /** Multiplies the pack's attack damage. Abilities are untouched. */
  damageMult?: number;
  /** Multiplies movement speed — core's own default, which no pack declares. */
  speedMult?: number;
}

export interface ChampionTuning extends ChampionScale {
  /** Flat respawn in ms. Absent means 5000 — `AttackableUnit.reviveTime`. */
  reviveTime?: number;
  /**
   * Growth instead of a flat number: `min(base + perMinute * minutes, max)`.
   * Present, it wins over `reviveTime`.
   *
   * There is no curve in the engine to expose — champion respawn is a flat
   * 5000ms and always has been — so this *is* the curve. A map wanting deaths
   * to get costlier as a match runs long writes something like
   * `{ base: 8000, perMinute: 2500, max: 60000 }`.
   */
  reviveCurve?: { base: number; perMinute: number; max: number };
}

/**
 * Turret numbers, absolute rather than multiplied.
 *
 * Absolute because the base — `DEFAULT_TURRET_PRESET` — is core's own and a
 * map author can read it. There is nothing to be relative *to* that they do
 * not already know, unlike a monster, whose numbers come from whichever pack
 * fills the slot.
 */
export interface TurretStats {
  health?: number;
  size?: number;
  attackRange?: number;
  attackInterval?: number;
  damage?: number;
  /** ms before a destroyed turret comes back. */
  rebuildTime?: number;
  /** ms without taking damage before it starts repairing itself. */
  repairDelay?: number;
  /** Health per frame once repairing. */
  repairRate?: number;
}
export type TurretTuning = TurretStats;

/** Fountain numbers. `Fountain` already accepts all four; nothing passed them. */
export interface FountainStats {
  name?: string;
  /** ms between restore ticks. */
  tickInterval?: number;
  /** Fraction of max health restored per tick. */
  healPercent?: number;
  /** Fraction of max mana restored per tick. */
  manaPercent?: number;
  /**
   * How far from this platform a champion may still use the shop. `0` — the
   * default — means the platform itself, which is the rule every map had
   * before this field existed.
   *
   * **Separate from the healing radius on purpose.** They were the same number
   * only because nothing had ever needed them apart: `r` is where a body is
   * restored and where the platform is *drawn*, so widening it to let people
   * shop further out would also hand them a huge healing pad and a floor
   * covering a quarter of the map. This is the one of the two that a map is
   * allowed to move.
   *
   * A big number is how a map says "buy from anywhere" — and the interesting
   * settings are the ones in between, because the number is a *distance from
   * your own base*: a map that sets it to half the map's width lets a player
   * shop in their own half and not in the enemy's, which is a rule no MOBA
   * this engine imitates has and which changes how far anyone dares push.
   *
   * It does not make a shop free of every other rule — a champion still cannot
   * buy while dead, and the shop still refuses what it always refused. It is
   * the *location* half, and only that half.
   */
  shopRange?: number;
}
export type FountainTuning = FountainStats;

/**
 * One minion type a map declares — the only place `MapTuning` lets a map
 * define a new *thing* rather than a new number.
 *
 * `style` is separate from the type's id on purpose, and it is the field that
 * makes this safe. Core's `Minion` decides bolt-or-swing and how to draw
 * itself from the style, not the id, so a map declaring `siege` says which of
 * the three bodies it fights like. Without it, a new id would silently get
 * melee behaviour and melee art.
 */
export interface MinionTypeDef {
  name: string;
  speed: number;
  size: number;
  health: number;
  damage: number;
  attackInterval: number;
  attackRange: number;
  aggroRange: number;
  /** Defaults to `'melee'`. */
  style?: MinionStyle;
  /** Defaults to core's own minion bounty. */
  goldBounty?: number;
}

/** A change of formation or pace that takes effect `atMs` into the match. */
export interface WaveStage {
  atMs: number;
  /** Type ids, in release order. */
  composition?: string[];
  intervalMs?: number;
}

export interface MinionTuning {
  /**
   * Present, this **replaces** core's three entirely, keyed by a free id.
   *
   * All-or-nothing on purpose. A partial merge raises "what does
   * `{ melee: { damage: 9 } }` mean when the map also declares `siege`?", and
   * the honest answer is that a map declaring its own roster is declaring its
   * own roster. A map that only wants tougher melee minions copies the three
   * defaults and edits one number — one button in the editor, not a
   * transcription job.
   */
  types?: Record<string, MinionTypeDef>;
  waves?: {
    /** Type ids, in release order. Absent keeps core's own formation. */
    composition?: string[];
    intervalMs?: number;
    firstDelayMs?: number;
    releaseIntervalMs?: number;
    liveCap?: number;
    /** Applied in `atMs` order; each stage overrides only the fields it names. */
    stages?: WaveStage[];
  };
}

/**
 * Monster numbers as **multipliers**, at the map level.
 *
 * A map does not know what monsters will fill its slots — the same map runs
 * with one pack's jungle or another's — so "×1.5 damage" is the only sentence
 * it can say that stays true across packs. That is the same argument
 * `NeutralSlot.role` already rests on.
 *
 * A *slot* may additionally state absolutes (`MonsterSlotStats`), because
 * there the author is aiming at one named camp on one map and can see what
 * fills it.
 */
export interface MonsterScale {
  healthMult?: number;
  damageMult?: number;
  speedMult?: number;
  attackIntervalMult?: number;
  aggroRangeMult?: number;
  reviveTimeMult?: number;
}

export interface MonsterTuning extends MonsterScale {
  /** Replaces `MONSTER_CHASE_MARGIN` for every camp on this map. */
  chaseMargin?: number;
  /** Replaces `MONSTER_GIVE_UP_DELAY_MS` for every camp on this map. */
  giveUpDelayMs?: number;
  /**
   * Replaces `MONSTER_REGEN_DELAY_MS` for every camp on this map — how long
   * after being hurt a camp refuses to heal at all.
   *
   * The knob that decides whether this map's jungle can be chipped down over
   * several visits or has to be cleared in one. Zero restores the behaviour
   * every map had before it existed: a camp back to full a second after you
   * stop hitting it.
   */
  regenDelayMs?: number;
}

/**
 * One camp's own numbers — the innermost of the three merge layers, applied
 * over the map's multipliers, which are applied over the pack's declaration.
 *
 * The absolutes here land **after** the multipliers, so a slot that states
 * `health` gets exactly that number and not that number scaled again.
 */
export interface MonsterSlotStats extends MonsterScale {
  health?: number;
  damage?: number;
  attackRange?: number;
  aggroRange?: number;
  reviveTime?: number;
  chaseMargin?: number;
  /**
   * Lets one map make its otherwise-timid camps fight. `roam` is deliberately
   * *not* overridable here — a roam region that disagrees with where the map
   * put the water is not a playstyle, it is a broken camp.
   */
  temperament?: MonsterTemperament;
  /**
   * Lets one map decide a camp breathes fire where the pack said it claws.
   * Overridable for the same reason `temperament` is: it changes how the camp
   * *plays* — a cone is telegraphed and a claw is not — and unlike `roam` it
   * cannot disagree with the map's own geometry.
   */
  attackStyle?: MonsterAttackStyle;
  /**
   * Lets one map give a camp a different body and a different number of legs.
   *
   * Overridable — unlike `roam`, which is not — because it is cosmetic and a
   * leg count cannot contradict where the map put the water. A map that wants
   * its wolves to be spiders is a map making a choice, not a broken camp.
   */
  rig?: CreatureRigSpec;
}

/**
 * What a terrain layer does to a unit standing in it.
 *
 * This is a **new mechanic**, not an exposed constant: before this, bush set
 * a vision flag and water drew ripples, and nothing on the map affected how
 * fast anything moved. Absent, or 1, and the second pass that implements it
 * does not run at all.
 */
export interface TerrainLayerTuning {
  /** Movement speed multiplier for a unit inside this layer. Default 1. */
  speedMultiplier?: number;
}

export interface TerrainTuning {
  bush?: TerrainLayerTuning;
  water?: TerrainLayerTuning;
}

export interface SpawnSlot {
  faction: string;
  x: number;
  y: number;
  r: number;
  /** This fountain's own numbers, over the map's, over core's. */
  stats?: FountainStats;
}

export interface MinionSlot {
  faction: string;
  lane: string;
  x: number;
  y: number;
  /**
   * How far a released minion may be scattered around this point, so a wave
   * does not spawn six bodies stacked on one coordinate for
   * `UnitCollisionSystem` to shove apart. Absent means no scatter.
   *
   * Deliberately per-slot rather than a shared engine constant: the old
   * `MUSTER_SCATTER_PX` was sized to stay under the gap between Summoner's
   * Rift's own two base turrets, a fact about that map's geometry, not a
   * rule every map shares. A map author who declares the point is the one
   * who can see whether it needs a scatter radius, and how big.
   */
  scatter?: number;
  /**
   * What *this* muster point fields, instead of the map's own wave formation.
   *
   * `tuning.minions.waves.composition` is one formation for the whole map:
   * every lane of every team sends the same six bodies. That is the right
   * default and it is the only thing a map could say until now — so "top lane
   * pushes with siege minions, bot lane trickles two melee" was not a map
   * anybody could build.
   *
   * Ids are read against the same roster the map-wide formation is
   * (`tuning.minions.types`, or core's three when a map declares none), and
   * `validate.ts` refuses one that names a type nothing supplies.
   *
   * An **empty array** is a real declaration, distinct from absent: this point
   * forms up no wave at all. A lane that exists for the bots to walk and ships
   * no minions is a legitimate map, and `[]` is how it says so.
   */
  stats?: MinionSlotStats;
}

/** A muster point's own overrides — see `MinionSlot.stats`. */
export interface MinionSlotStats {
  composition?: string[];
}

/** Core's own vocabulary — `Turret` and `Fountain` are core classes. */
export type StructureKind = 'turret';

export interface StructureSlot {
  faction: string;
  kind: StructureKind;
  x: number;
  y: number;
  /**
   * This turret's own numbers, over the map's, over core's — the innermost
   * of the three merge layers. This is what lets an outer turret be weaker
   * than a base one on the same map, which is most of what makes two maps
   * built from the same parts actually play differently.
   */
  stats?: TurretStats;
}

/**
 * What a neutral point is *for*, as the map that drew it says.
 *
 * `slots.neutral` meant one thing for as long as it existed — a jungle camp —
 * and `slotObjects` widened it: the same named point may now hold a relic, an
 * altar, a shrine. Which of the two a point is cannot be read off the slot,
 * because `role` is the pack's vocabulary and the map editor is its own
 * document with no pack installed in it — so it drew every relic as a camp,
 * complete with an aggro ring and a leash ring it invented out of a camp's
 * defaults.
 *
 * So the map says. Absent means `'camp'`, which is what every map drawn before
 * this meant, and it is only the *lookup order* that changes: see
 * `preset.ts`'s `neutralSlotFill`.
 *
 * The same shape `StructureSlot.kind` already has, one slot group over.
 */
export type NeutralKind = 'camp' | 'object';

export interface NeutralSlot {
  /** A free string a monster's `fills` matches. Core never interprets it. */
  role: string;
  /**
   * What this point holds. See `NeutralKind` — absent is `'camp'`, and a map
   * that says `'object'` is saying "never a camp here, whatever the packs
   * installed happen to answer with".
   */
  kind?: NeutralKind;
  x: number;
  y: number;
  r: number;
  /** This camp's own numbers, over the map's, over the pack's. */
  stats?: MonsterSlotStats;
  /**
   * Degrees to turn this camp's internal layout by — every `MonsterBody.offset`
   * is rotated about the slot before it becomes a body's home. Absent means 0,
   * which is every camp of one and every slot a layout was drawn for directly.
   *
   * It exists because a map's symmetry meets a shared `MonsterDef`. Summoner's
   * Rift's two halves are 180° *rotations* of each other, not copies, and one
   * `members` array serves both of a camp's slots — so the pit whose layout the
   * offsets were not drawn from had its bodies pointing the wrong way, and
   * stood them in a wall. Measured: on the red side two of two wolves and three
   * of three raptors were on unwalkable ground, and every one of them became
   * walkable once its offset was negated.
   *
   * Core cannot work that out for itself — "my two halves are rotations of each
   * other" is a fact about a map — so the map states it here.
   *
   * A rotation and not a `mirrored` boolean on purpose: a mirror is the wrong
   * transform. Reflecting a layout swaps its handedness, so a pit laid out
   * clockwise would come back anticlockwise.
   */
  rotationDeg?: number;
}

export interface LaneDefinition {
  id: string;
  from: string;
  to: string;
  waypoints: { x: number; y: number }[];
}

/**
 * A map's cheap half: enough to list, name and describe a world to a picker.
 * `PackRegistry.maps()` returns exactly this, qualified — never the polygons.
 */
export interface MapSummary {
  id: string;
  name: string;
  /** Square edge length in world units. */
  size: number;
  factions: Faction[];
  /** This map's own numbers. Absent — or any field absent — means core's. */
  tuning?: MapTuning;
  /**
   * The pack paints this map's walls, bushes and water itself, so core must
   * not fill them first.
   *
   * Core's terrain art is a 7px-stroked polygon per obstacle in view. Under a
   * pack's own scenery that is pure overdraw: on a map whose sea is one wall
   * the full width of the map, it was a second full-screen layer every frame
   * that the pack then painted over. Collision, sight, navigation and bush
   * concealment are untouched — only `TerrainMap.draw`'s obstacle fills stop.
   * Zones still paint. An older core ignores the field and draws as before.
   */
  paintsOwnTerrain?: boolean;
  /**
   * Icy ground. See `IceTuning`. Absent means no ice anywhere, unless a
   * `TerrainZone` says `ice: true` (then the zone uses core's defaults).
   *
   * A sibling of `paintsOwnTerrain` and **not** a `tuning.terrain` entry, on
   * purpose: `checkMapTuning` rejects keys it does not know, so an older core
   * would refuse the whole map. Here an older core never looks, ignores the
   * field, and the map plays as ordinary ground.
   */
  ice?: IceTuning;
}

/**
 * Ice: ground where a unit keeps its momentum.
 *
 * On ice a walking unit's velocity does not snap to its order. It accelerates
 * toward the direction it wants with a time constant of `accelMs`, and when it
 * has nothing to walk to (arrived, or stopped) it coasts and bleeds speed with
 * a time constant of `frictionMs`. Stopping and turning therefore take time,
 * and a unit stopped at full speed slides roughly `speed * frictionMs` px.
 *
 * - Both constants are **times, not per-frame factors**: the step is
 *   `1 - exp(-dt / tau)`, so the slide is the same at 30 and 60 ticks per
 *   second.
 * - Only a unit's own *walking* is affected. Dashes and knockbacks (anything
 *   extending `Dash`) move the body directly and are unchanged; a unit that
 *   dashes starts from rest afterwards. A unit that cannot move (stun, root,
 *   dead) loses its momentum at once.
 * - Bots navigate as before: orders and routes are unchanged, a unit simply
 *   brakes smoothly onto its final goal and settles within a few pixels of it
 *   instead of snapping exactly onto it.
 * - Which ground is icy: `everywhere` (the whole map), or every polygon of a
 *   `TerrainZone` with `ice: true`. With neither, `ice` has no effect.
 */
export interface IceTuning {
  /** Whole map is ice. Default false (only ice zones are). */
  everywhere?: boolean;
  /** Time constant (ms) of speeding up / turning toward the desired direction. Default 350. */
  accelMs?: number;
  /** Time constant (ms) of coasting to a halt when no order pulls the unit. Default 800. */
  frictionMs?: number;
}

/**
 * A map's heavy half: terrain to route and collide against, and the slots
 * fountains, turrets, jungle camps and minions occupy. Fetched only once a
 * match is actually starting — see `MapGeometrySource`.
 */
/**
 * A tagged region of ground: sand, a lava field, a bank of mist.
 *
 * ## Why this is not a fourth `terrain` layer
 *
 * The three layers carry heavy, *named* semantics core is entitled to know:
 * a wall is rasterized into the navigation grid, a wall and a bush block
 * sight, a bush conceals. A zone carries none of them. It multiplies speed,
 * answers "is this point inside me", and paints itself — and that is the
 * whole list, on purpose.
 *
 * The distinction is what lets core stay ignorant of the vocabulary. Core
 * knows what a *wall* is and always will; it does not know what "sand" is,
 * and — exactly like `ArchetypeDef`, the role taxonomy that was moved out of
 * core once already — it must not learn. A pack names its own zones, and a
 * pack whose world has acid pools instead of deserts works the same way with
 * no change here.
 *
 * ## Why the definition carries its own polygons
 *
 * The first cut split these: definitions in one list, polygons in a
 * `Record<string, Point[][]>` keyed by id. That is two lists to keep in step
 * and a class of bug — a zone painted under an id nothing declares — that
 * only surfaces as a region which is silently ordinary ground. One
 * self-contained object cannot drift from itself.
 *
 * ## Why it lives on the map and not on the pack
 *
 * `TerrainMap` is handed an `ActiveMap`, never a pack, so a pack-level list
 * would need `PackRegistry` to thread it through. It would also put the map
 * editor — which edits exactly one map — in the position of editing
 * something it does not own. A map that is self-contained round-trips
 * through `localMaps.ts` and `localStorage` with nothing else consulted.
 */
export interface TerrainZone {
  /** Local to the pack, unique within the map. Core never interprets it. */
  id: string;
  /** What the editor and the HUD call it. The pack's own language. */
  name: string;
  /**
   * Multiplied into the speed of anything standing here. Absent means 1.
   *
   * Overlapping zones multiply, the same rule `bush` and `water` already
   * follow — see `TerrainMap.speedFactorAt`.
   */
  speedMultiplier?: number;
  /**
   * This zone is ice: units on it keep momentum, using the map's `ice` numbers
   * (or core's defaults). See `IceTuning`. An older core ignores the field.
   */
  ice?: boolean;
  /** Core ships no palette for these: a zone core cannot name, it cannot colour. */
  render: { fill: string; stroke?: string };
  polygons: { x: number; y: number }[][];
}

export interface MapGeometry {
  terrain: {
    wall: { x: number; y: number }[][];
    bush: { x: number; y: number }[][];
    water: { x: number; y: number }[][];
  };
  /**
   * Regions that are not terrain layers — see `TerrainZone`. Absent on every
   * map written before them, which is why nothing here is required.
   */
  zones?: TerrainZone[];
  slots: {
    spawn: SpawnSlot[];
    minion: MinionSlot[];
    structure: StructureSlot[];
    neutral: NeutralSlot[];
  };
  /** Absent on a map with no lanes — no waves, and PUSH falls through. */
  lanes?: LaneDefinition[];
}

/** A map's geometry that has not been fetched yet. Resolved at most once. */
export type MapGeometryLoader = () => Promise<MapGeometry>;

/**
 * How a pack hands over a map's heavy half.
 *
 * A plain object for a small map; a loader for one the size of Summoner's
 * Rift — 395 polygons a menu screen has no business downloading before it has
 * even drawn a picker. See `SpellSource`'s own doc comment; the shape and the
 * reason are identical, one level up.
 */
export type MapGeometrySource = MapGeometry | MapGeometryLoader;

/**
 * A map, as a pack declares it — the eager `MapSummary` a picker lists, plus
 * the (possibly lazy) `geometry` a match actually plays on.
 *
 * Split the way `SpellSource` already splits a spell class from its loader,
 * for the same reason: `size`/`name`/`factions` cost nothing to hold in the
 * menu's own chunk, and `geometry` — the terrain, the slots, the lanes — is
 * the one payload in the whole pack contract bigger than everything else in
 * it combined. See `packs/riot/maps/summonersRift.ts` for the worked
 * example: its own module holds only the summary, and `geometry` is
 * `() => import('./summonersRiftGeometry')`.
 */
export interface MapDefinition extends MapSummary {
  geometry: MapGeometrySource;
}

/**
 * A map with its geometry already resolved — what `Game` and `TerrainMap`
 * are actually handed once `PackRegistry.loadMapGeometry` has settled.
 * `GameScene.startGame()` is what guarantees that has happened before
 * `new Game(...)` runs; see its own doc comment.
 */
export type ActiveMap = MapSummary & MapGeometry;

/**
 * Everything about a pack that a picker can render without the engine: no
 * spell class, no `ContentApi`, nothing that needs `Spell`/`SpellObject` in
 * scope. `PackRegistry.installData` writes exactly this, and `contentCatalog()`
 * installs only this — see that module's own header for why that closure
 * matters.
 */
/**
 * One role a pack offers a player who builds a kit by hand.
 *
 * A hand-assembled kit — Q from one champion, R from another — has no champion
 * to inherit a body from, and core cannot invent one: it does not know what a
 * "tank" is and deliberately never will. A role taxonomy is the roster's
 * vocabulary, not the engine's, which is why the table that holds one lives in
 * a pack and was moved *out* of core once already.
 *
 * So the pack publishes its taxonomy and core lists whatever came back,
 * storing nothing but the chosen `id`. Core names no role, and a pack with a
 * completely different set of them — or none — works the same way.
 */
export interface ArchetypeDef {
  /** Local, stable id. This is what a saved loadout keeps. */
  id: string;
  /** What the picker shows. The pack's own language. */
  name: string;
  /** One-line description, if the pack wants the picker to say more. */
  description?: string;
  attack: ChampionAttack;
  defence: ChampionDefence;
}

export interface ContentPackData {
  manifest: PackManifest;
  champions?: ChampionEntry[];
  /**
   * The roles a hand-built kit may choose from. Absent for a pack with no
   * taxonomy to offer, in which case core falls back to the average of the
   * installed roster — see `preset.ts`'s `averageDefence`.
   */
  archetypes?: ArchetypeDef[];
  /** Keyed by *local* spell id — the same keys as `ContentPackCode.spells`. */
  spellDisplay?: Record<string, SpellDisplayData>;
  /**
   * Keyed by *local* item id. Absent for a pack that ships no items, which is
   * every pack that existed before items did — the field is optional for the
   * same reason `maps` is.
   */
  items?: Record<string, ItemDef>;
  monsters?: Record<string, MonsterDef>;
  maps?: MapDefinition[];
}

/**
 * The half of a pack that is real engine classes, and the only half a
 * `ContentPackFactory` ever hands back — see that type's own doc comment for
 * why it still needs the api even though the data half no longer does.
 *
 * `monsterAbilities` is a distinct field from `ContentPackData.monsters`
 * rather than a same-named `abilities` addition to it — the two are keyed by
 * local monster id but hold different halves (tuning data vs. real classes),
 * and `ContentPack = ContentPackData & ContentPackCode` would otherwise
 * require one property to answer to two incompatible types. See
 * `MonsterBody`'s own doc comment for why abilities live here instead of on
 * `MonsterBody`/`MonsterDef` in the first place.
 */
export interface ContentPackCode {
  spells?: Record<string, SpellSource>;
  /**
   * A champion's own opinion for the bot brain, keyed by this pack's champion
   * id (the same key as `champions[].id`; qualified at install). Optional per
   * champion and per hook — see `ChampionAI`. A key that names no champion of
   * this pack is rejected at install, like a `monsterAbilities` key would be.
   */
  championAI?: Record<string, ChampionAI>;
  /** Keyed by *local* monster id — the same keys as `ContentPackData.monsters`. */
  monsterAbilities?: Record<string, MonsterAbility[]>;
  /**
   * What this pack's turrets are built carrying, **in place of core's own**.
   *
   * Core ships three (`gameObject/structures/turretPassives.ts`): an
   * armour-piercing ramp, a damage floor while the lane is empty, and true
   * sight over the lane — real buffs rather than branches inside `Turret`.
   * Declaring this field replaces that list wholesale; declaring nothing gets
   * it. Replacing rather than adding, because a pack with a different idea of
   * a tower wants *its* tower, and two half-towers stacked is not a third
   * opinion. `Game.spawnStructures` is where the two meet.
   *
   * Not keyed: turrets have no ids and every one on a map is the same kit, so
   * this is a plain list where `monsterAbilities` is a record.
   *
   * What is not a passive at all, and so is not here: which body a turret
   * shoots first, and how far it will answer for an ally. Those are rules about
   * how the engine picks a target, and a pack that could redefine them would be
   * changing what "a turret" means for everybody who plays against it.
   */
  turretPassives?: TurretPassive[];

  /**
   * A pack's own object standing on a neutral slot, keyed by the slot `role`
   * it claims.
   *
   * `slots.neutral` used to mean one thing — a jungle camp — and a role no
   * installed pack filled left the slot empty. But a map's neutral slots are
   * just *named points on the ground*: "core never interprets it"
   * (`NeutralSlot.role`). Everything a map wants to stand there that is not a
   * body to fight — a relic somebody walks over, an altar, a shrine, a
   * capture point — had nowhere to be declared, and a pack could not place so
   * much as a decoration of its own without pretending it was a monster.
   *
   * The factory is handed the slot itself and the running game, and returns
   * the object to add — or `null` for a slot it looked at and declined,
   * which is how a pack conditions on the slot's own `stats` without core
   * learning what any of them mean.
   *
   * **A point is filled once, and the map breaks the tie.** A slot whose
   * `kind` is `'object'` is never a camp; one that says nothing is a camp
   * first and falls back to here. See `preset.ts`'s `neutralSlotFill`.
   *
   * **A pack registered here always wins.** Core answers a short list of
   * roles itself now (`gameObject/structures/slotObjects.ts` — the relic, and
   * that is deliberately almost all of it), and this is consulted first, so a
   * pack that ships its own relic replaces core's. Core's table is a floor
   * under a map that names a furniture role, never a competitor.
   *
   * Silently ignored by a core too old to know the field, like every other
   * optional half of this interface — the slot falls back to core's own answer
   * for that role, or stays empty. A pack that ships one states the floor in
   * its manifest's `coreRange`.
   */
  slotObjects?: Record<string, SlotObjectFactory>;
}

/**
 * Builds one pack-owned object for one neutral slot. See
 * `ContentPackCode.slotObjects`.
 */
export type SlotObjectFactory = (
  slot: NeutralSlot,
  game: GameObjectRuntimeContext
) => GameObject | null;

/**
 * The whole pack, as every reader from before the split still names it —
 * `PackRegistry.install()` takes one, and both halves' fields stay optional
 * exactly as they were, since an intersection of two interfaces with only
 * optional fields is satisfied by either half alone.
 */
export type ContentPack = ContentPackData & ContentPackCode;

export const STRUCTURE_KINDS: readonly StructureKind[] = Object.freeze(['turret']);

/**
 * The vocabularies `validate.ts` checks a `MonsterBody` against, beside
 * `STRUCTURE_KINDS` and for the same reason: the type is erased at runtime,
 * so a pack shipping `temperament: 'agressive'` would otherwise install
 * cleanly and produce a camp that quietly never fights.
 */
/**
 * Beside `STRUCTURE_KINDS` and for the identical reason: the type is erased at
 * runtime, so a map shipping `kind: 'obect'` would otherwise validate cleanly
 * and be drawn — and filled — as a camp.
 */
export const NEUTRAL_KINDS: readonly NeutralKind[] = Object.freeze(['camp', 'object']);

export const MONSTER_TEMPERAMENTS: readonly MonsterTemperament[] = Object.freeze([
  'aggressive',
  'skittish',
]);

/**
 * The three bodies core knows how to fight and draw as. A map may name any
 * number of minion *types*; each one still has to pick one of these.
 */
export const MINION_STYLES: readonly MinionStyle[] = Object.freeze(['melee', 'ranged', 'cannon']);

/** Layers a `roam: { kind: 'terrain' }` may name — the two region layers. */
export const MONSTER_ROAM_LAYERS: readonly ('water' | 'bush')[] = Object.freeze(['water', 'bush']);

/**
 * The four shapes core knows how to draw a camp's swing as. Runtime for the
 * same reason the temperaments are: a pack shipping `attackStyle: 'melee '`
 * would otherwise install cleanly and fall through to the `ranged` branch.
 */
export const MONSTER_ATTACK_STYLES: readonly MonsterAttackStyle[] = Object.freeze([
  'melee',
  'ranged',
  'breath',
  'lash',
]);
