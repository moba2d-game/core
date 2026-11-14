// src/game/gameObject/Stats.ts

export class StatModifier {
  baseValue = 0;
  baseBonus = 0;
  flatBonus = 0;
  percentBonus = 0;
  percentBaseBonus = 0;

  constructor(baseValue = 0, baseBonus = 0, flatBonus = 0, percentBonus = 0, percentBaseBonus = 0) {
    this.baseValue = baseValue;
    this.baseBonus = baseBonus;
    this.flatBonus = flatBonus;
    this.percentBonus = percentBonus;
    this.percentBaseBonus = percentBaseBonus;
  }

  add(modifier: StatModifier) {
    this.baseValue += modifier.baseValue;
    this.baseBonus += modifier.baseBonus;
    this.flatBonus += modifier.flatBonus;
    this.percentBonus += modifier.percentBonus;
    this.percentBaseBonus += modifier.percentBaseBonus;
  }

  remove(modifier: StatModifier) {
    this.baseValue -= modifier.baseValue;
    this.baseBonus -= modifier.baseBonus;
    this.flatBonus -= modifier.flatBonus;
    this.percentBonus -= modifier.percentBonus;
    this.percentBaseBonus -= modifier.percentBaseBonus;
  }
}

export class Stat {
  baseValue = 0;
  baseBonus = 0;
  flatBonus = 0;
  percentBonus = 0;
  percentBaseBonus = 0;

  /**
   * Ceiling applied to `value`. Defaults to no limit, so only the stats that
   * genuinely need one pay for it. Attack speed is the clearest case: its buffs
   * multiply, so two or three overlapping ones reach a swing per frame and no
   * amount of balancing on the buff side can prevent it.
   *
   * Clamping the read rather than the modifiers keeps it reversible: a buff that
   * pushed the total past the cap still subtracts cleanly when it expires, and
   * the value comes back down instead of sticking.
   */
  maxValue = Infinity;

  /**
   * Floor applied to `value`, for the same reasons and with the same reversible
   * read-time clamp as `maxValue`. Movement speed is the case that needs one:
   * `AttackableUnit.move()` steps along `destination - position` scaled by
   * speed, so a negative speed does not stop a unit, it walks it *backwards,
   * away from where it was sent*.
   *
   * That is one typo away at all times. `Slow.percent` is a fraction — 0.5 is
   * fifty percent — and a single caller writing `35` for "35%" turns a champion
   * into something that cannot walk towards the thing slowing it. A jungle
   * boss's own
   * poison pool shipped with exactly that and read in game as the pool
   * physically shoving people out. Both values are numbers, so nothing in `tsc`
   * or in a type test can catch the next one; the floor is what makes it a
   * balance mistake instead of a physics one.
   */
  minValue = -Infinity;

  constructor(baseValue = 0, maxValue = Infinity, minValue = -Infinity) {
    this.baseValue = baseValue;
    this.maxValue = maxValue;
    this.minValue = minValue;
  }

  addModifier(modifier: StatModifier) {
    if (!(modifier instanceof StatModifier)) return;
    this.add(modifier);
  }

  removeModifier(modifier: StatModifier) {
    if (!(modifier instanceof StatModifier)) return;
    this.remove(modifier);
  }

  get value(): number {
    const total =
      ((this.baseValue + this.baseBonus) * (1 + this.percentBaseBonus) + this.flatBonus) *
      (1 + this.percentBonus);
    if (total > this.maxValue) return this.maxValue;
    return total < this.minValue ? this.minValue : total;
  }

  add(modifier: StatModifier) {
    this.baseValue += modifier.baseValue;
    this.baseBonus += modifier.baseBonus;
    this.flatBonus += modifier.flatBonus;
    this.percentBonus += modifier.percentBonus;
    this.percentBaseBonus += modifier.percentBaseBonus;
  }

  remove(modifier: StatModifier) {
    this.baseValue -= modifier.baseValue;
    this.baseBonus -= modifier.baseBonus;
    this.flatBonus -= modifier.flatBonus;
    this.percentBonus -= modifier.percentBonus;
    this.percentBaseBonus -= modifier.percentBaseBonus;
  }
}

// ---------------------------------------------------------------------------
// Stats / StatsModifier — imports go here so Stat/StatModifier are first
// ---------------------------------------------------------------------------

