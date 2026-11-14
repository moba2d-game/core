import BuffAddType from '@/game/enums/BuffAddType';
import Buff from '@/game/gameObject/Buff';
import { amplifiedAbilityDamage } from '@/game/combat/Amplification';
import { abilityPowerScales } from '@/game/combat/DamageAttribution';
import CombatText from '@/game/gameObject/helpers/CombatText';
import { DAMAGE_CLASS, DAMAGE_WORD } from '@/game/gameObject/buffs/describeBuff';
import { DEFAULT_DAMAGE_TYPE, type DamageType } from '@/game/combat/Mitigation';
import type AttackableUnit from '@/game/gameObject/attackableUnits/AttackableUnit';
import { shieldMultiplier } from '@/game/combat/Shielding';

/**
 * Absorbs incoming damage until it runs out, then expires.
 *
 *   const shield = new Shield(3000, caster, target);
 *   shield.amount = 80;
 *   target.addBuff(shield);
 *
 * Several shields can sit on one unit; they are consumed in the order applied.
 */
export default class Shield extends Buff {
  name = 'Khiên';
  buffAddType = BuffAddType.STACKS_AND_CONTINUE;
  maxStacks = 5;

  /** Damage this shield can still absorb. */
  amount = 50;
  color: [number, number, number] = [255, 205, 90];

  /**
   * Which damage types this shield stands in front of, or `null` for all three.
   *
   * `null` is the default and every shield that existed before this field did
   * keeps it, so nothing in either pack moved on the day it landed. It is here
   * because a shield sized in bare points cannot answer the question a player
   * asks of it — a wiki-faithful anti-magic shield and a general one both read
   * "hấp thụ 35 sát thương", and the two are not remotely the same item.
   *
   * A hit of an unlisted type passes straight through: the pool is not spent,
   * not partially spent, and the shield's own clock keeps running. That is the
   * behaviour a filtered shield has to have — one that quietly ate physical
   * damage at a reduced rate would be a third thing nobody asked for.
   */
  absorbs: DamageType[] | null = null;

  _initialAmount = 50;

  get shieldAmount(): number {
    return this.toRemove ? 0 : this.amount;
  }

  /**
   * Ability power lands here, not at the call site.
   *
   * A shield is the third funnel `Stats.abilityPower` was designed around and
   * the second one that was never wired up (see `AttackableUnit.takeHeal`).
   * An installed pack's shield ability is the case that reported it: its
   * description already promised `30 (+200)` — the HUD rescales a tagged
   * number by the reader's ability power — and the shield it actually applied
   * was thirty. The text was right about the design and the engine was the
   * half that had not been written.
   *
   * `onCreate` rather than the caster's own code because `addBuff` runs inside
   * the cast, so `abilityPowerScales()` is still answering for the spell that
   * is applying this — which means no pack sets `amount` differently from
   * how it already did, and a shield an *item* grants is not amplified, exactly as
   * an item's damage is not.
   *
   * Before `_initialAmount`, which is what the bar draws a fraction against: a
   * shield that started at 230 and reads as 30/30 full is a worse bug than the
   * one being fixed.
   */
  onCreate(): void {
    if (abilityPowerScales()) this.amount = amplifiedAbilityDamage(this.amount, this.sourceUnit);
    // The crack, on the *amplified* figure and before `_initialAmount`, for the
    // same two reasons the amplification itself is here: this is the pool the
    // wearer is actually standing behind, and the bar draws a fraction of
    // `_initialAmount` — cutting after it would paint a shield that starts at
    // half and reads as full. `combat/Shielding.ts` owns the rest, including
    // why a shield already standing is never touched.
    this.amount *= shieldMultiplier(this.targetUnit);
    this._initialAmount = this.amount;
    // The amplified figure, not the one the caster asked for: this is the
    // pool the tooltip's reader is actually standing behind — and *which*
    // damage it stands in front of, which a bare number cannot say.
    this.description ??=
      `Hấp thụ <span class="heal">${Math.round(this.amount)} ${this.absorbedKinds()}</span> tiếp theo.`;
  }

  /**
   * The damage this pool answers for, in the words and the colours a spell
   * description uses.
   *
   * An unfiltered shield says "mọi loại sát thương" rather than a bare "sát
   * thương", and the extra two words are the whole reason this method exists.
   * "Hấp thụ 35 sát thương" is silent about the question a player is actually
   * asking — *which* damage — and silence reads as "the tooltip forgot" rather
   * than as "all of it". Saying it outright is what makes the filtered case
   * mean something too: a shield that names one type is visibly making a
   * narrower promise than one that names all of them.
   */
  private absorbedKinds(): string {
    if (!this.absorbs || this.absorbs.length === 0 || this.absorbs.length >= 3) {
      return 'mọi loại sát thương';
    }
    const named = this.absorbs.map(
      type => `<span class="damage ${DAMAGE_CLASS[type]}">sát thương ${DAMAGE_WORD[type]}</span>`
    );
    return named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} hay ${named.at(-1)}`;
  }

  modifyIncomingDamage(
    damage: number,
    _attacker?: AttackableUnit,
    type: DamageType = DEFAULT_DAMAGE_TYPE
  ): number {
    if (this.toRemove || this.amount <= 0) return damage;
    // Not this shield's damage: it passes through untouched and the pool is
    // not spent. See `absorbs`.
    if (this.absorbs && !this.absorbs.includes(type)) return damage;

    const absorbed = Math.min(this.amount, damage);
    this.amount -= absorbed;
    // An item's shield, credited with what it actually stopped — not what it
    // was worth on paper — to whoever gave it (`combat/ItemLedger.ts`).
    if (this.sourceItem && absorbed > 0) {
      (this.sourceUnit?.tally ?? this.targetUnit.tally).addItemEffect(this.sourceItem, 'shielding', absorbed);
    }

    CombatText.show(this.targetUnit, 'shield', absorbed, this.color);

    if (this.amount <= 0) this.deactivateBuff();

    return damage - absorbed;
  }

  draw(): void {
    if (this.targetUnit.isDead) return;

    const pos = this.targetUnit.position;
    const size = this.targetUnit.animatedValues.displaySize;
    // the ring thins out as the shield is chipped away
    const remaining = this._initialAmount > 0 ? this.amount / this._initialAmount : 0;

    push();
    noFill();
    stroke(this.color[0], this.color[1], this.color[2], 80 + 140 * remaining);
    strokeWeight(2 + 3 * remaining);
    circle(pos.x, pos.y, size + 10);
    pop();
  }
}
