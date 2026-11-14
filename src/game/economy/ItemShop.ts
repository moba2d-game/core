import type Champion from '@/game/gameObject/attackableUnits/Champion';
import { HeldItem } from '@/game/items/Item';
import { spellClassOfId } from '@/game/spellRegistry';
import { packAsset } from '@/game/config/packAsset';
import type { AssetHandle } from '@/managers/AssetManager';
import type Spell from '@/game/gameObject/Spell';
import type { QualifiedItem } from '@/content/PackRegistry';
import { contentCatalog } from '@/content/catalog';
import { clearShopHistory, recordShopStep } from '@/game/economy/ShopHistory';

/**
 * Buying and selling, and the rules about where.
 *
 * ## At your own fountain — or dead
 *
 * The owner's call, and it is the rule both games this engine's players have
 * played use, both halves of it. Standing at your own fountain is what gives
 * going home a price: without it recall is a movement ability and nothing
 * more, and a player who never leaves the lane is strictly ahead of one who
 * does. And a death timer is shopping time — death *satisfies* the location
 * rule rather than adding a refusal on top of it, so a corpse buys and sells
 * from wherever it fell and respawns already carrying what its gold was for.
 * The respawn counter is the one stretch a player is guaranteed to be
 * reading the shop instead of the fight.
 *
 * ## Why `refusalFor` answers with a reason
 *
 * A bare `false` leaves the panel greying a button out for reasons the player
 * has to guess — and the four reasons want four different sentences ("chưa đủ
 * vàng", "túi đã đầy", "phải về bệ đá"). One function answers which rule said
 * no, and `buyItem` is that same function plus the mutation, so the two can
 * never disagree about what is allowed.
 *
 * ## Nothing half-happens
 *
 * `buyItem` checks everything first and only then touches the wallet and the
 * inventory. The specific failure it is written against is `NOT_LOADED`: a
 * spell class arrives through a dynamic import, an item is bought *once* and
 * held for the rest of the match, and selling the player an inert copy of the
 * thing they wanted — because a chunk had not landed yet — is the one failure
 * here with no way back.
 */

/**
 * What selling gives back, as a fraction of what was paid.
 *
 * Deliberately not 1. A full refund turns an inventory into a set of free stat
 * toggles — buy the armour for this fight, sell it for the damage next fight,
 * pay nothing ever — and a purchase stops being a decision. Deliberately not 0
 * either: a player who buys the wrong thing early should be able to correct
 * it at a cost rather than carry the mistake for the whole match.
 */
/**
 * Re-exported from `game/config/tuningDefaults.ts`, where every caller that
 * cannot afford this module has to be able to reach it — `config/mapTuning.ts`
 * resolves a map's own `sellRefund` against it and is pinned to the `pregame`
 * chunk. Same arrangement as the bounties above it.
 */
import { SELL_REFUND_FRACTION } from '@/game/config/tuningDefaults';
export { SELL_REFUND_FRACTION };

/**
 * **Who the shop is answering to**, and therefore which rules apply.
 *
 * The shop has two callers now. `'PLAYER'` is the real one: a champion
 * standing on their own platform, spending their own gold. `'CHEAT'` is the
 * practice panel's roster, which can open the same shop *aimed at another
 * champion* so an owner can build a bot a kit without playing it.
 *
 * The only difference is the fountain. "At your own fountain, and nowhere
 * else" is a rule about where the buyer's feet are, and in the second case the
 * buyer is a bot standing wherever the match has put it — enforced, the
 * feature refuses every purchase for the whole match bar the seconds after a
 * respawn. Everything else is untouched: the gold is real and comes out of
 * that champion's own wallet, and the bag is real and can be full.
 *
 * Named for who is asking rather than for what it turns off, because the
 * second shape invites a second flag the day something else needs waiving.
 * And it defaults to `'PLAYER'` everywhere, so a call site that forgets it
 * gets the rule the game is played by, never the cheat.
 */
export type ShopMode = 'PLAYER' | 'CHEAT';

