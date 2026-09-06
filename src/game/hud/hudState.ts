/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Everything the HUD needs to *know*, with no opinion on how it is drawn.
 *
 * This is the shared layer both view layers (`DesktopHudView`, `MobileHudView`)
 * read from. It exists so the desktop and mobile HUDs can be extended
 * independently without ever forking the arithmetic that turns a `Game` into
 * "66/100 health" or "this spell is greyed out" — that logic is written once,
 * here, and both views only choose how to lay the result out.
 */
import type Game from '@/game/Game';
import { HotKeys, ItemHotKeys, SpellHotKeys } from '@/game/constants';
import { INVENTORY_SIZE } from '@/game/items/Item';
import { atOwnFountain } from '@/game/economy/ItemShop';
import type MatchAnnouncer from '@/game/combat/Announcer';
import TeamId from '@/game/enums/TeamId';
import {
  FEED_ROWS,
  FEED_TTL_MS,
  bannerText,
  multiKillTier,
  type Announcement,
  type AnnouncementKind,
  type AnnouncementSide,
  type AnnouncementTag,
  type BannerKind,
  type ObjectiveKind,
} from '@/game/combat/Announcer';
import { MAX_FEED_VICTIMS, groupKillFeed, type KillFeedGroup } from '@/game/hud/killFeedGroups';
import AssetManager, { type AssetHandle } from '@/managers/AssetManager';
import { statLinesFor, type StatLine } from '@/game/hud/itemStatLines';

function ensureVisibleAsset(asset: Pick<AssetHandle, 'key' | 'status'> | undefined): void {
  if (asset?.key && asset.status === 'idle') {
    void AssetManager.ensure(asset.key).catch(error => console.warn(error));
  }
}

/**
 * How often the HUD reads the game, in milliseconds.
 *
 * It used to run on every animation frame, which meant rebuilding the spell and
 * buff arrays sixty times a second and handing Vue a fresh identity for every
 * one of them — style recalculation and patching on a phone that is already
 * several times slower than the desktop this was written on. Nothing here
 * changes fast enough to need it: the health bar carries a 0.1s CSS transition
 * that smooths the gaps, the cooldown numbers are whole seconds, and the wedge
 * is a percentage nobody can read to the frame. 50ms is twenty reads a second,
 * which is still four times finer than the fastest thing on screen.
 */
export const HUD_UPDATE_INTERVAL_MS = 50;

export interface SpellDisplay {
  instance: any;
  image: string;
  disabled: boolean;
  coolDown: number;
  currentCooldown: number;
  state: string;
  name: string;
  description: string;
  coolDownText: number;
  coolDownPercent: number;
  showCoolDown: boolean;
  /** True only for a real wait. A swing rhythm gets the wedge and nothing else. */
  lockedOut: boolean;
  small: boolean;
  canCast: boolean;
  hotKey: string;
  /** Undefined for spells that do not accumulate anything. */
  stackCount?: number;
  manaCost: number;
  /** False once the pool has dropped below manaCost, which greys the icon. */
  affordable: boolean;
  /**
   * The ability is running right now — a toggle that is on, an active window
   * open, a channel under way. See `Spell.isSustaining`.
   *
   * Deliberately not the same question as `showCoolDown`: a spell whose
   * cooldown starts at `'start'` is running and counting down at once, and
   * before this existed a toggle drew exactly the same icon on and off.
   */
  sustaining: boolean;
  /** Pressing the key again turns it off. Drives an on/off badge, not a clock. */
  toggle: boolean;
  /** 0..100 of the sustain left. **0 when it has no declared end**, not 100. */
  sustainPercent: number;
  /** Whole seconds left; 0 when it has no declared end. */
  sustainSecondsLeft: number;
}

export interface BuffDisplay {
  image: string;
  duration: number;
  timeElapsed: number;
  timeLeftText: number;
  stacks: number;
  /**
   * What the buff calls itself — `Buff.name`, which core's own buffs set to a
   * Vietnamese word ('Choáng', 'Khiên', 'Chậm') and everything else inherits
   * from its class name.
   *
   * Here because the row is hoverable now. Six unlabelled icons under the
   * portrait is a row a player can only learn by having been hit by each of
   * them once and remembering the picture; the name and the remaining time
   * were both already known and simply never shown.
   */
  name: string;
  /** `Buff.description`, '' for the many that declare none. */
  description: string;
  /** The one line under the name in the hover panel: how long is left. */
  note: string;
}

/** One source line inside a death-recap attacker row. */
export interface DeathRecapSourceRow {
  /** The ability's own name when the damage named one, else the type's label. */
  label: string;
  /** The ability's icon URL, '' when no live spell matched the label. */
  image: string;
  amount: number;
  hits: number;
  /** 'PHYSICAL' | 'MAGIC' | 'TRUE' — the panel colours the number with it. */
  type: string;
  /** What a shield or damage reduction ate out of these hits. `0` for most. */
  blocked: number;
}

/** One attacker in the death recap, heaviest first. */
export interface DeathRecapRow {
  attacker: string;
  total: number;
  /** What this attacker's hits lost to a shield before reaching health. */
  blocked: number;
  sources: DeathRecapSourceRow[];
}

