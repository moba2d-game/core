import type { MonsterTier } from '@/content/ContentPack';
import {
  MINION_STYLES,
  MONSTER_ATTACK_STYLES,
  MONSTER_ROAM_LAYERS,
  MONSTER_TEMPERAMENTS,
  NEUTRAL_KINDS,
  STRUCTURE_KINDS,
  type ContentPack,
  type ContentPackCode,
  type ContentPackData,
  type MinionStyle,
  type MonsterAttackStyle,
  type MonsterTemperament,
  type NeutralKind,
  type StructureKind,
} from './ContentPack';

/**
 * The boundary check, hand-written and dependency-free.
 *
 * Every rule here exists because the engine's own failure for it is silent.
 * `TerrainMap` drops a terrain layer it does not recognise without a word;
 * a lane naming a faction nobody declared walks minions to `undefined`; a
 * lane with no declared muster point for one of its factions is a wave with
 * nowhere to form up — `MinionSpawner.musterPointFor` used to answer that
 * with `null` and drop the whole wave into the fountain, silently, until it
 * walked back out (Task 6 deleted that fallback; now it is this file that
 * refuses the map). Each of those surfaces as a broken match some minutes
 * in. Named at load, they are a sentence.
 */
import { ITEM_STAT_KEYS } from '@/game/items/itemStats';

/** `ITEM_STAT_KEYS` as a set — see `checkItems`. */
const GRANTABLE_STATS = new Set<string>(ITEM_STAT_KEYS);