/** Which rule said no. See the header for why this is not a boolean. */
export type ShopRefusal = 'NOT_AT_FOUNTAIN' | 'NO_SLOT' | 'TOO_EXPENSIVE' | 'NOT_LOADED';

/**
 * The same question for a sale. One buy refusal applies unchanged — selling
 * is gated on the same at-the-fountain-or-dead rule buying uses, for the
 * reason `sellItem` gives — plus one that only makes sense here.
 *
 * It exists because there was no way to *ask*. The panel gated its Bán button
 * on "am I at the fountain" alone rather than on what `sellItem` really
 * applies, so the button and the sale could disagree — the exact "the button
 * says yes and the purchase says no" failure `refusalFor` was written to
 * prevent, reproduced on the other half of the same panel because only one
 * half had a seam to ask.
 */
export type SellRefusal = 'NOT_AT_FOUNTAIN' | 'EMPTY';

/**
 * The bits of a `Game` this file reads. Structural rather than `Game` itself,
 * so a test can drive the whole shop without building a match — and so this
 * module never grows a second reason to know about the game object.
 */
export interface ShopHost {
  readonly fountains: readonly {
    readonly teamId?: string;
    readonly position: { readonly x: number; readonly y: number };
    readonly radius: number;
    /**
     * How far the shop reaches, when the platform said so. Optional because a
     * test double and the LAN client both build this shape by hand, and
     * because the answer without it is the one every map had before the field
     * existed.
     */
    readonly shopRadius?: number;
  }[];
  /**
   * What a sale pays back here, as a fraction of the item's cost —
   * `EconomyTuning.sellRefund`, resolved once by `Game`.
   *
   * On the host rather than threaded separately because the host is already
   * the channel that crosses from the match into both readers: `sellItem`,
   * which pays the refund, and `sellRows`, which prints it. Nothing else was
   * needed, which is worth saying because this field was left out for a while
   * on the belief that the panel could not be reached.
   */
  readonly sellRefund?: number;
}

/**
 * Near enough to a friendly fountain to trade.
 *
 * `shopRadius`, not `radius`. A map may push the shop out past the platform
 * (`FountainStats.shopRange`) — a skirmish map where nobody walks home, or one
 * that reaches half way out so a player can buy in their own half and not in
 * the enemy's. The healing pad does not move with it: those were one number
 * only because nothing had needed them apart.
 *
 * Still the *location* half and only that half. Dead champions, refusals and
 * prices are all somewhere else and unchanged.
 */
export function atOwnFountain(champion: Champion, host: ShopHost): boolean {
  for (const fountain of host.fountains ?? []) {
    if (fountain.teamId !== champion.teamId) continue;
    const dx = champion.position.x - fountain.position.x;
    const dy = champion.position.y - fountain.position.y;
    if (Math.hypot(dx, dy) <= (fountain.shopRadius ?? fountain.radius)) return true;
  }
  return false;
}

/**
 * What this item pays back when sold. Whole coins, rounded down — see
 * `Wallet` for why every gold figure the player sees is an integer.
 *
 * The snap is not decoration. `350 * 0.7` is `244.99999999999997` in IEEE754,
 * so a bare `Math.floor` pays **244** for an item whose refund is exactly 245
 * — a number that is off by one from the one a player works out on paper, on
 * an arbitrary-looking subset of prices. Found by writing the expected value
 * out by hand in `shopState.test.ts` instead of calling this function to
 * check itself.
 */
export function sellValueOf(def: QualifiedItem, refund = SELL_REFUND_FRACTION): number {
  return Math.floor(Math.round(def.cost * refund * 1e4) / 1e4);
}

/**
 * The refund this match pays, from whichever host the caller already had.
 *
 * A default rather than a required field, because `ShopHost` is built by hand
 * in several places — a test double, the LAN client, `AIChampion`'s shopping
 * context — and the answer without it is the rule every map had before
 * `EconomyTuning.sellRefund` existed.
 */
