import { contentRegistry } from '@/content/registry';
import type { PackRegistry, QualifiedMonster } from '@/content/PackRegistry';
import type {
  Faction,
  MapTuning,
  MinionSlot,
  MonsterBody,
  NeutralSlot,
  SlotObjectFactory,
  SpawnSlot,
  StructureSlot,
} from '@/content/ContentPack';
import TeamId from './enums/TeamId';
import type { MonsterPresetData } from './gameObject/attackableUnits/Monster';
import { coreSlotObjectFor } from './gameObject/structures/slotObjects';
import type { FountainPresetData } from './gameObject/structures/Fountain';
import type { TurretPresetData } from './gameObject/structures/Turret';
import {
  resolveFountainStats,
  resolveMonsterPreset,
  resolveTurretPreset,
} from './config/mapTuning';
import type Champion from './gameObject/attackableUnits/Champion';
import {
  DEFAULT_CHAMPION_ATTACK,
  DEFAULT_CHAMPION_DEFENCE,
  type ChampionAttackTuning,
  type ChampionDefenceTuning,
} from './gameObject/attackableUnits/Champion';
import type { ChampionTrailSpec } from '@/content/ContentPack';
import type { ChampionPresetData } from './gameObject/attackableUnits/Champion';
import type { ChampionLoadout, MatchRules, SlotChoice } from './config/PregameConfig';
import { matchModeFor, type MatchModeId } from './config/matchModes';
import { poolOf, readChampionPool } from './config/championPool';
import { SLOT_COUNT } from './config/PregameConfig';
import {
  BASIC_ATTACK_ID,
  summonerSpellIds,
  listSelectableChampions,
  type SpellDisplay,
} from './config/spellCatalog';
import {
  allSpellIds,
  isSpellId,
  loadSpells,
  spellClassOfId,
  type SpellClass,
} from './spellRegistry';
import BasicAttack from './gameObject/coreSpells/BasicAttack';
// Core mechanism now (batch 5 task 1 moved `Recall.ts` back from
// `packs/riot/spells/`, beside `BasicAttack.ts`), not a content import — this
// line is no longer the one named exception `corePacksBoundary.test.ts`
// carries for this file; that file's allow-list no longer mentions
// `preset.ts` at all. `Recall`'s default export is still a factory
// (`(api: ContentApi) => SpellClass`) rather than a plain class like
// `BasicAttack`: `packs/riot/data.ts` still names every champion's way home
// as the bare string `'Recall'`, and `src/content/install.ts` still folds a
// real `Recall` class onto the installed pack's spells to resolve it (the
// same core-last fold that file already does for `BasicAttack`) — so the
// factory shape stays, for that one other caller, rather than being
// collapsed down to match `BasicAttack` exactly. `buildContentApi()` is
// otherwise reserved for `install.ts`'s caller (`registry.ts`); called here
// too because this is the second and only other place a real `Recall` class
// is built outside that path. Resolved once at module scope, not per
// champion: `buildContentApi()` is a cached singleton and the class itself
// never changes between champions.
import { buildContentApi } from '@/content/ContentApi';
import makeRecall from './gameObject/coreSpells/Recall';

const RecallClass = makeRecall(buildContentApi());

/**
 * The barrel is gone from this file, and that is the whole of Stage 4.
 *
 * `import * as AllSpells` used to sit on line 1, which meant every build of the
 * game carried all 238 spell modules in one chunk no matter what the match
 * played. Ids now come from `config/spellCatalog.ts` (generated data) and
 * classes from `spellRegistry.ts` (dynamic imports, fetched per champion).
 *
 * `BasicAttack` stays a static import because every kit has it in slot 0 and
 * because it is the last-resort fallback below — a spell the resolver reaches
 * for when it has nothing else must not itself be something that might not have
 * arrived.
 */
export type { SpellClass };

/**
 * Gives a freshly built champion its way home — the same kind of core-
 * mechanism decision this file already makes for `BasicAttack`, just made
 * once per champion instead of once per slot.
 *
 * `Champion.recall` is deliberately not part of `ChampionPresetData`: a preset
 * swap must not take the ability to go home away from a champion that already
 * has one (see that field's doc comment), so this runs exactly once, right
 * after construction, at every call site that builds a `Champion` for a real
 * match — `Game.ts`'s player and initial bots, and `MatchDirector.addBotWithPreset`.
 * A map with no fountain is future work for a content pack to express by
 * simply not calling this; nothing here assumes every champion gets one.
 *
 * Resolved once at module scope because `buildContentApi()` is a cached
 * singleton and the class itself never changes between champions — this is
 * the same reasoning `BasicAttack`'s own static import above rests on, not a
 * content bridge any more. `coreSpells/index.ts`'s own header explains why
 * `Recall` still is not re-exported from that barrel even though it lives
 * beside `BasicAttack.ts` now.
 */
export const attachRecall = <T extends Champion>(champion: T): T => {
  champion.recall = new RecallClass(champion);
  // Going home is not casting a spell — see `Spell.countsAsAbilityCast`.
  champion.recall.countsAsAbilityCast = false;
  return champion;
};

const random = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

/**
 * A catalogue id resolved to a class, with the fallbacks a lazily-loaded
 * catalogue needs.
 *
 * Two things can make a lookup miss and both are recoverable: a stale
 * `localStorage` slot naming a spell this build removed, and — for a mid-match
 * re-roll — an id whose chunk has not landed yet. Neither is worth a broken
 * match, so this degrades to the basic attack. It must never borrow a different
 * loaded spell: one champion's portrait holding another's ability is playable
 * but dishonest, and
 * much harder to diagnose than an obvious safe fallback. Anything a match
 * *plans* for is loaded before it starts; see `planMatchKits`.
 */
const classForId = (id: string): SpellClass => spellClassOfId(id) ?? BasicAttack;

