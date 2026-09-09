import { DEFAULT_DAMAGE_TYPE, type DamageType } from '@/game/combat/Mitigation';
import BuffAddType from '@/game/enums/BuffAddType';
import { describeStatusFlags } from '@/game/gameObject/buffs/describeBuff';
import type { AssetHandle } from '@/managers/AssetManager';
import type { GameObjectRuntimeContext } from './GameObject';
import type AttackableUnit from './attackableUnits/AttackableUnit';
import type { OnHitEvent } from '@/game/combat/OnHit';
import type Spell from './Spell';
import { currentAttribution } from '@/game/combat/DamageAttribution';

export type BuffConstructorArgs = [
  duration: number,
  sourceUnit: AttackableUnit,
  targetUnit: AttackableUnit,
];
export type BuffConstructor<TBuff extends Buff = Buff> = abstract new (
  ...args: BuffConstructorArgs
) => TBuff;
export type BuffStackId = string | BuffConstructor;

/**
 * One passive's readout on the body carrying it. See `Buff.structureMark`.
 */
export interface StructureMark {
  /** Lit segments — a stack count, or `1` for a passive that is simply on. */
  filled: number;
  /** How many segments there are at all. */
  total: number;
  /** The mark's own colour, so two passives on one turret stay tellable apart. */
  color: readonly [number, number, number];
}

/**
 * Running rearm clocks, parked between the lives — and the purchases — of
 * their wearers. See `Buff.rearmMsLeft`.
 *
 * Keyed by the *unit* and the spell's `name`, not by the spell instance:
 * selling an item destroys its spell, and a clock keyed there died with it —
 * so selling a spent Guardian Angel and buying it back handed the wings
 * straight back, which is a cooldown reset for 30% of the price. The source
 * game refuses exactly that trade, and so does this: the same champion
 * re-buying the same item finds the clock where they left it. A WeakMap on
 * the unit so a finished match takes every clock with it.
 */
const REARM_PARKED_BY_UNIT = new WeakMap<object, Map<string, { left: number; total: number }>>();

export default class Buff {
  name = this.constructor.name;

  /**
   * Whether damage this buff deals is amplified by its owner's
   * `Stats.abilityPower` — inherited, once, from whatever was running when the
   * buff was constructed.
   *
   * A buff is its own attribution while it ticks (`combat/DamageAttribution.ts`
   * brackets `update` and `onDamageTaken` with it, so a damage-over-time names
   * itself in the death recap). That is the right answer for the *name* and
   * the wrong one for the *scaling*: by the time it ticks, the cast that
   * applied it returned frames ago and there is nothing left to ask. Reading it
   * here — in a field initialiser, so it runs inside the applying spell's own
   * bracket — is what makes a poison an ability applied amplified and a poison
   * an item applied not, without either of them knowing the stat exists.
   */
  readonly damageScalesWithAbilityPower: boolean =
    currentAttribution()?.damageScalesWithAbilityPower === true;

  /**
   * Whether a hit this buff deals gives a hidden unit away — see
   * `combat/StealthBreak.ts` for the rule and `combat/DamageAttribution.ts`'s
   * `revealsStealth` for how the ambient carries it.
   *
   * True here, because most buffs that deal damage are somebody *doing*
   * something: an aura burning everyone standing next to its wearer, a
   * retaliation, a mark being detonated. The one that is not is a poison or a
   * burn already standing on its victim, which `buffs/DamageOverTime` turns
   * off — a buff of that shape written by hand rather than on top of that class
   * should turn it off too.
   */
  revealsStealth = true;
  description: string | null = null;
  image: AssetHandle | null | undefined = null;

  /**
   * Whether this buff appears on the HUD's buff row and on the overhead strip
   * above the champion. The mechanic runs either way — this is display only.
   *
   * Default true. A permanent armed state — an item passive that is simply
   * always on while the item is held — sets false: the inventory slot already
   * shows the item, and six of them wallpaper both bars with icons whose
   * "remaining time" means nothing. A buff with a state worth glancing at
   * (a charge armed, a stack count climbing) stays visible.
   */
  hudVisible = true;