import { hasFlag } from '@/utils/index';
import ActionState from '@/game/enums/ActionState';
import StatusFlags, { deniesAttacking, deniesCasting, deniesMovement } from '@/game/enums/StatusFlags';

/**
 * What `healthRegen` and `manaRegen` are denominated in.
 *
 * `update()` below adds the whole stat once per frame, so the stored number is
 * *per frame* — 0.06 health, which is a figure no player can do anything with.
 * Every place that shows regeneration to a human has to multiply by this, and
 * it lives here because this is the file that makes it true; the practice
 * panel and the buff tooltip both read it rather than each writing their own
 * 60 and drifting the day the tick rate changes.
 */
export const FRAMES_PER_SECOND = 60;

export class StatsModifier {
  maxHealth = new StatModifier(0);
  health = new StatModifier(0);
  maxMana = new StatModifier(0);
  mana = new StatModifier(0);
  speed = new StatModifier(0);
  size = new StatModifier(0);
  height = new StatModifier(0);
  manaRegen = new StatModifier(0);
  healthRegen = new StatModifier(0);
  visionRadius = new StatModifier(0);
  attackDamage = new StatModifier(0);
  abilityPower = new StatModifier(0);
  abilityHaste = new StatModifier(0);
  attackSpeed = new StatModifier(0);
  attackRange = new StatModifier(0);
  omnivamp = new StatModifier(0);
  lifesteal = new StatModifier(0);
  spellVamp = new StatModifier(0);
  onHitDamage = new StatModifier(0);
  critChance = new StatModifier(0);
  critDamage = new StatModifier(0);
  armorPenetration = new StatModifier(0);
  magicPenetration = new StatModifier(0);
  tenacity = new StatModifier(0);
  healingReceived = new StatModifier(0);
  armor = new StatModifier(0);
  magicResist = new StatModifier(0);

  addModifier(modifier: StatsModifier) {
    if (!(modifier instanceof StatsModifier)) return;
    this.maxHealth.add(modifier.maxHealth);
    this.health.add(modifier.health);
    this.maxMana.add(modifier.maxMana);
    this.mana.add(modifier.mana);
    this.speed.add(modifier.speed);
    this.size.add(modifier.size);
    this.height.add(modifier.height);
    this.manaRegen.add(modifier.manaRegen);
    this.healthRegen.add(modifier.healthRegen);
    this.visionRadius.add(modifier.visionRadius);
    this.attackDamage.add(modifier.attackDamage);
    this.abilityPower.add(modifier.abilityPower);
    this.abilityHaste.add(modifier.abilityHaste);
    this.attackSpeed.add(modifier.attackSpeed);
    this.attackRange.add(modifier.attackRange);
    this.omnivamp.add(modifier.omnivamp);
    this.lifesteal.add(modifier.lifesteal);
    this.spellVamp.add(modifier.spellVamp);
    this.onHitDamage.add(modifier.onHitDamage);
    this.critChance.add(modifier.critChance);
    this.critDamage.add(modifier.critDamage);
    this.armorPenetration.add(modifier.armorPenetration);
    this.magicPenetration.add(modifier.magicPenetration);
    this.tenacity.add(modifier.tenacity);
    this.healingReceived.add(modifier.healingReceived);
    this.armor.add(modifier.armor);
    this.magicResist.add(modifier.magicResist);
  }

  removeModifier(modifier: StatsModifier) {
    if (!(modifier instanceof StatsModifier)) return;
    this.maxHealth.remove(modifier.maxHealth);
    this.health.remove(modifier.health);
    this.maxMana.remove(modifier.maxMana);
    this.mana.remove(modifier.mana);
    this.speed.remove(modifier.speed);
    this.size.remove(modifier.size);
    this.height.remove(modifier.height);
    this.manaRegen.remove(modifier.manaRegen);
    this.healthRegen.remove(modifier.healthRegen);
    this.visionRadius.remove(modifier.visionRadius);
    this.attackDamage.remove(modifier.attackDamage);
    this.abilityPower.remove(modifier.abilityPower);
    this.abilityHaste.remove(modifier.abilityHaste);
    this.attackSpeed.remove(modifier.attackSpeed);
    this.attackRange.remove(modifier.attackRange);
    this.omnivamp.remove(modifier.omnivamp);
    this.lifesteal.remove(modifier.lifesteal);
    this.spellVamp.remove(modifier.spellVamp);
    this.onHitDamage.remove(modifier.onHitDamage);
    this.critChance.remove(modifier.critChance);
    this.critDamage.remove(modifier.critDamage);
    this.armorPenetration.remove(modifier.armorPenetration);
    this.magicPenetration.remove(modifier.magicPenetration);
    this.tenacity.remove(modifier.tenacity);
    this.healingReceived.remove(modifier.healingReceived);
    this.armor.remove(modifier.armor);
    this.magicResist.remove(modifier.magicResist);
  }
}

