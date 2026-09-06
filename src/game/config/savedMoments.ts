/**
 * The "Mốc đã lưu" library: one *moment* of a practice fight, saved by name
 * and reopenable from the menu in a later session.
 *
 * A moment is a `MatchTemplateSetup` — the whole bootable setup the "Trận
 * mẫu" machinery already knows how to write down and boot again, bags
 * included — plus the `matchSeed` the world was rolled from and a
 * `MomentOverlay`: the numbers that make a booted match *that* moment rather
 * than minute zero. Positions, health, mana, gold, per-slot cooldowns, each
 * spell's own counters, who is dead and for how long, the wave clock, the
 * camps. Everything in the overlay is a plain JSON scalar by construction,
 * because this blob outlives the session and every live reference with it.
 *
 * ## What a persisted moment deliberately does NOT carry
 *
 * Running timed effects — the buff list. A buff is a live class instance
 * whose identity is its constructor; there is no id space that could name a
 * pack's buff across sessions (the LAN protocol has none either — a client
 * *replays* buffs by running the same spell code, it never receives one).
 * Inventing a registry keyed on `constructor.name` would break the moment a
 * production build minifies. So a reopened moment starts with clean effect
 * bars, and the shelf's row says so out loud. Spell-held state — a stacking
 * spell's counter, an armed passive's own scalars — *does* cross, because it
 * rides the spell, not a buff.
 *
 * In-session rewind keeps full buff fidelity; that half lives in
 * `checkpoint/Checkpoint.ts` and holds live references it never serializes.
 *
 * ## Storage doctrine
 *
 * `matchTemplates.ts`'s, verbatim: its own versioned key, newest first,
 * rename and delete by id, a corrupt library reads as empty and can never
 * take the match config down with it. Pure data plus storage — no p5, no
 * Vue, no reach into the game object graph — so the menu chunk and the match
 * can both import it and it unit-tests in plain node.
 */
import { uuidv4 } from '@/utils';
import { sanitizeTemplateItems, type MatchTemplateSetup } from './matchTemplates';
import { sanitizePregameConfig } from './PregameConfig';

/**
 * A fresh 32-bit seed for a stored moment whose own is junk — the same roll
 * `game/matchSeed.ts`'s `randomMatchSeed` makes, restated here because this
 * directory is pinned to the `pregame` chunk and may value-import nothing
 * from `src/game/` but its own neighbours (`pregameChunkPurity.test.ts`);
 * importing the four-line original would drag a `game`-chunk module onto the
 * menu's first paint. Two lines is the cheaper duplication.
 */
const fallbackSeed = (): number => Math.floor(Math.random() * 0x1_0000_0000);

export const SAVED_MOMENTS_STORAGE_KEY = 'moba2d:savedMoments:v1';

/** Same width as a template's name, for the same shelf-heading reason. */
export const SAVED_MOMENT_NAME_MAX = 40;

/**
 * Ceiling on reflected per-spell fields, so a hand-edited blob cannot smuggle
 * a novel into storage through one spell's scalar bag. Real spells carry a
 * few dozen tuning numbers at most.
 */
const FIELD_KEYS_MAX = 128;
const FIELD_STRING_MAX = 400;

/** A reflected scalar bag — one spell's (or one buff's) own plain fields. */
export type ScalarFields = Record<string, number | boolean | string>;

/** One ability slot as a moment stores it; `null` for an empty slot. */
export interface MomentSpellState {
  /** Remaining cooldown, ms. */
  cooldownMs: number;
  /** The `Spell.stackCount` contract's answer, or `null` for a spell with none. */
  stacks: number | null;
  /** Own-enumerable JSON-able scalars, by reflection. */
  fields: ScalarFields;
}

export interface MomentUnitState {
  x: number;
  y: number;
  /** Composed (post-modifier) current pools, the same numbers the bars show. */
  health: number;
  mana: number;
  dead: boolean;
  /** Remaining respawn clock, ms. Meaningful only when `dead`. */
  reviveAfterMs: number;
  gold: number;
  /**
   * The scoreboard's numbers at the moment — own-enumerable numeric fields
   * of `MatchTally`, by name. Optional: a moment saved before the tally
   * joined the overlay simply leaves the board as it stands when applied.
   */
  tally?: Record<string, number>;
  /** Index-aligned with the unit's spell slots. */
  spells: (MomentSpellState | null)[];
}