export type ValidationResult = { ok: true; pack: ContentPack } | { ok: false; errors: string[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isStringArray = (value: unknown): value is string[] => {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (typeof item !== 'string') return false;
  }
  return true;
};

/** Bare identifier: the pack id becomes a prefix, so a colon is ambiguous. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkManifest(value: unknown, errors: string[]): void {
  if (!isObject(value)) {
    errors.push('manifest: missing');
    return;
  }
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) {
    errors.push(`manifest.id: must be a bare identifier, got ${JSON.stringify(value.id)}`);
  }
  if (typeof value.version !== 'string') errors.push('manifest.version: must be a string');
  if (typeof value.coreRange !== 'string') errors.push('manifest.coreRange: must be a string');
  if (value.assets !== undefined && typeof value.assets !== 'string') {
    errors.push('manifest.assets: must be a string when present');
  }
  if (value.name !== undefined && typeof value.name !== 'string') {
    errors.push('manifest.name: must be a string when present');
  }
}

function checkSpells(pack: Record<string, unknown>, errors: string[]): void {
  if (pack.spells === undefined) return;
  if (!isObject(pack.spells)) {
    errors.push('spells: must be an object');
    return;
  }
  for (const [id, value] of Object.entries(pack.spells)) {
    // A spell class is a constructor; a spell loader is a thunk returning a
    // promise of one. The success path casts this object to
    // Record<string, SpellSource>, and both arms of that union are
    // functions — a class is itself a function — so this one check already
    // accepts either without needing to tell them apart. Only PackRegistry
    // cares which arm it got, at resolution time.
    if (typeof value !== 'function') {
      errors.push(`spells.${id}: must be a class (constructor function)`);
    }
  }
}

/**
 * `ContentPackCode.monsterAbilities` — the code half `MonsterBody`'s own doc
 * comment points to. Structural, not deep: `cast` is a real closure over a
 * pack's `ContentApi`, so the only thing checkable here without invoking it
 * is that it is a function at all — the same shallow-but-real discipline
 * `checkSpells` applies to a spell class/loader.
 */
/**
 * `ContentPackCode.championAI` — a pack's per-champion bot opinions. Shallow,
 * like `checkMonsterAbilities`: each entry is an object whose hooks, where
 * present, are functions. When the candidate carries `champions` too (the
 * whole-pack path), every key must name one of them — the split path makes
 * the same cross-check in `PackRegistry.verifyPairing`.
 */
const CHAMPION_AI_HOOKS = ['scoreSpell', 'aim', 'posture', 'onCast'] as const;

function checkChampionAI(pack: Record<string, unknown>, errors: string[]): void {
  if (pack.championAI === undefined) return;
  if (!isObject(pack.championAI)) {
    errors.push('championAI: must be an object');
    return;
  }
  // A loop, not `.filter(isObject).map(...)`: this project's `filter` polyfill
  // typing cannot narrow (see `src/types/global.d.ts`).
  let championIds: Set<string> | null = null;
  if (Array.isArray(pack.champions)) {
    championIds = new Set<string>();
    for (const entry of pack.champions as unknown[]) {
      if (isObject(entry) && typeof entry.id === 'string') championIds.add(entry.id);
    }
  }
  for (const [id, value] of Object.entries(pack.championAI)) {
    if (!isObject(value)) {
      errors.push(`championAI.${id}: must be an object`);
      continue;
    }
    for (const hook of CHAMPION_AI_HOOKS) {
      if (value[hook] !== undefined && typeof value[hook] !== 'function') {
        errors.push(`championAI.${id}.${hook}: must be a function`);
      }
    }
    if (championIds && !championIds.has(id)) {
      errors.push(`championAI.${id}: no champion named ${id} in this pack`);
    }
  }
}

function checkMonsterAbilities(pack: Record<string, unknown>, errors: string[]): void {
  if (pack.monsterAbilities === undefined) return;
  if (!isObject(pack.monsterAbilities)) {
    errors.push('monsterAbilities: must be an object');
    return;
  }
  for (const [id, value] of Object.entries(pack.monsterAbilities)) {
    if (!Array.isArray(value) || value.length === 0) {
      errors.push(`monsterAbilities.${id}: must be a non-empty array`);
      continue;
    }
    value.forEach((ability, index) => {
      const path = `monsterAbilities.${id}[${index}]`;
      if (!isObject(ability)) {
        errors.push(`${path}: must be an object`);
        return;
      }
      if (typeof ability.name !== 'string') errors.push(`${path}.name: must be a string`);
      if (!isFiniteNumber(ability.cooldownMs)) {
        errors.push(`${path}.cooldownMs: must be a finite number`);
      }
      if (typeof ability.cast !== 'function') {
        errors.push(`${path}.cast: must be a function`);
      }
    });
  }
}

function checkChampions(pack: Record<string, unknown>, errors: string[]): void {
  if (pack.champions === undefined) return;
  if (!Array.isArray(pack.champions)) {
    errors.push('champions: must be an array');
    return;
  }
  // `pack.spells` is absent, not empty, when only the data half is being
  // validated (`validatePackData` — a `ContentPackData` has no `spells` key
  // at all) — the code half has not arrived yet, so there is nothing to
  // cross-check a champion's ability ids against, and skipping the check
  // here is not a hole: `install()` still validates the merged pack, spells
  // included, before either half is written. A *present* `spells: {}` (a
  // pack that truly declares none) still fails every reference below, same
  // as before the split.
  const spellsProvided = pack.spells !== undefined;
  const spells = isObject(pack.spells) ? pack.spells : {};
  for (const entry of pack.champions) {
    if (!isObject(entry) || typeof entry.id !== 'string') {
      errors.push('champions[]: each entry needs a string id');
      continue;
    }
    if (typeof entry.name !== 'string') {
      errors.push(`champions.${entry.id}.name: must be a string`);
    }
    if (entry.image !== null && typeof entry.image !== 'string') {
      errors.push(`champions.${entry.id}.image: must be a string or null`);
    }
    if (typeof entry.playable !== 'boolean') {
      errors.push(`champions.${entry.id}.playable: must be a boolean`);
    } else if (entry.playable) {
      // What `listSelectableChampions` and `PLAYABLE_CHAMPION_KITS` have
      // always meant by "pickable": a portrait and all four of Q/W/E/R.
      if (typeof entry.image !== 'string' || entry.image.length === 0) {
        errors.push(`champions.${entry.id}: playable champion needs a portrait (image)`);
      }
      if (!Array.isArray(entry.spells) || entry.spells.length !== 4) {
        errors.push(`champions.${entry.id}: playable champion needs exactly four abilities`);
      }
    }
    if (entry.attack !== undefined) {
      if (!isObject(entry.attack)) {
        errors.push(`champions.${entry.id}.attack: must be an object`);
      } else {
        for (const field of ['damage', 'attacksPerSecond', 'range'] as const) {
          if (!isFiniteNumber(entry.attack[field])) {
            errors.push(`champions.${entry.id}.attack.${field}: must be a finite number`);
          }
        }
        // Optional, but not free-form: a zero or negative missile speed is a
        // bolt that never arrives, which plays as an attack that silently
        // deals no damage.
        if (
          entry.attack.boltUnitsPerSecond !== undefined &&
          (!isFiniteNumber(entry.attack.boltUnitsPerSecond) || entry.attack.boltUnitsPerSecond <= 0)
        ) {
          errors.push(
            `champions.${entry.id}.attack.boltUnitsPerSecond: must be a positive finite number`
          );
        }
      }
    }
    checkChampionTrail(`champions.${entry.id}`, entry.trail, errors);
    if (entry.defence !== undefined) {
      if (!isObject(entry.defence)) {
        errors.push(`champions.${entry.id}.defence: must be an object`);
      } else {
        // Every field optional — a pack may raise health alone and leave the
        // resistances to core's default, which is the smallest useful step.
        // Present and unreadable is still an error: a `NaN` health pool is a
        // champion whose bar never draws and who cannot be damaged or killed.
        for (const field of ['health', 'healthRegen', 'armor', 'magicResist'] as const) {
          const value = entry.defence[field];
          if (value !== undefined && !isFiniteNumber(value)) {
            errors.push(`champions.${entry.id}.defence.${field}: must be a finite number`);
          }
        }
        // A pool is the one field with a floor. Zero health is a champion that
        // is dead on the frame it spawns, and negative is worse — nothing in
        // the damage path ever brings it back above zero, so it respawns into
        // the same state for the whole match. Resistances are deliberately not
        // checked this way: negative is meaningful there (shred), and
        // `combat/Mitigation.ts` mirrors its own curve to stay safe at any
        // depth.
        if (entry.defence.health !== undefined && (entry.defence.health as number) <= 0) {
          errors.push(`champions.${entry.id}.defence.health: must be greater than zero`);
        }
      }
    }
    if (!Array.isArray(entry.spells)) {
      errors.push(`champions.${entry.id}.spells: must be an array`);
      continue;
    }
    for (const id of entry.spells) {
      if (typeof id !== 'string') {
        errors.push(`champions.${entry.id}.spells: ids must be strings`);
      } else if (spellsProvided && !(id in spells)) {
        errors.push(`champions.${entry.id}: spell ${id} is not in this pack`);
      }
    }
    if (entry.passive !== undefined) {
      if (typeof entry.passive !== 'string') {
        errors.push(`champions.${entry.id}.passive: must be a string`);
      } else if (spellsProvided && !(entry.passive in spells)) {
        errors.push(`champions.${entry.id}: passive ${entry.passive} is not in this pack`);
      } else if (entry.spells?.includes?.(entry.passive)) {
        // Both a passive *and* a kit slot is two instances of one spell on one
        // champion, one of them armed by core and one bound to a key. The
        // player then sees the same icon twice and only one of them does
        // anything the tooltip describes.
        errors.push(
          `champions.${entry.id}: passive ${entry.passive} is also in the kit; it must be one or the other`
        );
      }
    }
    if (entry.recall !== undefined) {
      if (typeof entry.recall !== 'string') {
        errors.push(`champions.${entry.id}.recall: must be a string`);
      } else if (spellsProvided && !(entry.recall in spells)) {
        errors.push(`champions.${entry.id}: recall ${entry.recall} is not in this pack`);
      }
    }
  }
}

const SPELL_DISPLAY_FIELDS: Record<string, 'string' | 'number' | 'string-or-null'> = {
  name: 'string',
  description: 'string',
  iconKey: 'string-or-null',
  coolDownMs: 'number',
  manaCost: 'number',
  specCoolDownMs: 'number',
};

function checkSpellDisplay(pack: Record<string, unknown>, errors: string[]): void {
  if (pack.spellDisplay === undefined) return;
  if (!isObject(pack.spellDisplay)) {
    errors.push('spellDisplay: must be an object');
    return;
  }
  // See `checkChampions`'s identical guard: an absent `spells` key means only
  // the data half is being validated, and there is nothing yet to check a
  // display entry's id against.
  const spellsProvided = pack.spells !== undefined;
  const spells = isObject(pack.spells) ? pack.spells : {};
  for (const [id, value] of Object.entries(pack.spellDisplay)) {
    if (spellsProvided && !(id in spells)) {
      errors.push(`spellDisplay.${id}: no spell named ${id} in this pack`);
    }
    if (!isObject(value)) {
      errors.push(`spellDisplay.${id}: must be an object`);
      continue;
    }
    for (const [field, kind] of Object.entries(SPELL_DISPLAY_FIELDS)) {
      const fieldValue = value[field];
      const ok =
        kind === 'string'
          ? typeof fieldValue === 'string'
          : kind === 'number'
            ? isFiniteNumber(fieldValue)
            : fieldValue === null || typeof fieldValue === 'string';
      if (!ok) {
        errors.push(`spellDisplay.${id}.${field}: must be a ${kind}`);
      }
    }
  }
}

/**
 * An item, as a pack declares it.
 *
 * Two of these checks close a silent failure rather than a loud one, which is
 * the whole argument for this file existing:
 *
 *   - a `stats` key that is not on `ITEM_STAT_KEYS` grants nothing, for ever,
 *     with nothing anywhere to look at. `modifierFor` skips it deliberately —
 *     reaching that branch at runtime means core and this validator disagree.
 *   - a `passive`/`active` naming a spell the pack does not ship builds an
 *     item whose whole point never happens, and the player is simply out the
 *     gold.
 *
 * The `health`/`mana`/`size` exclusion is not pedantry: those are current
 * pools and the body, so an item granting one would top a champion up on
 * equip and **take it back on sale**, which is a shop that can kill you. See
 * `ITEM_STAT_KEYS`.
 */
/**
 * The roles a hand-built kit may pick from.
 *
 * Core never names one — a taxonomy is the roster's vocabulary — so the only
 * things worth checking are that a picker can render the list and that a saved
 * choice can find its way back:
 *
 *   - a **duplicate or missing `id`** is a stored loadout that resolves to the
 *     wrong role, or to none, and the player's kit silently changes body
 *     between sessions;
 *   - a **missing `name`** is a blank row in the picker;
 *   - a **malformed profile** is the same failure `checkChampions` guards for a
 *     champion, one screen earlier.
 */
function checkArchetypes(pack: Record<string, unknown>, errors: string[]): void {
  if (pack.archetypes === undefined) return;
  if (!Array.isArray(pack.archetypes)) {
    errors.push('archetypes: must be an array');
    return;
  }
  const seen = new Set<string>();
  for (const [index, value] of pack.archetypes.entries()) {
    const path = `archetypes[${index}]`;
    if (!isObject(value)) {
      errors.push(`${path}: must be an object`);
      continue;
    }
    const entry = value as Record<string, unknown>;
    const id = entry.id;
    if (typeof id !== 'string' || id.length === 0) {
      errors.push(`${path}.id: must be a non-empty string`);
    } else if (seen.has(id)) {
      errors.push(`${path}.id: "${id}" is declared twice`);
    } else {
      seen.add(id);
    }
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      errors.push(`${path}.name: must be a non-empty string`);
    }
    if (!isObject(entry.attack)) {
      errors.push(`${path}.attack: must be an object`);
    } else {
      for (const field of ['damage', 'attacksPerSecond', 'range'] as const) {
        if (!isFiniteNumber((entry.attack as Record<string, unknown>)[field])) {
          errors.push(`${path}.attack.${field}: must be a finite number`);
        }
      }
    }
    if (!isObject(entry.defence)) {
      errors.push(`${path}.defence: must be an object`);
    } else {
      const defence = entry.defence as Record<string, unknown>;
      for (const field of ['health', 'healthRegen', 'armor', 'magicResist'] as const) {
        if (defence[field] !== undefined && !isFiniteNumber(defence[field])) {
          errors.push(`${path}.defence.${field}: must be a finite number`);
        }
      }
      if (defence.health !== undefined && (defence.health as number) <= 0) {
        errors.push(`${path}.defence.health: must be greater than zero`);
      }
    }
  }
}