/**
 * Body width of a champion that nothing has resized. Every ability range in the
 * game was authored against two of these standing next to each other, which is
 * why `Reach.ts` measures a body's excess against it rather than against zero.
 * Named so the two places that care read the same number.
 */
export const DEFAULT_UNIT_SIZE = 55;

/**
 * Ceiling on how big a unit's body can get, whatever stacks it. A champion is
 * 55 across, a jungle boss is 100 and a turret 92, so three times base already makes a
 * unit the largest thing on the field. Past that the model stops fitting
 * through lane chokepoints, its fixed-width health bar detaches from it, and
 * an uncapped stacking-size ultimate — 6 size a stack, 99 stacks, permanent — would reach 649.
 */
export const MAX_UNIT_SIZE = 165;

/**
 * Hard ceiling on attacks per second. Attack speed buffs multiply, so two or
 * three overlapping ones would otherwise reach a swing per frame.
 */
/**
 * The ceiling. Raised from 2.5 once roles got their own profiles: a marksman
 * base of 1.65 plus an attack-speed ultimate (+45%) is already 2.39, so at 2.5
 * a second attack-speed source — a self-buff, an ally's buff — bought almost nothing, and
 * stacking them is meant to be a real decision rather than a wasted cast.
 */
export const MAX_ATTACK_SPEED = 3.0;
/** Default crit multiplier — League's, so "+75%" reads the way a player expects. */
export const CRIT_MULTIPLIER = 1.75;

/**
 * The floor under `abilityPower`, and it is load-bearing rather than tidy.
 *
 * The stat is read as `1 + value`, so -1 is exactly "this unit's abilities deal
 * nothing" and anything below it is a *negative multiplier* — an ability
 * suppression strong enough that casting on the victim would heal them. That is
 * the same trap `combat/Mitigation.ts` documents at length for shred, and the
 * same answer: put the limit where the value is read, not in the hope that no
 * pack ever stacks two reductions.
 */
export const MIN_ABILITY_POWER = -1;

/**
 * Ceiling on ability haste. Not a balance number — a sanity rail.
 *
 * The curve below can never reach a zero cooldown however large this gets, so
 * unlike the fraction this stat replaced it needs no cap to stay safe. 500 is
 * League's own, and it exists here for the same reason: to keep a runaway
 * stacking bug (a buff applied every frame, a cheat left on) from producing an
 * absurd number that shows up in a tooltip rather than a plausible one that
 * hides.
 */
export const MAX_ABILITY_HASTE = 500;

/**
 * What `abilityHaste` does to a duration: `100 / (100 + haste)`.
 *
 * ## Why points, not the fraction this replaced
 *
 * `cooldownReduction` was a fraction that additively stacked, and every problem
 * it had came from that: sources had to be *capped* (0.6 here) or two items and
 * a buff would reach 1.0 — a cooldown of zero, which is not a short cooldown
 * but a held key. Worse, under a cap each point is worth more than the last
 * (the tenth percent of reduction buys far more casts than the first), so a
 * shop cannot price the stat consistently and the last item a player buys is
 * the strongest one in the game.
 *
 * Haste inverts that: **casts per second is linear in it**. 100 haste is
 * exactly one extra cast in the time two used to take; the next 100 is another
 * one. Every point is worth the same against the base rate — the same property
 * armour has against damage, which is why League moved to it in 2020 and why
 * this engine follows. No cap is needed, a pack can keep selling it, and a
 * gold value per point actually means something.
 *
 * Negative haste is clamped away by the stat's own floor, but the guard is here
 * too: this is reachable from a hand-built stat block in a pack's tests, and a
 * multiplier above 1 would *lengthen* a cooldown past the number its author
 * typed.
 */
export function hasteCooldownMultiplier(haste: number): number {
  if (!Number.isFinite(haste) || haste <= 0) return 1;
  return 100 / (100 + haste);
}

