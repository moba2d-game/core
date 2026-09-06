/**
 * "Mốc đã lưu" — fight save points, and the rewind that makes the practice
 * room a practice room: save the moment, try the fight, come back to the
 * moment, alive or dead, as often as it takes.
 *
 * ## A checkpoint is a state snapshot, never a replay
 *
 * Deterministic re-simulation is off the table in this engine by design —
 * content rolls `Math.random()` freely and `matchSeed.ts` explicitly refuses
 * a shared RNG stream — so a checkpoint records *state* and writes it back.
 *
 * ## Restore-in-place is the law
 *
 * The in-session restore keeps the SAME champion instances and writes the
 * recorded fields back onto them. That is what keeps every identity-keyed
 * store alive untouched: the rearm clocks parked per unit in `Buff.ts`, the
 * purchase ledger in `ShopHistory`, whatever a pack keys on a unit in a
 * WeakMap of its own. Clone-and-swap would silently orphan all of it.
 *
 * ## What is captured, and what deliberately is not
 *
 * Captured: match time; per-champion position, pools, death state with its
 * remaining clock, gold, the bag as qualified ids per slot, per-slot
 * cooldowns, each spell's own-enumerable JSON-able scalars (plus the
 * `stackCount` contract), and the live buff list — constructor reference,
 * scalars, source/target, and the `sourceSpell` *name* for re-linking. The
 * wave clock, and every camp's health/position/revive clock.
 *
 * Not captured, because it is derived or disposable: fog and vision caches,
 * quadtrees, HUD state, bot blackboards, stats (rebuilt from items + buffs —
 * only the current pools need writing), and projectiles/VFX in flight, which
 * a restore simply drops (`toRemove`). The K/D/A tally is left alone on
 * purpose: a practice rewind undoes the fight, not the diary of attempts.
 *
 * ## Two tiers
 *
 * - `captureCheckpoint`/`restoreCheckpoint`: memory-held, full fidelity,
 *   live references allowed (buff constructors, unit refs) — never leaves
 *   the session.
 * - `MomentOverlay` (the serializable half, `config/savedMoments.ts`): what
 *   a persisted moment carries across sessions. `applyMomentOverlay` lays it
 *   over a world freshly booted through the "Trận mẫu" path. Buffs do not
 *   cross — see that module's header for why — and the UI says so.
 *
 * ## LAN
 *
 * Refused outright with a session attached (`world.net`). The wire protocol
 * is forward-only; a host rewinding under its clients would desync every one
 * of them. The HUD hides every entry point too — this guard is the backstop.
 */
import { contentCatalog } from '@/content/catalog';
import { buildHeldItem } from '@/game/economy/ItemShop';
import { setComposedValue } from '@/game/net/ClientSession';
import type Buff from '@/game/gameObject/Buff';
import type { BuffConstructorArgs } from '@/game/gameObject/Buff';
import type Spell from '@/game/gameObject/Spell';
import type GameObject from '@/game/gameObject/GameObject';
import type AttackableUnit from '@/game/gameObject/attackableUnits/AttackableUnit';
import type Champion from '@/game/gameObject/attackableUnits/Champion';
import Monster from '@/game/gameObject/attackableUnits/Monster';
import Minion from '@/game/gameObject/attackableUnits/Minion';
import Pet from '@/game/gameObject/attackableUnits/Pet';
import SpellObject from '@/game/gameObject/SpellObject';
import CombatText from '@/game/gameObject/helpers/CombatText';
import type { PregameConfig } from '@/game/config/PregameConfig';
import type { MatchTemplateSetup } from '@/game/config/matchTemplates';
import type {
  MomentMinionClock,
  MomentMonsterState,
  MomentOverlay,
  MomentSpellState,
  MomentUnitState,
  ScalarFields,
} from '@/game/config/savedMoments';
import { uuidv4 } from '@/utils';

/**
 * The wave clock as this module needs it. The clock fields are optional so a
 * bench spawner that stubs only `minions`/`enabled` still satisfies the
 * shape; capture answers `null` for one of those and apply skips it.
 */