export interface MomentMonsterState {
  x: number;
  y: number;
  health: number;
  dead: boolean;
  reviveAfterMs: number;
}

/**
 * One turret as a moment stores it. No position — a building stands where the
 * map put it — and no revive clock: a destroyed turret is a husk with no
 * countdown, and only a rewind (or a match reset) stands it back up.
 */
export interface MomentTurretState {
  health: number;
  dead: boolean;
}

/**
 * One relic pad's countdown. `cooling` 0 is "standing there now";
 * `coolingTotal` is what the wait started at, which the pad's arc fills
 * against — captured rather than re-derived because the match's cooldown
 * rules may have moved between the moment and the restore.
 */
export interface MomentRelicState {
  cooling: number;
  coolingTotal: number;
}

/** The wave clock, so a reopened moment's minions keep the moment's cadence. */
export interface MomentMinionClock {
  elapsedMs: number;
  nextWaveIn: number;
  waveCount: number;
}

/**
 * What turns a freshly booted setup into the saved moment. Player first,
 * bots index-aligned with the setup's bot slots — the same convention every
 * per-slot array in `PregameConfig` follows. `monsters` is aligned with the
 * deterministic order `Game.spawnJungle` fills camps in; a world whose camp
 * count no longer matches (packs changed) skips that part rather than
 * guessing.
 */
export interface MomentOverlay {
  matchTimeMs: number;
  player: MomentUnitState;
  bots: MomentUnitState[];
  minionClock: MomentMinionClock | null;
  monsters: MomentMonsterState[] | null;
  /**
   * Index-aligned with `Game.turrets`, whose order is the deterministic
   * construction order of the map's structure slots. Optional, like `tally`:
   * a moment saved before turrets joined the overlay simply leaves the field
   * of play as it stands. A world whose turret count no longer matches skips
   * this part rather than guessing which building was which.
   */
  turrets?: MomentTurretState[] | null;
  /**
   * Index-aligned with the relic pads in their deterministic construction
   * order (the neutral-slot walk). Same optional/count-mismatch contract as
   * `turrets`.
   */
  relics?: MomentRelicState[] | null;
}

export interface SavedMoment {
  id: string;
  name: string;
  /** Epoch ms. The library is listed newest first. */
  savedAt: number;
  /** The one number seeded content derives from — `Game.matchSeed`. */
  matchSeed: number;
  setup: MatchTemplateSetup;
  overlay: MomentOverlay;
}

const finite = (raw: unknown, fallback: number): number =>
  typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;

const sanitizeFields = (raw: unknown): ScalarFields => {
  const fields: ScalarFields = {};
  if (!raw || typeof raw !== 'object') return fields;
  let kept = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (kept >= FIELD_KEYS_MAX) break;
    const kind = typeof value;
    if (kind === 'number' && !Number.isFinite(value as number)) continue;
    if (kind === 'string' && (value as string).length > FIELD_STRING_MAX) continue;
    if (kind !== 'number' && kind !== 'boolean' && kind !== 'string') continue;
    fields[key] = value as number | boolean | string;
    kept++;
  }
  return fields;
};

const sanitizeSpellState = (raw: unknown): MomentSpellState | null => {
  if (!raw || typeof raw !== 'object') return null;
  const spell = raw as Partial<MomentSpellState>;
  return {
    cooldownMs: Math.max(0, finite(spell.cooldownMs, 0)),
    stacks: typeof spell.stacks === 'number' && Number.isFinite(spell.stacks) ? spell.stacks : null,
    fields: sanitizeFields(spell.fields),
  };
};

const sanitizeUnitState = (raw: unknown): MomentUnitState => {
  const unit = (raw && typeof raw === 'object' ? raw : {}) as Partial<MomentUnitState>;
  const spells: (MomentSpellState | null)[] = [];
  if (Array.isArray(unit.spells)) {
    for (const entry of unit.spells.slice(0, 16)) spells.push(sanitizeSpellState(entry));
  }
  return {
    x: finite(unit.x, 0),
    y: finite(unit.y, 0),
    health: Math.max(0, finite(unit.health, 0)),
    mana: Math.max(0, finite(unit.mana, 0)),
    dead: unit.dead === true,
    reviveAfterMs: Math.max(0, finite(unit.reviveAfterMs, 0)),
    gold: Math.max(0, finite(unit.gold, 0)),
    spells,
  };
};