/**
 * A catalogue row complete enough to be a real random champion.
 *
 * Kept as a narrowed table rather than repeatedly walking `contentRegistry()`:
 * random planning runs once per unit at boot and again on random bot respawns.
 * The loop is deliberate — this project's Array `filter` polyfill cannot narrow
 * types, so a predicate would still leave `image` nullable.
 *
 * `image` is plain `string` rather than `AssetKey`: a `QualifiedChampion` may
 * come from any installed pack, and a pack's own asset key is not a member of
 * core's generated `AssetKey` union. Nothing here casts back to the narrow
 * type — see `packAsset` in `config/spellCatalog.ts`, the matching
 * resolve-side helper Task 7 already introduced for the same crossing.
 * `spells` is `string[]` too, but for a weaker reason since batch 5 task 2:
 * `SpellCatalogId` is `string` now, not a literal union, so `SpellCatalogId[]`
 * would type-check identically here — `string[]` stays because it is what
 * `spells` actually is, a mix of the bundled pack's bare ids and other
 * packs' qualified ones, and naming a catalogue-specific type for a field
 * that is not exclusively the catalogue's own would be misleading regardless
 * of what that type happens to allow.
 */
export interface PlayableChampionKit {
  /** The installed pack this champion came from — `QualifiedChampion.packId`. What the random pool filters on. */
  packId: string;
  /** The catalogue row's qualified id (`pack:Champion`) — what a bot's `ChampionAI` is looked up by. */
  championId: string;
  name: string;
  image: string;
  spells: string[];
  /** Local id of this champion's passive, or absent. See `ChampionEntry.passive`. */
  passive?: string;
  attack: ChampionAttackTuning;
  defence: ChampionDefenceTuning;
  /** A tail or cloak this champion streams behind it, or none. Cosmetic. */
  trail?: ChampionTrailSpec;
}

let playableCache: PlayableChampionKit[] | null = null;
let playableCacheFor: PackRegistry | null = null;
/**
 * The registry's own content counter at the time the cache was built.
 *
 * Identity alone is not enough: a runtime pack install mutates the shared
 * registry in place, so `playableCacheFor === registry` stays true across the
 * install that added 58 champions. See `PackRegistry.contentRevision`.
 */
let playableCacheRevision = -1;

/**
 * Built on first use, not at module load.
 *
 * The old array was filled by a `for` loop at module scope, which was fine
 * while the roster was a literal in another module. It is not fine now: the
 * roster comes from `contentRegistry()`, which installs on its first read, and
 * a module-scope loop runs before `main.ts` has done anything at all. Memoised
 * rather than recomputed because random planning runs once per unit at boot
 * and again on every random bot respawn.
 *
 * Keyed on the registry **instance**, not a `resetPresetCachesForTests()`
 * plumbed in from `src/content/`. `resetContentRegistryForTests()` discards
 * the old `PackRegistry` and the next `contentRegistry()` call builds a fresh
 * one, so comparing against the *current* instance invalidates this cache for
 * free the moment a test installs a different pack set — a boolean latch would
 * need a reset function threaded from core's content layer into the game
 * layer above it, and would still go stale the first time a test installed a
 * different registry without calling that function.
 *
 * Exported (content-pack-and-repo-split batch 6 task 10, fix round 1) so
 * `tests/game/combat/AttackProfiles.test.ts` can read the same playable-
 * filtering rule this file already uses, instead of the file's own stale
 * `image?.startsWith('champ_')` sniff — a naming convention `ChampionEntry
 * .playable`'s own doc comment already says "no pack has any reason to
 * share," and one that quietly filtered every entry out (a vacuous pass)
 * the moment a non-Riot pack's asset keys stopped matching it.
 */
export const playableKits = (): PlayableChampionKit[] => {
  const registry = contentRegistry();
  if (
    playableCache &&
    playableCacheFor === registry &&
    playableCacheRevision === registry.contentRevision
  )
    return playableCache;
  const out: PlayableChampionKit[] = [];
  for (const champion of registry.champions()) {
    // `playable` is the whole rule — `content/validate.ts` already refuses to
    // install a playable champion without a portrait or without exactly four
    // abilities. The `image` check below is narrowing `string | null` to
    // `string`, not a second rule: it exists only because this project's
    // `Array.prototype.filter` polyfill cannot narrow types (see
    // `src/types/global.d.ts`), so a loop stands in for a predicate.
    if (!champion.playable) continue;
    if (!champion.image) continue;
    out.push({
      packId: champion.packId,
      championId: champion.id,
      name: champion.name,
      image: champion.image,
      spells: champion.spells,
      passive: champion.passive,
      attack: champion.attack ?? DEFAULT_CHAMPION_ATTACK,
      defence: { ...DEFAULT_CHAMPION_DEFENCE, ...champion.defence },
      trail: champion.trail,
    });
  }
  playableCache = out;
  playableCacheFor = registry;
  playableCacheRevision = registry.contentRevision;
  return playableCache;
};

/**
 * A random champion, from the packs the player left in the pool
 * (`config/championPool.ts`). Every random anything in a match — a 'random'
 * pick, a bot with no pick, the brawl's whole roster, a custom kit's avatar —
 * comes through here, so the pool is one filter and not four.
 */
const randomChampionKit = (): PlayableChampionKit =>
  random([...poolOf(playableKits(), readChampionPool().disabledPacks)]);
const randomAvatar = (): string => randomChampionKit().image;

/**
 * The durability of the average champion on the installed roster — what a kit
 * the player assembled by hand is worth.
 *
 * A custom kit has no archetype to read a profile off; `planLoadout` says so
 * and hands it `DEFAULT_CHAMPION_ATTACK` for the same reason. Doing the same
 * with `DEFAULT_CHAMPION_DEFENCE` would have been the obvious move and a bad
 * one: that constant is *the state before any pack declared a profile* — 100
 * health, no resistances — so the moment a pack spreads its champions from 125
 * to 220 health, the hand-built kit stops being the average and becomes the
 * single squishiest body in the game, thinner than the marksman. The mode
 * would be unplayable, and nothing in it would say why.
 *
 * Averaging the roster keeps it in the middle by construction and keeps it
 * there: a pack that raises everyone raises this too, with nothing to
 * remember. It also mirrors what the mode already does for its face —
 * `randomAvatar` borrows one from the same pool.
 *
 * Falls back to the default when no champion declares a profile, which is both
 * the honest answer for such a pack and exactly its current behaviour.
 */