  /**
   * What a structure draws on itself to say this passive is doing something
   * **right now** — or `null`, which is every buff in the game but three.
   *
   * ## Why structures need their own answer
   *
   * `hudVisible` puts a buff on the bar above the player's own champion. A
   * turret has no such bar and never will: its passives belong to a building
   * somebody is deciding whether to walk under, and that decision is made
   * looking at the building. So the three turret passives shipped
   * `hudVisible = false` and were invisible everywhere — a tower that is
   * currently taking 20% damage looked exactly like one that is not, and the
   * ramp that makes standing under it progressively lethal had no tell at all.
   *
   * ## Why a getter, and why segments
   *
   * A getter because the interesting ones *change*: the ramp climbs and cools,
   * the armour floor arms and disarms with the wave. A field would be a
   * snapshot from whenever the buff was built.
   *
   * Segments because that one shape covers both. A stacking passive lights
   * `filled` of `total`; an on/off one is `1` of `1` and simply returns `null`
   * while it is off. Nothing has to say which kind it is.
   *
   * **Returning `null` is how a passive says "not right now".** A passive that
   * is always on — the turret's own ward — deliberately draws nothing: a mark
   * that is never absent teaches nothing after the first glance, and the whole
   * value here is the difference between the lit and unlit states.
   *
   * It is on `Buff` rather than on a turret-specific base class because a pack
   * declaring `turretPassives` **replaces** core's list outright
   * (`turretPassivesFor`), so a pack's own turret has to be able to draw
   * without core having heard of its classes.
   */
  get structureMark(): StructureMark | null {
    return null;
  }

  buffAddType = BuffAddType.REPLACE_EXISTING;
  maxStacks = 1;

  /**
   * Identity used to decide which existing buffs this one stacks with or
   * replaces. Defaults to the class itself, which is what you want for a buff
   * that means one thing (Stun, Root).
   *
   * Set it when several unrelated spells apply the same generic buff class —
   * two bare `StatAmp`s or `DamageOverTime`s would otherwise fight over one
   * slot, so each spell should tag its own, e.g. `buff.stackId = 'ignite'`.
   */
  stackId: BuffStackId;
  timeElapsed = 0;
  toRemove = false;

  /**
   * When true, `AttackableUnit.drawBuffs()` calls `.draw()` on only the
   * *first* live buff sharing this instance's `stackId` each pass, and skips
   * every later one outright — a property read and a `Set` check, not a
   * function call.
   *
   * For a buff that paints its own visual per instance (a spinning icon over
   * the character, an aura ring), leave this `false` — the default, so every
   * existing buff draws exactly as before. Opt in when a *stack* is a data
   * count, not a drawable: a permanent growth stack is one buff instance per
   * kill (so `addBuff`'s grouping and a stat readout can count them), while
   * the ring it paints around its wearer already meant *one* stack's whole
   * drawn output. Before this flag, all of them still got their own `.draw()`
   * call — 999 calls a frame to paint one ring is a real, measured cost at
   * the stack counts a cheat can reach. The two buffs that opt in today are
   * both content, and both live in a pack rather than here; the cost, the
   * flag and the skip are the engine's
   * (`.superpowers/perf-healthbar-report.md`).
   */
  singleRepresentativeDraw = false;

  /**
   * When true, `AttackableUnit.addBuff()` increments `stacks` on the
   * existing live instance sharing this buff's `stackId` instead of pushing
   * a new one — one instance, a counter, rather than N instances carrying
   * identical bonuses.
   *
   * Correct only for a stack that is **permanent and uniform**: no per-stack
   * duration, no per-stack source, every stack worth exactly the same as
   * every other. A buff with a real per-stack expiry (a 10-stack Speedup
   * whose stacks were applied at different moments and must wear off at
   * different moments) needs the array — that is a list of expiry times
   * wearing a different name, and collapsing it into a counter would delete
   * information the model actually needs. Leave this `false` (the default)
   * for anything with a per-stack timer; opt in only where `duration` is a
   * single shared "how long since the last stack" clock, not N independent
   * ones. The two buffs that opt in today are both permanent stat stacks
   * shipped by a content pack — core defines the mechanism and names no
   * content, which is why this paragraph describes the shape rather than
   * pointing at two classes that are not in this repository's `src/`.
   */
  countedStacks = false;
  /**
   * How many stacks this instance is worth. 1 for an ordinary buff, and for
   * a single fresh application of a counted one — `addBuff()` adds a new
   * instance's `stacks` into the existing instance's `stacks` when
   * `countedStacks` is set, rather than treating the new instance as a
   * second drawable/timer. A `StatAmp` scales its modifier by this number
   * unconditionally (see `StatAmp.ts`), which is a no-op for every buff that
   * never touches it — it stays at the default of 1.
   */
  stacks = 1;