interface WaveClockLike {
  minions: { toRemove: boolean }[];
  _elapsedMs?: number;
  _nextWaveIn?: number;
  waveCount?: number;
  _queue?: unknown[];
}

/**
 * The slice of a match this module reads and writes. `Game` satisfies it
 * structurally; tests satisfy it with the practice bench plus a real
 * `MatchDirector`. Kept structural so capture/restore can be exercised with
 * no p5 scene and no `Game` construction.
 */
export interface CheckpointWorld {
  matchTimeMs: number;
  matchSeed: number;
  readonly player: Champion;
  monsters: Monster[];
  minionSpawner: WaveClockLike;
  objectManager: { objects: GameObject[]; _objectToBeAdd: GameObject[] };
  director: {
    bots(): Champion[];
    toPregameConfig(): PregameConfig;
    readonly jungleEnabled: boolean;
  };
  spawnJungle(): void;
  net: unknown;
  /** The slice of the announcer a rewind touches; absent on the test bench. */
  announcer?: { rewindTo(nowMs: number): void };
}

type BuffClass = new (...args: BuffConstructorArgs) => Buff;

/**
 * One live buff, written down. `make` is the constructor itself and
 * `sourceUnit`/`targetUnit` are live references — legal here because a
 * checkpoint never leaves the session; the persisted overlay carries none of
 * this. `sourceSpellName` is the re-link key: on restore the owner's spells
 * and item passives are searched by `Spell.name`, so a permanent passive's
 * effect finds the spell whose presence it depends on again.
 */
export interface CheckpointBuff {
  make: BuffClass;
  duration: number;
  sourceUnit: AttackableUnit;
  targetUnit: AttackableUnit;
  /** Only when the live buff carried a string id; a class-keyed one restores itself. */
  stackId: string | null;
  sourceSpellName: string | null;
  fields: ScalarFields;
}

/** One roster participant: the live unit, its bag by slot, its buff list. */
export interface CheckpointUnit {
  unit: Champion;
  /** Qualified item ids by slot, `null` for an empty slot — bag width kept. */
  bagSlots: (string | null)[];
  buffs: CheckpointBuff[];
}

export interface Checkpoint {
  id: string;
  name: string;
  /** True for the rows the match saves on its own, false for a player's press. */
  auto: boolean;
  /** Epoch ms — the shelf's "vừa lưu" stamp. */
  savedAt: number;
  matchTimeMs: number;
  matchSeed: number;
  /**
   * The row's one-line glance — "72% máu · 1450 vàng · 3 trang bị" — built
   * at capture, because it needs the max pools as they stood then and the
   * overlay deliberately stores only the current ones.
   */
  summary: string;
  /** The bootable setup as it stood at capture — what "Lưu vào thư viện" persists. */
  setup: MatchTemplateSetup;
  /** The serializable half, shared with the cross-session path. */
  overlay: MomentOverlay;
  /** Live-reference half, index-aligned player-first with the overlay. */
  units: CheckpointUnit[];
}

// --------------------------------------------------------------- reflection

/**
 * `id` is instance identity, and `name`/`description` are class identity and
 * authored prose — none of them *state*. In-session they are byte-identical
 * either way; across sessions, stamping a stored copy onto a fresh spell
 * would pin a minified class name or a superseded sentence over the real
 * one. Everything a spell counts or toggles stays captured.
 */
const SPELL_FIELD_SKIP: ReadonlySet<string> = new Set(['id', 'name', 'description']);
const BUFF_FIELD_SKIP: ReadonlySet<string> = new Set([
  'toRemove',
  '_created',
  '_deactivated',
  '_activated',
]);

/**
 * Own-enumerable JSON-able scalars of a live object. This is how a pack
 * spell's counter or a buff's tuning crosses without core naming a single
 * pack field: whatever the instance carries as a plain number, boolean or
 * string is recorded and written back verbatim. Objects, functions and
 * non-finite numbers are left where they are — they are either rebuilt by
 * the class itself or unserializable by nature.
 */