const averageDefence = (): ChampionDefenceTuning => {
  const kits = playableKits();
  if (kits.length === 0) return DEFAULT_CHAMPION_DEFENCE;

  const mean = (read: (kit: PlayableChampionKit) => number): number =>
    kits.reduce((sum, kit) => sum + read(kit), 0) / kits.length;

  return {
    // Rounded, because a health pool is drawn as a number and 163.4 is not one.
    health: Math.round(mean(kit => kit.defence.health)),
    healthRegen: mean(kit => kit.defence.healthRegen),
    armor: Math.round(mean(kit => kit.defence.armor)),
    magicResist: Math.round(mean(kit => kit.defence.magicResist)),
  };
};

/**
 * A wholly random champion — the AI's respawn re-roll, and what a loadout on
 * 'random' resolves to.
 *
 * Reads through one `planRandomKit` + `presetFromPlan` like everything else,
 * which keeps one definition of "what a random champion is" and one dice roll
 * for its name, portrait, four abilities and attack profile. A chunk that has
 * not arrived degrades that slot to BasicAttack through `classForId`; it never
 * swaps in an unrelated loaded spell.
 */
export const getChampionPresetRandom = (): ChampionPresetData & { avatar: string } =>
  presetFromPlan(planRandomKit());

/**
 * Every installed champion — playable rows and shelf-only stubs alike, same
 * population `CHAMPION_KITS` used to give this function — with each spell id
 * resolved to its class.
 *
 * A **function**, not the constant it used to be: the classes arrive
 * asynchronously now, so a value computed at module-eval time would be a table
 * of `undefined`. Callers must have loaded what they are about to read —
 * `loadSpells(allSpellIds())` in a test, `planMatchKits` in a match.
 *
 * `image` widens to `string | null`, matching `QualifiedChampion.image`: see
 * `PlayableChampionKit`'s doc comment for why a pack's own asset key is not a
 * member of core's generated `AssetKey` union.
 */
export const spellGroups = (): {
  name: string;
  image: string | null;
  spells: SpellClass[];
  /** The champion's basic-attack profile — `packs/riot/data.ts`'s own `ATTACK` picks one per row. */
  attack?: ChampionAttackTuning;
  /** And its durability profile — the same row's `DEFENCE` pick. */
  defence?: ChampionDefenceTuning;
}[] =>
  contentRegistry()
    .champions()
    .map(champion => ({
      name: champion.name,
      image: champion.image,
      spells: champion.spells.map(classForId),
      attack: champion.attack,
      defence: champion.defence ? { ...DEFAULT_CHAMPION_DEFENCE, ...champion.defence } : undefined,
    }));

// ---------------------------------------------------------------------------
// Display data, from a class
//
// The pregame screen no longer comes through here: it reads
// `config/spellCatalog.ts`, which is the same seven fields generated at build
// time, so that rendering a roster of 238 abilities does not require loading
// 238 modules. What is left is the *class*-shaped read, for the in-game HUD —
// already inside the game chunk, holding real spell instances, with nothing to
// save by going the long way round through an id.
//
// `new SpellClass(owner)` for a throwaway display instance is the technique the
// in-game spell-picker modal already uses to read a spell's icon/name without a
// real champion to own it, extended with a stub `owner.game.matchRules` so the
// same instance can also report its *effective* (CDR/URF-adjusted) cooldown and
// mana cost.
//
// The `catch` stays: this runs in a browser, where one broken spell must not
// take the picker down with it. `scripts/generate-spell-catalog.mjs` makes the
// opposite choice deliberately — see its header.
// ---------------------------------------------------------------------------

/** No cooldown reduction, no URF — what a spell shows outside any pregame context. */
const NO_MATCH_RULES: MatchRules = { cooldownMultiplier: 1, manaFree: false, recall: true };

export type { SpellDisplay } from '@/game/config/spellCatalog';

/**
 * Builds a throwaway instance to read a spell's display fields — including,
 * given `matchRules`, the same `effectiveCoolDownMs`/`effectiveManaCost`
 * getters `Spell.ts` uses for the real cast path (`reducedCooldown`), so a
 * number shown here is provably the number the engine will actually use.
 *
 * `config/spellCatalog.ts`'s `spellDisplayOf` is the id-shaped twin of this,
 * and `tests/game/config/spellCatalog.test.ts` asserts the two agree on every
 * spell in the barrel — which is what stops the generated data becoming a
 * second, quietly-wrong source of truth.
 */
export const getSpellDisplay = (
  SpellClass: SpellClass,
  matchRules: MatchRules = NO_MATCH_RULES
): SpellDisplay => {
  try {
    const instance = new SpellClass({ game: { matchRules } });
    const handle = instance.image as { url?: string } | null | undefined;
    return {
      iconUrl: handle?.url ?? null,
      name: instance.name ?? SpellClass.name,
      description: typeof instance.description === 'string' ? instance.description : '',
      coolDownMs: typeof instance.coolDown === 'number' ? instance.coolDown : 0,
      manaCost: typeof instance.manaCost === 'number' ? instance.manaCost : 0,
      effectiveCoolDownMs:
        typeof instance.effectiveCoolDownMs === 'number' ? instance.effectiveCoolDownMs : 0,
      effectiveManaCost:
        typeof instance.effectiveManaCost === 'number' ? instance.effectiveManaCost : 0,
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `preset.ts: a spell failed to construct for display (${SpellClass?.name ?? '?'})`,
      error
    );
    return {
      iconUrl: null,
      name: SpellClass?.name ?? '?',
      description: '',
      coolDownMs: 0,
      manaCost: 0,
      effectiveCoolDownMs: 0,
      effectiveManaCost: 0,
    };
  }
};

export {
  BASIC_ATTACK_ID,
  abilitySlotOfId,
  listSelectableChampions,
  listSpellCatalog,
  listSummonerSpells,
  summonerSpellIds,
  type SelectableChampion,
  type SelectableChampionSpell,
  type SpellCatalogEntry,
  type SummonerSpellOption,
} from '@/game/config/spellCatalog';

