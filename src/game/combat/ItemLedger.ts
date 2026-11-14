/**
 * What each held item has done for its owner this match, for the tooltip:
 * "đã gây 1.240 sát thương, hồi 380 máu, chặn 510 sát thương".
 *
 * Two kinds of credit, and they are honest in different ways.
 *
 * **An item's own effects** — its passive, its active, and anything those
 * applied (a burn, a shield, a heal) — carry `DamageAttributable.sourceItem`
 * through the same ambient that names a hit in the death recap. That number is
 * exact.
 *
 * **An item's stats** cannot say which point of armour stopped which point of
 * damage, so the total a stat produced is split by each item's share of that
 * stat: 30 of a champion's 60 armour is half of everything armour blocked.
 * Exact for the linear stats (vamp, regeneration); for a resistance, whose
 * curve bends, it is the standard proportional split, stated here so nobody
 * mistakes it for a measurement.
 *
 * Nothing here allocates on the per-frame path when a unit holds no item that
 * grants the stat: `creditStatShare` walks at most six slots and returns.
 */

import type { ItemDamageSource } from '@/game/combat/DamageAttribution';

export type ItemEffectKind = 'damage' | 'healing' | 'shielding' | 'mitigated' | 'mana';

export interface ItemTotals {
  name: string;
  damage: number;
  healing: number;
  shielding: number;
  mitigated: number;
  mana: number;
}

export const emptyTotals = (name: string): ItemTotals => ({
  name,
  damage: 0,
  healing: 0,
  shielding: 0,
  mitigated: 0,
  mana: 0,
});

/** The parts of a unit this reads — a champion, structurally; anything else answers nothing. */
interface LedgerUnit {
  tally?: { addItemEffect(item: ItemDamageSource, kind: ItemEffectKind, amount: number): void };
  items?: readonly ({ def?: { id: string; name: string; stats?: Record<string, number> } } | null)[];
  stats?: object;
}

const valueOf = (stat: unknown): number => {
  const value = (stat as { value?: number } | undefined)?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

/**
 * Splits `amount` of `kind` between `unit`'s items by their share of the
 * stats named. Several stats when more than one paid for the same thing —
 * omnivamp and lifesteal both heal a physical hit — and the denominator is
 * their sum, so the shares still add up to at most the whole.
 */
export function creditStatShare(
  unit: LedgerUnit | undefined | null,
  stats: readonly string[],
  amount: number,
  kind: ItemEffectKind
): void {
  if (!unit?.items || !unit.tally || !(amount > 0)) return;
  let total = 0;
  const own = unit.stats as Record<string, unknown> | undefined;
  for (const stat of stats) total += valueOf(own?.[stat]);
  if (!(total > 0)) return;
  for (const held of unit.items) {
    const def = held?.def;
    if (!def?.stats) continue;
    let granted = 0;
    for (const stat of stats) {
      const g = def.stats[stat];
      if (typeof g === 'number' && g > 0) granted += g;
    }
    if (!(granted > 0)) continue;
    // A debuff can push the total under what the items grant; never credit
    // more than the whole.
    const share = granted >= total ? 1 : granted / total;
    // The def itself is the `{ id, name }` — no object per credit on the
    // per-frame regeneration path.
    unit.tally.addItemEffect(def, kind, amount * share);
  }
}

/** The tooltip's lines for one item, in the order a player asks; zeros left out. */
export interface ItemTotalLine {
  label: string;
  amount: string;
}

const LINE_ORDER: readonly [ItemEffectKind, string][] = [
  ['damage', 'sát thương gây ra'],
  ['healing', 'máu đã hồi'],
  ['shielding', 'sát thương khiên đã chặn'],
  ['mitigated', 'sát thương giáp/kháng phép đã giảm'],
  ['mana', 'năng lượng đã hồi'],
];

const whole = (n: number): string => Math.round(n).toLocaleString('vi-VN');

export function itemTotalLines(totals: Readonly<ItemTotals> | null | undefined): ItemTotalLine[] {
  if (!totals) return [];
  const lines: ItemTotalLine[] = [];
  for (const [kind, label] of LINE_ORDER) {
    if (Math.round(totals[kind]) >= 1) lines.push({ label, amount: whole(totals[kind]) });
  }
  return lines;
}