/**
 * The death recap: who killed the player and what the last seconds of damage
 * were made of, the way the source game retells a death. Built off
 * `AttackableUnit.deathRecap`, which `die()` snapshots from the rolling
 * damage ledger. `seq` bumps per death so the HUD can re-show a dismissed
 * panel on the next one.
 */
export interface DeathRecapDisplay {
  seq: number;
  killer: string;
  total: number;
  /**
   * What this player dealt over **the same window** the rows above cover,
   * split by kind.
   *
   * Same window on purpose: the comparison a player is making is "that fight
   * went badly — how badly", and match totals answered a different question
   * with the same-looking number. `AttackableUnit.recentDamageDealtLog` is the
   * other end of the ledger the rows come from, pruned by the same rule.
   */
  dealt: { physical: number; magic: number; true: number };
  /**
   * Everything a shield or a damage-reduction buff absorbed in the same
   * window — the number the recap used to leave out entirely.
   *
   * Beside `total` rather than folded into it: they answer different
   * questions ("what killed me" against "what saved me"), and adding them
   * would inflate the figure a player checks against their own health pool.
   */
  blocked: number;
  rows: DeathRecapRow[];
}

export interface StatsDisplay {
  health: number;
  maxHealth: number;
  mana: number;
  maxMana: number;
  healthPercent: number;
  manaPercent: number;
  shieldPercent: number;
  shieldLeftPercent: number;
  shield: number;
}

/**
 * Hồi Thành, which is not a `SpellDisplay` because it is not in `spells[]` —
 * it lives on `Champion.recall` (see that class's comment for why) and the bar
 * is built by index off the kit. Its own row here keeps that separation
 * visible instead of smuggling an eighth slot into a seven-slot array.
 */
export interface RecallDisplay {
  name: string;
  description: string;
  /** `B`. The key is one way in, not the definition of the action. */
  hotKey: string;
  /** The trip home is running, so the button now cancels it. */
  channeling: boolean;
  /** 0..100 through the channel, clamped: the button fills by this. */
  progressPercent: number;
  /** Whole seconds of channel left. 0 while it is not running. */
  secondsLeft: number;
  /** False for a corpse, a silenced champion, or a disabled recall. */
  canCast: boolean;
}

/**
 * One inventory slot. **Always six of them**, filled or not: the row is a
 * fixed shape a player learns the position of, and a list that grew as items
 * were bought would move every key under their thumb.
 */
export interface ItemSlotDisplay {
  filled: boolean;
  /** '' for an empty slot, and for an item whose pack named art nothing registered. */
  image: string;
  name: string;
  /**
   * What this item grants, one stat to a line — the same lines the shop card
   * shows, from the same function, so the two never disagree about what an
   * item is worth or what order to read it in.
   *
   * The tooltip had none of this and the packs worked around that by opening
   * every description with its own stat block in prose. That put the numbers
   * on screen twice inside the shop and in one flat colour outside it. With
   * the list here, a description can go back to being the passive, the active
   * and the notes.
   */
  stats: StatLine[];
  /** The passive, the active, the notes. **Not** the stat block above. */
  description: string;
  /**
   * '1'..'6', or **''** for an item with no active.
   *
   * A key printed on something that does nothing when pressed is a promise the
   * bar does not keep — and most items are exactly that: stats and a passive.
   */
  hotKey: string;
  hasActive: boolean;
  coolDownPercent: number;
  coolDownText: number;
  showCoolDown: boolean;
  canCast: boolean;
  /** The active is running — same question, same answer, as `SpellDisplay.sustaining`. */
  sustaining: boolean;
}

/**
 * The champion's own passive: a spell it *has* rather than one it casts, so it
 * carries no key, no cooldown and no cost. Null for the champions that have
 * none, which is most of them, and null for one whose spell has no icon —
 * there is nothing to draw, and an empty square in the bar reads as a bug.
 */
export interface PassiveDisplay {
  image: string;
  name: string;
  description: string;
}

/** One kill-feed row, from the player's side of it. */
export interface FeedSideDisplay {
  name: string;
  avatar: string;
  side: 'ally' | 'enemy';
}

/** One champion on a feed row's victim list. `seq` is the kill that added them. */
export interface FeedVictimDisplay extends FeedSideDisplay {
  seq: number;
}

export interface FeedRowDisplay {
  /** The seq of the kill that opened the row; stable while a run grows onto it. */
  seq: number;
  killer: FeedSideDisplay | null;
  /**
   * Who this killer took down in one run, **newest first** — a single kill is
   * a list of one. Capped at `MAX_FEED_VICTIMS`; the older ones past the cap
   * are `overflow`. See `killFeedGroups.ts` for why a run is one row.
   */
  victims: FeedVictimDisplay[];
  /** The older victims past the cap, counted rather than drawn. 0 when they all fit. */
  overflow: number;
  /**
   * Set when the row is an objective falling rather than a champion dying — a
   * turret, an epic camp. The victim has no portrait to draw, so `KillFeed.vue`
   * puts the glyph for the kind in its place.
   */
  objective?: ObjectiveKind;
  /** "Máu đầu", "Song sát", "Chuỗi 5" — see `announcementTags`. */
  tags: AnnouncementTag[];
  /**
   * The row's colour family. A run is the one thing that must read
   * differently from a kill at a glance, so it wins over the rest; a plain
   * kill has none.
   */
  accent: AnnouncementKind | null;
  /** 1 fresh, falling to 0 over the row's last moment on screen. */
  fade: number;
  /** The player killed or died here. */
  mine: boolean;
}