// ---------------------------------------------------------------------------
// Planning a match, then building it
//
// These used to be one step: `getChampionPresetFromLoadout` rolled the dice for
// every 'random' slot *and* reached into the barrel for the classes, in a single
// synchronous call from `Game`'s constructor. With the barrel gone that no
// longer works, and the reason is worth stating because it is the whole
// argument for splitting them:
//
//   A default match is four `championName: 'random'` loadouts. The config says
//   none of which four champion rows they will become, so deciding what to load
//   from it alone would still answer "all 58 kits" — the exact thing this was
//   supposed to avoid.
//
// So the roll happens first, against ids alone (`planMatchKits` — no module has
// to have arrived for it to pick names out of a list), the ~16 ids it produces
// are loaded, and only then are classes read (`presetFromPlan`). One roll, and
// a match that fetches the six kits it is about to play.
//
// Ids are the spell barrel's own export names — e.g. `'<Champion>_Q'` — never
// `SpellClass.name`. Both are ostensibly the same string today, but only the
// key is stable: a minifier renames a class's `Function.prototype.name` and
// cannot rename a key that `spellModules.ts` writes as a literal.
// ---------------------------------------------------------------------------

/** A catalogue id's class, or `null` if its module has not been loaded. */
export { spellClassOfId } from './spellRegistry';

/** One unit's kit, decided before a single spell module has been fetched. */
export interface KitPlan {
  /** The catalogue champion this kit is, or absent for a hand-built kit. See `Champion.championId`. */
  championId?: string;
  name: string;
  /** A pack's own asset key — see `PlayableChampionKit`'s doc comment. */
  avatar: string;
  /** The same catalogue row's basic-attack tuning; custom kits use the engine default. */
  attack: ChampionAttackTuning;
  /** The same row's durability; custom kits use the roster's average — see `averageDefence`. */
  defence: ChampionDefenceTuning;
  /**
   * And the same row's cosmetic trail, if it declared one.
   *
   * Never averaged the way `defence` is, and never invented for a custom kit:
   * durability has to be *some* number or the body is unplayable, while a
   * champion with no tail is a champion with no tail. Averaging a look across
   * a roster produces a look nobody designed.
   */
  trail?: ChampionTrailSpec;
  /** Exactly `SLOT_COUNT` ids, in A/Q/W/E/R/D/F order. */
  spellIds: string[];
  /**
   * The champion's passive id, or absent.
   *
   * Outside `spellIds` on purpose: that list is the hotkey layout, exactly
   * `SLOT_COUNT` long, and every consumer indexes into it. A passive has no
   * slot — see `Champion.passive`. It is carried here rather than re-derived
   * later because a plan is the point where *all* randomness is already
   * resolved, and a randomly-rolled champion has to bring its own passive.
   */
  passiveId?: string;
}

export interface MatchPlan {
  player: KitPlan;
  bots: KitPlan[];
  /**
   * The match mode these kits were planned under — `config/matchModes.ts`.
   * On the plan rather than read again from storage because a net client's
   * plan comes from the *host's* `hello`, and its own stored config knows
   * nothing about the room it is joining. `Game` lays the mode's tuning over
   * the map from this; absent means classic, i.e. the map's own numbers.
   */
  mode?: MatchModeId;
}

const randomSpellId = (): string => random(allSpellIds());

/**
 * A stored summoner choice, or the shelf's own first entry if it no longer
 * names one.
 *
 * The middle case is the one that matters: a choice stored **bare** against a
 * shelf that is now some pack's, so `'Flash'` has to find `riot:Flash`.
 * `PregameConfig`'s own defaults are those bare names, and so is every save
 * written before content became packs — without this both D and F fall to
 * `ids[0]`, which is one spell in two slots, and before `summonerSpellIds`
 * stopped narrowing to the bundled pack they fell all the way to a basic
 * attack. Matched on the local half only, never across packs by accident: a
 * qualified choice is compared whole, first.
 */
const summonerIdOr = (choice: string): string => {
  const ids = summonerSpellIds();
  // No cast needed against `ids: SpellCatalogId[]` — `SpellCatalogId` is
  // `string` since batch 5 task 2, so `choice` is already a member.
  if (ids.includes(choice)) return choice;
  if (!choice.includes(':')) {
    for (const id of ids) {
      if (id.slice(id.indexOf(':') + 1) === choice) return id;
    }
  }
  return ids[0] ?? choice;
};

/**
 * A slot's stored choice with 'random' — and any id this build dropped —
 * rolled out.
 *
 * Slot 0 never rolls. It is the A key and the basic-attack input path (see
 * `planRandomKit`'s slot comment): whatever sits there is what
 * `BasicAttackController` drives, so a rolled ability in it leaves the
 * champion unable to auto-attack at all — which is exactly what a custom kit
 * whose A was left to chance used to spawn with. Its dice land on the one
 * basic attack instead.
 */
const planSlot = (choice: SlotChoice, slotIndex: number): string => {
  if (choice !== 'random' && isSpellId(choice)) return choice;
  return slotIndex === 0 ? BASIC_ATTACK_ID : randomSpellId();
};

/**
 * A random champion: one complete catalogue row, kept coherent all the way
 * through name, portrait, Q/W/E/R and basic-attack profile.
 *
 * D and F are arguments rather than part of that row because summoners are an
 * explicit choice on every loadout. Random decides the champion, not those two
 * slots — a player who set a particular summoner spell on a random champion
 * must keep it. Omitted (or invalid), each falls back through `summonerIdOr`
 * to the shelf's own first entry rather than a literal id of this pack's own.
 */