function checkItems(pack: Record<string, unknown>, errors: string[]): void {
  if (pack.items === undefined) return;
  if (!isObject(pack.items)) {
    errors.push('items: must be an object');
    return;
  }
  // See `checkChampions`'s identical guard: an absent `spells` key means only
  // the data half is on the table, so there is nothing yet to resolve an
  // item's spell ids against. `install()` still validates the merged pack.
  const spellsProvided = pack.spells !== undefined;
  const spells = isObject(pack.spells) ? pack.spells : {};

  /**
   * Gathered as the loop runs and checked after it, because every question
   * worth asking about a recipe needs the *other* items to answer: does this
   * id name anything, does the graph cycle, do the parts add up. Only entries
   * that passed their own checks go in — an item with a broken `cost` would
   * otherwise earn a second, more confusing error about arithmetic.
   */
  const costs = new Map<string, number>();
  const recipes = new Map<string, string[]>();

  for (const [key, value] of Object.entries(pack.items)) {
    const path = `items.${key}`;
    if (!isObject(value)) {
      errors.push(`${path}: must be an object`);
      continue;
    }
    // The map key is what everything else looks this item up by, so an `id`
    // saying something else is two names for one thing.
    if (value.id !== key) {
      errors.push(`${path}.id: must equal its key, got ${JSON.stringify(value.id)}`);
    }
    if (typeof value.name !== 'string') errors.push(`${path}.name: must be a string`);
    if (typeof value.icon !== 'string') {
      errors.push(`${path}.icon: must be a string — an item with no icon is unbuyable`);
    }
    if (!isFiniteNumber(value.cost) || (value.cost as number) < 0) {
      errors.push(`${path}.cost: must be a number of 0 or more`);
    } else {
      costs.set(key, value.cost as number);
    }

    if (value.buildsFrom !== undefined) {
      if (!Array.isArray(value.buildsFrom)) {
        errors.push(`${path}.buildsFrom: must be an array of item ids`);
      } else if (value.buildsFrom.some(entry => typeof entry !== 'string')) {
        errors.push(`${path}.buildsFrom: every entry must be an item id`);
      } else {
        recipes.set(key, value.buildsFrom as string[]);
      }
    }
    if (value.description !== undefined && typeof value.description !== 'string') {
      errors.push(`${path}.description: must be a string when present`);
    }

    if (value.stats !== undefined) {
      if (!isObject(value.stats)) {
        errors.push(`${path}.stats: must be an object`);
      } else {
        for (const [statKey, amount] of Object.entries(value.stats)) {
          if (!GRANTABLE_STATS.has(statKey)) {
            errors.push(`${path}.stats.${statKey}: not a stat an item may grant`);
          }
          if (!isFiniteNumber(amount)) {
            errors.push(`${path}.stats.${statKey}: must be a finite number`);
          }
        }
      }
    }

    for (const slot of ['passive', 'active'] as const) {
      const spellId = value[slot];
      if (spellId === undefined) continue;
      if (typeof spellId !== 'string') {
        errors.push(`${path}.${slot}: must be a string`);
        continue;
      }
      if (spellsProvided && !(spellId in spells)) {
        errors.push(`${path}: ${slot} ${spellId} is not in this pack`);
      }
    }
  }
  checkRecipes(costs, recipes, errors);
}

/**
 * The three questions a recipe can only be asked once every item is on the
 * table, all of which fail *silently* at runtime if they go unasked.
 *
 * **An id naming nothing** is a component `ItemShop.componentSlotsFor` can
 * never match, so the item quietly costs full price for ever and the build
 * path the author drew does not exist.
 *
 * **A cycle** is an item that is its own ancestor. Nothing hangs — the shop
 * only ever looks one level down — but no sequence of purchases can complete
 * it, which is a build path that is unreachable rather than merely wrong.
 *
 * **A total under the sum of its parts** wants a negative price out of
 * `priceFor`, which is `Wallet.spend` handing gold *out*. Core floors it at
 * zero rather than trusting this check, but a floored price is still a number
 * the author did not mean to write, and this is the only place that can say so.
 */
function checkRecipes(
  costs: Map<string, number>,
  recipes: Map<string, string[]>,
  errors: string[]
): void {
  for (const [id, parts] of recipes) {
    let sum = 0;
    let priceable = true;
    for (const part of parts) {
      if (!costs.has(part)) {
        errors.push(`items.${id}.buildsFrom: ${part} is not an item in this pack`);
        priceable = false;
        continue;
      }
      sum += costs.get(part) as number;
    }
    // Skipped when a part is missing: its price is unknown, so the sum is not
    // a real number and reporting it would be a second error about the first.
    if (priceable && (costs.get(id) ?? 0) < sum) {
      errors.push(
        `items.${id}.cost: ${costs.get(id)} is under the ${sum} its parts cost — ` +
          '`cost` is the total, so combining would pay the player'
      );
    }
  }

  // Iterative walk with an explicit stack, not recursion: a deep build path is
  // a legal pack and a pack is a stranger's JSON, so the depth is not ours to
  // bound.
  //
  // The `'open'` test below is not only how a cycle is *reported* — it is the
  // loop's termination condition. Weakening it does not produce a missed
  // error, it produces a hang: measured, by mutating it to `'done'` and
  // watching this file's own cycle case run the worker out of heap.
  const state = new Map<string, 'open' | 'done'>();
  const walk = (start: string): void => {
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const parts = recipes.get(frame.id) ?? [];
      if (frame.next === 0) {
        if (state.get(frame.id) === 'done') {
          stack.pop();
          continue;
        }
        state.set(frame.id, 'open');
      }
      if (frame.next >= parts.length) {
        state.set(frame.id, 'done');
        stack.pop();
        continue;
      }
      const part = parts[frame.next++];
      if (state.get(part) === 'open') {
        errors.push(`items.${part}.buildsFrom: builds out of itself, through ${frame.id}`);
        state.set(part, 'done');
        continue;
      }
      if (state.get(part) !== 'done' && recipes.has(part)) stack.push({ id: part, next: 0 });
    }
  };
  for (const id of recipes.keys()) {
    if (!state.has(id)) walk(id);
  }
}

/** One `MonsterBody` entry of a `monsters.<id>.members` array. */
function checkMonsterBody(path: string, value: unknown, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  if (typeof value.name !== 'string') errors.push(`${path}.name: must be a string`);
  // A body's own asset key, never validated against core's generated union —
  // same shape as `checkChampions`'s `image` check, but not nullable: unlike
  // a champion shelf entry, a jungle body with no art is not a real shape.
  if (typeof value.avatar !== 'string') errors.push(`${path}.avatar: must be a string`);
  if (!isFiniteNumber(value.speed)) errors.push(`${path}.speed: must be a finite number`);
  if (!isFiniteNumber(value.size)) errors.push(`${path}.size: must be a finite number`);
  if (!isFiniteNumber(value.attackRange)) {
    errors.push(`${path}.attackRange: must be a finite number`);
  }
  if (!isFiniteNumber(value.reviveTime)) {
    errors.push(`${path}.reviveTime: must be a finite number`);
  }
  if (!isFiniteNumber(value.health)) errors.push(`${path}.health: must be a finite number`);
  if (
    !isObject(value.offset) ||
    !isFiniteNumber(value.offset.x) ||
    !isFiniteNumber(value.offset.y)
  ) {
    errors.push(`${path}.offset: must be {x, y} finite numbers`);
  }
  checkMonsterBehaviour(path, value, errors);
}