export interface BannerDisplay {
  seq: number;
  kind: BannerKind;
  title: string;
  subtitle: string;
  /**
   * How loud to draw it: 0 for an ordinary moment, then 2..`MAX_MULTI_TIER`
   * as a multi-kill climbs. `hud.css` scales the type and the glow off this,
   * and stops where the words stop changing.
   */
  tier: number;
}

export interface FeedDisplay {
  rows: FeedRowDisplay[];
  banner: BannerDisplay | null;
}

/** One champion on the quick scoreboard. */
export interface ScoreboardRow {
  id: string;
  name: string;
  avatar: string;
  isPlayer: boolean;
  isDead: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  gold: number;
  damage: number;
  /** Kills since this champion last died — `MatchAnnouncer.streakOf`; 0 without an announcer. */
  streak: number;
  /** Whole seconds until the corpse stands up; 0 while alive. Painted over the grey portrait. */
  reviveAfter: number;
  /**
   * Always `INVENTORY_SIZE` entries, the same shape the inventory bar reads,
   * so the scoreboard's hover shows exactly the card the owner would see —
   * stats and prose included.
   */
  items: ItemSlotDisplay[];
}

export interface ScoreboardTeam {
  teamId: string;
  label: string;
  modifier: 'blue' | 'red' | 'other';
  /** The player's own side — listed first. */
  mine: boolean;
  kills: number;
  rows: ScoreboardRow[];
}

export interface ScoreboardDisplay {
  teams: ScoreboardTeam[];
}

export interface HudState {
  avatar: string;
  isDead: boolean;
  reviveAfter: number;
  /**
   * The ally the camera is on while dead — `Game.deathCamera.watching`'s
   * name — or null on the corpse and while alive. The spectate pill's label.
   */
  spectating: string | null;
  stats: StatsDisplay;
  spells: SpellDisplay[];
  buffs: BuffDisplay[];
  /** Null for a unit with no recall at all — a headless test, mostly. */
  recall: RecallDisplay | null;
  /** Null while alive (or before the first death). See `DeathRecapDisplay`. */
  deathRecap: DeathRecapDisplay | null;
  /** The kill feed and the banner. Empty for a context with no announcer. */
  feed: FeedDisplay;
  /** Every champion in the match, by team, for the Tab glance. */
  scoreboard: ScoreboardDisplay;
  /** `Game.matchTimeMs` as m:ss — the score strip's clock. */
  clock: string;
  /** Whole coins. 0 for a unit with no wallet — a minion, a pet, a test double. */
  gold: number;
  /** Always `INVENTORY_SIZE` entries. See `ItemSlotDisplay`. */
  items: ItemSlotDisplay[];
  passive: PassiveDisplay | null;
  /**
   * The shop is reachable from where this champion is standing.
   *
   * Read through `ItemShop.atOwnFountain` rather than restated here: the bar
   * lighting up somewhere the shop would then refuse is worse than no light at
   * all, and one rule with two implementations is how that happens. It is what
   * teaches the rule — a pill that brightens at the fountain says "here" in
   * one match, where a button that silently refuses says nothing.
   */
  canShop: boolean;
  /**
   * Whether a fight save point exists to rewind to — false in a LAN match,
   * where rewinding is refused wholesale. Drives the death screen's "Thử lại
   * từ mốc gần nhất" shortcut, which must not render a button that would do
   * nothing.
   */
  hasCheckpoint: boolean;
  /**
   * Whether the player has saved a point on purpose this match — the auto
   * "Đầu trận" anchor does not count. Arms the death shortcut's instant
   * rewind; without it the same button opens the modal to choose from.
   */
  hasManualCheckpoint: boolean;
}

function buildStats(player: any): StatsDisplay {
  const { health, maxHealth, mana, maxMana } = player.stats || {};
  const healthPercent = Math.min((health?.value as number) / maxHealth?.value, 1) * 100;
  const shield = player.shieldAmount ?? 0;
  const shieldPercent = Math.min(shield / (maxHealth?.value || 1), 1) * 100;
  return {
    health: ~~health?.value,
    maxHealth: ~~maxHealth?.value,
    mana: ~~mana?.value,
    maxMana: ~~maxMana?.value,
    healthPercent,
    manaPercent: Math.min((mana?.value as number) / maxMana?.value, 1) * 100,
    shield: ~~shield,
    shieldPercent,
    shieldLeftPercent: Math.min(healthPercent, 100 - shieldPercent),
  };
}