const sanitizeMonsterState = (raw: unknown): MomentMonsterState => {
  const monster = (raw && typeof raw === 'object' ? raw : {}) as Partial<MomentMonsterState>;
  return {
    x: finite(monster.x, 0),
    y: finite(monster.y, 0),
    health: Math.max(0, finite(monster.health, 0)),
    dead: monster.dead === true,
    reviveAfterMs: Math.max(0, finite(monster.reviveAfterMs, 0)),
  };
};

const sanitizeTurretState = (raw: unknown): MomentTurretState => {
  const turret = (raw && typeof raw === 'object' ? raw : {}) as Partial<MomentTurretState>;
  return {
    health: Math.max(0, finite(turret.health, 0)),
    dead: turret.dead === true,
  };
};

const sanitizeRelicState = (raw: unknown): MomentRelicState => {
  const relic = (raw && typeof raw === 'object' ? raw : {}) as Partial<MomentRelicState>;
  const coolingTotal = Math.max(0, finite(relic.coolingTotal, 0));
  return {
    // Never longer than the wait it started at — a hand-edited blob must not
    // freeze a pad's arc past full.
    cooling: Math.min(Math.max(0, finite(relic.cooling, 0)), coolingTotal),
    coolingTotal,
  };
};

/**
 * Repairs a stored overlay the way `sanitizePregameConfig` repairs the
 * config: every piece independently, garbage dropped rather than thrown on.
 */
export const sanitizeMomentOverlay = (raw: unknown): MomentOverlay => {
  const overlay = (raw && typeof raw === 'object' ? raw : {}) as Partial<MomentOverlay>;
  const bots: MomentUnitState[] = [];
  if (Array.isArray(overlay.bots)) {
    for (const entry of overlay.bots.slice(0, 32)) bots.push(sanitizeUnitState(entry));
  }
  let minionClock: MomentMinionClock | null = null;
  if (overlay.minionClock && typeof overlay.minionClock === 'object') {
    const clock = overlay.minionClock as Partial<MomentMinionClock>;
    minionClock = {
      elapsedMs: Math.max(0, finite(clock.elapsedMs, 0)),
      nextWaveIn: Math.max(0, finite(clock.nextWaveIn, 0)),
      waveCount: Math.max(0, Math.floor(finite(clock.waveCount, 0))),
    };
  }
  let monsters: MomentMonsterState[] | null = null;
  if (Array.isArray(overlay.monsters)) {
    monsters = [];
    for (const entry of overlay.monsters.slice(0, 256)) monsters.push(sanitizeMonsterState(entry));
  }
  // Optional on purpose, and staying absent when absent: a moment saved
  // before turrets and relics joined the overlay must read back without
  // either field, so the apply side can tell "not recorded" from "recorded
  // empty" and leave the field of play alone.
  let turrets: MomentTurretState[] | null | undefined;
  if (Array.isArray(overlay.turrets)) {
    turrets = [];
    for (const entry of overlay.turrets.slice(0, 64)) turrets.push(sanitizeTurretState(entry));
  }
  let relics: MomentRelicState[] | null | undefined;
  if (Array.isArray(overlay.relics)) {
    relics = [];
    for (const entry of overlay.relics.slice(0, 64)) relics.push(sanitizeRelicState(entry));
  }
  const sanitized: MomentOverlay = {
    matchTimeMs: Math.max(0, finite(overlay.matchTimeMs, 0)),
    player: sanitizeUnitState(overlay.player),
    bots,
    minionClock,
    monsters,
  };
  if (turrets) sanitized.turrets = turrets;
  if (relics) sanitized.relics = relics;
  return sanitized;
};