  statusFlagsToEnable = 0;
  statusFlagsToDisable = 0;

  /**
   * The re-arm clock — how long until this buff's once-in-a-while passive
   * may fire again, and the full window it counts down from.
   *
   * This is a whole mechanism, not a pair of display fields, because every
   * rearm-style passive needs the same four things and each pack was about
   * to hand-roll them again: a Guardian Angel's wings, a spell-block veil, a
   * barrier that rebuilds. Call `startRearm(windowMs)` when the passive
   * fires; ask `rearmed` before firing. The base `update` ticks the clock
   * down (no `onUpdate` bookkeeping owed), `hudState.buildItems` and the
   * touch item grid read it through the item's own `passive`/`active` spell
   * (matched by `sourceSpell`) and draw the same wedge-and-seconds a
   * cooldown gets — and the clock **survives its wearer's death**:
   * `deactivateBuff` parks the remainder on `sourceSpell`, and the fresh
   * buff the respawn's `armPassives` creates picks it back up in
   * `activateBuff`. Without that, dying re-pressed the passive and every
   * save came back armed — reported from a real match as a Guardian Angel
   * that always had its revival ready.
   *
   * A buff that never calls `startRearm` never writes these fields and shows
   * nothing.
   */
  rearmMsLeft = 0;
  rearmTotalMs = 0;

  /**
   * Whether this buff rides through its wearer's death instead of being
   * cleared with everything else.
   *
   * Default false — a stun, a shield, a poison on a corpse is nonsense, and
   * `AttackableUnit.clearBuffs` (death's sweep, and only death's) unwinds
   * them all. Set true on a **permanent growth stack** — a Feast, a dark
   * seal, an eaten heart — whose whole promise is the word "vĩnh viễn": the
   * first version let death eat a devourer's every stack, which the modern
   * source game does not do. Meant for pure stat carriers; a buff that holds
   * status flags or draws combat state should never set it.
   */
  survivesDeath = false;

  startRearm(windowMs: number): void {
    // The match's cooldown setting reaches rearm windows the same way it
    // reaches every cast — the same live read `Spell.cooldownMultiplier`
    // makes. An URF-style room shortens the wings' 50s with everything else.
    const rule = this.game?.matchRules?.cooldownMultiplier ?? 1;
    const window = windowMs * rule;
    this.rearmTotalMs = window;
    this.rearmMsLeft = window;
  }

  /** Whether the once-in-a-while passive may fire. True until `startRearm`. */
  get rearmed(): boolean {
    return this.rearmMsLeft <= 0;
  }

  duration = 0;
  sourceUnit: AttackableUnit;
  targetUnit: AttackableUnit;
  game: GameObjectRuntimeContext;

  /**
   * The spell whose *presence* this buff depends on, or null for the default —
   * a buff that stands on its own once applied (every timed effect).
   *
   * Set it on a permanent buff hung by something removable: an item passive's
   * on-hit or reflect, a kit passive's aura. `Spell.onRemoved` deactivates
   * every buff on its owner that names it here, which is what makes selling
   * the item (or swapping the kit) actually take the effect away — before
   * this existed, a sold Giáp Gai kept its spikes for the rest of the match.
   */
  sourceSpell: Spell | null = null;

  _deactivateListeners: (() => void)[] = [];
  _created = false;
  _deactivated = false;
  _activated = false;