function buildSpells(player: any): SpellDisplay[] {
  const mana = player.stats?.mana;
  return (player.spells || [])
    .filter((i: any) => i?.image?.path)
    .map((spell: any, index: number) => {
      ensureVisibleAsset(spell.image);
      const isInternalSpell = index === 0;
      const isSummonerSpell = index > 4;
      const hotKey = SpellHotKeys[index]
        ? String.fromCharCode(SpellHotKeys[index]).toUpperCase()
        : '';

      const { disabled, image, state, currentCooldown, name, description, stackCount } =
        spell || {};

      // The *effective* numbers, not the spell's own tuning fields: under a
      // cooldown-reduction or URF match those differ, and the icon has to agree
      // with what the cast path actually charges and waits. `currentCooldown`
      // already counts down from the reduced duration, so using the raw
      // `coolDown` as the denominator would also under-fill the sweep.
      // These are equipped spells, so an owner and its match rules always
      // exist — ownerless instances built by `pregameCatalog` cannot see match
      // rules and stay on raw numbers.
      const coolDown = spell?.effectiveCoolDownMs ?? spell?.coolDown ?? 0;
      const manaCost = spell?.effectiveManaCost ?? spell?.manaCost ?? 0;
      // And the description, for exactly the same reason: its damage is
      // authored text with the first-frame number baked in, while `takeDamage`
      // multiplies by this owner's ability power. The bar promised 15 for the
      // whole match however much power the player bought.
      const effectiveDescription = spell?.effectiveDescription ?? description;

      // `=== true` rather than a truthy read: an ownerless catalogue instance
      // and a spell from a pack built against an older core both answer
      // `undefined` here, and neither may make the bar throw or glow.
      const sustaining = spell?.isSustaining === true;
      const sustainDurationMs = sustaining ? (spell?.sustainDurationMs ?? 0) : 0;

      return {
        instance: spell,
        image: image?.path,
        disabled,
        coolDown,
        currentCooldown,
        state,
        name,
        description: effectiveDescription,
        coolDownText: Math.ceil(currentCooldown / 1000),
        coolDownPercent: coolDown > 0 ? Math.min((currentCooldown / coolDown) * 100, 100) : 0,
        showCoolDown: currentCooldown > 0,
        // `!== false` so a spell that never heard of the flag still reads as a
        // lockout, which is what every cooldown but the swing timer is.
        lockedOut: currentCooldown > 0 && spell?.cooldownLocksOut !== false,
        small: isInternalSpell || isSummonerSpell,
        // Per spell, not per champion: a spell that declines the crowd-control
        // rule (`Spell.castableWhileControlled` — a cleanse) is pressable while
        // its owner is stunned, and greying it out then would be the bar lying
        // about the one moment it matters.
        canCast: (player.canCast || spell?.castableWhileControlled === true) && !player.isDead,
        hotKey,
        stackCount,
        manaCost,
        affordable: (mana?.value ?? 0) >= manaCost,
        sustaining,
        toggle: spell?.isToggle === true,
        // A duration of 0 means "no declared end" (`SpellRuntime.sustainDurationMs`),
        // so the percentage is 0 rather than a bar filling toward nothing.
        sustainPercent:
          sustainDurationMs > 0
            ? Math.min(
                100,
                Math.max(0, ((spell?.sustainRemainingMs ?? 0) / sustainDurationMs) * 100)
              )
            : 0,
        sustainSecondsLeft:
          sustainDurationMs > 0 ? Math.ceil((spell?.sustainRemainingMs ?? 0) / 1000) : 0,
      };
    });
}

const EMPTY_SLOT: Omit<ItemSlotDisplay, 'hotKey'> = {
  filled: false,
  image: '',
  name: '',
  stats: [],
  description: '',
  hasActive: false,
  coolDownPercent: 0,
  coolDownText: 0,
  showCoolDown: false,
  canCast: false,
  sustaining: false,
};

/**
 * Six slots, always. See `ItemSlotDisplay` for why the empty ones are here.
 *
 * The icon comes off `HeldItem.icon`, an already-resolved handle, rather than
 * being looked up from the def's key: `AssetManager.get` throws on an unknown
 * key and this function runs twenty times a second, so a pack with one bad
 * icon key would take the whole bar down mid match. `ItemShop` does that
 * lookup once, at purchase, and guards it.
 */
function buildItems(player: any): ItemSlotDisplay[] {
  const held = player.items ?? [];
  const slots: ItemSlotDisplay[] = [];

  for (let slot = 0; slot < INVENTORY_SIZE; slot++) {
    const item = held[slot];
    const key = ItemHotKeys[slot] ? String.fromCharCode(ItemHotKeys[slot]).toUpperCase() : '';

    if (!item) {
      slots.push({ ...EMPTY_SLOT, hotKey: '' });
      continue;
    }

    ensureVisibleAsset(item.icon);
    const active = item.active ?? null;
    // `effectiveCoolDownMs`, not the spell's own tuning field, for the same
    // reason `buildSpells` uses it: under a cooldown-reduction match the two
    // differ and the icon has to agree with what the cast path actually waits.
    let coolDown = active?.effectiveCoolDownMs ?? active?.coolDown ?? 0;
    let currentCooldown = active?.currentCooldown ?? 0;

    // A passive that is re-arming counts down on the slot exactly the way an
    // active's cooldown does — see `Buff.rearmMsLeft`. The active's own
    // cooldown wins while it runs (it is the one blocking a press); the rearm
    // fills the slot's silence the rest of the time, which for a passive-only
    // item like a Guardian Angel is the only clock it has.
    if (currentCooldown <= 0 && Array.isArray(player.buffs)) {
      for (const buff of player.buffs) {
        if (buff?.toRemove || !(buff?.rearmMsLeft > 0) || !buff.sourceSpell) continue;
        if (buff.sourceSpell !== item.passive && buff.sourceSpell !== item.active) continue;
        if (buff.rearmMsLeft > currentCooldown) {
          currentCooldown = buff.rearmMsLeft;
          coolDown = buff.rearmTotalMs || buff.rearmMsLeft;
        }
      }
    }

    slots.push({
      filled: true,
      image: item.icon?.path ?? '',
      name: item.def?.name ?? '',
      stats: statLinesFor(item.def),
      // **Not** rescaled, unlike a spell's. An item's abilities are the one
      // population `economy/ItemShop` opts out of ability power by hand
      // (`damageScalesWithAbilityPower = false`, because they already read
      // `attackDamage` and must not be paid for out of two stats), so an
      // item's printed damage is the damage it deals at every point in the
      // match. This line ran through `amplifiedDamageText` for one commit and
      // promised a flat 30 as `30 (+60)` — the exact failure the rescaling
      // exists to prevent, pointed the other way.
      description: item.def?.description ?? '',
      hotKey: active ? key : '',
      hasActive: !!active,
      coolDownPercent: coolDown > 0 ? Math.min((currentCooldown / coolDown) * 100, 100) : 0,
      coolDownText: Math.ceil(currentCooldown / 1000),
      showCoolDown: currentCooldown > 0,
      canCast:
        !!active &&
        (!!player.canCast || active?.castableWhileControlled === true) &&
        !player.isDead,
      sustaining: active?.isSustaining === true,
    });
  }

  return slots;
}