export const planRandomKit = (summonerD?: string, summonerF?: string): KitPlan => {
  const kit = randomChampionKit();
  // Left wholly unset (the AI's respawn re-roll — see `getChampionPresetRandom`),
  // D and F default to the shelf's first two entries rather than its first
  // entry twice, so a coherent random kit still offers two different
  // summoner spells the way an explicit loadout always would.
  const ids = summonerSpellIds();
  const defaultD = ids[0] ?? '';
  const defaultF = ids[1] ?? defaultD;
  return {
    championId: kit.championId,
    name: kit.name,
    avatar: kit.image,
    attack: kit.attack,
    defence: kit.defence,
    trail: kit.trail,
    passiveId: kit.passive,
    spellIds: [
      // Slot 0 is the internal slot and SpellHotKeys[0] is `A`, so whatever sits
      // here is what `A` presses. The basic attack lives there: it is an ability
      // like the rest, and putting it in a slot is what gives the champion's own
      // attack a key, an icon and a timer without inventing a second input path
      // beside the spell one.
      BASIC_ATTACK_ID,
      ...kit.spells,
      summonerD === undefined ? defaultD : summonerIdOr(summonerD),
      summonerF === undefined ? defaultF : summonerIdOr(summonerF),
    ],
  };
};

/**
 * Turns a `ChampionLoadout` (plain, serializable data — the player's or one
 * AI bot's) into the ids that loadout will play:
 *
 * - `mode: 'custom'` rolls each of the 7 stored `customSlots` choices
 *   independently.
 * - `mode: 'champion'` with a real `championName` takes that champion's real
 *   Q/W/E/R plus the chosen summoners.
 * - `mode: 'champion'` with `championName: 'random'`, or a name that no longer
 *   names a full-kit champion — a stale save from before a champion was
 *   removed, or corruption `PregameConfig`'s own sanitizer cannot catch because
 *   it does not know this catalogue — falls through to the random kit.
 *
 * A custom kit has no single champion identity or attack archetype, so it gets
 * a portrait from the playable pool and keeps `DEFAULT_CHAMPION_ATTACK`; only
 * explicit random-champion mode promises one coherent catalogue row.
 */
export const planLoadout = (loadout: ChampionLoadout): KitPlan => {
  if (loadout.mode === 'custom') {
    const slots = Array.from({ length: SLOT_COUNT }, (_, i) => loadout.customSlots[i] ?? 'random');
    const chosen = loadout.archetypeId ? contentRegistry().archetype(loadout.archetypeId) : null;
    return {
      name: chosen ? `Tự Ghép Chiêu — ${chosen.name}` : 'Tự Ghép Chiêu',
      avatar: randomAvatar(),
      // A role the player picked decides both halves of the body. With none —
      // an older saved config, or an id whose pack is gone — core's default
      // attack profile stands, and durability falls back to the roster's
      // average rather than to `DEFAULT_CHAMPION_DEFENCE`; see
      // `averageDefence` for why a constant would make this mode the thinnest
      // body in the game.
      attack: chosen?.attack ?? DEFAULT_CHAMPION_ATTACK,
      defence: chosen ? { ...DEFAULT_CHAMPION_DEFENCE, ...chosen.defence } : averageDefence(),
      // No trail, ever, whatever role was picked. A custom kit is not a
      // champion somebody drew — see `KitPlan.trail`.
      spellIds: slots.map(planSlot),
    };
  }

  const kit =
    loadout.championName === 'random'
      ? undefined
      : playableKits().find(candidate => candidate.name === loadout.championName);

  if (!kit) return planRandomKit(loadout.summonerD, loadout.summonerF);

  return {
    championId: kit.championId,
    name: kit.name,
    avatar: kit.image,
    attack: kit.attack,
    defence: kit.defence,
    trail: kit.trail,
    spellIds: [
      BASIC_ATTACK_ID,
      ...kit.spells,
      summonerIdOr(loadout.summonerD),
      summonerIdOr(loadout.summonerF),
    ],
  };
};

/** Every unit's kit for one match, with all randomness already resolved. */
/**
 * The brawl's "everyone random", as a loadout: the pick is set aside, the
 * summoners are kept. Kept, because a random *champion* is the mode's point
 * and a random Flash is nobody's — and because the player's two summoner
 * choices are the one part of a loadout they still get to own in that room.
 */
const randomised = (loadout: ChampionLoadout): ChampionLoadout => ({
  ...loadout,
  mode: 'champion',
  championName: 'random',
});

export const planMatchKits = (config: {
  player: ChampionLoadout;
  ai: { count: number; bots: readonly ChampionLoadout[]; botTeams?: readonly string[] };
  mode?: MatchModeId;
  playerTeam?: string;
}): MatchPlan => {
  const mode = matchModeFor(config.mode);
  // Twins: one roll per team, kept per unit's own summoners.
  const rolled = new Map<string, KitPlan>();
  const twin = (team: string, loadout: ChampionLoadout): KitPlan => {
    let base = rolled.get(team);
    if (!base) {
      base = planRandomKit();
      rolled.set(team, base);
    }
    return {
      ...base,
      spellIds: [
        ...base.spellIds.slice(0, 5),
        summonerIdOr(loadout.summonerD),
        summonerIdOr(loadout.summonerF),
      ],
    };
  };
  const plan = (loadout: ChampionLoadout, team: string): KitPlan =>
    mode.twins
      ? twin(team, loadout)
      : planLoadout(mode.allRandom ? randomised(loadout) : loadout);
  const playerTeam = config.playerTeam ?? 'BLUE';
  return {
    player: plan(config.player, playerTeam),
    bots: Array.from({ length: config.ai.count }, (_, i) =>
      plan(config.ai.bots[i] ?? config.player, config.ai.botTeams?.[i] ?? 'RED')
    ),
    mode: mode.id,
  };
};

/**
 * The loadout the in-game editor should open on, reconstructed from a plan.
 *
 * A net client's champion is built from the host's hello plan, not from this
 * device's stored `pregameConfig` — but `loadoutOf` used to be seeded from
 * the stored config anyway, so the editor opened on whatever this machine
 * last persisted. Two tabs on one machine share `localStorage`, and the host
 * tab persists its own loadout into the same key on every panel mutation:
 * the client's "đổi tướng" modal opened showing the *host's* kit.
 *
 * Champion mode when the plan's name is a catalogue champion (the hello kit
 * is `planRandomKit`, which always rolls one), so the editor opens with that
 * champion selected; anything else falls to a custom kit carrying the exact
 * slots. Either way the summoners are the plan's own.
 */