/**
 * The three optional behaviour fields, checked by vocabulary rather than by
 * shape alone.
 *
 * Each one's failure is silent in a way `tsc` cannot see, because a published
 * pack is JSON by the time it gets here: a misspelled temperament reads as
 * "not aggressive" at every comparison in `Monster`, so the camp installs
 * fine and then stands there while you kill it. `roam` is worse — an
 * unrecognised `kind` falls through to the camp circle, which *works*, so a
 * river crab silently becomes an ordinary one and nobody finds out until they
 * wonder why it never swims.
 */
/**
 * The one vocabulary both a `MonsterBody` and a map's own slot may name, so
 * both call this rather than repeating the message.
 */
function checkAttackStyle(path: string, value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!MONSTER_ATTACK_STYLES.includes(value as MonsterAttackStyle)) {
    errors.push(
      `${path}.attackStyle: unknown ${JSON.stringify(value)}; ` +
        `core provides ${MONSTER_ATTACK_STYLES.join(', ')}`
    );
  }
}

/**
 * A creature rig — legs, and optionally a body drawn instead of a sprite.
 *
 * Checked rather than trusted for the same reason the vocabularies above are:
 * a bad rig does not throw, it draws something wrong on every frame of the
 * match. An odd `count` limps, a negative `reach` turns the legs inside out,
 * and a `bend` core does not know silently becomes the one it does.
 *
 * Named per field, because "invalid rig" on a pack with nine camps is not an
 * error message, it is a search.
 */
function checkCreatureRig(path: string, value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!isObject(value)) {
    errors.push(`${path}.rig: must be an object`);
    return;
  }

  const { body, legs } = value;

  if (body !== undefined && body !== 'avatar') {
    if (!isObject(body) || (body.kind !== 'orb' && body.kind !== 'chain')) {
      errors.push(`${path}.rig.body: must be 'avatar', { kind: 'orb' } or { kind: 'chain' }`);
    } else {
      checkColor(`${path}.rig.body`, 'color', body.color, errors);
      if (body.glow !== undefined && !isFiniteNumber(body.glow)) {
        errors.push(`${path}.rig.body.glow: must be a finite number`);
      }
      if (body.kind === 'chain') checkSpine(path, body, errors);
    }
  }

  if (legs === undefined) return;
  if (!isObject(legs)) {
    errors.push(`${path}.rig.legs: must be an object`);
    return;
  }

  // Type only, never range. Every number in a rig is clamped by `resolveRig`
  // (odd counts down to a pair, a nonsense reach back to the default), and
  // refusing one instead used to take the whole map down with it: a `7` typed
  // into the editor's leg count failed here, `localMaps.keepValid` dropped the
  // map, and the playtest the player had just started fell back to the menu.
  //
  // A number out of range has one obvious repair, so it is taken. A word core
  // does not know has none, so it is still refused — see `bend` below.
  for (const key of ['count', 'reach', 'step', 'spread', 'thickness'] as const) {
    const own = legs[key];
    if (own === undefined) continue;
    if (!isFiniteNumber(own)) {
      errors.push(`${path}.rig.legs.${key}: must be a number`);
    }
  }

  if (legs.bend !== undefined && legs.bend !== 'up' && legs.bend !== 'down') {
    errors.push(
      `${path}.rig.legs.bend: unknown ${JSON.stringify(legs.bend)}; core provides up, down`
    );
  }

  checkColor(`${path}.rig.legs`, 'color', legs.color, errors);

  if (legs.on !== undefined && !isNumberArray(legs.on)) {
    errors.push(`${path}.rig.legs.on: must be a list of vertebra numbers`);
  }
}

const isNumberArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every(isFiniteNumber);

/**
 * A segmented body. Shape is checked, range is not — `resolveRig` clamps a
 * spine that is too short, a width that went negative and a bend past a right
 * angle, for the same reason it clamps a leg count: a number nobody can draw
 * must not cost somebody their map.
 */
function checkSpine(path: string, body: Record<string, unknown>, errors: string[]): void {
  if (!isNumberArray(body.widths)) {
    errors.push(
      `${path}.rig.body.widths: must be a list of numbers, one per vertebra — ` +
        `it is the list that gives the body its shape`
    );
  }
  for (const key of ['spacing', 'bend'] as const) {
    if (body[key] !== undefined && !isFiniteNumber(body[key])) {
      errors.push(`${path}.rig.body.${key}: must be a number`);
    }
  }
}

/**
 * A champion's cosmetic tail.
 *
 * Shape only, and `widths` is the one thing that has to be there: it is the
 * list that says how many vertebrae there are, so a trail without it is not a
 * trail that is too short, it is a trail nobody described. Everything numeric
 * beside it is clamped by `resolveRig` on the way in — the same line every rig
 * in this file takes, and for the same reason a leg count of 7 must not cost
 * anybody their map.
 */
function checkChampionTrail(path: string, value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!isObject(value)) {
    errors.push(`${path}.trail: must be an object`);
    return;
  }
  if (!isNumberArray(value.widths)) {
    errors.push(
      `${path}.trail.widths: must be a list of numbers, one per vertebra — ` +
        `it is the list that gives the tail its shape`
    );
  }
  for (const key of ['spacing', 'bend', 'glow'] as const) {
    if (value[key] !== undefined && !isFiniteNumber(value[key])) {
      errors.push(`${path}.trail.${key}: must be a number`);
    }
  }
  checkColor(`${path}.trail`, 'color', value.color, errors);
}

/** `[r, g, b]`, the shape `attackColor` has always taken. Always optional. */
function checkColor(path: string, key: string, value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length !== 3 || !value.every(isFiniteNumber)) {
    errors.push(`${path}.${key}: must be [r, g, b]`);
  }
}

function checkMonsterBehaviour(
  path: string,
  value: Record<string, unknown>,
  errors: string[]
): void {
  if (
    value.temperament !== undefined &&
    !MONSTER_TEMPERAMENTS.includes(value.temperament as MonsterTemperament)
  ) {
    errors.push(
      `${path}.temperament: unknown ${JSON.stringify(value.temperament)}; ` +
        `core provides ${MONSTER_TEMPERAMENTS.join(', ')}`
    );
  }

  for (const key of ['ephemeral', 'anchored'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      errors.push(`${path}.${key}: must be a boolean`);
    }
  }

  checkAttackStyle(path, value.attackStyle, errors);
  checkCreatureRig(path, value.rig, errors);

  for (const key of ['chaseMargin', 'giveUpDelayMs', 'regenDelayMs', 'wanderSpeed'] as const) {
    if (value[key] !== undefined && !isFiniteNumber(value[key])) {
      errors.push(`${path}.${key}: must be a finite number`);
    }
  }

  if (value.attackColor !== undefined) {
    const color = value.attackColor;
    if (!Array.isArray(color) || color.length !== 3 || !color.every(isFiniteNumber)) {
      errors.push(`${path}.attackColor: must be [r, g, b] finite numbers`);
    }
  }

  if (value.roam === undefined) return;
  if (!isObject(value.roam)) {
    errors.push(`${path}.roam: must be an object`);
    return;
  }
  const roam = value.roam;
  if (roam.kind === 'camp') {
    return;
  }
  if (roam.kind !== 'terrain') {
    errors.push(
      `${path}.roam.kind: unknown ${JSON.stringify(roam.kind)}; core provides camp, terrain`
    );
    return;
  }
  if (!MONSTER_ROAM_LAYERS.includes(roam.layer as 'water' | 'bush')) {
    errors.push(
      `${path}.roam.layer: unknown ${JSON.stringify(roam.layer)}; ` +
        `core provides ${MONSTER_ROAM_LAYERS.join(', ')}`
    );
  }
}

/** `MonsterDef.tier`'s two words. See `MonsterTier`. */
export const MONSTER_TIERS: readonly MonsterTier[] = Object.freeze(['camp', 'epic']);