/**
 * The passive, or null. Null for a champion with none *and* for one whose
 * passive spell carries no icon — the bar has nothing to draw, and an empty
 * square in a row of artwork reads as a broken image rather than as a feature.
 */
function buildPassive(player: any): PassiveDisplay | null {
  const passive = player.passive;
  if (!passive?.image?.path) return null;
  ensureVisibleAsset(passive.image);
  return {
    image: passive.image.path,
    name: passive.name ?? '',
    description: passive.description ?? '',
  };
}

/**
 * One `BuffDisplay` object per kind of buff, reused between reads.
 *
 * `buildBuffs` used to mint a fresh object every 50ms, which this file's own
 * `HUD_UPDATE_INTERVAL_MS` comment already calls out as the thing to avoid —
 * and it became a correctness problem, not just a cost one, the moment the row
 * grew a hover panel. `HudInteractions.showSpellInfo` keeps the *object* it was
 * handed, so a countdown read off a snapshot taken at hover time freezes at
 * whatever it said then and sits there being wrong for as long as the pointer
 * rests on the icon.
 *
 * Keyed by `stackId ?? constructor`, the same identity the aggregation below
 * groups on: both are stable for the life of the process, and the map is
 * bounded by how many kinds of buff the installed content declares — not by
 * how many are applied, and not by how long the match runs.
 */
const buffDisplays = new Map<unknown, BuffDisplay>();

/** How long is left, in the words the hover panel puts under the name. */
function buffNote(duration: number, timeLeft: number, stacks: number): string {
  const parts: string[] = [];
  // duration 0 is `Buff`'s "never expires" — a countdown there would be a
  // number counting down to nothing.
  parts.push(duration > 0 ? `còn ${Math.max(0, Math.ceil(timeLeft / 1000))}s` : 'vĩnh viễn');
  if (stacks > 1) parts.push(`${stacks} lớp`);
  return parts.join(' · ');
}

/**
 * One row per kind of buff, not per stack: one stacking spell alone can hold hundreds of
 * StatAmp instances, which used to render hundreds of icons. The longest
 * remaining instance drives the countdown.
 */
function buildBuffs(player: any): BuffDisplay[] {
  const buffRows = new Map<any, BuffDisplay>();
  for (const buff of player.buffs || []) {
    if (!buff?.image?.path) continue;
    // Display-only opt-out — a permanent item passive's armed state. See
    // `Buff.hudVisible`; `=== false` so a plain test double stays visible.
    if (buff.hudVisible === false) continue;
    ensureVisibleAsset(buff.image);

    const key = buff.stackId ?? buff.constructor;
    const timeLeft = (buff.duration || 0) - (buff.timeElapsed || 0);
    const existing = buffRows.get(key);
    // A `countedStacks` buff (`src/game/gameObject/Buff.ts` — a permanent,
    // uniform stat stack) is one instance carrying its whole
    // count on `.stacks`; every other buff has never heard of that field, so
    // this falls back to 1 and behaves exactly as a plain per-instance count.
    const stacks = buff.stacks ?? 1;

    if (existing) {
      existing.stacks += stacks;
      if (buff.duration && timeLeft > existing.duration - existing.timeElapsed) {
        existing.duration = buff.duration;
        existing.timeElapsed = buff.timeElapsed;
        existing.timeLeftText = Math.ceil(timeLeft / 1000);
      }
      existing.note = buffNote(
        existing.duration,
        existing.duration - existing.timeElapsed,
        existing.stacks
      );
      continue;
    }

    // The same object as last read when this kind was up then — see
    // `buffDisplays`. Every field is written here, so an entry coming back
    // after a gap carries nothing over from the last time it was on.
    const display = buffDisplays.get(key) ?? ({} as BuffDisplay);
    buffDisplays.set(key, display);
    display.image = buff.image.path;
    display.duration = buff.duration;
    display.timeElapsed = buff.timeElapsed;
    // duration 0 is `Buff`'s "never expires": no countdown, rather than the
    // negative seconds a permanent buff used to count into.
    display.timeLeftText = buff.duration ? Math.ceil(timeLeft / 1000) : 0;
    display.stacks = stacks;
    display.name = buff.name ?? '';
    display.description = buff.description ?? '';
    display.note = buffNote(buff.duration, timeLeft, stacks);
    buffRows.set(key, display);
  }
  return [...buffRows.values()];
}

