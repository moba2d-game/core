import { emptyTotals, type ItemEffectKind, type ItemTotals } from '@/game/combat/ItemLedger';
/**
 * What a participant did this match.
 *
 * Before this the game kept exactly one number about anybody — `Champion.score`,
 * `++` on a kill and `--` on a death — so 3 kills and 3 deaths was indexed the
 * same as never having fought. Minions and camps were credited to nobody at
 * all, which meant "farm" was not a quantity this game had, and damage was not
 * one either: the single most useful number for answering "is this new ability
 * tuned right" was thrown away every frame it was computed.
 *
 * Kept on `AttackableUnit` rather than on `Champion`, because the crediting
 * happens in `takeDamage` and `die` — both of which live on the base — and
 * because a turret's damage output is a real question. `score` stays a *view*
 * of two of these so the number painted on the health bar keeps meaning what it
 * has always meant.
 *
 * A match total, deliberately: nothing here is reset on death or respawn.
 */
export default class MatchTally {
  /** Enemy champions finished off. */
  kills = 0;
  /** Times this unit was finished off. */
  deaths = 0;
  /**
   * Enemy champions and structures somebody else finished off, that this unit
   * had a hand in. `AttackableUnit.die` decides who had a hand in it, from the
   * participation ledger `takeDamage` keeps.
   */
  assists = 0;
  /** Minions and jungle camps finished off — the CS number. */
  minionsKilled = 0;
  /** Damage that actually landed on someone else, after their shields. */
  damageDealt = 0;
  /** Damage that actually landed on this unit, after its own shields. */
  damageTaken = 0;
  /**
   * What each item did this match, keyed by its qualified id — see
   * `combat/ItemLedger.ts` for what is exact and what is a share. Kept after
   * the item is sold, so a match's total stays a match's total.
   */
  readonly itemEffects = new Map<string, ItemTotals>();

  addItemEffect(item: { id: string; name: string }, kind: ItemEffectKind, amount: number): void {
    if (!(amount > 0)) return;
    let row = this.itemEffects.get(item.id);
    if (!row) this.itemEffects.set(item.id, (row = emptyTotals(item.name)));
    row[kind] += amount;
  }

  /** What `itemId` has done this match, or `null` for an item that has done nothing yet. */
  totalsFor(itemId: string): Readonly<ItemTotals> | null {
    return this.itemEffects.get(itemId) ?? null;
  }

  /** Kills minus deaths — the figure `Champion.drawHealthBar` has always shown. */
  get score(): number {
    return this.kills - this.deaths;
  }

  /**
   * Back to an unplayed match.
   *
   * Every other unit gets this for free by being a new object: a bot the panel
   * re-adds, a minion the next wave spawns. The **player is the one body that
   * is never rebuilt** — `MatchDirector.resetToDefaults` recreates the bots and
   * calls `applyResolvedLoadout` on the standing `game.player` — so without a
   * way to say it, the one row a player actually reads was the only cumulative
   * one on the board: bots back to 0/0/0 beside a player carrying every kill
   * and every last hit since the page loaded. Reported as a CS column reading
   * three to four thousand, which is what a whole session of a practice room
   * genuinely adds up to.
   */
  reset(): void {
    this.kills = 0;
    this.deaths = 0;
    this.assists = 0;
    this.minionsKilled = 0;
    this.damageDealt = 0;
    this.damageTaken = 0;
    this.itemEffects.clear();
  }
}

/**
 * What killing this unit is worth on someone else's scoreboard.
 *
 * `'none'` is not an oversight: a `Pet` extends `Champion`, so without it every
 * summoned pet's kill would read as a champion kill, and a turret would read
 * as a minion. Neither is a thing you get credit for here.
 */
export type KillCredit = 'champion' | 'minion' | 'none';