const sanitizeMoment = (value: unknown): SavedMoment | null => {
  if (!value || typeof value !== 'object') return null;
  const moment = value as Partial<SavedMoment>;
  if (typeof moment.id !== 'string' || moment.id.length === 0) return null;
  if (typeof moment.name !== 'string' || moment.name.length === 0) return null;
  if (typeof moment.savedAt !== 'number' || !Number.isFinite(moment.savedAt)) return null;
  const setup = moment.setup;
  if (!setup || typeof setup !== 'object' || !('config' in setup)) return null;
  return {
    id: moment.id,
    name: moment.name.slice(0, SAVED_MOMENT_NAME_MAX),
    savedAt: moment.savedAt,
    matchSeed:
      typeof moment.matchSeed === 'number' && Number.isFinite(moment.matchSeed)
        ? moment.matchSeed
        : fallbackSeed(),
    setup: {
      config: sanitizePregameConfig((setup as Partial<MatchTemplateSetup>).config),
      items: sanitizeTemplateItems((setup as Partial<MatchTemplateSetup>).items),
    },
    overlay: sanitizeMomentOverlay(moment.overlay),
  };
};

const read = (): SavedMoment[] => {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SAVED_MOMENTS_STORAGE_KEY);
  } catch {
    // `localStorage` disabled entirely, or absent (node). Not an error here.
    return [];
  }
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  // A plain loop rather than `.filter` with a narrowing predicate — the
  // repo's own `global.d.ts` overload makes that come back un-narrowed.
  const moments: SavedMoment[] = [];
  for (const entry of parsed) {
    const moment = sanitizeMoment(entry);
    if (moment) moments.push(moment);
  }
  return moments;
};

const write = (moments: SavedMoment[]): void => {
  try {
    localStorage.setItem(SAVED_MOMENTS_STORAGE_KEY, JSON.stringify(moments));
  } catch {
    // A full or blocked storage costs the player this save, nothing more.
  }
};

/** Newest first. Never throws; a corrupt library reads as an empty one. */
export const loadSavedMoments = (): SavedMoment[] => read();

/** @throws if `name` is blank once trimmed — an unnamed moment is unfindable. */
export const saveSavedMoment = (
  name: string,
  matchSeed: number,
  setup: MatchTemplateSetup,
  overlay: MomentOverlay
): SavedMoment => {
  const trimmed = name.trim().slice(0, SAVED_MOMENT_NAME_MAX);
  if (!trimmed) throw new Error('A saved moment needs a name.');

  const moment: SavedMoment = {
    id: uuidv4(),
    name: trimmed,
    savedAt: Date.now(),
    matchSeed: Number.isFinite(matchSeed) ? matchSeed : fallbackSeed(),
    // Sanitized on the way in rather than trusted — it doubles as the deep
    // copy, the same way `saveMatchTemplate` uses `sanitizePregameConfig`.
    setup: {
      config: sanitizePregameConfig(setup.config),
      items: sanitizeTemplateItems(setup.items),
    },
    overlay: sanitizeMomentOverlay(overlay),
  };
  write([moment, ...read()]);
  return moment;
};

/** Silently ignores an unknown id, and a name that is blank once trimmed. */
export const renameSavedMoment = (id: string, name: string): void => {
  const trimmed = name.trim().slice(0, SAVED_MOMENT_NAME_MAX);
  if (!trimmed) return;
  write(read().map(moment => (moment.id === id ? { ...moment, name: trimmed } : moment)));
};

/** Silently ignores an unknown id. */
export const deleteSavedMoment = (id: string): void => {
  write(read().filter(moment => moment.id !== id));
};

/**
 * The half of an opened moment the config write cannot carry, parked for the
 * boot that follows — the exact `stashTemplateItems` arrangement, for the
 * exact reason: the menu cannot reach a world that does not exist yet.
 *
 * One-shot: `Game`'s constructor takes it once, so a plain restart from
 * inside the reopened match re-rolls an ordinary match instead of replaying
 * a stale moment. The seed rides here too because it has to be in hand
 * *before* the jungle spawns — seeded content derives its rotation from it.
 */
export interface MomentBoot {
  matchSeed: number;
  overlay: MomentOverlay;
}

let pendingBoot: MomentBoot | null = null;

export const stashMomentBoot = (boot: MomentBoot): void => {
  pendingBoot = {
    matchSeed: Number.isFinite(boot.matchSeed) ? boot.matchSeed : fallbackSeed(),
    overlay: sanitizeMomentOverlay(boot.overlay),
  };
};

/** Hands the parked moment over and forgets it. `null` when nothing is parked. */
export const takeMomentBoot = (): MomentBoot | null => {
  const boot = pendingBoot;
  pendingBoot = null;
  return boot;
};