/**
 * The channel's length comes off the spell's own `castSpec.channel`, never off
 * a copy of `RECALL_CHANNEL_MS` — retuning the constant must not mean editing
 * the HUD, and importing the spell here would drag it into this shared layer.
 */
function buildRecall(player: any): RecallDisplay | null {
  const recall = player.recall;
  if (!recall) return null;
  // A match without recall (`MatchRules.recall`) has no button for it either:
  // a greyed-out B that never works reads as broken, an absent one as a rule.
  if (player.game?.matchRules?.recall === false) return null;

  const durationMs = recall.castSpec?.channel?.durationMs ?? 0;
  const progress = Math.min(1, Math.max(0, recall.channelProgress ?? 0));

  return {
    name: recall.name ?? '',
    description: recall.description ?? '',
    hotKey: String.fromCharCode(HotKeys.B),
    channeling: recall.state === 'CHANNELING',
    progressPercent: progress * 100,
    secondsLeft: Math.ceil(((1 - progress) * durationMs) / 1000),
    canCast: !!player.canCast && !player.isDead && !recall.disabled,
  };
}

/** The type labels the recap falls back to when no ability named itself. */
const DAMAGE_TYPE_LABEL: Record<string, string> = {
  PHYSICAL: 'Sát thương vật lý',
  MAGIC: 'Sát thương phép',
  TRUE: 'Sát thương chuẩn',
};

/** A source label, as the icon map keys it: codename trimmed, case folded. */
const sourceKeyOf = (name: string): string =>
  name
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .toLowerCase();

/**
 * label -> iconUrl, read off the spells actually living in this match.
 *
 * The ledger stores display labels, not ids — and resolving a bare id
 * through the catalog is the qualified-id swamp (`summonerIdOr`'s trap).
 * Every live `Spell` already carries its own `name` and `image`, so one walk
 * over the world's champions — kits, passives, item spells — answers the
 * lookup for any installed pack, with no registry and no chunk crossing.
 * Cached per death: icons do not change while the corpse reads them.
 */
let recapIconCache: { recap: unknown; icons: Map<string, string> } | null = null;
function recapIconsFor(player: any, recap: unknown): Map<string, string> {
  // Keyed on the recap object itself, not its seq: seq restarts per unit, so
  // a fresh match's first death would otherwise wear the last match's icons.
  if (recapIconCache?.recap === recap) return recapIconCache.icons;
  const icons = new Map<string, string>();
  const claim = (
    spell:
      { name?: string; image?: { path?: string; key?: string; status?: string } } | null | undefined
  ): void => {
    const name = spell?.name;
    const path = spell?.image?.path;
    if (!name || !path) return;
    const key = sourceKeyOf(name);
    if (!icons.has(key)) {
      ensureVisibleAsset(spell.image as AssetHandle);
      icons.set(key, path);
    }
  };
  const units: any[] = player.game?.objectManager?.objects ?? [];
  for (const unit of [player, ...units]) {
    if (!Array.isArray(unit?.spells)) continue;
    for (const spell of unit.spells) claim(spell);
    claim(unit.passive);
    claim(unit.recall);
    if (Array.isArray(unit.items)) {
      for (const held of unit.items) {
        claim(held?.passive);
        claim(held?.active);
      }
    }
  }
  recapIconCache = { recap, icons };
  return icons;
}

/** A row's last moment: it thins out over this long before it goes. */
const FEED_FADE_MS = 1_500;

/** m:ss, hours folded into the minutes: a match here has no end to count down to. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

const TEAM_LABEL: Record<string, { label: string; modifier: ScoreboardTeam['modifier'] }> = {
  [TeamId.BLUE]: { label: 'Đội Xanh', modifier: 'blue' },
  [TeamId.RED]: { label: 'Đội Đỏ', modifier: 'red' },
};

/**
 * Every champion on the board, grouped by side, the player's side first.
 * Read off the live objects rather than the director's roster so a LAN
 * client — which has no director and builds its champions from the wire —
 * sees the same board the host does. Pets are champions by class and are
 * left out by their `killCredit`, the same way the kill feed leaves them out.
 */