export const refundFractionOf = (host: ShopHost): number =>
  typeof host.sellRefund === 'number' ? host.sellRefund : SELL_REFUND_FRACTION;

/**
 * Every spell class this item needs, or `null` if any of them is not in
 * memory yet. All-or-nothing on purpose: an item with half its spells is the
 * `NOT_LOADED` failure in the header, wearing a success.
 */
function resolveSpellClasses(def: QualifiedItem): { passive: unknown; active: unknown } | null {
  const passive = def.passive === undefined ? null : spellClassOfId(def.passive);
  if (def.passive !== undefined && !passive) return null;
  const active = def.active === undefined ? null : spellClassOfId(def.active);
  if (def.active !== undefined && !active) return null;
  return { passive, active };
}

/**
 * Which held slots a purchase of `def` would consume, lowest first.
 *
 * Empty for an item with no recipe, which is most of them, and empty for one
 * whose components are simply not in the bag — both are "this is an ordinary
 * purchase" and both callers treat them the same way.
 *
 * ## Why the matching is written out rather than done with a Set
 *
 * A recipe may name the same component twice, and it may name one the bag
 * holds three of. The obvious `held.filter(item => recipe.includes(item.id))`
 * gets both wrong in opposite directions: it consumes all three spares, and it
 * resolves both halves of a doubled recipe to whichever copy it met first —
 * billing the player for two longswords and taking one. So each entry claims
 * one slot, and a claimed slot is out of the running for the entries after it.
 *
 * ## One level deep, deliberately
 *
 * A recipe naming `berserkers_greaves` is **not** satisfied by holding the
 * `boots` that greaves are built from. That reads like a missing recursion and
 * is the rule both games this engine's players have played use: you buy the
 * intermediate item — which credits the boots at *that* purchase — and the
 * intermediate is then what the next tier consumes. Crediting transitively
 * would let a bag of six cheap components collapse into a top-tier item in one
 * click, which deletes the build path the recipe exists to draw. The total
 * spent is identical either way; only the number of decisions changes.
 *
 * The *display* tree in `shopState.recipeTree` does descend several levels, on
 * purpose: what a part is eventually made of is worth reading, and is a
 * different question from what this purchase consumes. Do not reconcile the
 * two. `itemRecipes.test.ts` pins both halves.
 */
export function componentSlotsFor(champion: Champion, def: QualifiedItem): number[] {
  // `Array.isArray` and not a length check: `buildsFrom` reaches here from a
  // stranger's JSON through `validate.ts`, and `tsconfig`'s non-strict half
  // lets a non-array compile clean. See `packCache.prefetchPackFiles` for the
  // same guard and the same reason.
  const recipe = Array.isArray(def.buildsFrom) ? def.buildsFrom : [];
  if (recipe.length === 0) return [];

  const held = champion.items ?? [];
  const claimed: number[] = [];
  for (const componentId of recipe) {
    for (let slot = 0; slot < held.length; slot++) {
      if (claimed.includes(slot)) continue;
      if (held[slot]?.def.id !== componentId) continue;
      claimed.push(slot);
      break;
    }
  }
  return claimed;
}

/**
 * What `def` costs this champion **right now** — its price less whatever of
 * its recipe is already in the bag.
 *
 * `def.cost` is the total, always, and the combine cost is derived from it
 * rather than declared beside it. A pack that wrote both would be writing one
 * fact twice, and the two would drift the first time anyone retuned a price.
 * The property that falls out of deriving it: buying the components and
 * combining costs exactly what buying the finished item costs, so a recipe
 * changes *when* gold leaves and never *how much*.
 *
 * The credit is read off each held item's own `cost`, not off the registry's
 * copy of it, so a component whose price changed under a pack update still
 * refunds what the bag says it is worth.
 *
 * Floored at zero. `validate.ts` refuses a pack whose total is under the sum
 * of its parts, so a negative can only mean core and a pack disagree — and
 * negative gold out of `Wallet.spend` is the shop paying the player to shop.
 */