function checkMonsters(pack: Record<string, unknown>, errors: string[]): void {
  if (pack.monsters === undefined) return;
  if (!isObject(pack.monsters)) {
    errors.push('monsters: must be an object');
    return;
  }
  for (const [id, value] of Object.entries(pack.monsters)) {
    if (!isObject(value)) {
      errors.push(`monsters.${id}: must be an object`);
      continue;
    }
    if (typeof value.id !== 'string') errors.push(`monsters.${id}.id: must be a string`);
    if (typeof value.name !== 'string') errors.push(`monsters.${id}.name: must be a string`);
    // PackRegistry.install() and monstersFilling(role) both call
    // monster.fills.includes(role); a non-array fills is a runtime
    // TypeError one layer downstream instead of a named error here.
    if (!isStringArray(value.fills)) {
      errors.push(`monsters.${id}: fills must be an array of strings`);
    }
    if (value.tier !== undefined && !MONSTER_TIERS.includes(value.tier as MonsterTier)) {
      errors.push(`monsters.${id}.tier: must be one of ${MONSTER_TIERS.join(', ')}`);
    }
    // `Game.spawnJungle()` loops `members` unconditionally; an empty array
    // is a camp that fills its slot with nothing, the same silent-failure
    // shape this file exists to catch named rather than left to surface as
    // an empty jungle later.
    if (!Array.isArray(value.members) || value.members.length === 0) {
      errors.push(`monsters.${id}.members: must be a non-empty array`);
      continue;
    }
    value.members.forEach((member, index) => {
      checkMonsterBody(`monsters.${id}.members[${index}]`, member, errors);
    });
  }
}

/**
 * The heavy half — terrain, slots, lanes. `checkMap` below calls this only
 * when `geometry` arrived as a plain object, because a loader's body cannot
 * be inspected synchronously (see `checkSpells`'s identical treatment of a
 * `SpellSource` loader) — a lazy map's geometry goes unchecked at
 * `checkMap` time. It is **not** unchecked forever: exported so
 * `PackRegistry.loadMapGeometry` can call it again, against the resolved
 * object, the moment a loader settles — both shipped maps
 * (`summonersRift`, `referenceMap`) use loaders, so without that second
 * call this function's whole terrain/slot/lane half never ran on either of
 * them in production.
 */
/**
 * A bag of optional non-negative numbers, checked against a closed key list.
 *
 * **Unknown keys are errors, not noise.** That is the whole reason this is
 * strict: a map author who writes `attackRnage` and gets silence has a turret
 * that quietly kept core's range and no way at all to find out. It is the same
 * stance `checkMapGeometry` already takes on an unknown terrain layer, for the
 * same reason — the engine's own failure for both is to ignore it.
 *
 * Non-negative because every field these bags hold is a duration, a distance,
 * a size, a rate or a multiplier, and none of those has a meaning below zero.
 * A negative interval is a turret that fires every frame.
 */
function checkNumberBag(
  path: string,
  value: unknown,
  allowed: readonly string[],
  errors: string[]
): void {
  if (!isObject(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.includes(key)) {
      errors.push(`${path}.${key}: unknown; core provides ${allowed.join(', ')}`);
      continue;
    }
    if (!isFiniteNumber(entry)) {
      errors.push(`${path}.${key}: must be a finite number`);
    } else if (entry < 0) {
      errors.push(`${path}.${key}: must not be negative`);
    }
  }
}

const TURRET_STAT_KEYS = [
  'health',
  'size',
  'attackRange',
  'attackInterval',
  'damage',
  'rebuildTime',
  'repairDelay',
  'repairRate',
] as const;

const FOUNTAIN_NUMBER_KEYS = [
  'tickInterval',
  'healPercent',
  'manaPercent',
  'shopRange',
] as const;

const MONSTER_SCALE_KEYS = [
  'healthMult',
  'damageMult',
  'speedMult',
  'attackIntervalMult',
  'aggroRangeMult',
  'reviveTimeMult',
] as const;

const MONSTER_MAP_KEYS = [
  ...MONSTER_SCALE_KEYS,
  'chaseMargin',
  'giveUpDelayMs',
  'regenDelayMs',
] as const;

const MONSTER_SLOT_NUMBER_KEYS = [
  ...MONSTER_SCALE_KEYS,
  'health',
  'damage',
  'attackRange',
  'aggroRange',
  'reviveTime',
  'chaseMargin',
] as const;

/** `fountain` and a spawn slot's `stats`: numbers, plus an optional name. */
function checkFountainStats(path: string, value: unknown, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  const { name, ...numbers } = value;
  if (name !== undefined && typeof name !== 'string') {
    errors.push(`${path}.name: must be a string`);
  }
  checkNumberBag(path, numbers, FOUNTAIN_NUMBER_KEYS, errors);
}

/** A neutral slot's `stats`: numbers, plus the one behaviour field a map may set. */
function checkMonsterSlotStats(path: string, value: unknown, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  const { temperament, attackStyle, rig, ...numbers } = value;
  if (
    temperament !== undefined &&
    !MONSTER_TEMPERAMENTS.includes(temperament as MonsterTemperament)
  ) {
    errors.push(
      `${path}.temperament: unknown ${JSON.stringify(temperament)}; ` +
        `core provides ${MONSTER_TEMPERAMENTS.join(', ')}`
    );
  }
  checkAttackStyle(path, attackStyle, errors);
  checkCreatureRig(path, rig, errors);
  checkNumberBag(path, numbers, MONSTER_SLOT_NUMBER_KEYS, errors);
}

const MINION_TYPE_NUMBER_KEYS = [
  'speed',
  'size',
  'health',
  'damage',
  'attackInterval',
  'attackRange',
  'aggroRange',
  'goldBounty',
] as const;

const WAVE_NUMBER_KEYS = ['intervalMs', 'firstDelayMs', 'releaseIntervalMs', 'liveCap'] as const;

/**
 * The one tuning group where a map defines new *things*, so it is the one
 * that has to be checked as a whole rather than field by field.
 *
 * A declared type is **all-or-nothing**, unlike every override elsewhere in
 * `MapTuning`: there is no core default for a body nobody has heard of, so a
 * type missing `health` is a minion with no health, not a minion with core's.
 *
 * And a composition is checked against the roster it will actually be
 * resolved against — the map's own if it declared one, core's three
 * otherwise. A wave listing an id nothing can supply spawns nothing, silently
 * and forever.
 */
/**
 * What a map's minion tuning says about its roster and its formations, read
 * without validating anything.
 *
 * Two readers need this and only one of them is the tuning check. The other is
 * `checkMapGeometry`, because **a muster point may field a type nothing else
 * does** (`MinionSlot.stats.composition`), and "is every declared type ever
 * fielded?" therefore stopped being a question the tuning alone can answer.
 */
export interface MinionFormationView {
  /** The roster a composition resolves against — the map's, or core's three. */
  types: ReadonlySet<string>;
  /** Whether the map replaced core's roster. The never-fielded rule is about its types. */
  declaresRoster: boolean;
  /** Type ids the map-wide waves and stages field, before any muster is read. */
  fielded: ReadonlySet<string>;
}

export function minionFormationOf(tuning: unknown): MinionFormationView {
  const minions = isObject(tuning) && isObject(tuning.minions) ? tuning.minions : undefined;
  // `resolveMinionTypes` replaces rather than merges, so a map that declares
  // `grunt` has no `melee` any more — see `checkMinionTuning`'s own comment.
  const declaresRoster = isObject(minions?.types) && Object.keys(minions.types).length > 0;
  const types = new Set<string>(
    declaresRoster ? Object.keys(minions!.types as object) : ['melee', 'ranged', 'cannon']
  );

  const fielded = new Set<string>();
  const waves = isObject(minions?.waves) ? minions.waves : undefined;
  const collect = (list: unknown): void => {
    if (isStringArray(list)) for (const id of list) fielded.add(id);
  };
  collect(waves?.composition);
  if (Array.isArray(waves?.stages)) {
    for (const stage of waves.stages) if (isObject(stage)) collect(stage.composition);
  }
  return { types, declaresRoster, fielded };
}