export const loadoutFromPlan = (plan: KitPlan): ChampionLoadout => ({
  mode: playableKits().some(kit => kit.name === plan.name) ? 'champion' : 'custom',
  championName: plan.name,
  summonerD: plan.spellIds[5] ?? '',
  summonerF: plan.spellIds[6] ?? '',
  customSlots: [...plan.spellIds],
});

/** The flat, deduplicated id list a plan needs loaded — what `GameScene` awaits. */
export const plannedSpellIds = (plan: MatchPlan): string[] => [
  // Passives ride along: they are ordinary spell modules and `presetFromPlan`
  // resolves them through the same `classForId`, so a passive left out here is
  // a champion whose passive is silently missing on the first match and
  // present on the second, once the background warm-up has caught up.
  ...new Set(
    [plan.player, ...plan.bots].flatMap(kit =>
      kit.passiveId ? [...kit.spellIds, kit.passiveId] : kit.spellIds
    )
  ),
];

/** A plan with its classes attached. Everything it names must already be loaded. */
export const presetFromPlan = (plan: KitPlan): ChampionPresetData & { avatar: string } => ({
  championId: plan.championId,
  name: plan.name,
  avatar: plan.avatar,
  attack: plan.attack,
  defence: plan.defence,
  trail: plan.trail,
  spells: plan.spellIds.map(classForId),
  // `classForId` has fallbacks for a miss (a stale slot, a catalogue still
  // warming) and answers with core's own basic attack. That is right for a
  // *slot*, which must always hold something pressable, and wrong for a
  // passive: a champion whose passive did not resolve should have none, not
  // silently gain a second basic attack armed once per life.
  passive: plan.passiveId ? classForId(plan.passiveId) : undefined,
});

/**
 * Plan and build in one step, for the callers that are already inside a running
 * match and can rely on the catalogue being loaded: `MatchDirector` swapping a
 * live champion's kit, and `AIChampion` re-rolling on respawn.
 */
export const getChampionPresetFromLoadout = (
  loadout: ChampionLoadout
): ChampionPresetData & { avatar: string } => presetFromPlan(planLoadout(loadout));

/**
 * Safe live-match variant: decide the identity once, fetch exactly those spell
 * modules, then build from that same plan. Practice-panel swaps use this path
 * so confirming a champion before the background catalogue warm-up finishes
 * cannot produce that champion's portrait with fallback skills.
 */
export const loadChampionPresetFromLoadout = async (
  loadout: ChampionLoadout
): Promise<ChampionPresetData & { avatar: string }> => {
  const plan = planLoadout(loadout);
  await loadSpells(plan.spellIds);
  return presetFromPlan(plan);
};

/**
 * The monster that fills a neutral slot, or `null` when no installed pack
 * declares one — spec §6: *a slot nobody fills is left empty and the map
 * still plays*. `role` is a free string core never interprets, so a map
 * naming a role nobody supplies is not an error, just an empty camp.
 *
 * Several packs may answer the same `role`; `PackRegistry.monstersFilling`'s
 * own doc comment is the ruling — install order decides, and the match
 * config may override later.
 */
export const monsterFillingSlot = (slot: NeutralSlot): QualifiedMonster | null =>
  contentRegistry().monstersFilling(slot.role)[0] ?? null;

/**
 * What actually stands on a neutral slot: a pack's own object, a camp, or
 * nothing.
 *
 * `slots.neutral` meant one thing for as long as it existed — a jungle camp —
 * and `ContentPackCode.slotObjects` is what widened it: a map's neutral slots
 * are named points on the ground, and a relic somebody walks over is as much
 * a thing that stands on one as a pack of wolves is.
 *
 * **A point is filled once, and the map is what breaks the tie.** A role a
 * camp and an object both answer is a contradiction somebody has to settle,
 * and the map that drew the point is the one that knows what it drew: a
 * `kind: 'object'` point is never a camp, and a point that says nothing is a
 * camp first — which is what every map drawn before `slotObjects` meant.
 *
 * The order is the *only* thing `kind` chooses. A point that says nothing and
 * no camp answers still gets its object, so a forgotten `kind` costs a slot
 * drawn wrong in the editor and never a relic that fails to appear.
 *
 * **"An object" is a pack's first and core's second.** Core answers a short
 * list of furniture roles on its own (`structures/slotObjects.ts`), so a map
 * drawn in core's own editor can name `role: 'relic'` and get one without
 * knowing which packs the player has installed. A pack that registers the same
 * role replaces core's answer; it never has to out-argue it.
 *
 * Stated here rather than inside `Game.spawnJungle`'s loop because that loop
 * cannot be tested: nothing in this codebase constructs a real `Game` (see
 * `tests/game/fixtures.ts`), which is exactly why `fountainsFromSlots` and
 * `turretsFromSlots` are pure functions beside it too.
 */
export type NeutralSlotFill =
  | { kind: 'object'; build: SlotObjectFactory }
  | { kind: 'camp'; monster: QualifiedMonster }
  | null;

export const neutralSlotFill = (slot: NeutralSlot): NeutralSlotFill => {
  // A pack first, core's own table second. The order is the whole of the rule:
  // `slotObjects` is still how a pack claims a role core has never heard of,
  // and a pack that ships its own relic replaces core's rather than fighting
  // it. See `gameObject/structures/slotObjects.ts` for what core answers and
  // why the list is short.
  const build = contentRegistry().slotObjectFor(slot.role) ?? coreSlotObjectFor(slot.role);
  // The map's own word, and the only way to say "never a camp here" — which is
  // what a point drawn for a relic needs, and what the editor draws it as.
  if (slot.kind === 'object') return build ? { kind: 'object', build } : null;

  const monster = monsterFillingSlot(slot);
  if (monster) return { kind: 'camp', monster };
  // The fallback that keeps a forgotten `kind` from being a quiet failure: a
  // map that drew a relic point and said nothing still gets its relic, because
  // no camp answered the role. Only the *order* is what `kind` chooses.
  return build ? { kind: 'object', build } : null;
};