const scalarFieldsOf = (source: object, skip: ReadonlySet<string>): ScalarFields => {
  const fields: ScalarFields = {};
  for (const [key, value] of Object.entries(source)) {
    if (skip.has(key)) continue;
    const kind = typeof value;
    if (kind === 'number') {
      if (Number.isFinite(value)) fields[key] = value as number;
      continue;
    }
    if (kind === 'boolean' || kind === 'string') fields[key] = value as boolean | string;
  }
  return fields;
};

const assignScalars = (target: object, fields: ScalarFields): void => {
  const record = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) record[key] = value;
};

// ------------------------------------------------------------------ capture

const captureSpells = (unit: Champion): (MomentSpellState | null)[] => {
  const spells: (MomentSpellState | null)[] = [];
  for (const spell of unit.spells ?? []) {
    if (!spell) {
      spells.push(null);
      continue;
    }
    spells.push({
      cooldownMs: Math.max(0, spell.currentCooldown ?? 0),
      stacks: typeof spell.stackCount === 'number' ? spell.stackCount : null,
      fields: scalarFieldsOf(spell, SPELL_FIELD_SKIP),
    });
  }
  return spells;
};

const captureBuffs = (unit: Champion): CheckpointBuff[] => {
  const buffs: CheckpointBuff[] = [];
  for (const buff of unit.buffs) {
    if (buff.toRemove) continue;
    buffs.push({
      make: buff.constructor as BuffClass,
      duration: buff.duration,
      sourceUnit: buff.sourceUnit,
      targetUnit: buff.targetUnit,
      stackId: typeof buff.stackId === 'string' ? buff.stackId : null,
      sourceSpellName: buff.sourceSpell?.name ?? null,
      fields: scalarFieldsOf(buff, BUFF_FIELD_SKIP),
    });
  }
  return buffs;
};

interface CapturedUnit {
  state: MomentUnitState;
  bagSlots: (string | null)[];
  buffs: CheckpointBuff[];
}

const captureUnit = (unit: Champion): CapturedUnit => {
  const bagSlots: (string | null)[] = [];
  for (const held of unit.items ?? []) bagSlots.push(held?.def?.id ?? null);
  return {
    state: {
      x: unit.position.x,
      y: unit.position.y,
      // Composed values — the same numbers the bars show — so the write side
      // (`setComposedValue`) can solve for the base under whatever modifiers
      // stand at restore time, exactly the way the LAN snapshot writes pools.
      health: unit.stats.health.value,
      mana: unit.stats.mana.value,
      dead: unit.isDead,
      reviveAfterMs: Math.max(0, unit.deathData?.reviveAfter ?? 0),
      gold: unit.wallet?.balance ?? 0,
      spells: captureSpells(unit),
    },
    bagSlots,
    buffs: captureBuffs(unit),
  };
};

const captureWaveClock = (spawner: WaveClockLike): MomentMinionClock | null => {
  if (
    typeof spawner._elapsedMs !== 'number' ||
    typeof spawner._nextWaveIn !== 'number' ||
    typeof spawner.waveCount !== 'number'
  ) {
    return null;
  }
  return {
    elapsedMs: spawner._elapsedMs,
    nextWaveIn: spawner._nextWaveIn,
    waveCount: spawner.waveCount,
  };
};

const captureMonsters = (world: CheckpointWorld): MomentMonsterState[] | null => {
  if (!world.director.jungleEnabled) return null;
  return world.monsters.map(monster => ({
    x: monster.position.x,
    y: monster.position.y,
    health: monster.stats.health.value,
    dead: monster.isDead,
    reviveAfterMs: Math.max(0, monster.deathData?.reviveAfter ?? 0),
  }));
};

/** Slot list to the dense id list `TemplateItems` stores. A plain loop, per house rule. */
const denseBag = (slots: readonly (string | null)[]): string[] => {
  const ids: string[] = [];
  for (const id of slots) if (id) ids.push(id);
  return ids;
};