export default class Stats {
  maxHealth = new Stat(100);
  health = new Stat(100);
  maxMana = new Stat(500);
  mana = new Stat(500);
  // Floored at 0: a slow may root you, it may never reverse you. See `minValue`.
  speed = new Stat(3, Infinity, 0);
  size = new Stat(DEFAULT_UNIT_SIZE, MAX_UNIT_SIZE);
  height = new Stat(0);
  manaRegen = new Stat(0.1);
  /** Health regeneration restored on the last `update()`; see `combat/ItemLedger.ts`. */
  regeneratedHealth = 0;
  /** Mana regeneration restored on the last `update()`. */
  regeneratedMana = 0;
  healthRegen = new Stat(0.06);
  visionRadius = new Stat(500);

  /** Damage of one basic attack. */
  attackDamage = new Stat(0);

  /* ----------------------------------------------- making a build matter
     Two stats that exist so buying items improves the half of a champion
     that is not its right-click. Both are fractions, both are read in
     exactly one place, and both default to a no-op. */

  /**
   * How much more this unit's **abilities** hit for, as a fraction: `0.35` is
   * +35%. Read once, in `takeDamage`, against the ability damage core can see
   * is being dealt — see `combat/DamageAttribution.ts` for how it knows.
   *
   * **A fraction, deliberately, and not flat points.** Flat ability power is
   * the more expressive design and it is unreachable from here: a flat point
   * value means nothing until each ability declares what share of it to take,
   * and there are 308 abilities across the two installed packs, none of which
   * reads a single stat of its caster today. A multiplier is the only form
   * that can be applied *once*, at the funnel every hit already passes
   * through, and have all 308 scale without one of them being edited. An
   * ability that later wants a scaling of its own is not blocked by this: it
   * reads `owner.stats` and adds to its own number, exactly as the item
   * abilities already do with `attackDamage`.
   *
   * It also puts it in company it already keeps — `omnivamp`, `critChance` and
   * `critDamage` on this same class are fractions too, so `0.35` reading as
   * "+35%" is this file's existing convention rather than a new one.
   *
   * **Zero by default**, so the multiplier is exactly 1 for every ability in
   * the game on the day it lands and not one tuning number moves — the
   * migration argument `armor` makes below, for the same reason. Floored at
   * `MIN_ABILITY_POWER`; negative is a real effect (ability damage reduction)
   * and is supported, but it may never turn a cast into a heal.
   */
  abilityPower = new Stat(0, Infinity, MIN_ABILITY_POWER);

  /**
   * How much sooner this unit's abilities come back, as a fraction: `0.15` is
   * a cooldown 15% shorter. Read once, in `Spell.reducedCooldown`, which is
   * already the single seam every countdown in the game starts from — its own
   * doc comment says so, and it was already multiplying by a match-wide rule,
   * so this stat joins that expression rather than adding a second one.
   *
   * Zero by default and railed at `MAX_ABILITY_HASTE`; see
   * `hasteCooldownMultiplier` for the curve and for why this is points.
   */
  abilityHaste = new Stat(0, MAX_ABILITY_HASTE, 0);
  /**
   * Basic attacks per second, not the period between them. A rate is what buffs
   * actually modify — "+30% attack speed" is a 1.3x on this number and composes
   * with the existing percent machinery, while the same buff on a period
   * would have to be written as a division. It is also the direction a ceiling
   * makes sense in, so MAX_ATTACK_SPEED can be a plain maxValue.
   *
   * **`baseValue` is the champion's own rate, and every bonus is a share of
   * it.** Items grant `percentBaseBonus` (`items/Item.ts`'s `GRANT_SLOT`)
   * and so do abilities, which puts every gain in one additive pool that
   * multiplies the base exactly once — League's arrangement, and the reason
   * "+25% attack speed" means the same thing on every champion instead of
   * being worth a third again to the slowest one and a sixth to the fastest.
   *
   * **Slows use the outer `percentBonus` instead**, so they multiply whatever
   * the build reached rather than diluting into that pool: a cripple is worth
   * the same share against a fed carry as against a starved one.
   */
  attackSpeed = new Stat(0, MAX_ATTACK_SPEED);
  /** Surface-to-surface reach of a basic attack; decides melee versus ranged. */
  attackRange = new Stat(0);