/**
 * One body of a resolved monster's `members`, spawn-ready — `Game.spawnJungle()`
 * calls this once per member and positions the resulting body at
 * `slot.{x,y} + member.offset`, so a multi-body camp (a Greater Wolf plus two
 * Wolves) lands exactly where the pack's `offset`s say, not stacked on the
 * slot's own centre.
 *
 * `camp` is the slot object itself, never a copy — every member of the same
 * `monster` spawned for the same `slot` gets the *same* `camp` reference,
 * which is what lets `Monster.alertCamp` find its packmates by identity
 * instead of the `campId` string this replaces. See that method's own doc
 * comment. (`camp` is still just the leash/home point — `{x, y, r}` — not
 * where any one body's `position` starts; that positioning is `Game.spawnJungle()`'s
 * job, using the same `member.offset`.)
 *
 * `abilities` stays engine-only: a `MonsterBody` cannot carry `MonsterAbility`
 * callbacks (real code — see that field's own doc comment on `MonsterBody`),
 * so they are merged in here from the pack's *code* half instead —
 * `contentRegistry().abilitiesFor(monster.id)`, keyed by the monster's own
 * qualified id, the same way a champion's spell classes are resolved by
 * qualified spell id. This pack's one boss monster is the only
 * monster that supplies any today, and it is a camp of one, so in practice
 * this only ever returns something for `members[0]`; nothing here is
 * specific to that monster, though — a second pack's monster with its own kit needs no
 * change here to pick this up.
 */
/**
 * A body's home: its slot, plus its offset turned by the slot's own
 * `rotationDeg`.
 *
 * The rotation is in screen space, where y grows downward, so a positive angle
 * reads clockwise on screen — which is what a map author sees. See
 * `NeutralSlot.rotationDeg` for why a map needs to say this at all.
 *
 * A non-number is treated as no rotation rather than propagated: `NaN` here is
 * a monster at `NaN`, which is a body nothing can path to and a health bar
 * drawn nowhere.
 */
const rotatedHome = (
  offset: { x: number; y: number },
  slot: NeutralSlot
): { x: number; y: number } => {
  const degrees = slot.rotationDeg;
  if (!Number.isFinite(degrees) || degrees === 0) {
    return { x: slot.x + offset.x, y: slot.y + offset.y };
  }
  const radians = ((degrees as number) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: slot.x + offset.x * cos - offset.y * sin,
    y: slot.y + offset.x * sin + offset.y * cos,
  };
};

export const monsterBodyPreset = (
  monster: QualifiedMonster,
  member: MonsterBody,
  slot: NeutralSlot,
  tuning?: MapTuning
): MonsterPresetData =>
  // The pack's declaration is the base; `resolveMonsterPreset` lays the map's
  // multipliers and then this slot's own absolutes over it. Routed through
  // `config/mapTuning.ts` rather than merged here so the arithmetic has one
  // home and one test file — see that module's header.
  resolveMonsterPreset(bareMonsterBodyPreset(monster, member, slot), tuning, slot);

const bareMonsterBodyPreset = (
  monster: QualifiedMonster,
  member: MonsterBody,
  slot: NeutralSlot
): MonsterPresetData => ({
  name: member.name,
  avatar: member.avatar,
  camp: slot,
  tier: monster.tier ?? 'camp',
  // Where this one body stands, which is a different question from where the
  // camp is: `camp` is the slot object itself, shared by reference across
  // every member so `alertCamp` can match on identity. `Monster` reads `home`
  // for its spawn point, its walk home, its arrived check and its respawn —
  // all four used to read `camp` and collapsed a pit into a pile.
  home: rotatedHome(member.offset, slot),
  speed: member.speed,
  size: member.size,
  attackRange: member.attackRange,
  reviveTime: member.reviveTime,
  health: member.health,
  damage: member.damage,
  attackInterval: member.attackInterval,
  aggroRange: member.aggroRange,
  attackStyle: member.attackStyle,
  attackColor: member.attackColor,
  rig: member.rig,
  temperament: member.temperament,
  anchored: member.anchored,
  wanderSpeed: member.wanderSpeed,
  chaseMargin: member.chaseMargin,
  giveUpDelayMs: member.giveUpDelayMs,
  regenDelayMs: member.regenDelayMs,
  roam: member.roam,
  ephemeral: member.ephemeral,
  abilities: contentRegistry().abilitiesFor(monster.id),
});

/**
 * Bridges a map's own faction vocabulary — a pack's free-string `Faction.id`,
 * e.g. `summonersRift`'s `'blue'`/`'red'` (`packs/riot/maps/summonersRift.ts`)
 * or `referenceMap`'s `'amber'`/`'jade'` (`packs/reference/map.ts`) — to the
 * match's fixed two-team model. Every comparison the engine actually runs
 * (`canTakeDamageFromTeam`, `PredefinedFilters.teamId`, `opposingTeam`, a
 * champion's own `pregameConfig.playerTeam`) is against `TeamId.BLUE`/
 * `TeamId.RED`, not the raw faction string, so a slot's faction has to land
 * on one of those two before a `Fountain`/`Turret` can share a side with a
 * champion.
 *
 * The bridge is **positional, not a fixed vocabulary**: `factions[0]` is
 * BLUE and `factions[1]` is RED, whatever a map spells them — the order its
 * own `MapSummary.factions` lists them in, the same list `validate.ts`
 * already requires every slot's `faction` to be drawn from. A hard-coded
 * `{blue: BLUE, red: RED}` table used to answer every other faction id with
 * `undefined`, silently — every Proving Grounds fountain, turret and muster
 * point bridged to no team at all, `randomSpawnPoint` fell back to picking
 * either fountain at random for *every* spawn on *both* sides, and
 * `MinionSpawner.queueWave` skipped every fountain outright (its `teamId
 * !== BLUE && teamId !== RED` guard), so no wave ever formed up despite the
 * map declaring a lane and two muster slots. Refusing any faction not
 * literally called `blue`/`red` would "fix" that by freezing the
 * abstraction as a lie instead — a map author writes `factions` and never
 * touches `TeamId`, so the vocabulary has to be exactly as free as
 * `Faction.id` already promises it is.
 *
 * A third-or-later faction (or a slot naming one `validate.ts` never saw,
 * which cannot happen on an installed pack but costs nothing to guard here
 * too) falls through to `undefined`, the same "isolated object" default
 * every other unbound `teamId` gets (`GameObject.teamId`'s own fresh-uuid
 * fallback) — a building on a faction the engine cannot seat on either team
 * ends up unaffiliated rather than crashing the match.
 */
