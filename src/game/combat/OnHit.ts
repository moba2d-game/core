import { beginItemCredit, endItemCredit } from '@/game/combat/DamageAttribution';
import type AttackableUnit from '@/game/gameObject/attackableUnits/AttackableUnit';

/**
 * The on-hit pipeline: what runs when a basic attack actually lands.
 *
 * `EventType.ON_ATTACK_HIT` already exists and stays what it is — a global
 * *observation* seam, fired once per landed swing for anything watching the
 * whole match (a spell that re-arms itself off a landed swing, an e2e
 * counter). What it cannot carry is the item economy's on-hit family, because
 * those effects need each other: a phantom-hit passive re-applies *everyone
 * else's* on-hit effects, a side-bolt passive applies them to a second and
 * third victim, and a doubling passive echoes each application once more. A
 * crowd of independent global listeners has no way to say "run all of you
 * again, at that unit, but without re-triggering the ones that got us here".
 *
 * So on-hit effects are a *unit-local* walk instead: every buff on the
 * attacker gets `Buff.onHit(hit)`, in insertion order. An item passive hangs a
 * permanent buff (the `Item_Thornmail` shape) and that buff is the effect;
 * anything else that grants an on-hit — a champion passive, a temporary
 * steroid — is a buff already.
 *
 * ## `echo`, and who checks it
 *
 * A **propagator** is an effect that calls `applyOnHitEffects` itself: a
 * phantom hit, a side bolt, a doubler. Every propagator marks the application
 * it starts with `echo: true` and refuses to act on one — that pair of rules
 * is what makes any *set* of propagators terminate: an echo can only come
 * from a real swing, never from another echo, so the chain is at most two
 * deep per victim. Plain payloads (bonus damage, a heal, a mana refund)
 * ignore `echo` and simply run again, which is what being doubled means.
 *
 * `MAX_ONHIT_DEPTH` is the belt over those braces: a pack author who forgets
 * the `echo` check has written an infinite loop, and a frozen tab is the
 * worst possible way to find that out. The latch turns it into an effect that
 * quietly stops compounding past a depth no legitimate stack reaches.
 */
export interface OnHitEvent {
  attacker: AttackableUnit;
  victim: AttackableUnit;
  /**
   * What the swing itself landed for (crit already applied) — for effects
   * that scale off the hit. Extra on-hit damage is *not* folded back in;
   * each effect deals its own, with its own damage type.
   */
  damage: number;
  /** True for a bolt, false for a melee swing. */
  ranged: boolean;
  crit: boolean;
  /**
   * True when this application is itself a proc — a phantom hit, a
   * propagated bolt, a doubling. Propagators must not act on an echo.
   */
  echo: boolean;
}

/** Applications may nest (swing → echo), never recurse past this. */
export const MAX_ONHIT_DEPTH = 4;

let depth = 0;

/**
 * Runs every on-hit effect the attacker is carrying, once, against `victim`.
 *
 * Called by `landBasicAttack` with `echo: false` for the real swing, and by
 * propagators with `echo: true` for their re-applications. The buff list is
 * copied first: an on-hit that removes its own buff (a one-shot empowerment,
 * the spellblade shape) must not pull the list out from under the walk.
 */
export function applyOnHitEffects(hit: OnHitEvent): void {
  if (depth >= MAX_ONHIT_DEPTH) return;
  depth++;
  try {
    for (const buff of [...(hit.attacker.buffs ?? [])]) {
      if (buff.toRemove) continue;
      // Counted for the item that armed it (`combat/ItemLedger.ts`), without
      // moving the hit out from under the swing's attribution — see
      // `beginItemCredit`. No bracket at all for a buff no item applied.
      const item = buff.sourceItem ?? null;
      if (!item) {
        buff.onHit(hit);
        continue;
      }
      const previous = beginItemCredit(item);
      try {
        buff.onHit(hit);
      } finally {
        endItemCredit(previous);
      }
    }
  } finally {
    depth--;
  }
}
