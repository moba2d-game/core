import type Champion from '@/game/gameObject/attackableUnits/Champion';
import type { QualifiedItem } from '@/content/PackRegistry';
import {
  atOwnFountain,
  buildHeldItem,
  buyItem,
  sellItem,
  sellValueOf,
  type ShopHost,
  type ShopMode,
} from '@/game/economy/ItemShop';

/**
 * Taking a purchase back, at the price it was made.
 *
 * ## Why selling is not the answer
 *
 * `SELL_REFUND_FRACTION` is 0.7, and it should be: a full refund turns an
 * inventory into a set of free stat toggles, which is the argument its own
 * comment makes at length. But that fraction is the price of **changing your
 * mind**, and a misclick is not a change of mind — a player who meant to buy
 * the sword and hit the cloak beside it loses 30% of their gold to a slip of
 * the hand, and there is nothing in the game they can learn from that.
 *
 * So undo is not a sell. It reverses the exact transaction: the gold that
 * left comes back whole, the components a combine ate come back into the
 * slots they were in, and an undone sell takes its refund back out again.
 *
 * ## What stops it being a free refund
 *
 * **The same fountain rule buying and selling obey.** Undo at will and it *is*
 * a 100% sell — buy the armour for this fight, undo it on the way out. So a
 * step can only be reversed where it could have been made.
 *
 * **Only the top of the stack, and only if the world still matches.** Buy a
 * sword, combine it into a bigger item, then undo the sword: the sword is not
 * there any more, and putting one back would be minting it. Every step
 * therefore records what it expects to find and refuses when it does not find
 * it — so the guard is a fact about the bag rather than a bet on the order
 * things happened in.
 *
 * ## Why the record is taken inside `buyItem`/`sellItem`
 *
 * Because there are two callers and they must not drift: the HUD panel, and
 * `net/HostSession` answering a LAN client's order. A history written at the
 * panel would be blind to every purchase a client made, and a host that
 * offered undo would undo the wrong player's item.
 *
 * `applying` is what keeps the reversal itself out of the record — undo runs
 * the same `equipItem`/wallet calls a purchase does, and without the latch a
 * redo would push a fresh step and the stack would grow by one every time the
 * player pressed a button.
 */

/**
 * One reversible transaction.
 *
 * It holds the **defs**, not their ids. Looking an id back up through
 * `contentCatalog()` would be one more thing that can fail between the
 * purchase and the undo — a pack uninstalled mid-match, a headless caller
 * with no catalog at all — and a def is plain data already in hand at the
 * moment the step is recorded. `buildHeldItem` is what turns it back into a
 * live item, and that is allowed to fail; finding out *what* the item was
 * is not.
 */
export type ShopStep =
  | {
      kind: 'buy';
      def: QualifiedItem;
      /** Where the bought item landed — a combine lands on its lowest part. */
      slot: number;
      /** What was actually paid, components already deducted. */
      price: number;
      /** The parts the combine ate, with the slots they were in. */
      consumed: { slot: number; def: QualifiedItem }[];
    }
  | { kind: 'sell'; def: QualifiedItem; slot: number; refund: number };

interface History {
  done: ShopStep[];
  undone: ShopStep[];
}

/**
 * Per champion, and weak on purpose: a bot removed mid-match, or a whole
 * finished match, takes its own history with it and nothing has to remember to
 * clear anything.
 */
const histories = new WeakMap<Champion, History>();

/**
 * How far back a player may go. Deep enough to cover a misclick and the two
 * purchases after it; shallow enough that "undo" never means "replay the
 * match's economy from the start", which is a thing no player wants and every
 * unbounded stack eventually offers.
 */
export const SHOP_HISTORY_LIMIT = 20;

/** True while a reversal is running — see the header. */
let applying = false;

const historyFor = (champion: Champion): History => {
  const found = histories.get(champion);
  if (found) return found;
  const fresh: History = { done: [], undone: [] };
  histories.set(champion, fresh);
  return fresh;
};

/**
 * Records a completed transaction. Called by `ItemShop` and nowhere else.
 *
 * A new action clears the redo stack, which is the rule every undo stack in
 * every editor uses: once you have gone back and then done something else,
 * the branch you left is not somewhere the player can be returned to.
 */
export function recordShopStep(champion: Champion, step: ShopStep): void {
  if (applying) return;
  const history = historyFor(champion);
  history.done.push(step);
  if (history.done.length > SHOP_HISTORY_LIMIT) history.done.shift();
  history.undone.length = 0;
}

/** Throws away everything remembered for this champion. */
export function clearShopHistory(champion: Champion): void {
  histories.delete(champion);
}

/**
 * The ledger as it stands, for a checkpoint ("Mốc đã lưu") to write down.
 *
 * Both stacks, as slices holding the same step objects — a step is never
 * mutated after `recordShopStep`, so sharing references is safe and the
 * capture costs two array copies. Deliberately not "remember the length and
 * truncate later": the cap above `shift()`s the *front* of a full stack, so a
 * moment saved twenty purchases deep followed by more buying would leave a
 * length-truncation holding rows from the erased future.
 *
 * `null` for a champion nothing has recorded — restore reads that as "the
 * ledger was empty", which it was.
 */