  /* ------------------------------------------------ making a swing matter
     Four stats that exist so a basic attack is a build, not a filler action
     between cooldowns. They are read in exactly one place each —
     `landBasicAttack` for the three attack ones, `takeDamage` for the vamp —
     so an ability grants them the way it grants any other stat (a `StatAmp`
     with `omnivamp: { baseBonus: 0.3 }`) instead of hand-rolling its own
     `ON_ATTACK_HIT` listener. Four spells used to do exactly that, each with
     its own copy of the same subscribe/unsubscribe bookkeeping. */

  /**
   * Fraction of *all* damage this unit deals that returns as health — League's
   * omnivamp rather than its lifesteal, so a damage-over-time tick and a spell
   * feed it as readily as a swing does. Capped at 1: a unit may not profit
   * from hitting something.
   */
  omnivamp = new Stat(0, 1, 0);
  /**
   * The same fraction, but only out of `PHYSICAL` and `TRUE` damage.
   *
   * The three vamp stats split by the *type* of the hit rather than by what
   * dealt it, because the type is what this engine's one damage funnel
   * actually knows — `combat/Vamp.ts` has the whole argument, and owns the
   * arithmetic that adds this to `omnivamp`.
   */
  lifesteal = new Stat(0, 1, 0);
  /** The same, out of `MAGIC` damage. See `lifesteal` and `combat/Vamp.ts`. */
  spellVamp = new Stat(0, 1, 0);
  /** Flat damage added to every basic attack that lands, before the crit roll. */
  onHitDamage = new Stat(0);
  /** 0..1. Left at 0 by default, so nothing in the game rolls dice unless something granted this. */
  critChance = new Stat(0, 1, 0);
  /** What a crit multiplies the swing by. 1.75 is +75%, League's own number. */
  critDamage = new Stat(CRIT_MULTIPLIER);
  /**
   * The share of a victim's `armor` this unit's `PHYSICAL` damage ignores —
   * 0..1, and 0 for everyone until something grants it.
   *
   * **A fraction rather than points**, for the reason `abilityPower` is one:
   * a resistance here is whatever the installed pack tuned it to, and a flat
   * "ignores 18 armour" is worth everything against this shop's Giáp Lụa and
   * nothing against the next pack's. A share is the only form that means the
   * same thing in both. `combat/Mitigation.ts` owns what it does, including
   * the part that is easy to get wrong — it never applies to a resistance
   * that is already negative.
   */
  armorPenetration = new Stat(0, 1, 0);
  /** The same, against `magicResist`, for `MAGIC` damage. */
  magicPenetration = new Stat(0, 1, 0);
  /**
   * The share taken off the *duration* of crowd control somebody else applies
   * — 0..1. `AttackableUnit.addBuff` is where it is read, against
   * `CROWD_CONTROL_FLAGS`, which is the same definition `cleanse()` uses: a
   * slow is not on that list and neither is a knock-up, so this shortens
   * stuns, roots, silences and their neighbours and leaves the two effects a
   * player cannot play around anyway.
   */
  tenacity = new Stat(0, 1, 0);
  /**
   * How much more this unit gets out of everything that puts health back on
   * it — a fraction, so `0.25` is a quarter again of every heal and every
   * point of regeneration.
   *
   * The mirror of a grievous wound, and it goes through the same module
   * (`combat/Healing.ts`) at the same two doors for the same reason: a
   * sustain build that answered the wound only on *heals* would still be shut
   * off by it, because regeneration is what a sustain build is mostly made
   * of. Floored at -1 rather than 0, so a pack can express "heals for less"
   * as a stat if it ever wants to, without the value crossing into negative
   * healing.
   *
   * **Named for the direction on purpose.** League has two different things
   * here and it is easy to ship the wrong one: *heal and shield power* boosts
   * what a champion **gives** (and their own self-heals), and pointedly does
   * not touch regeneration or lifesteal; the "healing *received* is increased"
   * effect is a single item's passive. This stat is the second one — every
   * source of health arriving at this unit — because that is the direction a
   * grievous wound cuts, and a counter that answered a different direction
   * from the thing it counters would be no counter at all.
   */
  healingReceived = new Stat(0, Infinity, -1);
  /**
   * Resistance to `PHYSICAL` damage, on the `100 / (100 + r)` curve
   * `combat/Mitigation.ts` owns — 100 halves the hit.
   *
   * **Zero by default, and that is the whole migration plan.** Damage types
   * arrived long after 240 abilities were written and tuned; starting every
   * unit in the game at 0 of both resistances means the multiplier is exactly
   * 1 everywhere on the day they landed, so not one existing number moved.
   * A resistance is something a champion preset, a buff or a pack now *can*
   * grant, never something they inherited.
   *
   * Negative is meaningful and supported — armour shred — and `Mitigation`
   * mirrors the curve rather than extending it, so no amount of shred ever
   * turns a hit into a heal.
   */
  armor = new Stat(0);
  /** Resistance to `MAGIC` damage. Same curve, same default, same reasoning as `armor`. */
  magicResist = new Stat(0);