  constructor(...[duration, sourceUnit, targetUnit]: BuffConstructorArgs) {
    this.stackId = new.target;
    this.duration = duration;
    this.sourceUnit = sourceUnit;
    this.targetUnit = targetUnit;
    this.game = targetUnit.game;
  }

  activateBuff(): void {
    // The rearm clock coming back from the wearer's last life — or last
    // purchase of this item — see `rearmMsLeft`. Before `onCreate`, so a
    // subclass reading its own state there already sees the restored clock.
    // Only when this instance has not started one of its own: a restore must
    // never shorten a live window.
    if (this.sourceSpell && this.rearmMsLeft <= 0) {
      const parked = REARM_PARKED_BY_UNIT.get(this.targetUnit)?.get(this.sourceSpell.name);
      if (parked && parked.left > 0) {
        this.rearmTotalMs = parked.total;
        this.rearmMsLeft = parked.left;
      }
    }
    if (!this._created) {
      this.onCreate();
      // After `onCreate`, because that is the first moment a buff is fully
      // built — callers set `percent`, `amount` and `bonuses` on the instance
      // after the constructor returns, which is what `onCreate` exists for —
      // and only when nothing has written one, so a buff that describes itself
      // always wins. See `buffs/describeBuff.ts` for why the control effects
      // are derived from their own flags rather than written out.
      this.description ??= describeStatusFlags(this.statusFlagsToEnable, this.statusFlagsToDisable);
      this._created = true;
    }
    if (this._activated) return;
    this.onActivate();
    this._activated = true;
  }

  deactivateBuff(): void {
    if (this._deactivated) return;
    this._deactivated = true;
    this.toRemove = true;
    // Park a running rearm clock under the wearer and the item's name, so
    // neither death nor a sell-and-rebuy hands the passive back armed. A
    // finished clock clears the parking spot.
    if (this.sourceSpell && this.rearmTotalMs > 0) {
      let clocks = REARM_PARKED_BY_UNIT.get(this.targetUnit);
      if (this.rearmMsLeft > 0) {
        if (!clocks) {
          clocks = new Map();
          REARM_PARKED_BY_UNIT.set(this.targetUnit, clocks);
        }
        clocks.set(this.sourceSpell.name, { left: this.rearmMsLeft, total: this.rearmTotalMs });
      } else {
        clocks?.delete(this.sourceSpell.name);
      }
    }
    this.onDeactivate();
    for (const listener of this._deactivateListeners) {
      listener?.();
    }
  }

  renewBuff(): void {
    if (this._deactivated) {
      this.onActivate(); // re-activate
      this._deactivated = false;
    }
    this.timeElapsed = 0;
    this.toRemove = false;
  }

  update(): void {
    // Before `onUpdate`, so a passive asking `rearmed` there reads a clock
    // that has already moved this frame.
    if (this.rearmMsLeft > 0) this.rearmMsLeft = Math.max(0, this.rearmMsLeft - deltaTime);

    this.onUpdate();

    this.timeElapsed += deltaTime;
    if (this.duration && this.timeElapsed >= this.duration) {
      this.deactivateBuff();
    }
  }

  /**
   * Whether this live buff refuses `incoming`, which is then never added.
   *
   * The one place a buff already on a unit gets a say in what lands next. It
   * exists because `addBuff`'s stack rules answer "how do two of these share a
   * slot", and some effects need to answer "this one does not get a slot at
   * all" — `Dash.unstoppable` is the first: a charge that says crowd control
   * cannot stop it has to be able to turn away the pull that would otherwise
   * replace it, and `REPLACE_EXISTING` gives the incoming buff that place
   * unconditionally.
   *
   * Asked of every live buff, so keep it cheap and keep it a *question* —
   * nothing here may mutate either side. Undefined on almost everything.
   */
  blocksIncoming?(incoming: Buff): boolean;

  // for override
  onCreate(): void {}
  onUpdate(): void {}
  onActivate(): void {}
  onDeactivate(): void {}
  draw(): void {}
  /**
   * `countedStacks` only: called on an already-active instance right after
   * `AttackableUnit.addBuff()` changes `stacks` on it (never on the first
   * stack, which goes through `onCreate`/`onActivate` instead, already
   * reading the starting `stacks` value). Override to rescale whatever the
   * stack count drives — `StatAmp` rebuilds and re-applies its modifier.
   */
  onStacksChanged(): void {}