function checkMinionTuning(path: string, value: unknown, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== 'types' && key !== 'waves') {
      errors.push(`${path}.${key}: unknown; core provides types, waves`);
    }
  }

  /**
   * The roster a wave will actually be resolved against — core's three, or the
   * map's own **instead of** them.
   *
   * `resolveMinionTypes` replaces rather than merges (`MinionTuning.types` says
   * why), so a map that declares `grunt` has no `melee` any more. Seeding this
   * with core's three and then adding to it would let a composition name
   * `melee` on such a map, pass validation, and spawn nothing.
   */
  const declaredTypes = isObject(value.types) && Object.keys(value.types).length > 0;
  const known = new Set<string>(declaredTypes ? [] : ['melee', 'ranged', 'cannon']);
  if (value.types !== undefined) {
    if (!isObject(value.types)) {
      errors.push(`${path}.types: must be an object`);
    } else {
      known.clear();
      for (const [id, def] of Object.entries(value.types)) {
        known.add(id);
        const typePath = `${path}.types.${id}`;
        if (!isObject(def)) {
          errors.push(`${typePath}: must be an object`);
          continue;
        }
        if (typeof def.name !== 'string') errors.push(`${typePath}.name: must be a string`);
        if (def.style !== undefined && !MINION_STYLES.includes(def.style as MinionStyle)) {
          errors.push(
            `${typePath}.style: unknown ${JSON.stringify(def.style)}; ` +
              `core provides ${MINION_STYLES.join(', ')}`
          );
        }
        const { name, style, ...numbers } = def;
        void name;
        void style;
        checkNumberBag(typePath, numbers, MINION_TYPE_NUMBER_KEYS, errors);
        // Every field but `style` and `goldBounty` is required: a declared
        // type has no core default to fall back to.
        for (const key of MINION_TYPE_NUMBER_KEYS) {
          if (key !== 'goldBounty' && def[key] === undefined) {
            errors.push(`${typePath}.${key}: missing`);
          }
        }
      }
    }
  }

  const waves = isObject(value.waves) ? value.waves : undefined;
  if (value.waves !== undefined && !waves) {
    errors.push(`${path}.waves: must be an object`);
    return;
  }

  // The two rules about *which types get fielded* used to live here. They
  // moved to `checkMinionRoster`, which `checkMapGeometry` calls: a muster
  // point may now field a type the map-wide formation never names
  // (`MinionSlot.stats.composition`), so the answer stopped being visible from
  // the tuning alone. See that function for what it costs on a lazily-loaded
  // geometry.
  void declaredTypes;

  if (waves === undefined) return;
  const { composition, stages, ...numbers } = waves;
  checkNumberBag(`${path}.waves`, numbers, WAVE_NUMBER_KEYS, errors);
  checkComposition(`${path}.waves.composition`, composition, known, errors);

  if (stages === undefined) return;
  if (!Array.isArray(stages)) {
    errors.push(`${path}.waves.stages: must be an array`);
    return;
  }
  stages.forEach((stage: unknown, index: number) => {
    const stagePath = `${path}.waves.stages[${index}]`;
    if (!isObject(stage)) {
      errors.push(`${stagePath}: must be an object`);
      return;
    }
    if (!isFiniteNumber(stage.atMs)) errors.push(`${stagePath}.atMs: must be a finite number`);
    const { composition: staged, atMs, ...rest } = stage;
    void atMs;
    checkNumberBag(stagePath, rest, ['intervalMs'], errors);
    checkComposition(`${stagePath}.composition`, staged, known, errors);
  });
}

function checkComposition(
  path: string,
  composition: unknown,
  known: ReadonlySet<string>,
  errors: string[]
): void {
  if (composition === undefined) return;
  if (!isStringArray(composition)) {
    errors.push(`${path}: must be an array of type ids`);
    return;
  }
  for (const id of composition) {
    if (!known.has(id)) {
      errors.push(`${path}: no minion type ${JSON.stringify(id)} is declared`);
    }
  }
}

/**
 * The groups `MapTuning` holds, as a runtime list.
 *
 * Kept beside the checks that walk them rather than derived from the type,
 * which is erased: adding a group to `MapTuning` and forgetting this line
 * makes a real group read as a typo, and the two failing tests that caught
 * exactly that are why it is one constant now instead of an inline literal.
 */
const TUNING_GROUPS = [
  'champions',
  'economy',
  'turrets',
  'fountain',
  'minions',
  'monsters',
  'terrain',
  'vision',
];

/** `MapTuning.vision` — see `VisionTuning`. */
const VISION_KEYS = ['attackRevealMs', 'attackRevealRadius'];

const ECONOMY_KEYS = [
  'startingGold',
  'passiveGoldPerSecond',
  'minionBounty',
  'monsterBounty',
  'championBounty',
  'turretBounty',
  'sellRefund',
  'assistWindowMs',
  'assistGoldShare',
  'killCreditWindowMs',
] as const;

/**
 * A map's own numbers.
 *
 * Every group is optional and an absent one means core's defaults, so the
 * only thing to check is that what a map *did* say is sayable — see
 * `checkNumberBag` for why an unknown key is an error rather than a shrug.
 */
export function checkMapTuning(tuning: unknown, name: string, errors: string[]): void {
  if (!isObject(tuning)) {
    errors.push(`${name}.tuning: must be an object`);
    return;
  }

  for (const group of Object.keys(tuning)) {
    if (!TUNING_GROUPS.includes(group)) {
      errors.push(`${name}.tuning.${group}: unknown; core provides ${TUNING_GROUPS.join(', ')}`);
    }
  }

  if (tuning.champions !== undefined) {
    const path = `${name}.tuning.champions`;
    if (!isObject(tuning.champions)) {
      errors.push(`${path}: must be an object`);
    } else {
      const { reviveCurve, ...rest } = tuning.champions;
      checkNumberBag(
        path,
        rest,
        ['reviveTime', 'healthMult', 'damageMult', 'speedMult'],
        errors
      );
      if (reviveCurve !== undefined) {
        checkNumberBag(`${path}.reviveCurve`, reviveCurve, ['base', 'perMinute', 'max'], errors);
        // Every field of a curve is required — unlike everything else here,
        // there is no sensible half-curve to fall back to.
        if (isObject(reviveCurve)) {
          for (const key of ['base', 'perMinute', 'max']) {
            if (reviveCurve[key] === undefined) {
              errors.push(`${path}.reviveCurve.${key}: missing`);
            }
          }
        }
      }
    }
  }

  if (tuning.economy !== undefined) {
    checkNumberBag(`${name}.tuning.economy`, tuning.economy, ECONOMY_KEYS, errors);
  }
  if (tuning.turrets !== undefined) {
    checkNumberBag(`${name}.tuning.turrets`, tuning.turrets, TURRET_STAT_KEYS, errors);
  }
  if (tuning.fountain !== undefined) {
    checkFountainStats(`${name}.tuning.fountain`, tuning.fountain, errors);
  }
  if (tuning.minions !== undefined) {
    checkMinionTuning(`${name}.tuning.minions`, tuning.minions, errors);
  }
  if (tuning.monsters !== undefined) {
    checkNumberBag(`${name}.tuning.monsters`, tuning.monsters, MONSTER_MAP_KEYS, errors);
  }
  if (tuning.vision !== undefined) {
    checkNumberBag(`${name}.tuning.vision`, tuning.vision, VISION_KEYS, errors);
  }
  if (tuning.terrain !== undefined) {
    const path = `${name}.tuning.terrain`;
    if (!isObject(tuning.terrain)) {
      errors.push(`${path}: must be an object`);
    } else {
      for (const layer of Object.keys(tuning.terrain)) {
        if (layer !== 'bush' && layer !== 'water') {
          // `wall` is a layer, but not one anything stands in.
          errors.push(`${path}.${layer}: unknown; core provides bush, water`);
          continue;
        }
        checkNumberBag(`${path}.${layer}`, tuning.terrain[layer], ['speedMultiplier'], errors);
      }
    }
  }
}