export interface ShopHistorySnapshot {
  done: ShopStep[];
  undone: ShopStep[];
}

export function captureShopHistory(champion: Champion): ShopHistorySnapshot | null {
  const history = histories.get(champion);
  if (!history) return null;
  return { done: history.done.slice(), undone: history.undone.slice() };
}

/**
 * The captured ledger, written back over whatever the erased future recorded.
 * Works because restore-in-place keeps the same unit identity, so the WeakMap
 * entry survives the rewind; a `null` snapshot clears the ledger outright —
 * every row it holds was recorded after the moment.
 */
export function restoreShopHistory(champion: Champion, snapshot: ShopHistorySnapshot | null): void {
  if (!snapshot) {
    histories.delete(champion);
    return;
  }
  const history = historyFor(champion);
  history.done.length = 0;
  history.done.push(...snapshot.done);
  history.undone.length = 0;
  history.undone.push(...snapshot.undone);
}

export function canUndoShop(champion: Champion): boolean {
  return historyFor(champion).done.length > 0;
}

export function canRedoShop(champion: Champion): boolean {
  return historyFor(champion).undone.length > 0;
}

/**
 * The location rule, borrowed rather than restated.
 *
 * `sellRefusalFor` would be the obvious thing to call and is the wrong one: it
 * also asks whether the slot has something in it, which is exactly the
 * question an undo answers for itself and differently for each direction.
 */
const mayTransact = (champion: Champion, host: ShopHost, mode: ShopMode): boolean =>
  mode === 'CHEAT' || champion.isDead || atOwnFountain(champion, host);

/** Puts an item back into a named slot, rebuilt from its def. */
const restore = (champion: Champion, def: QualifiedItem, slot: number): boolean => {
  if (champion.items?.[slot]) return false;
  const held = buildHeldItem(champion, def);
  if (!held) return false;
  champion.equipItem(held, slot);
  return true;
};

/**
 * Takes back the last transaction, and answers whether it did.
 *
 * Everything is checked before anything moves, the way `buyItem` is: a
 * half-reversed combine — components back, gold not — is the one failure here
 * with no way out.
 */
export function undoShop(champion: Champion, host: ShopHost, mode: ShopMode = 'PLAYER'): boolean {
  if (!mayTransact(champion, host, mode)) return false;
  const history = historyFor(champion);
  const step = history.done[history.done.length - 1];
  if (!step) return false;

  const held = champion.items?.[step.slot];

  if (step.kind === 'buy') {
    // The bought item has to still be sitting where it was put. If it has been
    // sold, moved or eaten by a bigger combine, this step is about a world
    // that no longer exists.
    if (held?.def?.id !== step.def.id) return false;

    // Its own slot is about to be free, so it does not count as occupied.
    const blocked = step.consumed.some(
      part => part.slot !== step.slot && champion.items?.[part.slot]
    );
    if (blocked) return false;

    applying = true;
    try {
      champion.unequipItem(step.slot);
      for (const part of step.consumed) restore(champion, part.def, part.slot);
      champion.wallet?.earn(step.price);
    } finally {
      applying = false;
    }
  } else {
    // An undone sell has to be paid for. The refund may already be spent, and
    // conjuring the item anyway would be a free copy.
    if (held) return false;
    if ((champion.wallet?.balance ?? 0) < step.refund) return false;

    applying = true;
    try {
      if (!champion.wallet?.spend(step.refund)) return false;
      if (!restore(champion, step.def, step.slot)) {
        champion.wallet?.earn(step.refund);
        return false;
      }
    } finally {
      applying = false;
    }
  }

  history.done.pop();
  history.undone.push(step);
  if (history.undone.length > SHOP_HISTORY_LIMIT) history.undone.shift();
  return true;
}

/**
 * Does the undone transaction again, and answers whether it did.
 *
 * Replayed through `buyItem`/`sellItem` rather than by reversing the reversal,
 * so a redo obeys every rule a first purchase does — the gold may be gone, the
 * bag may be full, the champion may have walked off the platform. What a redo
 * must never be is a second, cheaper way to buy something.
 */
export function redoShop(champion: Champion, host: ShopHost, mode: ShopMode = 'PLAYER'): boolean {
  if (!mayTransact(champion, host, mode)) return false;
  const history = historyFor(champion);
  const step = history.undone[history.undone.length - 1];
  if (!step) return false;

  applying = true;
  let done = false;
  try {
    if (step.kind === 'buy') {
      done = buyItem(champion, step.def, host, mode);
    } else {
      // The slot has to hold the same item again, or this is a different sale.
      done =
        champion.items?.[step.slot]?.def?.id === step.def.id &&
        sellItem(champion, step.slot, host, mode) > 0;
    }
  } finally {
    applying = false;
  }
  if (!done) return false;

  history.undone.pop();
  history.done.push(step);
  if (history.done.length > SHOP_HISTORY_LIMIT) history.done.shift();
  return true;
}

/** What a redone sell is worth, for a panel that wants to say so. */
export const refundOf = sellValueOf;
