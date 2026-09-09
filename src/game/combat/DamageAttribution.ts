/**
 * Who dealt this hit, when the hit did not say so itself.
 *
 * `takeDamage(damage, attacker, type, source)` takes the ability's own name as
 * its fourth argument, and the death recap prints it. A caller that omits it
 * lands under `DAMAGE_TYPE_LABEL` instead — the player reads "Sát thương phép"
 * and is told nothing about what killed them. Reported from a real match, from
 * an installed pack whose whole kit omits it.
 *
 * Asking every ability to remember a display string is what produced the state
 * this replaces: 224 sites across two packs pass it, 20 do not, and the ones
 * that do pass a string equal to their own `name` in all but five cases. The
 * information was always available — it just was not reachable from where the
 * damage lands.
 *
 * ## Why an ambient rather than a parameter
 *
 * Damage rarely lands in the method that knows the ability. A missile's hit
 * runs in its own object's `onHit`, frames after the cast returned, on an
 * object with no `name` and no back-link to its spell (`SpellObject` carries
 * neither). Passing the spell down would mean changing every spell object's
 * constructor in every pack — the thing this exists to avoid.
 *
 * So core brackets the three places it *already* owns the call into pack code,
 * and whatever is running is what a nameless hit is attributed to:
 *
 *   - a spell's cast, through `Spell`'s runtime delegate;
 *   - a buff's tick and its `onDamageTaken`, which is how `DamageOverTime` and
 *     `DamageReflect` (an item's Blade Mail) name themselves;
 *   - a spell object's `update()`, using the attribution stamped onto it when
 *     it was constructed — which is inside its own spell's cast for 34 of one
 *     installed pack's 40 spells and 226 of the other's 268.
 *
 * ## The rules that keep it honest
 *
 * **An explicit `source` always wins.** Five sites across the installed packs
 * deliberately name a sub-ability or a particular projectile rather than the
 * spell that fired it, and an ambient that overrode them would be a downgrade.
 *
 * **Save and restore, never assign.** `DamageReflect` re-enters `takeDamage` on
 * the attacker from inside the victim's own damage pass, so attributions nest.
 * Each bracket keeps the previous value and puts it back in a `finally`; the JS
 * call stack is the stack, which is why there is no array here to leak.
 *
 * **No allocation per frame.** `ObjectManager.update()` brackets every object
 * every tick, so this deliberately has no closure-taking `withAttribution`
 * helper — a callback per object per tick is 30k throwaway closures a second at
 * a teamfight's object count.
 */

/** Anything that can own a hit. `Spell` and `Buff` both already are one. */
/**
 * What a basic attack calls itself in the death recap.
 *
 * One string, because there are five swings in this engine and they are all
 * the same act: a champion's (`landBasicAttack`), a minion's melee and its
 * bolt, a turret's bolt, and a camp's three. Only the first of them named
 * itself until the others were found dealing magic damage — see
 * `BASIC_ATTACK_TYPE` beside it — and a recap that says "Đánh thường" for one
 * attacker and nothing for the other four is a recap that reads as a bug.
 *
 * Here rather than in `BasicAttack.ts` because `Minion`, `Turret` and
 * `monsterAttacks` all need it and none of them should import the champion
 * attack to get a label. This module has no imports of its own.
 */
export const BASIC_ATTACK_SOURCE = 'Đánh thường';

/**
 * The attribution every swing lands under.
 *
 * A basic attack is not ability damage — it scales on `attackDamage`, which
 * items already pay for handsomely — and `coreSpells/BasicAttack` says so on
 * the spell. But the spell is only the *order*: the swing itself becomes damage
 * frames later, inside a `BasicAttackSwing` or a `BasicAttackBolt` whose
 * attribution is whatever happened to be ambient when the controller launched
 * it, which is during the attacker's own `update()`.
 *
 * That was `null` for every unit in the game, so the right answer came out of
 * an accident. It stopped being an accident the day a summon started carrying
 * its summoner's cast as its attribution (`Pet.attributedTo`): a pet's swings
 * would have inherited it, and a decoy clone's basic attacks would quietly have
 * been amplified by its owner's ability power on top of the attack damage they
 * already scale on. `landBasicAttack` states the fact instead of inheriting it.
 *
 * It carries the label too, so a swing names itself in the recap from the same
 * place — see `BASIC_ATTACK_SOURCE` above.
 */