/**
 * Writes the moment down. Cheap by construction — scalars, ids and
 * references, no cloning of the object graph — so saving is pressable in the
 * middle of a fight and spammable between them.
 */
export const captureCheckpoint = (
  world: CheckpointWorld,
  name: string,
  auto = false
): Checkpoint => {
  const roster: Champion[] = [world.player, ...world.director.bots()];
  const captured = roster.map(captureUnit);

  const overlay: MomentOverlay = {
    matchTimeMs: world.matchTimeMs,
    player: captured[0].state,
    bots: captured.slice(1).map(entry => entry.state),
    minionClock: captureWaveClock(world.minionSpawner),
    monsters: captureMonsters(world),
  };

  // The exact "Trận mẫu" shape, captured at THIS moment rather than at save
  // time — the roster or the bags may drift between saving the checkpoint
  // and pressing "Lưu vào thư viện", and the persisted moment must be the
  // moment, not the present.
  const setup: MatchTemplateSetup = {
    config: world.director.toPregameConfig(),
    items: {
      player: denseBag(captured[0].bagSlots),
      bots: captured.slice(1).map(entry => denseBag(entry.bagSlots)),
    },
  };

  const maxHealth = world.player.stats.maxHealth.value;
  const healthPct = maxHealth > 0 ? Math.round((captured[0].state.health / maxHealth) * 100) : 0;
  const itemCount = denseBag(captured[0].bagSlots).length;
  const summary = `${Math.max(0, Math.min(100, healthPct))}% máu · ${captured[0].state.gold} vàng · ${itemCount} trang bị`;

  return {
    id: uuidv4(),
    name,
    auto,
    savedAt: Date.now(),
    matchTimeMs: world.matchTimeMs,
    matchSeed: world.matchSeed,
    summary,
    setup,
    overlay,
    units: roster.map((unit, i) => ({
      unit,
      bagSlots: captured[i].bagSlots,
      buffs: captured[i].buffs,
    })),
  };
};

// ------------------------------------------------------------------ restore

/**
 * The owner's spell (kit, item passive/active, champion passive, recall)
 * carrying this name, or `null`. Name-keyed on purpose: within one session
 * the class names are stable — minified or not, they are the same build —
 * and the instance the name resolves to may legitimately be a *new* one when
 * the bag was rebuilt between capture and restore.
 */
const spellNamed = (unit: Champion, name: string): Spell | null => {
  for (const spell of unit.spells ?? []) if (spell && spell.name === name) return spell;
  for (const held of unit.items ?? []) {
    if (held?.passive?.name === name) return held.passive;
    if (held?.active?.name === name) return held.active;
  }
  if (unit.passive?.name === name) return unit.passive;
  if (unit.recall?.name === name) return unit.recall;
  return null;
};

/**
 * Per-slot diff, the LAN client's own `applyBag` shape: a slot already
 * holding the wanted item is left untouched — its spells stay armed, its
 * effects stand — and only a slot that changed is unequipped and rebuilt. An
 * id nothing installs leaves the slot empty rather than throwing, the
 * template-bag policy.
 */
const restoreBagSlots = (unit: Champion, slots: readonly (string | null)[]): void => {
  const held = unit.items ?? [];
  for (let slot = 0; slot < held.length; slot++) {
    const wanted = slots[slot] ?? null;
    const current = held[slot]?.def?.id ?? null;
    if (current === wanted) continue;
    if (held[slot]) unit.unequipItem(slot);
    if (!wanted) continue;
    const def = contentCatalog().item(wanted);
    if (!def) continue;
    const built = buildHeldItem(unit, def);
    if (built) unit.equipItem(built, slot);
  }
};

/**
 * Rebuild one recorded buff on its original target: construct through the
 * shared three-argument signature, write the scalars back *before* adding —
 * so `onCreate` reads restored state, exactly the way live callers set
 * fields between `new` and `addBuff` — re-link the source spell by name, and
 * hand it to `addBuff` so the ordinary stacking rules run. Re-adding in
 * captured order is what keeps a REPLACE_EXISTING family from evicting the
 * wrong twin. A constructor with sharper needs than the shared signature is
 * skipped rather than crashed on.
 */