export function priceFor(champion: Champion, def: QualifiedItem): number {
  const held = champion.items ?? [];
  let credit = 0;
  for (const slot of componentSlotsFor(champion, def)) credit += held[slot]?.def.cost ?? 0;
  return Math.max(0, def.cost - credit);
}

/** Which rule refuses this purchase, or `null` when none does. */
export function refusalFor(
  champion: Champion,
  def: QualifiedItem,
  host: ShopHost,
  mode: ShopMode = 'PLAYER'
): ShopRefusal | null {
  // Dead-or-at-the-fountain — the header's rule. Death satisfies the
  // location check; it never adds a refusal of its own.
  if (mode === 'PLAYER' && !champion.isDead && !atOwnFountain(champion, host)) {
    return 'NOT_AT_FOUNTAIN';
  }
  // A combine frees its components' slots before it fills one, so a bag
  // holding exactly the six pieces of a build can still finish it. Refusing
  // that was the shop telling a player no at the one moment the inventory was
  // doing precisely what it is for.
  if (componentSlotsFor(champion, def).length === 0 && champion.firstEmptyItemSlot() < 0) {
    return 'NO_SLOT';
  }
  if ((champion.wallet?.balance ?? 0) < priceFor(champion, def)) return 'TOO_EXPENSIVE';
  if (!resolveSpellClasses(def)) return 'NOT_LOADED';
  return null;
}

/**
 * The item's icon, or `null` when the pack named a key nothing registered.
 *
 * `AssetManager.get` throws on an unknown key, deliberately — a mistyped key
 * should be loud. But the *place* it becomes loud has to be here, once, at
 * purchase, and not in the HUD's twenty-times-a-second read: a bad pack would
 * otherwise take the whole bar down mid match. `validate.ts` checks the icon
 * is a string; nothing can check it names registered art until the art is
 * registered.
 */
function iconOf(def: QualifiedItem): AssetHandle | null {
  try {
    return packAsset(def.icon);
  } catch {
    return null;
  }
}

/**
 * Builds the live item — its two spells and its icon — for `owner`.
 *
 * `null` when a spell class this item names has not landed yet, which is the
 * `NOT_LOADED` refusal. Never a half-built item: see the header.
 */
export function buildHeldItem(champion: Champion, def: QualifiedItem): HeldItem | null {
  const classes = resolveSpellClasses(def);
  if (!classes) return null;

  const build = (SpellClass: unknown): Spell | null => {
    if (!SpellClass) return null;
    const spell = new (SpellClass as new (owner: Champion) => Spell)(champion);
    // An item's own casts are not ability casts: the passive is pressed once
    // per life just to arm it, and an active triggering a spellblade-style
    // "after casting a spell" empowerment would let one item power another —
    // see `Spell.countsAsAbilityCast`.
    spell.countsAsAbilityCast = false;
    // Nor is an item's damage ability damage. Every one of them already reads
    // the wearer's `attackDamage`, so amplifying it by `abilityPower` too would
    // pay a single purchase out of two stats.
    spell.damageScalesWithAbilityPower = false;
    // So every hit the item's own code lands is counted for it
    // (`MatchTally.itemDamage`, shown on the item's tooltip).
    spell.sourceItem = { id: def.id, name: def.name };
    return spell;
  };

  return new HeldItem(def, build(classes.passive), build(classes.active), iconOf(def));
}

/**
 * Hands `champion` an item outright — no gold, no fountain, no full-bag check
 * beyond needing a slot. The practice panel's cheat, and the only door into an
 * inventory that is not a purchase.
 *
 * Deliberately its own function rather than a flag on `buyItem`: a cheat that
 * shares a code path with the real thing is a cheat that can be reached by
 * accident, and the gates are the entire content of `buyItem`.
 */
export function grantItem(champion: Champion, def: QualifiedItem): boolean {
  const slot = champion.firstEmptyItemSlot();
  if (slot < 0) return false;

  const held = buildHeldItem(champion, def);
  if (!held) return false;

  champion.equipItem(held, slot);
  return true;
}