  actionState =
    ActionState.CAN_CAST | ActionState.CAN_MOVE | ActionState.CAN_ATTACK | ActionState.TARGETABLE;

  addModifier(modifier: StatsModifier) {
    if (!(modifier instanceof StatsModifier)) return;
    this.maxHealth.addModifier(modifier.maxHealth);
    this.health.addModifier(modifier.health);
    this.maxMana.addModifier(modifier.maxMana);
    this.mana.addModifier(modifier.mana);
    this.speed.addModifier(modifier.speed);
    this.size.addModifier(modifier.size);
    this.height.addModifier(modifier.height);
    this.manaRegen.addModifier(modifier.manaRegen);
    this.healthRegen.addModifier(modifier.healthRegen);
    this.visionRadius.addModifier(modifier.visionRadius);
    this.attackDamage.addModifier(modifier.attackDamage);
    this.abilityPower.addModifier(modifier.abilityPower);
    this.abilityHaste.addModifier(modifier.abilityHaste);
    this.attackSpeed.addModifier(modifier.attackSpeed);
    this.attackRange.addModifier(modifier.attackRange);
    this.omnivamp.addModifier(modifier.omnivamp);
    this.lifesteal.addModifier(modifier.lifesteal);
    this.spellVamp.addModifier(modifier.spellVamp);
    this.onHitDamage.addModifier(modifier.onHitDamage);
    this.critChance.addModifier(modifier.critChance);
    this.critDamage.addModifier(modifier.critDamage);
    this.armorPenetration.addModifier(modifier.armorPenetration);
    this.magicPenetration.addModifier(modifier.magicPenetration);
    this.tenacity.addModifier(modifier.tenacity);
    this.healingReceived.addModifier(modifier.healingReceived);
    this.armor.addModifier(modifier.armor);
    this.magicResist.addModifier(modifier.magicResist);
  }

  removeModifier(modifier: StatsModifier) {
    if (!(modifier instanceof StatsModifier)) return;
    this.maxHealth.removeModifier(modifier.maxHealth);
    this.health.removeModifier(modifier.health);
    this.maxMana.removeModifier(modifier.maxMana);
    this.mana.removeModifier(modifier.mana);
    this.speed.removeModifier(modifier.speed);
    this.size.removeModifier(modifier.size);
    this.height.removeModifier(modifier.height);
    this.manaRegen.removeModifier(modifier.manaRegen);
    this.healthRegen.removeModifier(modifier.healthRegen);
    this.visionRadius.removeModifier(modifier.visionRadius);
    this.attackDamage.removeModifier(modifier.attackDamage);
    this.abilityPower.removeModifier(modifier.abilityPower);
    this.abilityHaste.removeModifier(modifier.abilityHaste);
    this.attackSpeed.removeModifier(modifier.attackSpeed);
    this.attackRange.removeModifier(modifier.attackRange);
    this.omnivamp.removeModifier(modifier.omnivamp);
    this.lifesteal.removeModifier(modifier.lifesteal);
    this.spellVamp.removeModifier(modifier.spellVamp);
    this.onHitDamage.removeModifier(modifier.onHitDamage);
    this.critChance.removeModifier(modifier.critChance);
    this.critDamage.removeModifier(modifier.critDamage);
    this.armorPenetration.removeModifier(modifier.armorPenetration);
    this.magicPenetration.removeModifier(modifier.magicPenetration);
    this.tenacity.removeModifier(modifier.tenacity);
    this.healingReceived.removeModifier(modifier.healingReceived);
    this.armor.removeModifier(modifier.armor);
    this.magicResist.removeModifier(modifier.magicResist);
  }

  getActionState(state: number): boolean {
    return hasFlag(this.actionState, state);
  }

