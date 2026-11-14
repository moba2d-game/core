import StatusFlags, {
  deniesAttacking,
  deniesCasting,
  deniesMovement,
} from '@/game/enums/StatusFlags';
import { hasFlag } from '@/utils/index';
import type { DamageType } from '@/game/combat/Mitigation';
import { FRAMES_PER_SECOND } from '@/game/gameObject/Stats';
import { AS_PERCENT, STAT_LABEL } from '@/game/hud/itemStatLines';
import type { ItemStatKey } from '@/game/items/itemStats';

/**
 * What a buff does, in the words a spell description would use.
 *
 * ## The gap this fills
 *
 * `Buff.description` has existed and been rendered by the HUD's hover panel
 * for as long as the panel has; not one buff in core or in either installed
 * pack ever set it. So the row under the portrait said "Bùa Xanh · còn 62
 * giây" and stopped there — the name and the clock, which are the two things
 * a player can already work out, and nothing about the blessing itself. Six
 * unlabelled icons is a row you can only learn by having been hit by each of
 * them once and remembering the picture.
 *
 * ## Why most of it is derived rather than written
 *
 * A control effect's whole meaning is the flags it sets, and those flags are
 * read by exactly one function — `Stats.updateActionState`, now asking
 * `deniesMovement` / `deniesCasting` / `deniesAttacking` on `StatusFlags`.
 * Asking the same three predicates here means the sentence cannot drift from
 * the mechanic: add `Rooted` to a buff and its tooltip gains "không thể di
 * chuyển" the same frame the champion stops walking. A hand-written Vietnamese
 * copy of those lists would have been a second source of truth that fails
 * silently — it does not throw when it goes stale, it just lies.
 *
 * So the split is: **anything the flags already say is derived, anything
 * carrying a number is written by the buff that owns the number.** `Slow`
 * knows its percent, `Shield` its pool, `DamageOverTime` its tick; none of
 * those is recoverable from a flag and each is the whole point of its buff.
 *
 * ## Where it runs
 *
 * `Buff.activateBuff`, immediately after `onCreate` and only when the buff has
 * not set a description of its own. That is the one point where a buff is
 * fully built — callers set `percent`, `amount` and `bonuses` *after* the
 * constructor, which is why `onCreate` exists at all — and it is before the
 * first frame anything can hover it.
 */

/** The three the engine actually gates, in the order a player loses them. */
const DENIED_ACTION: [(flags: number) => boolean, string][] = [
  [deniesMovement, 'di chuyển'],
  [deniesAttacking, 'đánh thường'],
  [deniesCasting, 'dùng chiêu'],
];

/**
 * Flags whose meaning is not "an action is gone" but "you are being steered".
 *
 * Kept apart from the denials because they read as a different kind of
 * sentence: a stun is a subtraction, a charm is an instruction. Both can be
 * true at once — a charm denies all three actions *and* walks you forward —
 * and a tooltip that only said "không thể di chuyển" about a charm would be
 * technically true and useless.
 */
const COMPULSION: [number, string][] = [
  [StatusFlags.Charmed, 'Bị hút về phía kẻ đã quyến rũ.'],
  [StatusFlags.Feared, 'Bỏ chạy khỏi nguồn gây sợ hãi.'],
  [StatusFlags.Taunted, 'Buộc phải đánh thường kẻ đã khiêu khích.'],
];

/** Flags that change what you are rather than what you may do. */
const STATE_SET: [number, string][] = [
  [StatusFlags.Grounded, 'Không thể lướt hay dịch chuyển.'],
  [StatusFlags.Stealthed, 'Tàng hình — kẻ địch không nhìn thấy bạn.'],
  [StatusFlags.Invulnerable, 'Miễn mọi sát thương.'],
  [StatusFlags.Ghosted, 'Đi xuyên qua mọi đơn vị và địa hình.'],
  [StatusFlags.PhasesUnits, 'Đi xuyên qua các đơn vị.'],
  [StatusFlags.NearSighted, 'Tầm nhìn bị thu hẹp.'],
];

/** The same question for flags a buff *takes away*. */
const STATE_CLEARED: [number, string][] = [
  [StatusFlags.Targetable, 'Không thể bị chọn làm mục tiêu.'],
  [StatusFlags.Stealthed, 'Bị lộ diện — không thể tàng hình.'],
];

/**
 * The damage type, as a player reads it and as the stylesheet paints it.
 *
 * Core's, because core owns both halves: `DAMAGE_TEXT_COLOR` gives the floating
 * numbers their colour and `styles/main.css` gives the same three to
 * `damage physical|magic|true`. A pack writing its own tooltips writes these
 * words itself — that is its own language — but core's generic buffs cannot,
 * and a burn that says only "5 sát thương" hides the one thing a player buying
 * resistances needs from it.
 */
// One copy, in `combat/DamageText.ts`, because that is where the words became
// load-bearing: `dmg()` generates the noun from the damage type it was handed,
// so a second table here could drift and let a spell tooltip and a buff
// tooltip disagree about what "chuẩn" means. Re-exported rather than moved so
// every existing importer keeps working.
export { DAMAGE_WORD } from '@/game/combat/DamageText';

export const DAMAGE_CLASS: Record<DamageType, string> = {
  PHYSICAL: 'physical',
  MAGIC: 'magic',
  TRUE: 'true',
};