const teamIdOfFaction = (factions: readonly Faction[], factionId: string): string | undefined => {
  if (factions[0]?.id === factionId) return TeamId.BLUE;
  if (factions[1]?.id === factionId) return TeamId.RED;
  return undefined;
};

/**
 * A spawn slot's own fountain preset. `FountainPreset` — a hard-coded
 * two-entry array whose *index* used to carry the team
 * (`Game.spawnFountains()` read index 0 as blue, 1 as red) — is gone; the
 * team now rides on the slot's own `faction` field, so the order the map
 * lists its spawn slots in no longer matters. Every fountain gets the same
 * name and the same defaults (tick interval, heal/mana percent) `Fountain`
 * itself falls back to; only position, radius and team come from the map.
 *
 * @param factions The active map's own `MapSummary.factions`, in the order
 *   it declares them — see `teamIdOfFaction`'s doc comment for why this is
 *   what carries the team, not the faction's spelling.
 */
export const fountainsFromSlots = (
  slots: SpawnSlot[],
  factions: readonly Faction[],
  tuning?: MapTuning
): FountainPresetData[] => {
  const presets: FountainPresetData[] = [];
  for (const slot of slots) {
    // Name, tick interval and the two percentages used to be hardcoded here
    // while `Fountain` had accepted all four since it was written — the
    // fields existed and nothing ever passed them. They come from the map now,
    // and `resolveFountainStats(undefined, …)` returns exactly the literals
    // this used to hold, which is why no existing map changes.
    const stats = resolveFountainStats(tuning, slot);
    presets.push({
      name: stats.name,
      x: slot.x,
      y: slot.y,
      r: slot.r,
      teamId: teamIdOfFaction(factions, slot.faction),
      tickInterval: stats.tickInterval,
      healPercent: stats.healPercent,
      manaPercent: stats.manaPercent,
      shopRange: stats.shopRange,
    });
  }
  return presets;
};

export interface TurretPosition {
  x: number;
  y: number;
  /** Absent for a structure slot whose faction `teamIdOfFaction` cannot seat on either team. */
  teamId?: string;
  /**
   * This turret's fully resolved numbers — core's, under the map's, under
   * the slot's own. Always present: `Game.spawnTurrets` used to build every
   * turret with no preset at all, so *every* turret in the engine was
   * `DEFAULT_TURRET_PRESET` and a map had no way to say otherwise.
   */
  preset: TurretPresetData;
}

/**
 * A structure slot's own turret position. Replaces `getTurretPositions()`,
 * which read the two turret rows straight out of `summoner_map.json` through
 * a synchronous `AssetManager.get('json_summoner_map')` — a second hard-coded
 * coupling to the map file, on top of the asset key itself. Turrets now come
 * from the active map's own `slots.structure`, already resolved to `{x, y}`
 * points with a `faction` by `summonersRiftGeometry.ts`.
 *
 * `slot.kind` is always `'turret'` here: `validate.ts` refuses to install a
 * pack whose `structure` slots carry any other kind (`STRUCTURE_KINDS` is
 * `['turret']` today), so this loop does not defend against a kind that can
 * never arrive.
 *
 * @param factions The active map's own `MapSummary.factions` — see
 *   `teamIdOfFaction`'s doc comment.
 */
export const turretsFromSlots = (
  slots: StructureSlot[],
  factions: readonly Faction[],
  tuning?: MapTuning
): TurretPosition[] => {
  const positions: TurretPosition[] = [];
  for (const slot of slots) {
    positions.push({
      x: slot.x,
      y: slot.y,
      teamId: teamIdOfFaction(factions, slot.faction),
      preset: resolveTurretPreset(tuning, slot),
    });
  }
  return positions;
};

export interface MinionMusterPoint {
  /** Absent for a minion slot whose faction `teamIdOfFaction` cannot seat on either team. */
  teamId?: string;
  lane: string;
  x: number;
  y: number;
  /** `MinionSlot.scatter`, or 0 for a slot that declared none. */
  scatter: number;
  /**
   * This point's own wave formation, or absent to use the map's.
   *
   * `readonly string[]` and not `string[]`: an **empty** array is a real
   * declaration — this point forms up nothing — and it must survive the trip
   * distinguishable from absent. See `MinionSlot.stats`.
   */
  composition?: readonly string[];
}

/**
 * A minion slot's own muster point, teamId-bridged the same way
 * `fountainsFromSlots`/`turretsFromSlots` bridge theirs. Where a wave for
 * `(teamId, lane)` forms up — `MinionSpawner.musterPoint` is the reader.
 *
 * `validate.ts` refuses to install a map missing a slot for a lane one of
 * its declared factions walks, so by the time this runs on an installed
 * pack's map every lane a match actually queues waves for already has one.
 *
 * @param factions The active map's own `MapSummary.factions` — see
 *   `teamIdOfFaction`'s doc comment.
 */
export const minionMusterSlotsFrom = (
  slots: MinionSlot[],
  factions: readonly Faction[]
): MinionMusterPoint[] => {
  const points: MinionMusterPoint[] = [];
  for (const slot of slots) {
    points.push({
      teamId: teamIdOfFaction(factions, slot.faction),
      lane: slot.lane,
      x: slot.x,
      y: slot.y,
      scatter: slot.scatter ?? 0,
      composition: slot.stats?.composition,
    });
  }
  return points;
};