/**
 * Every declared minion type is fielded by something, and something fields a
 * minion at all.
 *
 * Here rather than in `checkMinionTuning` because a muster point may declare
 * its own formation, so the full set of fielded ids is `tuning ∪ slots` and
 * only this side sees the slots. The cost is timing, and it is worth stating:
 * a map whose geometry is a **loader** — which is every big map — has these
 * two errors raised when its geometry loads rather than when the pack
 * installs. `checkMapGeometry`'s own header already records that trade for the
 * terrain half; this joins it rather than inventing a second mechanism.
 *
 * The failure both rules exist for is silent. `MinionSpawner.spawn` returns
 * `null` for an id its roster does not hold, so a wave is simply smaller — or
 * empty, for the whole match — with nothing on screen or in a log saying why.
 */
function checkMinionRoster(
  name: string,
  minions: MinionFormationView,
  musterFielded: ReadonlySet<string>,
  errors: string[]
): void {
  if (!minions.declaresRoster) return;

  const fielded = new Set([...minions.fielded, ...musterFielded]);
  if (fielded.size === 0) {
    errors.push(
      `${name}.tuning.minions.waves.composition: missing, and this map declares its own ` +
        `minion types (${[...minions.types].join(', ')}). Core's default wave names ` +
        `melee/ranged/cannon, which this roster no longer supplies, so every wave would be ` +
        `empty. Declare a formation here, or on a muster point's own stats.composition.`
    );
  }
  for (const id of minions.types) {
    if (!fielded.has(id)) {
      errors.push(
        `${name}.tuning.minions.types.${id}: declared but never fielded — no composition ` +
          `lists it, on the map or on any muster point, so this minion can never spawn.`
      );
    }
  }
}

/** `MapSummary.ice` — see `IceTuning`. Absent is fine; present must make sense. */
function checkIce(ice: unknown, name: string, errors: string[]): void {
  if (ice === undefined) return;
  if (!isObject(ice)) {
    errors.push(`${name}.ice: must be an object`);
    return;
  }
  if (ice.everywhere !== undefined && typeof ice.everywhere !== 'boolean') {
    errors.push(`${name}.ice.everywhere: must be true or false`);
  }
  for (const key of ['accelMs', 'frictionMs']) {
    const value = ice[key];
    if (value === undefined) continue;
    if (!isFiniteNumber(value) || value <= 0) {
      errors.push(`${name}.ice.${key}: must be a positive number of milliseconds`);
    }
  }
}

/**
 * The zone list — see `TerrainZone` for what a zone is and is not.
 *
 * Checked apart from the terrain-layer loop on purpose. That loop's whole job
 * is to refuse a *fourth layer*, because `TerrainMap` drops an unknown one in
 * silence; a zone is deliberately not a layer, and folding the two together
 * would make the error message for each one wrong.
 *
 * Every failure here is one the engine answers with silence of its own: a
 * duplicate id makes `zoneIdsAt` mean two things, a missing `render.fill`
 * paints nothing (an invisible speed change), and a two-point "polygon"
 * contains no point at all — `CollideUtils.pointPolygon` returns false for
 * every query against it, so the zone costs a lookup forever and catches
 * nobody.
 */
function checkZones(zones: unknown, name: string, errors: string[]): void {
  if (zones === undefined) return;
  if (!Array.isArray(zones)) {
    errors.push(`${name}.zones: must be an array`);
    return;
  }
  const seen = new Set<string>();
  zones.forEach((zone, index) => {
    const path = `${name}.zones[${index}]`;
    if (!isObject(zone)) {
      errors.push(`${path}: must be an object`);
      return;
    }
    if (typeof zone.id !== 'string' || zone.id === '') {
      errors.push(`${path}.id: must be a non-empty string`);
    } else if (seen.has(zone.id)) {
      errors.push(
        `${path}.id: duplicate ${JSON.stringify(zone.id)} — two zones sharing an id ` +
          `make a query for it mean two different things`
      );
    } else {
      seen.add(zone.id);
    }
    if (typeof zone.name !== 'string' || zone.name === '') {
      errors.push(`${path}.name: must be a non-empty string`);
    }
    if (zone.speedMultiplier !== undefined) {
      if (!isFiniteNumber(zone.speedMultiplier)) {
        errors.push(`${path}.speedMultiplier: must be a finite number`);
      } else if (zone.speedMultiplier < 0) {
        errors.push(`${path}.speedMultiplier: must not be negative`);
      }
    }
    if (zone.ice !== undefined && typeof zone.ice !== 'boolean') {
      errors.push(`${path}.ice: must be true or false`);
    }
    if (!isObject(zone.render) || typeof zone.render.fill !== 'string' || zone.render.fill === '') {
      errors.push(`${path}.render.fill: must be a non-empty colour string`);
    } else if (zone.render.stroke !== undefined && typeof zone.render.stroke !== 'string') {
      errors.push(`${path}.render.stroke: must be a colour string`);
    }
    if (!Array.isArray(zone.polygons)) {
      errors.push(`${path}.polygons: must be an array`);
      return;
    }
    zone.polygons.forEach((polygon: unknown, polygonIndex: number) => {
      const polygonPath = `${path}.polygons[${polygonIndex}]`;
      if (!Array.isArray(polygon) || polygon.length < 3) {
        errors.push(`${polygonPath}: a polygon needs at least 3 points`);
        return;
      }
      for (const point of polygon) {
        if (!isObject(point) || !isFiniteNumber(point.x) || !isFiniteNumber(point.y)) {
          errors.push(`${polygonPath}: every point needs finite x and y`);
          return;
        }
      }
    });
  });
}