export const BASIC_ATTACK_ATTRIBUTION: DamageAttributable = Object.freeze({
  name: BASIC_ATTACK_SOURCE,
  damageScalesWithAbilityPower: false,
});

export interface DamageAttributable {
  readonly name?: string;
  /**
   * Whether damage landing under this attribution is *ability* damage, and so
   * whether `Stats.abilityPower` amplifies it. See `abilityPowerScales` below
   * for why the ambient answers this rather than `takeDamage` guessing.
   */
  readonly damageScalesWithAbilityPower?: boolean;
  /**
   * Whether damage landing under this attribution means somebody was **found**
   * — the question `combat/StealthBreak.ts` asks of every hit, on both ends.
   *
   * Defaults to true, which is every cast, every swing and every effect in the
   * game. `buffs/DamageOverTime` is what turns it off and states why: a poison
   * already standing on a body ticks on its own clock, and neither end of that
   * tick is anyone acting. Same shape as `damageScalesWithAbilityPower` above
   * and for the same reason — the hit itself cannot tell, and whatever is
   * running already knows.
   */
  readonly revealsStealth?: boolean;
}

let current: DamageAttributable | null = null;

/**
 * Makes `source` the attribution and hands back what it replaced.
 *
 * Always paired with `endAttribution(previous)` in a `finally` — see the header
 * on why nesting is not hypothetical.
 */
export function beginAttribution(
  source: DamageAttributable | null | undefined
): DamageAttributable | null {
  const previous = current;
  current = source ?? null;
  return previous;
}

/** Puts back what `beginAttribution` replaced. */
export function endAttribution(previous: DamageAttributable | null): void {
  current = previous;
}

/** What is running right now, for a spell object to stamp onto itself. */
export function currentAttribution(): DamageAttributable | null {
  return current;
}

/**
 * Whether what is running right now is an ability, for `Stats.abilityPower`.
 *
 * `takeDamage` cannot work this out on its own. It sees a number, an attacker
 * and a damage type, and none of the three separates a swing from a cast — a
 * basic attack is `PHYSICAL`, but so are a third of the abilities in the
 * installed packs since they started declaring their types. The ambient
 * already knows, because it is bracketing the call into the code that *is* the
 * ability.
 *
 * **Opt-in, not opt-out.** Nothing running at all — core's own periodic
 * effects, a hazard, anything a future caller adds — answers `false` and is
 * amplified by nothing. `Spell` opts every ability in with a default of `true`
 * and the two things that are not abilities opt back out by hand
 * (`coreSpells/BasicAttack` and, in `economy/ItemShop`, an item's own
 * abilities — those already scale on `attackDamage` and must not draw from
 * both stats at once). A spell object inherits it through the attribution
 * stamped on it at construction, and a buff through the same, so a damage-over-time
 * an ability applied is amplified and one an item applied is not, with no pack
 * ever naming the stat.
 */
export function abilityPowerScales(): boolean {
  return current?.damageScalesWithAbilityPower === true;
}

/**
 * Whether the hit being dealt right now gives a hidden unit away.
 *
 * **Opt-out, not opt-in** — the mirror of `abilityPowerScales` above, and
 * deliberately the other way round. That one asks "is this an ability", where
 * silence honestly means no; this one asks "did somebody just get found", where
 * silence means yes: a hit whose author said nothing is an ordinary hit, and
 * the failure of a wrong default here is a champion who cannot be revealed
 * rather than one revealed too eagerly.
 */
export function attributionRevealsStealth(): boolean {
  return current?.revealsStealth !== false;
}

/**
 * The label a nameless `takeDamage` is filed under, or `undefined` when nothing
 * is running that could answer — in which case the recap falls back to the
 * damage type exactly as it did before.
 */
export function currentAttributionName(): string | undefined {
  const name = current?.name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/** Test-only: drops any attribution left standing by a thrown update. */
export function resetAttributionForTests(): void {
  current = null;
}