  setActionState(state: number, enabled: boolean) {
    if (enabled) {
      this.actionState |= state;
    } else {
      this.actionState &= ~state;
    }
  }

  updateActionState(statusFlag: number) {
    this.setActionState(ActionState.CHARMED, hasFlag(statusFlag, StatusFlags.Charmed));
    this.setActionState(ActionState.FEARED, hasFlag(statusFlag, StatusFlags.Feared));
    this.setActionState(ActionState.TAUNTED, hasFlag(statusFlag, StatusFlags.Taunted));
    this.setActionState(ActionState.IS_GHOSTED, hasFlag(statusFlag, StatusFlags.Ghosted));
    this.setActionState(ActionState.PHASES_UNITS, hasFlag(statusFlag, StatusFlags.PhasesUnits));
    this.setActionState(ActionState.GROUNDED, hasFlag(statusFlag, StatusFlags.Grounded));
    this.setActionState(ActionState.IS_NEAR_SIGHTED, hasFlag(statusFlag, StatusFlags.NearSighted));
    this.setActionState(ActionState.NO_RENDER, hasFlag(statusFlag, StatusFlags.NoRender));
    this.setActionState(ActionState.STEALTHED, hasFlag(statusFlag, StatusFlags.Stealthed));
    this.setActionState(ActionState.TARGETABLE, hasFlag(statusFlag, StatusFlags.Targetable));

    // The three lists live on `StatusFlags` itself, because the buff tooltip
    // has to say what a control effect takes away and the only honest way to
    // write that sentence is to ask the predicate the engine obeys. See their
    // own comments there, including why a taunt appears in exactly one.
    this.setActionState(ActionState.CAN_MOVE, !deniesMovement(statusFlag));
    this.setActionState(ActionState.CAN_CAST, !deniesCasting(statusFlag));
    this.setActionState(ActionState.CAN_ATTACK, !deniesAttacking(statusFlag));
  }

  /**
   * `healingMultiplier` is what a grievous wound left of this unit's
   * regeneration, handed down by `AttackableUnit.update` — the one caller —
   * because a `Stats` cannot see the buffs on the body it belongs to and a
   * cut that reached heals but not regeneration would be no cut at all
   * (`combat/Healing.ts` owns both halves of that sentence).
   *
   * A parameter with a default rather than a field: every other caller in the
   * game and in the tests is a bare `update()`, and an unwounded unit must
   * regenerate exactly what it always did.
   *
   * **Health only.** Mana is not healing, so `manaRegen` is untouched below —
   * a wound does not stop anybody casting.
   */
  update(healingMultiplier = 1) {
    // `baseValue`, not `value`, on the right-hand side of both of these.
    //
    // These two lines are the only place a stat's *read* is written back into
    // its own base, which makes them the one place a modifier can compound.
    // Sourcing the write from `.value` folded every modifier on `health` into
    // the base once per frame, and the modifier then re-applied itself on the
    // next read — so a buff granting +50 health granted +50 *again* every
    // frame, +3000 a second at 60fps, and simply re-pinned its owner to full
    // health no matter what was hitting them. Three separate ultimates
    // all shipped `health: { baseBonus: N }` on a StatAmp and all three were
    // effectively unkillable for the duration.
    //
    // Current health and current mana are resources, not stats: they are moved
    // by `takeDamage`, `takeHeal`, `spendMana` and `restoreMana`, which all
    // write `baseValue` directly. Nothing should be modifying them through the
    // stat pipeline at all, and the `stat-resource-modifier` seam enforces that
    // — but the write-back is what turned a merely meaningless modifier into a
    // game-breaking one, so it is fixed here as well.
    const health0 = this.health.baseValue;
    const mana0 = this.mana.baseValue;
    this.health.baseValue = constrain(
      this.health.baseValue + this.healthRegen.value * healingMultiplier,
      0,
      this.maxHealth.value
    );
    this.mana.baseValue = constrain(
      this.mana.baseValue + this.manaRegen.value,
      0,
      this.maxMana.value
    );
    // What regeneration actually put back this tick — never negative, never
    // past the cap — for the per-item totals (`combat/ItemLedger.ts`).
    this.regeneratedHealth = Math.max(0, this.health.baseValue - health0);
    this.regeneratedMana = Math.max(0, this.mana.baseValue - mana0);
  }
}
