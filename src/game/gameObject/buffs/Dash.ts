import BuffAddType from '@/game/enums/BuffAddType';
import StatusFlags from '@/game/enums/StatusFlags';
import Buff from '@/game/gameObject/Buff';
import type AttackableUnit from '@/game/gameObject/attackableUnits/AttackableUnit';
import Airborne from './Airborne';
import Root from './Root';
import AssetManager from '@/managers/AssetManager';
import VectorUtils from '@/utils/vector.utils';
import Stun from './Stun';
import TrailSystem from '@/game/gameObject/helpers/TrailSystem';
import Fear from './Fear';
import Charm from './Charm';
import type { BuffConstructor } from '@/game/gameObject/Buff';
import { foreignControlBuff } from '@/game/spell/runtime/CancelPolicy';

/**
 * The crowd control that takes a dash off its feet.
 *
 * A dash is the movement half of the cancellation model: it is not a spell
 * state, so it cannot carry a `SpellForm`, but the question is the same one and
 * `CancelPolicy` answers it in the same vocabulary. Listed as buff classes
 * rather than status flags because the rule has to know *who* applied it — a
 * spell that roots its victim and then pulls them must not have its own pull
 * cancelled by its own root. See the table in docs/ADDING_SPELLS.md.
 */
export const DASH_INTERRUPT_BUFFS: readonly BuffConstructor[] = [Airborne, Root, Stun, Fear, Charm];

export default class Dash extends Buff {
  image: Buff['image'] = AssetManager.get('buff_root');
  name = 'Lướt';
  buffAddType = BuffAddType.REPLACE_EXISTING;

  // for override
  trailSystem = new TrailSystem({
    trailColor: 'rgba(255, 255, 255, 0.39)',
    maxLength: 20,
  });
  showTrail = true;
  dashSpeed = 13;
  dashDestination: p5.Vector | null = null;
  stayAtDestination = true;
  cancelable = true;
  buffsToCheckCancel: BuffConstructor[] = [...DASH_INTERRUPT_BUFFS];

  /**
   * Nothing anyone else does takes this flight off its line.
   *
   * `cancelable = false` is the older, narrower word and it stays what it was:
   * it skips the `buffsToCheckCancel` test below, so a stun or a root landing
   * mid-flight no longer ends the flight. Almost every use of it in the packs
   * is a *displacement* saying "my own pull must not be cancelled by my own
   * slow", which is a different sentence from the one a charge wants.
   *
   * What it never covered is the case a charge actually meets: **a
   * displacement is another `Dash`**. `buffAddType` is `REPLACE_EXISTING` and
   * `stackId` is the constructor, so a pull landing on a champion mid-charge
   * shares the charge's stack and `addBuff` deactivates the charge to make room
   * for it — no interrupt check involved, nothing asked. Reported from a real
   * match: an ultimate whose card promised "không thể cản phá bởi các hiệu ứng
   * khống chế" was stopped dead by an enemy's drag and again by their throw,
   * both of which are that shape, as is every other pull, knockback and throw
   * in every pack.
   *
   * So this one refuses a foreign `Dash` outright (`blocksIncoming`) *and*
   * implies the older flag. It lasts precisely as long as the flight does — the
   * buff ends on arrival — so it is the charge that is unstoppable, never the
   * champion.
   */
  unstoppable = false;

  override overridesMovement = true;

  statusFlagsToEnable = StatusFlags.Ghosted;

  /**
   * Whether a unit may dash under its own power. Grounding blocks this, but not
   * displacements applied by someone else — those construct a Dash directly.
   *
   * Spells should still call this so a blocked dash fails before it charges the
   * player mana; `blockedByGround` below is the backstop for the ones that do
   * not, so grounding holds whether or not a spell remembered to ask.
   */
  static CanDash(targetUnit: AttackableUnit): boolean {
    return targetUnit.canMove && !targetUnit.grounded;
  }

  /**
   * Grounding stops a unit moving itself, not being moved. `sourceUnit ===
   * targetUnit` is how this codebase already tells those apart — it is the same
   * test `onActivate` uses to decide whether to mark the target as displaced.
   */
  private get blockedByGround(): boolean {
    return this.sourceUnit === this.targetUnit && this.targetUnit.grounded;
  }