function buildScoreboard(game: any, player: any): ScoreboardDisplay {
  const objects: any[] = game?.objectManager?.objects ?? [];
  const announcer = game?.announcer as MatchAnnouncer | undefined;
  const byTeam = new Map<string, ScoreboardRow[]>();
  for (const unit of objects) {
    if (!unit || unit.killCredit !== 'champion' || !unit.tally || unit.toRemove) continue;
    ensureVisibleAsset(unit.avatar);
    const row: ScoreboardRow = {
      id: String(unit.id ?? unit.name ?? ''),
      name: unit.name ?? 'Không rõ',
      avatar: unit.avatar?.path ?? '',
      isPlayer: unit === player,
      isDead: !!unit.isDead,
      kills: unit.tally.kills,
      deaths: unit.tally.deaths,
      assists: unit.tally.assists,
      cs: unit.tally.minionsKilled,
      gold: Math.floor(unit.wallet?.balance ?? 0),
      damage: Math.round(unit.tally.damageDealt ?? 0),
      streak: announcer?.streakOf(unit) ?? 0,
      reviveAfter: unit.isDead ? Math.ceil((unit.deathData?.reviveAfter ?? 0) / 1000) : 0,
      items: buildItems(unit),
    };
    const team = byTeam.get(unit.teamId);
    if (team) team.push(row);
    else byTeam.set(unit.teamId, [row]);
  }
  const teams: ScoreboardTeam[] = [...byTeam.entries()].map(([teamId, rows]) => {
    rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name));
    const named = TEAM_LABEL[teamId] ?? { label: 'Đội khác', modifier: 'other' as const };
    return {
      teamId,
      ...named,
      mine: teamId === player.teamId,
      kills: rows.reduce((sum, row) => sum + row.kills, 0),
      rows,
    };
  });
  teams.sort((a, b) => Number(b.mine) - Number(a.mine) || a.label.localeCompare(b.label));
  return { teams };
}

/**
 * The kill feed, read from the match's announcer. Tolerates a context with
 * none (the headless HUD tests, a pack's test double) by showing nothing.
 */
function buildFeed(game: any, player: any): FeedDisplay {
  const announcer = game?.announcer as MatchAnnouncer | undefined;
  if (!announcer) return { rows: [], banner: null };
  const now: number = game?.matchTimeMs ?? 0;
  const sideOf = (side: AnnouncementSide | null): FeedSideDisplay | null =>
    side && {
      name: side.name,
      avatar: side.avatar,
      side: side.team === player.teamId ? 'ally' : 'enemy',
    };
  // Newest first: a new callout lands at the top and pushes the rest down,
  // the way the eye expects a ticker under the top edge to move.
  //
  // Folded before it is aged, and aged by the row rather than the kill: a run
  // is one row, and it stays as long as its newest kill would have. Reading
  // `buffered` rather than `recent` is what makes that possible — `recent`
  // caps at three kills, which is less than one penta.
  const groups = groupKillFeed(announcer.buffered(now));
  const fresh = groups.filter(group => now - group.latestAtMs <= FEED_TTL_MS);
  // Which rows survive the cap is decided on each run's *newest* kill, not on
  // the kill that opened it. Sliced by opening order, a run still being added
  // to — the player's, in a fight they are winning — was dropped in favour of
  // three fresh single kills, then let straight back in with the drop
  // animation the moment one of those aged out. A row that blinks out and
  // returns is worse than a row that is one kill stale, and in a 1v10 it
  // blinked several times a second.
  //
  // Kept in opening order all the same, which is what `reverse` below reads:
  // choosing on recency and *drawing* on recency are different things, and
  // the second would have every row swapping places as the fight went on.
  const keep = new Set([...fresh].sort((a, b) => a.latestAtMs - b.latestAtMs).slice(-FEED_ROWS));
  const rows = fresh
    .filter(group => keep.has(group))
    .map(group => {
      ensureVisibleAsset(group.killerUnit?.avatar);
      // Newest first, capped: the face of whoever just died leads the row, and
      // the run's older kills fall off the end into `overflow`.
      const shown = group.victims.slice(-MAX_FEED_VICTIMS).reverse();
      // Only the faces that get drawn: a run past the cap must not fetch art
      // for portraits it has already decided to count instead.
      for (const member of shown) ensureVisibleAsset(member.victimUnit?.avatar);
      const left = FEED_TTL_MS - (now - group.latestAtMs);
      return {
        seq: group.seq,
        killer: sideOf(group.killer),
        victims: shown.map(member => ({ seq: member.seq, ...sideOf(member.victim)! })),
        overflow: Math.max(0, group.victims.length - MAX_FEED_VICTIMS),
        // An objective never folds (its `multi` is 0), so the group is one kill
        // and the kind can be read straight off it.
        objective: group.victims[0].objective,
        tags: group.tags,
        accent: group.accent,
        fade: left >= FEED_FADE_MS ? 1 : Math.max(0, left / FEED_FADE_MS),
        mine:
          group.killerUnit === player || group.victims.some(member => member.victimUnit === player),
      };
    })
    .reverse();
  const top = announcer.banner(now, player);
  return { rows, banner: top && buildBanner(top, groups, player) };
}

/**
 * The banner under the stack, or nothing when the recap is already saying it.
 *
 * **Keyed on the run, not the kill.** `KillFeed.vue` gives the banner a
 * `<transition>` keyed on this seq, and a climbing multi-kill used to hand it a
 * new one every time: the Quadra banner and the Penta banner were both in the
 * flex column for the length of a leave, so the new one appeared 46px low and
 * snapped up as the old one went. Keyed on the group, "QUADRA KILL" becomes
 * "PENTA KILL" in place — one banner, no jump, the same fold the rows got.
 */