export function checkMapGeometry(
  geometry: Record<string, unknown>,
  name: string,
  factions: Set<string>,
  minions: MinionFormationView,
  errors: string[]
): void {
  /** Type ids some muster point fields — read into `checkMinionRoster` below. */
  const musterFielded = new Set<string>();
  if (!isObject(geometry.terrain)) {
    errors.push(`${name}.terrain: missing`);
  } else {
    for (const layer of Object.keys(geometry.terrain)) {
      // TerrainMap only knows wall/bush/water and drops anything else in
      // silence. A pack that declares `lava` must be told, not ignored.
      if (layer !== 'wall' && layer !== 'bush' && layer !== 'water') {
        errors.push(`${name}.terrain: unknown layer ${layer}`);
      }
    }
  }

  checkZones(geometry.zones, name, errors);

  // Slots that declare a muster point, kept so the lane loop below can ask
  // "does this faction have somewhere to form up on this lane" — see the
  // `minionSlots` use after the lanes are walked.
  let minionSlots: Record<string, unknown>[] = [];

  if (!isObject(geometry.slots)) {
    errors.push(`${name}.slots: missing`);
  } else {
    const slots = geometry.slots;
    for (const group of ['spawn', 'minion', 'structure', 'neutral']) {
      if (!Array.isArray(slots[group])) errors.push(`${name}.slots.${group}: must be an array`);
    }

    const structures = Array.isArray(slots.structure) ? slots.structure : [];
    for (const slot of structures) {
      if (!isObject(slot)) continue;
      if (!STRUCTURE_KINDS.includes(slot.kind as StructureKind)) {
        errors.push(
          `${name}.slots.structure: unknown kind ${JSON.stringify(slot.kind)}; ` +
            `core provides ${STRUCTURE_KINDS.join(', ')}`
        );
      }
      if (typeof slot.faction === 'string' && !factions.has(slot.faction)) {
        errors.push(`${name}.slots.structure: faction ${slot.faction} was never declared`);
      }
      if (slot.stats !== undefined) {
        checkNumberBag(`${name}.slots.structure.stats`, slot.stats, TURRET_STAT_KEYS, errors);
      }
    }

    for (const slot of Array.isArray(slots.spawn) ? slots.spawn : []) {
      if (isObject(slot) && slot.stats !== undefined) {
        checkFountainStats(`${name}.slots.spawn.stats`, slot.stats, errors);
      }
    }

    for (const slot of Array.isArray(slots.neutral) ? slots.neutral : []) {
      if (!isObject(slot)) continue;
      if (slot.stats !== undefined) {
        checkMonsterSlotStats(`${name}.slots.neutral.stats`, slot.stats, errors);
      }
      // Erased at runtime, so a misspelled kind would install cleanly and be
      // drawn — and filled — as a camp, which is the one thing a map writing
      // this field is trying to say it is not.
      if (slot.kind !== undefined && !NEUTRAL_KINDS.includes(slot.kind as NeutralKind)) {
        errors.push(
          `${name}.slots.neutral.kind: unknown ${JSON.stringify(slot.kind)}; ` +
            `core provides ${NEUTRAL_KINDS.join(', ')}`
        );
      }
    }

    for (const group of ['spawn', 'minion'] as const) {
      const groupSlots = Array.isArray(slots[group]) ? slots[group] : [];
      for (const slot of groupSlots) {
        if (isObject(slot) && typeof slot.faction === 'string' && !factions.has(slot.faction)) {
          errors.push(`${name}.slots.${group}: faction ${slot.faction} was never declared`);
        }
      }
    }

    for (const slot of Array.isArray(slots.minion) ? slots.minion : []) {
      if (!isObject(slot) || slot.stats === undefined) continue;
      const path = `${name}.slots.minion.stats`;
      if (!isObject(slot.stats)) {
        errors.push(`${path}: must be an object`);
        continue;
      }
      for (const key of Object.keys(slot.stats)) {
        if (key !== 'composition') {
          errors.push(`${path}.${key}: unknown; core provides composition`);
        }
      }
      // Against the same roster the map-wide formation is checked against —
      // a muster point naming a type the roster does not hold forms up a
      // smaller wave, or none, in silence.
      checkComposition(`${path}.composition`, slot.stats.composition, minions.types, errors);
      if (isStringArray(slot.stats.composition)) {
        for (const id of slot.stats.composition) musterFielded.add(id);
      }
    }

    if (Array.isArray(slots.minion)) {
      minionSlots = slots.minion.filter(isObject);
    }
  }

  checkMinionRoster(name, minions, musterFielded, errors);

  // Absent lanes are a shape, not an omission: no waves, and BotBrain's PUSH
  // posture — the only rule that reads a lane — falls through to ROAM.
  if (geometry.lanes === undefined) return;
  if (!Array.isArray(geometry.lanes)) {
    errors.push(`${name}.lanes: must be an array when present`);
    return;
  }
  for (const lane of geometry.lanes) {
    if (!isObject(lane) || typeof lane.id !== 'string') {
      errors.push(`${name}.lanes[]: each lane needs a string id`);
      continue;
    }
    for (const end of ['from', 'to'] as const) {
      const faction = lane[end];
      if (typeof faction !== 'string' || !factions.has(faction)) {
        errors.push(
          `${name}.lanes.${lane.id}.${end}: faction ${String(faction)} was never declared`
        );
        continue;
      }
      // A faction that walks this lane and has no muster point on it is the
      // exact silent failure this file's header names: `MinionSpawner` used
      // to answer with `null` and drop the whole wave into the fountain, and
      // nobody found out until the first wave walked out of it. Refused here
      // instead, at install.
      const musters = minionSlots.some(slot => slot.faction === faction && slot.lane === lane.id);
      if (!musters) {
        errors.push(
          `${name}.slots.minion: no muster point for faction ${faction} on lane ${lane.id}`
        );
      }
    }
  }
}

function checkMap(map: unknown, index: number, errors: string[]): void {
  const where = `maps[${index}]`;
  // The one legitimate early return: if `map` is not an object there is
  // nothing left in it to inspect. Every other precondition below is
  // guarded on its own so one malformed section does not hide its siblings.
  if (!isObject(map)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  if (typeof map.id !== 'string') {
    errors.push(`${where}: needs a string id`);
  }
  const name = typeof map.id === 'string' ? `maps.${map.id}` : where;
  if (typeof map.name !== 'string') {
    errors.push(`${name}.name: must be a string`);
  }
  if (!isFiniteNumber(map.size) || map.size <= 0) {
    errors.push(`${name}.size: must be a positive number`);
  }

  const factions = new Set<string>();
  if (!Array.isArray(map.factions) || map.factions.length === 0) {
    errors.push(`${name}.factions: must list at least one faction`);
  } else {
    for (const faction of map.factions) {
      if (isObject(faction) && typeof faction.id === 'string') factions.add(faction.id);
      else errors.push(`${name}.factions[]: each faction needs a string id`);
    }
  }

  // Before the `geometry` block below, and that ordering is load-bearing: a
  // map whose geometry is a *loader* returns early from this function, and
  // every big map is a loader. Checking tuning after that point would mean
  // Summoner's Rift's own numbers were never validated at all — the same
  // shape of hole this function's own header records for the terrain half.
  if (map.tuning !== undefined) checkMapTuning(map.tuning, name, errors);
  checkIce(map.ice, name, errors);

  // `geometry` is a `MapGeometrySource`: a plain object, checked in full
  // below, or a loader — see `checkMapGeometry`'s own header for why a loader
  // gets only the structural check `checkSpells` already gives a spell loader.
  if (map.geometry === undefined) {
    errors.push(`${name}.geometry: missing`);
    return;
  }
  if (typeof map.geometry === 'function') return;
  if (!isObject(map.geometry)) {
    errors.push(`${name}.geometry: must be an object or a loader function`);
    return;
  }
  checkMapGeometry(map.geometry, name, factions, minionFormationOf(map.tuning), errors);
}

function checkMaps(pack: Record<string, unknown>, errors: string[]): void {
  if (pack.maps === undefined) return;
  if (!Array.isArray(pack.maps)) {
    errors.push('maps: must be an array');
    return;
  }
  pack.maps.forEach((map: unknown, index: number) => checkMap(map, index, errors));
}

export function validatePack(candidate: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(candidate)) {
    return { ok: false, errors: ['pack: must be an object'] };
  }

  checkManifest(candidate.manifest, errors);
  checkSpells(candidate, errors);
  checkMonsterAbilities(candidate, errors);
  checkSpellDisplay(candidate, errors);
  checkChampions(candidate, errors);
  checkChampionAI(candidate, errors);
  checkArchetypes(candidate, errors);
  checkItems(candidate, errors);
  checkMonsters(candidate, errors);
  checkMaps(candidate, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, pack: candidate as unknown as ContentPack };
}

export type DataValidationResult =
  { ok: true; data: ContentPackData } | { ok: false; errors: string[] };

/**
 * The data half alone: manifest, champions, spell display, monsters, maps —
 * everything `PackRegistry.installData` writes. Reuses the same section
 * checks `validatePack` does; a `ContentPackData` candidate has no `spells`
 * key at all (not an empty one), so `checkChampions`/`checkSpellDisplay`'s
 * "does this id exist in `spells`" cross-check quietly skips itself (see
 * their own `spellsProvided` guard) rather than flagging every reference as
 * missing. `installCode` is what completes the pack; nothing here is a
 * weaker check, only an earlier one.
 */
export function validatePackData(candidate: unknown): DataValidationResult {
  const errors: string[] = [];
  if (!isObject(candidate)) {
    return { ok: false, errors: ['pack: must be an object'] };
  }

  checkManifest(candidate.manifest, errors);
  checkSpellDisplay(candidate, errors);
  checkChampions(candidate, errors);
  checkChampionAI(candidate, errors);
  checkArchetypes(candidate, errors);
  checkItems(candidate, errors);
  checkMonsters(candidate, errors);
  checkMaps(candidate, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: candidate as unknown as ContentPackData };
}

export type CodeValidationResult =
  { ok: true; code: ContentPackCode } | { ok: false; errors: string[] };

/**
 * The code half alone: every entry in `spells` is a class or a loader, and
 * every entry in `monsterAbilities` is a well-shaped `MonsterAbility[]`.
 */
export function validatePackCode(candidate: unknown): CodeValidationResult {
  const errors: string[] = [];
  if (!isObject(candidate)) {
    return { ok: false, errors: ['pack: must be an object'] };
  }

  checkSpells(candidate, errors);
  checkMonsterAbilities(candidate, errors);
  checkChampionAI(candidate, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, code: candidate as unknown as ContentPackCode };
}