  /**
   * An immovable body refuses a displacement, the way grounding refuses a
   * self-dash. Same shape, opposite side of `sourceUnit === targetUnit`:
   * grounding stops you moving yourself, this stops anyone moving you.
   *
   * `Monster` used to answer this by snapping back to its camp point every
   * frame, which works only for a body that cannot walk — one with legs
   * would be pinned to its home instead of chasing. Refusing the buff is the
   * answer that holds for both.
   */
  private get blockedByAnchor(): boolean {
    return this.sourceUnit !== this.targetUnit && this.targetUnit.isImmovable;
  }

  onCreate(): void {
    if (this.showTrail && this.game) {
      this.game.objectManager.addObject(this.trailSystem);
      this.trailSystem.trailSize = this.targetUnit.stats.size.value;
    }
  }

  onActivate(): void {
    if (this.blockedByGround || this.blockedByAnchor) {
      this.dashDestination = null;
      this.deactivateBuff();
      return;
    }
    if (this.sourceUnit !== this.targetUnit) this.targetUnit.markDisplaced?.();
    if (this.stayAtDestination && this.dashDestination) {
      this.targetUnit.moveTo(this.dashDestination.x, this.dashDestination.y);
    }
  }

  onUpdate(): void {
    if (this.toRemove) return;
    // Ground can land mid-dash, not just before it starts.
    if (this.blockedByGround || this.blockedByAnchor) {
      this.dashDestination = null;
      this.deactivateBuff();
      return;
    }

    // apply dash
    if (this.dashDestination) {
      VectorUtils.moveVectorToVector(
        this.targetUnit.position,
        this.dashDestination,
        this.dashSpeed
      );

      // The owning spell gets the frame *after* the step, so a pass that damages
      // what it flies through tests the ground it has actually covered.
      this.onDashUpdate?.();

      if (
        this.dashDestination &&
        p5.Vector.dist(this.targetUnit.position, this.dashDestination) < this.dashSpeed
      ) {
        this.onReachedDestination?.();
        this.deactivateBuff();
      }
    } else {
      this.onDashUpdate?.();
    }

    // somebody else took control of this unit mid-flight
    if (
      this.cancelable &&
      !this.unstoppable &&
      foreignControlBuff(this.targetUnit.buffs, this, this.sourceUnit, this.buffsToCheckCancel)
    ) {
      this.onCancelled?.();
      this.deactivateBuff();
    }

    // update trails
    if (this.showTrail) {
      this.trailSystem.addTrail(this.targetUnit.position);
    }
  }

  /**
   * An unstoppable flight turns away somebody else's displacement.
   *
   * Only another `Dash`, and only one whose source is not this dash's own — a
   * champion re-applying their own movement (Temari's drag renews itself every
   * few hundred milliseconds by design) is not somebody taking control. Every
   * other kind of buff still lands: the promise on the card is that crowd
   * control cannot *stop the charge*, not that it cannot be applied, and a stun
   * that lands here still stuns the moment the charge ends.
   */
  blocksIncoming(incoming: Buff): boolean {
    return (
      this.unstoppable &&
      incoming !== this &&
      incoming instanceof Dash &&
      incoming.sourceUnit !== this.sourceUnit
    );
  }

  // for override
  onCancelled?(): void {}
  onReachedDestination?(): void {}

  /**
   * Per-frame hook for the spell that owns this dash — a pass that damages what
   * it flies through, an afterimage dropped every other frame.
   *
   * Use this, never `dashBuff.onUpdate = …`. `Buff.update()` calls `onUpdate()`,
   * and `Dash` puts the movement itself in `Dash.prototype.onUpdate`, so an
   * instance-level assignment does not *hook* the frame, it *replaces* it: the
   * step, the arrival check and the interrupt check all disappear and the
   * champion plays the dash standing still. It reads exactly like a callback,
   * which is why three separate champions shipped with it.
   * `tests/game/spells/dash-onupdate-seam.test.ts` forbids the assignment.
   */
  onDashUpdate?(): void {}
}