/** Every effect term is a `buff` span, the class a spell description already uses for one. */
export const term = (text: string): string => `<span class="buff">${text}</span>`;

/** `1.2 giây`, in a `time` span — at most one decimal, and no trailing `.0`. */
export const seconds = (ms: number): string =>
  `<span class="time">${Math.round(ms / 100) / 10} giây</span>`;

/** `25%`, from the fraction every `percent` field in this engine is written as. */
export const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

/** "a, b hay c" — Vietnamese takes `hay` before the last of a list, not a comma. */
const list = (parts: string[]): string =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} hay ${parts.at(-1)}`;

/**
 * The sentence a control effect's own flags already contain, or `null` for a
 * buff that sets none — a `Slow`, a `Shield`, a blessing — which is the
 * signal to leave `description` alone for its owner to write.
 */
export function describeStatusFlags(enabled: number, disabled: number): string | null {
  const parts: string[] = [];

  const denied = DENIED_ACTION.filter(([denies]) => denies(enabled)).map(([, label]) => label);
  if (denied.length) parts.push(`Không thể ${list(denied.map(term))}.`);

  for (const [flag, clause] of COMPULSION) if (hasFlag(enabled, flag)) parts.push(clause);
  for (const [flag, clause] of STATE_SET) if (hasFlag(enabled, flag)) parts.push(clause);
  for (const [flag, clause] of STATE_CLEARED) if (hasFlag(disabled, flag)) parts.push(clause);

  return parts.length ? parts.join(' ') : null;
}

/**
 * What a `StatAmp` grants, read off the same `bonuses` it builds its modifier
 * from — so a buff cannot promise a number it does not apply.
 *
 * Borrows `STAT_LABEL` rather than restating nineteen Vietnamese words that
 * are already written down for the shop; a stat with no label there is one no
 * item may grant, and it is skipped rather than printed as its English key.
 */
/**
 * Regeneration is stored per *frame* (`Stats.update` adds it once a frame), so
 * a blessing granting 0.06 reads as nothing at all. Shown per second, which is
 * the number a player can actually weigh — the same conversion the practice
 * panel makes, from the same constant.
 */
const PER_FRAME = new Set(['healthRegen', 'manaRegen']);

const signed = (value: number): string =>
  `${value > 0 ? '+' : ''}${Math.round(value * 100) / 100}`;

/**
 * The `BonusKind` slots that hold **points**, as against a share.
 *
 * `Stat.value` is
 * `((baseValue + baseBonus) * (1 + percentBaseBonus) + flatBonus) * (1 + percentBonus)`,
 * so three of the five slots are added to the number and two multiply it. This
 * used to ask `kind !== 'flatBonus'` — one of the three — which made every
 * `baseBonus` in the game print as a percentage of itself: a growth stack
 * granting `maxHealth: { baseBonus: 75 }` advertised **+7500% Máu tối đa** on
 * one stack. `baseBonus` is the slot `StatAmp`'s own doc comment uses in its
 * example, so this was the common case, not the corner one.
 */
const POINT_KINDS = new Set<string>(['baseValue', 'baseBonus', 'flatBonus']);

/** Points, a share, or a rate — decided by the stat and by the kind of bonus. */
const grantedAmount = (stat: string, kind: string, amount: number): string => {
  if (!POINT_KINDS.has(kind)) return `${amount > 0 ? '+' : ''}${percent(amount)}`;
  if (PER_FRAME.has(stat)) {
    return `${signed(Number((amount * FRAMES_PER_SECOND).toFixed(1)))}/giây`;
  }
  // Some stats are stored as fractions rather than points and would otherwise
  // print "+0.12 Giảm hồi chiêu". The shop already answers which — borrowed
  // rather than re-listed, because a copy written from memory puts
  // `attackSpeed` on it, and `attackSpeed` is points.
  if (AS_PERCENT.has(stat as ItemStatKey)) return `${amount > 0 ? '+' : ''}${percent(amount)}`;
  return signed(amount);
};

/**
 * The same bonuses as `describeStatBonuses`, one stat to a plain-text line —
 * for a list that styles its own numbers (an item tooltip's "Trong trận này").
 */
export function statBonusLines(
  bonuses: Partial<Record<string, Partial<Record<string, number>>>>,
  stacks = 1
): { label: string; amount: string }[] {
  const lines: { label: string; amount: string }[] = [];
  for (const [stat, bonus] of Object.entries(bonuses)) {
    const label = STAT_LABEL[stat as ItemStatKey];
    if (!label || !bonus) continue;
    for (const [kind, raw] of Object.entries(bonus)) {
      const amount = (raw ?? 0) * stacks;
      if (amount) lines.push({ label, amount: grantedAmount(stat, kind, amount) });
    }
  }
  return lines;
}

export function describeStatBonuses(
  bonuses: Partial<Record<string, Partial<Record<string, number>>>>,
  stacks = 1
): string | null {
  const lines: string[] = [];
  for (const [stat, bonus] of Object.entries(bonuses)) {
    const label = STAT_LABEL[stat as ItemStatKey];
    if (!label || !bonus) continue;
    for (const [kind, raw] of Object.entries(bonus)) {
      const amount = (raw ?? 0) * stacks;
      if (!amount) continue;
      lines.push(term(`${grantedAmount(stat, kind, amount)} ${label}`));
    }
  }
  return lines.length ? `${lines.join(', ')}.` : null;
}