/**
 * Replaces `champion`'s bag with a stored one — a "Trận mẫu"'s
 * (`config/matchTemplates.ts`), granted free through `grantItem` above
 * because that is what it is: the same cheat, replayed from a save.
 *
 * A qualified id that resolves to nothing installed is skipped, not thrown
 * on: a template outlives its packs, and a boot that dies on a stale id
 * would turn an uninstall into a bricked save. The visible half of the skip
 * is the panel's job (`hud/config/templateGaps.ts` says what is missing
 * before the press); this half just quietly grants what still resolves.
 */
export function grantTemplateBag(champion: Champion, itemIds: readonly string[]): void {
  for (let slot = 0; slot < (champion.items?.length ?? 0); slot++) champion.unequipItem(slot);
  for (const id of itemIds) {
    const def = contentCatalog().item(id);
    if (def) grantItem(champion, def);
  }
}

/**
 * Buys `def` into the first free slot. Answers whether it happened.
 *
 * Everything is checked before anything is touched — see the header. The gold
 * comes out through `Wallet.spend`, which is itself all-or-nothing, so a
 * purchase can never leave a champion holding an item nobody paid for.
 */
export function buyItem(
  champion: Champion,
  def: QualifiedItem,
  host: ShopHost,
  mode: ShopMode = 'PLAYER'
): boolean {
  if (refusalFor(champion, def, host, mode) !== null) return false;

  const held = buildHeldItem(champion, def);
  if (!held) return false;

  // Everything measured before anything moves — the bag is about to change
  // underneath both of these.
  const consumed = componentSlotsFor(champion, def);
  const price = priceFor(champion, def);

  // The upgrade goes where its parts were, not into the first free slot. A
  // build that walks rightwards across the bar every time it combines is a bar
  // the player has to re-read mid fight, and the muscle memory for an item's
  // hotkey is worth more than tidy packing.
  const slot = consumed.length > 0 ? Math.min(...consumed) : champion.firstEmptyItemSlot();
  if (slot < 0) return false;
  if (!champion.wallet?.spend(price)) return false;

  // Consumed, not sold: their value came off the price already, so paying for
  // them again would be a 70% refund on top of a 100% credit. `unequipItem` is
  // what takes their stat modifiers and their passives back off, which is the
  // half a slot count cannot see — a combine that kept a component's armour
  // would leave a champion permanently tougher than the bar says.
  // The parts, named before they are taken off — `unequipItem` is about to
  // make them unreadable, and undo has to be able to put back exactly these.
  //
  // Built with a loop rather than `map().filter(predicate)`. The narrowing
  // form typechecks under this file's ordinary program and **not** under
  // `tsconfig.strict-core.json`, where `strictNullChecks` is on and the
  // predicate overload does not survive the `as` cast that has to be there —
  // `HeldItem.def` is an `ItemDef` and `ShopStep` wants the qualified one.
  // Missed locally because nothing in the strict program reached this file
  // until `AIChampion` grew a shopper; caught by CI, which runs both.
  const parts: { slot: number; def: QualifiedItem }[] = [];
  for (const componentSlot of consumed) {
    const part = champion.items?.[componentSlot]?.def as QualifiedItem | undefined;
    if (part) parts.push({ slot: componentSlot, def: part });
  }

  for (const componentSlot of consumed) champion.unequipItem(componentSlot);

  champion.equipItem(held, slot);
  // Recorded here rather than at the panel, because there are two callers and
  // they must not drift — see `ShopHistory.ts`'s own header.
  recordShopStep(champion, { kind: 'buy', def, slot, price, consumed: parts });
  return true;
}

/**
 * Which rule refuses to sell what is in `slot`, or `null` when none does.
 *
 * Selling is gated on the fountain exactly like buying: an inventory that can
 * be liquidated mid-fight is a second set of abilities, not a build. `EMPTY`
 * covers both nothing-in-the-slot and not-a-slot, because to a panel they are
 * the same fact — there is nothing there to sell — and splitting them would
 * mean a sentence for a state no player can produce.
 */
