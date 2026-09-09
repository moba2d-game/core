import StatusFlags from '@/game/enums/StatusFlags';
import { hasFlag } from '@/utils/index';
import type Buff from '@/game/gameObject/Buff';
import type AttackableUnit from '@/game/gameObject/attackableUnits/AttackableUnit';

/**
 * **Damage gives a hidden unit away — and nothing else does.**
 *
 * ## The rule
 *
 * A stealth ends the moment its owner **deals damage or takes damage**. Landing
 * a hit is being found; being hit is being found. Everything in between —
 * walking, blinking, warding, shielding, summoning, buffing, recalling — is
 * something a hidden champion may do while staying hidden.
 *
 * ## What this replaces, and why
 *
 * The rule used to be League's: *any* cast reveals you. Two seams enforced it,
 * the swing and `Spell.press`, and the press seam was the one players hit. A
 * jester who blinked away, then dropped a trap box or a decoy, was revealed by
 * the box — an ability that damages nobody, announces nothing, and is the
 * entire reason the blink is worth casting. Reported exactly that way, and the
 * answer chosen was not an exemption for that one ability but the rule itself:
 *
 * > "chỉ bị huỷ tàng hình khi gây damage/nhận damage, áp dụng cho mọi tướng"
 *
 * It is a smaller rule than the one it replaces and it is enforced in fewer
 * places, which is the point: `AttackableUnit.takeDamage` is the funnel every
 * hit in the game already passes through, on both ends at once. There is no
 * per-ability flag to forget and no list of quiet abilities to maintain.
 *
 * ## The one seam that is not the damage funnel
 *
 * A basic attack still ends stealth at `BasicAttackController.launch`, before
 * its damage lands, for the reason the reveal hangs there too
 * (`combat/AttackReveal.ts`): a ranged attacker whose reveal waited for the
 * bolt to arrive stays invisible for the whole of its flight, which is exactly
 * the stretch the victim is trying to read. The swing is a committed hit, so
 * committing to it is dealing damage as far as this rule is concerned.
 *
 * ## The one hit that is not somebody being found
 *
 * A poison already standing on a body ticks on its own clock, and *nobody is
 * acting* when it does — the cast that applied it returned seconds ago. Hanging
 * the rule on the hit would therefore have broken two things at once, at both
 * ends of that tick: a poisoner could not vanish while their own poison ran,
 * and a single burn would have been a hard counter to every stealth in the
 * game. So a tick of `buffs/DamageOverTime` reveals neither end.
 *
 * That carve-out lives on the **attribution**, not here
 * (`DamageAttribution.revealsStealth`), for the reason `abilityPowerScales`
 * gives about its own question: `takeDamage` sees a number, an attacker and a
 * type, and none of the three separates "a poison is ticking" from "somebody
 * just hit you". Whatever is running already knows. Applying the poison still
 * reveals, and so does every other hit either of them takes.
 *
 * ## Why the flag and not the class
 *
 * `buffs/Invisible` is the one core ships, but a pack subclasses it (this game
 * already has several) and nothing stops a pack writing its own buff that turns
 * the flag on. What makes a unit hidden is `StatusFlags.Stealthed`, so that is
 * what this asks about — a stealth core has never heard of still ends when its
 * owner is hit.
 */

/** What this module needs of a unit, so a test need not build a champion. */
export interface Hideable {
  buffs: Buff[];
}

/** Whether this buff is what is hiding its owner. */
export const grantsStealth = (buff: Buff): boolean =>
  hasFlag(buff.statusFlagsToEnable, StatusFlags.Stealthed);

/**
 * Whether a hit may tear this stealth off, which is not the same question.
 *
 * **A stealth that also makes its owner untargetable is left alone.** The shape
 * that needs it is an ultimate that takes its caster off the map for a second —
 * one buff carrying `Stealthed`, `Stunned` and `Ghosted` at once and clearing
 * `Targetable` with them, because the champion is not standing anywhere. Two
 * things go wrong if a stray hit ends it, and a stray hit is reachable: a burn
 * applied before the leap keeps ticking on a unit nothing can *aim* at.
 *
 *   - being revealed out of a state where nothing can touch you answers a
 *     question nobody asked, and
 *   - the only way to end a stealth is `deactivateBuff`, which would take the
 *     action lock and the phasing with it and drop the caster out of their own
 *     ultimate halfway through it.
 *
 * `Pet.setHidden`'s buried trap is deliberately *not* covered by this: it pairs
 * two separate buffs, so its `Invisible` is a plain stealth and ends like one.
 */
const breakableByDamage = (buff: Buff): boolean =>
  grantsStealth(buff) && !hasFlag(buff.statusFlagsToDisable, StatusFlags.Targetable);

/**
 * Every stealth standing on this unit that a hit would end.
 *
 * Written as a loop over a shared empty result rather than a `filter` because
 * the damage funnel asks this on **every hit in the game**, from both ends, and
 * the overwhelmingly common answer is "this unit is not hidden". Nothing is
 * allocated for it.
 */
export const stealthsOn = (unit: Hideable | undefined | null): readonly Buff[] => {
  const buffs = unit?.buffs;
  if (!buffs || buffs.length === 0) return NO_STEALTH;
  let found: Buff[] | null = null;
  for (const buff of buffs) {
    if (buff.toRemove || !breakableByDamage(buff)) continue;
    (found ??= []).push(buff);
  }
  return found ?? NO_STEALTH;
};

/** The answer for a unit that is not hiding, allocated once. */
export const NO_STEALTH: readonly Buff[] = Object.freeze([]);

/**
 * End the unit's stealth, because it was found.
 *
 * Through `deactivateBuff`, never `toRemove`: the flag is applied by the
 * buff's activation and only `onDeactivate` gives it back, so a buff merely
 * marked for the sweep leaves its owner hidden until the next tick collects it.
 */
export const breakStealth = (unit: Hideable | undefined | null): void => {
  for (const buff of stealthsOn(unit)) {
    if (buff.toRemove) continue;
    buff.deactivateBuff();
  }
};

/** Narrowing helper for the call sites, which hold a real unit. */
export const breakStealthOn = (unit: AttackableUnit | undefined | null): void =>
  breakStealth(unit as unknown as Hideable | undefined | null);