function buildBanner(
  top: Announcement,
  groups: readonly KillFeedGroup[],
  player: any
): BannerDisplay | null {
  const text = bannerText(top, player);
  // A death banner and the death recap are the same sentence — "Bạn đã bị hạ /
  // bởi X" over the recap's own "Hạ gục bởi X" — arriving at the same instant
  // in the same place. The recap is the one that stays and the one that
  // explains, so it wins; the banner is what the player was reading *through*,
  // because the recap is deliberately semi-transparent.
  if (text.kind === 'death' && player?.deathRecap) return null;
  const run = groups.find(group => group.victims.some(member => member.seq === top.seq));
  return { seq: run?.seq ?? top.seq, ...text, tier: multiKillTier(top.multi) };
}

/**
 * Groups the death ledger for the panel: one row per attacker, heaviest
 * first; inside a row, one line per named source (or per damage type when
 * nothing named itself), heaviest first.
 */
function buildDeathRecap(player: any): DeathRecapDisplay | null {
  // Deliberately not gated on `isDead`: respawns are fast here, and a recap
  // that vanished with the corpse was gone before anyone finished reading
  // it. The panel decides its own dismissal (the close button, or a tap
  // outside once respawned) — the data just keeps answering.
  if (!player.deathRecap) return null;
  const recap = player.deathRecap;
  const icons = recapIconsFor(player, recap);
  const dealt = { physical: 0, magic: 0, true: 0 };
  for (const entry of (recap.dealt ?? []) as { amount: number; type: string }[]) {
    if (entry.type === 'PHYSICAL') dealt.physical += entry.amount;
    else if (entry.type === 'TRUE') dealt.true += entry.amount;
    else dealt.magic += entry.amount;
  }

  const rows = new Map<string, DeathRecapRow & { lines: Map<string, DeathRecapSourceRow> }>();
  let total = 0;
  let blocked = 0;
  for (const entry of recap.entries as {
    amount: number;
    type: string;
    attackerName: string;
    attackerId: string;
    source?: string;
    blocked?: number;
    hits?: number;
  }[]) {
    total += entry.amount;
    const eaten = entry.blocked ?? 0;
    blocked += eaten;
    let row = rows.get(entry.attackerId);
    if (!row) {
      row = { attacker: entry.attackerName, total: 0, blocked: 0, sources: [], lines: new Map() };
      rows.set(entry.attackerId, row);
    }
    row.total += entry.amount;
    row.blocked += eaten;
    // Spell names carry their code name as a trailing parenthetical, which is
    // documentation, not something to retell a death with — trimmed here.
    const label = (entry.source ?? DAMAGE_TYPE_LABEL[entry.type] ?? entry.type).replace(
      /\s*\([^)]*\)\s*$/,
      ''
    );
    const key = `${label}:${entry.type}`;
    const line = row.lines.get(key);
    if (line) {
      line.amount += entry.amount;
      line.blocked += eaten;
      // The ledger folds a tick stream into one entry now, so an entry stands
      // for `hits` blows rather than always one — counting entries would show
      // a forty-tick burn as a single hit.
      line.hits += entry.hits ?? 1;
    } else {
      row.lines.set(key, {
        label,
        image: icons.get(sourceKeyOf(label)) ?? '',
        amount: entry.amount,
        blocked: eaten,
        hits: entry.hits ?? 1,
        type: entry.type,
      });
    }
  }

  return {
    seq: recap.seq,
    killer: recap.killerName,
    total,
    blocked,
    dealt,
    rows: [...rows.values()]
      .map(row => ({
        attacker: row.attacker,
        total: row.total,
        blocked: row.blocked,
        // By damage dealt, then by what was blocked — so a source that landed
        // nothing because a shield ate all of it still sorts sensibly instead
        // of collapsing to the bottom in arbitrary order.
        sources: [...row.lines.values()].sort(
          (a, b) => b.amount - a.amount || b.blocked - a.blocked
        ),
      }))
      .sort((a, b) => b.total - a.total || b.blocked - a.blocked),
  };
}

/** Reads `game.player` and returns everything the HUD displays. Null while there is no player yet. */
export function computeHudState(game: Game | undefined | null): HudState | null {
  const player = (game as any)?.player;
  if (!player) return null;

  ensureVisibleAsset(player.avatar);

  return {
    avatar: player.avatar?.path || '',
    isDead: player.isDead,
    reviveAfter: ~~((player.deathData?.reviveAfter ?? 0) / 1000),
    spectating: player.isDead ? ((game as any)?.deathCamera?.watching?.name ?? null) : null,
    stats: buildStats(player),
    spells: buildSpells(player),
    buffs: buildBuffs(player),
    recall: buildRecall(player),
    deathRecap: buildDeathRecap(player),
    feed: buildFeed(game, player),
    scoreboard: buildScoreboard(game, player),
    clock: formatClock(game?.matchTimeMs ?? 0),
    gold: player.wallet?.balance ?? 0,
    items: buildItems(player),
    passive: buildPassive(player),
    canShop: atOwnFountain(player, { fountains: (game as any)?.fountains ?? [] }),
    hasCheckpoint: !(game as any)?.net && ((game as any)?.checkpoints?.length ?? 0) > 0,
    hasManualCheckpoint:
      !(game as any)?.net &&
      !!((game as any)?.checkpoints as { auto: boolean }[] | undefined)?.some(c => !c.auto),
  };
}