const restoreBuff = (unit: Champion, snap: CheckpointBuff): void => {
  let buff: Buff;
  try {
    buff = new snap.make(snap.duration, snap.sourceUnit, snap.targetUnit);
  } catch {
    return;
  }
  assignScalars(buff, snap.fields);
  if (snap.stackId !== null) buff.stackId = snap.stackId;
  if (snap.sourceSpellName) buff.sourceSpell = spellNamed(unit, snap.sourceSpellName);
  unit.addBuff(buff);
};

/**
 * One participant, written back in place. Order is the contract here:
 *
 * 1. alive first — `addBuff` refuses a corpse, and a revive must clear the
 *    death state before the death camera's next tick reads it;
 * 2. current buffs unwound through `deactivateBuff`, so status flags and
 *    stat modifiers are handed back properly;
 * 3. the bag, by per-slot diff;
 * 4. body and wallet;
 * 5. spell scalars, then cooldowns, then the stack contract;
 * 6. the recorded buffs, in order;
 * 7. pools last, so the composed write solves under the restored modifiers;
 * 8. and the death state re-applied at the end when the moment was a corpse
 *    — set directly, never through `die()`, which would pay a bounty and
 *    count a death for a rewind.
 */
const applyUnitInPlace = (
  unit: Champion,
  state: MomentUnitState,
  bagSlots?: readonly (string | null)[],
  buffs?: readonly CheckpointBuff[]
): void => {
  unit.deathData = null;

  for (const buff of unit.buffs.slice()) buff.deactivateBuff();
  unit.buffs.length = 0;

  if (bagSlots) restoreBagSlots(unit, bagSlots);

  unit.teleportTo(state.x, state.y);
  unit.wallet?.syncTo(state.gold);

  const spells = unit.spells ?? [];
  for (let i = 0; i < spells.length; i++) {
    const spell = spells[i];
    const snap = state.spells[i];
    if (!spell || !snap) continue;
    assignScalars(spell, snap.fields);
    spell.currentCooldown = snap.cooldownMs;
    if (snap.stacks !== null) spell.setStackCount(snap.stacks);
  }

  if (buffs) for (const snap of buffs) restoreBuff(unit, snap);

  setComposedValue(unit.stats.health, state.health);
  setComposedValue(unit.stats.mana, state.mana);

  if (state.dead) {
    unit.stats.health.baseValue = 0;
    unit.deathData = { reviveAfter: state.reviveAfterMs };
    unit.pathAgent?.clear();
    unit.basicAttack?.clear();
  }
};

/**
 * Everything in flight is dropped, not restored: missiles, spell zones,
 * summons, minions. Floating combat text stays — it is presentation of the
 * past, not state. Both object lists are swept because the pending queue can
 * hold objects while the panel keeps the match paused.
 */
const clearTransientObjects = (world: CheckpointWorld): void => {
  const lists = [world.objectManager.objects, world.objectManager._objectToBeAdd];
  for (const list of lists) {
    for (const object of list) {
      if (object instanceof Minion || object instanceof Pet) {
        object.toRemove = true;
        continue;
      }
      if (object instanceof SpellObject && !(object instanceof CombatText)) {
        object.toRemove = true;
      }
    }
  }
  for (const minion of world.minionSpawner.minions) minion.toRemove = true;
};

const applyWaveClock = (spawner: WaveClockLike, clock: MomentMinionClock | null): void => {
  if (spawner._queue) spawner._queue.length = 0;
  if (!clock) return;
  if (typeof spawner._elapsedMs === 'number') spawner._elapsedMs = clock.elapsedMs;
  if (typeof spawner._nextWaveIn === 'number') spawner._nextWaveIn = clock.nextWaveIn;
  if (typeof spawner.waveCount === 'number') spawner.waveCount = clock.waveCount;
};