export function sellRefusalFor(
  champion: Champion,
  slot: number,
  host: ShopHost,
  mode: ShopMode = 'PLAYER'
): SellRefusal | null {
  if (mode === 'PLAYER' && !champion.isDead && !atOwnFountain(champion, host)) {
    return 'NOT_AT_FOUNTAIN';
  }
  if (!champion.items?.[slot]) return 'EMPTY';
  return null;
}

/**
 * Sells whatever is in `slot`, and answers how much it paid — `0` for a
 * refusal or an empty slot, which the caller can treat the same way because
 * neither changed anything.
 *
 * `sellRefusalFor` plus the mutation, exactly the way `buyItem` is
 * `refusalFor` plus the mutation. Re-deriving the rules here is how the two
 * halves of one panel came apart in the first place.
 */
export function sellItem(
  champion: Champion,
  slot: number,
  host: ShopHost,
  mode: ShopMode = 'PLAYER'
): number {
  if (sellRefusalFor(champion, slot, host, mode) !== null) return 0;

  const held = champion.items?.[slot];
  if (!held) return 0;

  const sold = held.def as QualifiedItem;
  const refund = sellValueOf(sold, refundFractionOf(host));
  champion.unequipItem(slot);
  champion.wallet?.earn(refund);
  recordShopStep(champion, { kind: 'sell', def: sold, slot, refund });
  return refund;
}

/**
 * Hands the entire bag back at the price it was bought for, and answers the
 * gold returned.
 *
 * ## Not a sale, for the same reason an undo is not one
 *
 * `SELL_REFUND_FRACTION` is the price of **changing your mind**, and the case
 * this exists for is not a change of mind: a bot that re-rolls into a new
 * champion on death did not decide to abandon its build — the match took the
 * champion out from under it (`AIChampion.respawn`). Charging 30% for that
 * turns every death into a tax on a decision nobody made, and a bot that dies
 * often ends the match poorer than one that never bought anything at all,
 * which is how it was reported: it sells and re-buys its way down.
 *
 * `ShopHistory.undoShop` is the right *idea* and cannot do this — it reverses
 * one step at a time, only from the top of the stack, only while the world
 * still matches it, and only `SHOP_HISTORY_LIMIT` steps deep. A finished build
 * is none of those things. So this reaches the same place from the other end:
 * whatever is in the bag right now, back at `cost`, all of it at once.
 *
 * ## Why it takes no host
 *
 * There is no location rule to obey here and no refund fraction to look up.
 * *Whether* a champion may do this is the caller's question — the one caller,
 * `ai/BotShopper.rebuildBotBag`, asks the same fountain question a purchase
 * asks — and there is deliberately no player-facing door onto it: a full
 * refund at will is exactly the inventory-as-free-stat-toggles that
 * `SELL_REFUND_FRACTION`'s own comment refuses.
 *
 * The history goes with the items. Every step in it describes a bag that no
 * longer exists, and while `undoShop` would refuse each one on its own guard,
 * leaving a stack of dead steps behind a champion that is about to buy a whole
 * new build is not a state anybody should have to reason about.
 */
export function refundBag(champion: Champion): number {
  // No wallet, no refund — and therefore no unequipping either. `grantItem` is
  // a door into a bag that never went through a wallet, and emptying one of
  // those would be a deletion rather than a reversal.
  if (!champion.wallet) return 0;

  const items = champion.items ?? [];
  let paid = 0;

  for (let slot = 0; slot < items.length; slot++) {
    // Read before `unequipItem` — that is what takes the stats and the
    // passives back off, and it makes the entry unreadable on the way.
    const def = items[slot]?.def as QualifiedItem | undefined;
    if (!def) continue;
    champion.unequipItem(slot);
    // `sellValueOf` at a whole fraction rather than a bare `def.cost`, so the
    // one function that turns a price into coins stays the only one.
    paid += sellValueOf(def, 1);
  }

  if (paid === 0) return 0;
  champion.wallet?.earn(paid);
  clearShopHistory(champion);
  return paid;
}