  /**
   * Runs before damage reaches the target's health. Return what should get
   * through: less for shields and damage reduction, more for amplification.
   * Every buff on the unit sees the damage in turn.
   *
   * `type` is the hit's `DamageType`, so a buff can answer differently for
   * one kind of damage than for another — a shield that eats only magic, a
   * reduction that armour already covers. It arrives third and optional
   * because every override that existed before it ignores the question, and
   * a buff that reduces damage full stop is still the common case.
   */
  modifyIncomingDamage(
    damage: number,
    _attacker?: AttackableUnit,
    _type: DamageType = DEFAULT_DAMAGE_TYPE
  ): number {
    return damage;
  }

  /**
   * Called once damage has been mitigated and applied, whatever the outcome —
   * including a hit a shield swallowed whole.
   *
   * `swung` is what arrived before anything ate it; `landed` is what actually
   * reached health. It cannot change either, and that is the point: a buff that
   * *reacts* to being hit (a thorns-style spike counter, a shield's own burn
   * effect) has no
   * business being a link in the mitigation chain, where the answer depends on
   * whether some other buff was added before or after it. Two shields on one
   * unit put a reflect behind them and it silently stopped firing.
   */
  onDamageTaken(_swung: number, _landed: number, _attacker?: AttackableUnit): void {}

  /**
   * The mirror of `onDamageTaken`, on the other body: called once for every hit
   * the *owner of this buff* dealt to somebody else, after it resolved.
   *
   * `Buff.onHit` above is basic attacks only — `combat/BasicAttack.ts` is its
   * one emitter — so before this hook an effect that answers "I damaged
   * somebody" could not exist for a spell at all. A grievous-wounds passive on
   * a mage's item is the case that needed it: the item is bought to be used
   * with abilities, and hanging it on the on-hit seam would have sold a
   * counter that never fires to the half of the roster that never swings.
   *
   * `type` is here and absent from `onDamageTaken` because this side is where
   * it decides anything: an item that answers physical damage and one that
   * answers magic are two different items in the same shop, while a buff
   * reacting to *being* hit has the attacker in hand and cares about who, not
   * which kind.
   *
   * Like the taken side it cannot change the hit — the numbers are settled by
   * the time it runs, `landed` is already capped at the pool that took it, and
   * a buff that wants to modify a hit is a `modifyIncomingDamage` on the other
   * unit. Also like the taken side, it fires for a hit a shield swallowed
   * whole, with `landed` at 0: what was swung still happened.
   */
  onDamageDealt(
    _swung: number,
    _landed: number,
    _victim: AttackableUnit,
    _type: DamageType = DEFAULT_DAMAGE_TYPE
  ): void {}

  /**
   * Called once per basic attack the *owner of this buff* lands — the on-hit
   * seam, walked by `combat/OnHit.ts`'s `applyOnHitEffects` from
   * `landBasicAttack` after the swing's own damage has been applied.
   *
   * The effect deals its own damage (`hit.victim.takeDamage(..., 'MAGICAL')`),
   * heals, refunds — nothing is folded back into the swing, so each payload
   * carries its own damage type through mitigation. An effect that
   * *re-applies* on-hits (a phantom hit, a side bolt, a doubling) must mark
   * what it starts `echo: true` and refuse to act when `hit.echo` is already
   * true — see `OnHit.ts`'s header for why that pair of rules is what makes
   * every stack of propagators terminate.
   */
  onHit(_hit: OnHitEvent): void {}

  /**
   * Damage this buff can still absorb, drawn as a grey overlay on the health
   * bar. Anything that soaks damage should report it here so the player can see
   * how much cushion is left; the health bar never has to know the class.
   */
  get shieldAmount(): number {
    return 0;
  }

  addDeactivateListener(listener: () => void): void {
    this._deactivateListeners.push(listener);
  }
}