const applyMonsterState = (monster: Monster, state: MomentMonsterState): void => {
  if (monster.isDead && !state.dead) monster.respawn();
  if (!state.dead) {
    monster.teleportTo(state.x, state.y);
    setComposedValue(monster.stats.health, state.health);
    return;
  }
  // Dead with a clock left on it. Direct writes, never `die()`: a rewind
  // must not pay a bounty or fire a kill reward a second time.
  monster.targetLock = null;
  monster.phase = Monster.PHASES.IDLE;
  monster.stats.health.baseValue = 0;
  monster.deathData = { reviveAfter: state.reviveAfterMs };
  monster.pathAgent?.clear();
};

/**
 * Camps back to the moment, in place when the standing list still matches
 * body for body — the in-session case, where the list is stable — and
 * through a full despawn-and-`spawnJungle` when it does not (a reopened
 * moment, mostly). A world whose freshly spawned camp count STILL differs
 * (other packs installed) keeps its fresh camps rather than guessing which
 * body was which.
 */
const applyMonsters = (world: CheckpointWorld, states: MomentMonsterState[] | null): void => {
  if (!states || !world.director.jungleEnabled) return;
  if (world.monsters.length !== states.length) {
    for (const monster of world.monsters) monster.toRemove = true;
    world.monsters.length = 0;
    world.spawnJungle();
  }
  if (world.monsters.length !== states.length) return;
  for (let i = 0; i < states.length; i++) applyMonsterState(world.monsters[i], states[i]);
};

/**
 * The in-session rewind — full fidelity, same instances. Answers whether it
 * ran: false with a LAN session attached, where the protocol is forward-only
 * and a host rewinding under its clients would desync the room.
 */
export const restoreCheckpoint = (world: CheckpointWorld, checkpoint: Checkpoint): boolean => {
  if (world.net) return false;

  world.matchTimeMs = checkpoint.matchTimeMs;
  // The future being erased was announced: kill banners and sprees stamped
  // after the target would otherwise carry negative age forever and never
  // leave the screen.
  world.announcer?.rewindTo(checkpoint.matchTimeMs);
  clearTransientObjects(world);
  applyWaveClock(world.minionSpawner, checkpoint.overlay.minionClock);
  applyMonsters(world, checkpoint.overlay.monsters);

  const states = [checkpoint.overlay.player, ...checkpoint.overlay.bots];
  for (let i = 0; i < checkpoint.units.length && i < states.length; i++) {
    const entry = checkpoint.units[i];
    // A bot removed from the roster since the save: its object is marked (or
    // already swept). Restore-in-place restores what still stands and leaves
    // the removal alone — the roster is a setting, not part of the moment's
    // fight state, and rebuilding it here would be a second, worse
    // `applyConfig`.
    if (entry.unit.toRemove) continue;
    applyUnitInPlace(entry.unit, states[i], entry.bagSlots, entry.buffs);
  }
  return true;
};

/**
 * The cross-session half: lay a persisted moment's overlay over a world the
 * "Trận mẫu" boot path just built from the same setup. Bags were granted at
 * boot (the template item stash), so only the numbers are written here.
 * Transient buffs are not part of a persisted moment — spell-held state,
 * which includes every stack the `stackCount` contract can name and every
 * plain scalar a spell keeps on itself, is what crosses.
 */
export const applyMomentOverlay = (world: CheckpointWorld, overlay: MomentOverlay): void => {
  world.matchTimeMs = overlay.matchTimeMs;
  // A fresh boot holds seconds of feed at most, but the clock jump is the same.
  world.announcer?.rewindTo(overlay.matchTimeMs);
  applyWaveClock(world.minionSpawner, overlay.minionClock);
  applyMonsters(world, overlay.monsters);

  applyUnitInPlace(world.player, overlay.player);
  const bots = world.director.bots();
  for (let i = 0; i < bots.length && i < overlay.bots.length; i++) {
    applyUnitInPlace(bots[i], overlay.bots[i]);
  }
};
