import { uuidv4 } from '@/utils/index';
import { effectiveRange } from '@/game/combat/Reach';
import { amplifiedDamageText } from '@/game/combat/Amplification';
import EventType from '@/game/enums/EventType';
import SpellState from '@/game/enums/SpellState';
import { SpellRuntime, type SpellRuntimeDelegate } from '@/game/spell/runtime/SpellRuntime';
import SpellVfx from '@/game/vfx/SpellVfx';
import {
  interruptsSuspended,
  isInterruptibleState,
  ownerInterruptReason,
  resolveInterrupts,
  snapshotOwnerMovement,
  type OwnerMovementSnapshot,
} from '@/game/spell/runtime/CancelPolicy';
import type { TargetingRequest } from '@/game/spell/targeting/TargetResolver';
import { beginAttribution, endAttribution } from '@/game/combat/DamageAttribution';
import { isNetClient } from '@/game/net/netRole';
import { hasteCooldownMultiplier } from '@/game/gameObject/Stats';
import type {
  CancelReason,
  CastContext,
  CastSpec,
  ResourceCommitPoint,
  SpellRuntimeState,
  TargetingMode,
  Vec2,
} from '@/game/spell/runtime/types';

/** Where a spell fires when neither the aim nor the caster points anywhere. */
const DEFAULT_FACING: Vec2 = Object.freeze({ x: 1, y: 0 });

const legacyCastSpec = (durationMs: number, targeting: TargetingMode): CastSpec => ({
  activation: 'PRESS',
  targeting,
  castTimeMs: 0,
  resource: { commitAt: 'start', refundOn: [] },
  cooldown: { startAt: 'start', durationMs },
});

const snapshotContext = (context: CastContext): CastContext =>
  Object.freeze({
    ...context,
    origin: Object.freeze({ ...context.origin }),
    cursorWorld: Object.freeze({ ...context.cursorWorld }),
    direction: Object.freeze({ ...context.direction }),
  });

export default class Spell {
  // for display in HUD
  name = this.constructor.name;
  image: any = null;
  description: any = null;
  disabled = false;
  willDrawPreview = false;

  // for spell logic
  level = 0;
  coolDown = 0;
  manaCost = 0;
  healthCost = 0;

  /**
   * Whether a completed cast of this spell counts as *using an ability* — the
   * question a spellblade-style effect ("your next attack after casting a
   * spell…") asks of the `ON_POST_CAST_SPELL` event it hears.
   *
   * True for every ordinary kit spell, which is why the default is here and
   * not on each of them. Core switches it off for the casts that merely ride
   * the spell machinery without being abilities: the basic attack
   * (`coreSpells/BasicAttack` — every attack order would otherwise arm the
   * empowerment it is supposed to consume), Hồi Thành (`preset.ts`), and a
   * held item's own passive and active (`ItemShop.buildHeldItem` — an item
   * passive is *pressed* once per life to arm it, and an item triggering
   * itself is not what anyone means by "after casting a spell").
   */
  countsAsAbilityCast = true;

  /**
   * Whether damage this ability deals is amplified by the caster's
   * `Stats.abilityPower`. True for every kit ability, which is the whole point
   * — 308 abilities across the installed packs scale off a build without one
   * of them being edited.
   *
   * **A separate flag from `countsAsAbilityCast` above, and not an oversight.**
   * That one answers "did the player just use an ability", which is a question
   * about the *cast*; this one answers "is this ability damage", which is a
   * question about the *hit*. They disagree in both directions and the cases
   * are real: a champion's own passive is not a cast (`Champion.armPassives`
   * switches it off) but the damage it deals is unmistakably ability damage,
   * while Hồi Thành is switched off in both and deals no damage at all.
   * Folding them together would have quietly excluded every passive in the
   * game from scaling, with nothing to look at.
   *
   * Core switches it off in two places: `coreSpells/BasicAttack`, whose damage
   * is a swing and already scales on `attackDamage`, and `economy/ItemShop`,
   * because an item's own abilities scale on the wearer's attack damage and
   * must not draw from both stats at once.
   */
  damageScalesWithAbilityPower = true;

  /**
   * What this ability *does*, for the bot brain — see `src/game/ai/SpellRole.ts`.
   * Optional on purpose: an untagged spell is classified from its `castSpec`,
   * so tagging is an improvement a champion can opt into, never a gate on
   * shipping one.
   */
  static aiRoles?: number;

  /**
   * Pixels per frame this ability's projectile travels, for aim prediction.
   * Defaults to `MissileSpellObject`'s own 7 when absent.
   */
  static aiProjectileSpeed?: number;

  /**
   * When the bot may spend this ability's recast, in ms from activation.
   *
   * `BotBrain.cast` schedules a follow-through press for every `RECAST`
   * activation at `recastDelayMs`, which defaults to **0**. That is right when
   * the recast is the payload — a detonation detonates, a queued shot fires,
   * a second dash goes a second time — and wrong in two different ways when
   * the recast is something the player is meant to *time*:
   *
   * - **Never.** A transform's recast puts the form down. The bot pressed it
   *   on the next think tick, so a fifteen-second form lasted one frame and
   *   the player reported never seeing the ultimate used at all. `Infinity`
   *   says the recast is not the bot's to spend.
   * - **Later.** Some recasts both fire a payload *and* end a window that was
   *   supposed to run. One ultimate here launches a cone and tears down its
   *   own nine-second buff in the same call; pressed at once the bot gets the
   *   cone and none of the nine seconds, and never pressing it means the cone
   *   never happens. Neither is right, and a boolean cannot say so — this is
   *   the field's whole reason for being a number.
   *
   * A third shape needs it too, with nothing being ended: an ability whose
   * recast reads a value that is still ramping — a charge, a rotating card —
   * gives the bot the weakest reading in the cycle at 0ms, every time.
   *
   * Omitted means today's behaviour, which is what every payload recast wants.
   * The first press is delayed by `max(recastDelayMs, this)`; later recasts of
   * a multi-shot ability keep their own cadence.
   */
  static aiRecastAfterMs?: number;

  /**
   * How long the bot holds this ability's charge before letting go, in ms.
   *
   * The default was `maxDurationMs / 2` — half, for every charged ability in
   * every pack, with nothing saying why. So a bot threw a 18–48 skillshot at
   * 33 and a 45–75 one at 60, forever, and a tap-or-hold ability never tapped.
   *
   * Charging to the top is the better default and it is *not* a safe blanket
   * rule, which is why this field exists rather than a constant. Two reasons,
   * both real in the shipped content:
   *
   * - **A charge that is not `releaseAtMax` is CANCELLED at max.**
   *   `SpellRuntime.updateCharge` calls `cancelActivation('MAX_DURATION')`,
   *   so holding to the number in `maxDurationMs` throws the whole ability
   *   away — mana, cooldown and all. The default therefore stops short of it
   *   by `CHARGE_CANCEL_MARGIN_MS`, and a declared value is clamped the same
   *   way rather than trusted over the runtime.
   * - **Most charges stop paying long before max.** One skillshot here maxes
   *   its range at 1500ms and its damage at 1250ms against a 4000ms window:
   *   the last 2.5 seconds buy nothing at all, and `advanceCharge` returns
   *   `true` while holding, so the bot does not think or move for any of them.
   *
   * Where the ability stops improving is a fact about *that* ability, so it is
   * stated on it. Omitted means charge to the top, safely.
   */
  static aiChargeReleaseAtMs?: number;

  id: string = uuidv4();
  owner: any;
  game: any;
  private spellRuntime?: SpellRuntime;
  private resolvedSpec?: CastSpec;
  private spellVfx?: SpellVfx;
  private _castContext?: CastContext;
  private ownerSnapshot?: OwnerMovementSnapshot;

  constructor(owner: any) {
    this.owner = owner;
    this.game = owner?.game;
  }

  /** @deprecated New and migrated spells must use lifecycle policies. */
  get state(): SpellRuntimeState {
    return this.runtime.state;
  }

  set state(state: SpellRuntimeState) {
    this.runtime.setCompatibilityState(state);
  }

  /** @deprecated New and migrated spells must use lifecycle policies. */
  get currentCooldown(): number {
    return this.runtime.cooldownRemainingMs;
  }

  set currentCooldown(remainingMs: number) {
    this.runtime.setCompatibilityCooldown(remainingMs);
  }

  /**
   * Whether this ability is running right now — a toggle that is on, an active
   * window open, a channel under way. See `SpellRuntime.isSustaining` for why
   * it is not called `isActive` and why a windup does not count.
   *
   * Read by the HUD, which had no way to ask before: a toggle drew exactly the
   * same icon on and off, and the only ability state a player could see was
   * the cooldown wedge.
   */
  get isSustaining(): boolean {
    return this.runtime.isSustaining;
  }

  /** How long that sustain lasts, or 0 when it has no declared end. */
  get sustainDurationMs(): number {
    return this.runtime.sustainDurationMs;
  }

  /** Milliseconds left of it; 0 both when nothing runs and when it is open-ended. */
  get sustainRemainingMs(): number {
    return this.runtime.sustainRemainingMs;
  }

  /**
   * Pressing the key again turns it off, rather than doing something new.
   *
   * The HUD needs the distinction that `isSustaining` alone does not carry: a
   * bounded active window ends on its own and wants a countdown, while a
   * toggle wants a plain on/off badge and the promise that the same key is the
   * way out.
   */
  get isToggle(): boolean {
    return this.castSpec.activation === 'TOGGLE';
  }

  get castContext(): CastContext | undefined {
    return this._castContext;
  }

  /**
   * A counter this spell accumulates across casts, e.g. a stacking spell's strikes. The
   * HUD badges the icon with it, so a stacking spell shows its progress instead
   * of only flashing a number at the moment it lands. `undefined` means the
   * spell has nothing to count and gets no badge.
   */
  get stackCount(): number | undefined {
    return undefined;
  }

  /**
   * Set this spell's accumulated stacks. Absolute rather than incremental so
   * one method covers both "give me 100" and "back to zero"; symmetric with
   * `stackCount`, which is the read side.
   *
   * Default: this spell has none, so the call is refused rather than silently
   * doing nothing. Returns whether the spell accepted it.
   */
  setStackCount(_count: number): boolean {
    return false;
  }

  get aimPoint(): p5.Vector {
    if (this.spellRuntime?.state === 'CHARGING' && this.owner === this.game?.player) {
      // The live aim is the *player's* charge preview, and only theirs — the
      // same owner check `onChargeUpdate` and `onRelease` below already make,
      // which this branch was missing. A bot charging a HOLD_RELEASE spell
      // read the human's pointer. Below this, `_castContext.cursorWorld` comes
      // first, so a bot on the `BotBrain.cast` path never reaches it at all.
      //
      // **`worldMouse` is the desktop half of the answer, not the whole of
      // it.** With a mouse the cursor *is* where the player is pointing; with
      // a thumb it is where the finger is pressing, which while charging is
      // the ability button in the corner of the screen. Reading it directly
      // made every charged ability on a phone fire at its own button and
      // ignore the drag entirely. `Game.liveAimFor` is the question
      // `Game.createContext` already asks to build the opening press — the
      // slot's drag aim, else the mouse — asked again for the two moments the
      // opening press cannot answer: the charging frames, and the release.
      //
      // The release is the one that is easy to miss. `SpellRuntime.releaseCast`
      // calls `onRelease` *before* it moves the state off `CHARGING`, so a
      // hook aiming its projectile with `this.aimPoint` — which is how every
      // charged ability in the shipped packs aims — takes this branch too.
      const liveAim = this.game.liveAimFor?.(this) ?? this.game.worldMouse;
      if (liveAim) return createVector(liveAim.x, liveAim.y);
    }
    const aim = this._castContext?.cursorWorld ?? this.game?.worldMouse;
    return createVector(aim ? aim.x : 0, aim ? aim.y : 0);
  }

  /**
   * Runs `body` with this spell as the attribution for any damage inside it
   * that does not name a source, and for any `SpellObject` it constructs.
   *
   * Applied at the four places core hands control to the runtime — `update`,
   * `press`, `hold`, `release` — rather than at each of the seven delegate
   * callbacks below, because every one of those fires synchronously inside one
   * of these four. Four brackets that cannot miss a path beat seven that can.
   *
   * See `combat/DamageAttribution.ts`, including why this saves and restores
   * instead of assigning.
   */
  private attributed<T>(body: () => T): T {
    const previous = beginAttribution(this);
    try {
      return body();
    } finally {
      endAttribution(previous);
    }
  }

  update(): void {
    this.onUpdate();
    this.observeInterrupts();
    this.holdStillWhileCasting();
    this.attributed(() => this.runtime.update(deltaTime));
    if (this.owner.isDead) {
      this.spellVfx?.dispose();
      return;
    }
    this.syncVfxPhase();
    this.spellVfx?.update(deltaTime);
  }

  drawVfx(): void {
    this.spellVfx?.draw();
  }

  /**
   * Whether this spell may be pressed while its caster is crowd-controlled.
   *
   * **False for every ability, and that is not negotiable for them.** Every
   * gate below reads `owner.canCast`, which `Stats.updateActionState` clears
   * for Stunned, Silenced, Charmed, Feared, Taunted and Suppressed — a stun
   * that did not stop casting would not be a stun.
   *
   * It exists for the one shape that is the exact opposite: an effect whose
   * *purpose* is getting out of crowd control. A Quicksilver-style cleanse
   * that refuses while you are stunned is an item that does nothing on the
   * only occasion anybody buys it, and there is no way for a pack to express
   * that without core saying it may.
   *
   * It buys past crowd control **and nothing else** — death, cooldown, mana,
   * health cost and `checkCastCondition` all still apply. This is not "this
   * spell ignores the rules"; it is one rule, named, that a spell can decline.
   */
  castableWhileControlled = false;

  /**
   * The caster can act, or this spell is one of the few allowed to act anyway.
   * See `castableWhileControlled`.
   */
  protected get casterMayCast(): boolean {
    return this.owner.canCast || this.castableWhileControlled;
  }

  /**
   * Off cooldown, paid for, and nothing about the caster in the way — "press
   * this key right now and something happens".
   *
   * The same gate `castCancelCheck` applies, minus two things it does that a
   * read-only question must not: it calls `resetCoolDown()`, and it calls
   * `checkCastCondition()`, which for the auto-locking spells means a fresh
   * quadtree scan. Callers that ask every frame (`ExecuteMarks`) do their own
   * scan anyway and would otherwise pay for two.
   */
  get isCastableNow(): boolean {
    return (
      !this.disabled &&
      this.state === SpellState.READY &&
      !!this.owner &&
      !this.owner.isDead &&
      this.casterMayCast &&
      this.canAffordMana(this.manaCost) &&
      this.owner.stats.health.value >= this.healthCost
    );
  }

  cast(): void {
    if (this.state !== SpellState.READY) return;

    const origin = { x: this.owner.position.x, y: this.owner.position.y };
    const cursorWorld = {
      x: this.game.worldMouse.x,
      y: this.game.worldMouse.y,
    };
    const dx = cursorWorld.x - origin.x;
    const dy = cursorWorld.y - origin.y;
    const length = Math.hypot(dx, dy);
    this.press(
      Object.freeze({
        spellId: this.id,
        activationId: uuidv4(),
        startedAtMs: Date.now(),
        caster: this.owner,
        origin: Object.freeze(origin),
        cursorWorld: Object.freeze(cursorWorld),
        direction: Object.freeze({
          x: length === 0 ? 0 : dx / length,
          y: length === 0 ? 0 : dy / length,
        }),
      })
    );
  }

  press(context: CastContext): boolean {
    this._castContext = snapshotContext(context);
    this.game.eventManager.emit(EventType.ON_PRE_CAST_SPELL, this);
    const accepted = this.attributed(() => this.runtime.press(this._castContext!));
    if (accepted) {
      // **A cast that movement ends must first end the movement.**
      //
      // `CancelPolicy` watches `movementRevision`, which counts move *orders* —
      // so a champion already walking when the channel starts issues no new
      // order, the watcher sees nothing, and she strolls across the lane firing
      // an ultimate she is supposed to be standing still for. Reported exactly
      // that way. Planting her here is what makes the rule the form already
      // declares (`SpellForm.CHANNELED`) reachable at all: from this frame on,
      // any move order is a *change* and cancels the channel.
      //
      // `stopMovement()` deliberately does not bump the revision (it writes the
      // destination directly), so this cannot cancel the cast it just started.
      // Before `snapshotOwner`, so the snapshot records the stopped feet.
      // Optional at both hops, the same way the attack-order clear below is:
      // a spell is constructed against a bare stat block in more than one
      // fixture, and a cast must not throw because its owner has no feet.
      if (resolveInterrupts(this.activeCastSpec.interrupts).move) this.owner?.stopMovement?.();
      this.snapshotOwner();
      // Casting is the third way to cancel a standing attack order, beside a
      // move order and crowd control: committing to an ability is a decision to
      // stop chasing.
      //
      // Here rather than on ON_PRE_CAST_SPELL because that event fires before
      // the runtime has ruled on the cast, so a listener cannot tell a real cast
      // from a key pressed into a cooldown. That distinction is not cosmetic:
      // an AI champion attempts a cast several times a second and is refused
      // almost every time, so cancelling on the attempt would leave the bots
      // unable to hold an attack order at all. `accepted` is the cast.
      if (this.activeCastSpec.attackOrder !== 'keep') this.owner?.basicAttack?.clear();

      // Unit-targeted casts give the caster away; skillshots do not. The test
      // is a *resolved target*, not "a spell was cast", because a spell that
      // names no unit is exactly the one that must stay quiet — firing one out
      // of a brush is a real thing to do, in League and here. See
      // `combat/AttackReveal.ts`.
      //
      // The fog is the whole of what a cast gives away. **It does not end a
      // stealth**, and there was a line here that did: dropping a box or a
      // decoy announces nothing and damages nobody, so a jester who blinked
      // away was given up by the two abilities the blink is cast to set up.
      // What ends a stealth is a hit landing, on either end of it, from
      // `AttackableUnit.takeDamage` — see `combat/StealthBreak.ts`.
      if (this._castContext?.target) this.owner?.revealForAttack();
    }
    this.syncVfxPhase();
    return accepted;
  }

  /**
   * Whether this spell's countdown is a lockout — a wait before the ability can
   * be used at all — or a rhythm the ability keeps on its own.
   *
   * Every real cooldown is a lockout, and the HUD says so loudly: it greys the
   * icon and stamps the seconds left over it. The basic attack's countdown is
   * its swing interval, which is running whenever the champion is fighting, so
   * the loud treatment would leave that slot greyed out and covered in a
   * flickering "2" for the whole game. It gets the sweeping wedge and nothing
   * else, which is the part that actually reads as a rhythm.
   */
  get cooldownLocksOut(): boolean {
    return true;
  }

  hold(context: CastContext): boolean {
    return this.attributed(() => this.runtime.hold(context));
  }

  release(context: CastContext): boolean {
    this._castContext = snapshotContext(context);
    const released = this.attributed(() => this.runtime.release(this._castContext!));
    this.syncVfxPhase();
    return released;
  }

  cancel(reason: CancelReason): boolean {
    return this.runtime.cancel(reason);
  }

  castCancelCheck(): boolean {
    if (
      this.disabled ||
      this.owner.isDead ||
      !this.casterMayCast ||
      !this.canAffordMana(this.manaCost) ||
      this.owner.stats.health.value < this.healthCost ||
      !this.checkCastCondition()
    ) {
      this.resetCoolDown();
      return true;
    }

    return false;
  }

  /**
   * The spell is going dormant but is coming back — a form swap.
   *
   * `deactivate()` minus `resetCoolDown()`, and that subtraction is the whole
   * point. A stance is a toggle, so zeroing the cooldown on the way out hands
   * the player a free reset: cast Q, transform, transform back, cast Q again.
   * `tests/game/attackableUnits/ChampionStance.test.ts` pins it.
   *
   * Cancels the in-flight cast because a channel cannot keep running while its
   * caster no longer has the spell in a slot, and disposes the VFX because the
   * dormant spell is no longer in the `spells[]` array that `drawVfx` walks —
   * anything it left on screen would hang there until the form ended.
   */
  suspend(): void {
    this.runtime.cancel('STANCE_SWAP');
    this.spellVfx?.dispose();
  }

  deactivate(): void {
    this.runtime.cancel('SCENE_EXIT');
    this.resetCoolDown();
    this.spellVfx?.dispose();
  }

  /**
   * The spell is leaving its owner for good — an item sold, a kit swapped.
   *
   * Any permanent buff that declared this spell as its `sourceSpell` goes
   * with it. That is the other half of the item-passive contract: the passive
   * hangs a duration-0 buff once per life (`Champion.armPassives`), and
   * without this sweep the buff outlived the sale — a sold Giáp Gai kept
   * reflecting for the rest of the match. Over a copy, because
   * `deactivateBuff` calls out to listeners that must not mutate the list
   * under the walk.
   */
  onRemoved(): void {
    this.runtime.cancel('SCENE_EXIT');
    this.spellVfx?.dispose();
    for (const buff of [...(this.owner?.buffs ?? [])]) {
      if (buff.sourceSpell === this) buff.deactivateBuff();
    }
  }

  resetCoolDown(): void {
    this.currentCooldown = 0;
  }

  /**
   * The unit vector to fire along; never (0,0).
   *
   * Both context builders — `cast()` above and `TargetResolver.createContext`
   * — resolve an aim that landed exactly on the caster to a zero direction,
   * and every consumer then multiplies it by a range and gets nothing. It is
   * not a rare case: `AIChampion.aimPoint` falls back to `destination` when
   * there is no cursor, and a bot with `_autoMove` off leaves that parked on
   * its own feet, so it aims every spell into the ground under it. Measured on
   * a live beam ability: a beam whose start and end were the same coordinate, which
   * paints nothing and hit-tests as a dot at the caster's feet.
   *
   * The fallback is the caster's own heading and then a fixed vector, which is
   * the rule `Game.facing()` already states for the touch layer, in the same
   * words: never (0,0).
   */
  protected firingDirection(context: CastContext): Vec2 {
    const aim = context.direction;
    if (aim.x !== 0 || aim.y !== 0) return aim;

    const dx = (this.owner?.destination?.x ?? 0) - (this.owner?.position?.x ?? 0);
    const dy = (this.owner?.destination?.y ?? 0) - (this.owner?.position?.y ?? 0);
    const length = Math.hypot(dx, dy);
    if (length > 0.01) return { x: dx / length, y: dy / length };
    return DEFAULT_FACING;
  }

  // for override
  checkCastCondition(): boolean {
    return true;
  }

  onSpellCast(_context: CastContext): void {}
  onUpdate(): void {}
  onCastStart(_context: CastContext): void {}
  onChargeUpdate(_context: CastContext, _elapsedMs: number, _ratio: number): void {}
  onRelease(_context: CastContext): void {}
  onChannelTick(_context: CastContext, _tickIndex: number): void {}
  onActivate(_context: CastContext): void {}
  onRecast(_context: CastContext): void {}
  onCancel(_context: CastContext, _reason: CancelReason): void {}
  onComplete(_context: CastContext): void {}

  /**
   * How a thumb (or the mouse) aims this spell — see `docs/ADDING_SPELLS.md`.
   * Only read by the default `castSpec` below; a spell that overrides
   * `castSpec` itself (the typed-lifecycle spells) puts `targeting` straight
   * into its own spec and this field is never consulted for it.
   *
   * There used to be no such field: the default `castSpec` simply hardcoded
   * `targeting: 'DIRECTION'`, silently, for every one of the ~69 spells that
   * had not been migrated onto their own `castSpec`. DIRECTION is the one
   * mode that discards a drag's distance, so on touch every one of those
   * spells flew to its absolute maximum range no matter where the thumb let
   * go — including placed effects like a ground-mark ability, which should have stopped
   * wherever it was aimed. `castSpec` now throws instead of guessing, so a
   * legacy spell subclass must set this explicitly to what it actually does.
   * The `targeting-mode-declared` seam (`npm run check-seams`) fails the build for any
   * spell file that doesn't (mirrors `tests/game/buffs/Ground.test.ts`, which
   * does the same for `owner.teleportTo`).
   */
  protected targetingMode?: TargetingMode;

  get castSpec(): Readonly<CastSpec> {
    if (!this.targetingMode) {
      throw new Error(
        `${this.constructor.name} has no targeting mode. Set \`targetingMode\` to 'SELF' | ` +
          "'DIRECTION' | 'POINT' | 'UNIT', or override `castSpec` yourself — see docs/ADDING_SPELLS.md."
      );
    }
    return legacyCastSpec(this.coolDown, this.targetingMode);
  }

  /**
   * The spec the runtime was actually built from. `castSpec` is a getter that
   * rebuilds its object on every read, so anything that must agree with the
   * live runtime — the interrupt form, the attack-order rule — has to read the
   * copy the runtime kept rather than a fresh one.
   */
  protected get activeCastSpec(): Readonly<CastSpec> {
    void this.runtime;
    return this.resolvedSpec as CastSpec;
  }

  /**
   * The one expression in the codebase that reads the match's cooldown rule.
   * Read through `reducedCooldown` every time a countdown starts, never cached:
   * `MatchDirector.seedRules` mutates this same object mid-match so a slider
   * drag reaches spells that already exist, and anything holding a copy of the
   * multiplier would keep the rule the match was booted with.
   */
  private get cooldownMultiplier(): number {
    const rule = this.game?.matchRules?.cooldownMultiplier ?? 1;
    // **Only real ability casts.** `countsAsAbilityCast` is already the flag
    // that means "the player used an ability" rather than "a spell object ran",
    // which is exactly the question a cooldown-reduction stat is asking, so it
    // is reused here rather than a second flag being invented beside it. It
    // keeps the three casts that merely ride the spell machinery out: the basic
    // attack, whose rhythm is `stats.attackSpeed` and whose timer belongs to
    // its controller; Hồi Thành, which is a fixed channel and not an ability;
    // and a held item's own passive and active, so one purchase cannot shorten
    // another's.
    //
    // Note this is the opposite reuse decision from
    // `damageScalesWithAbilityPower`, which needed a flag of its own — and for
    // the reason given there: that one is a question about a *hit*, and this one
    // is a question about a *cast*, which is what `countsAsAbilityCast` has
    // always answered.
    if (!this.countsAsAbilityCast) return rule;
    const haste = this.owner?.stats?.abilityHaste?.value;
    if (!Number.isFinite(haste) || (haste as number) <= 0) return rule;
    // `100 / (100 + haste)` — `Stats.hasteCooldownMultiplier` owns the curve and
    // the argument for points over a fraction. It can never reach zero, so
    // unlike the fraction this replaced there is no cap to respect here.
    return rule * hasteCooldownMultiplier(haste as number);
  }

  /**
   * Cooldown reduction's seam — the only place a match-wide rule turns a
   * spell's tuning number into the number that actually gets counted down.
   *
   * Both ways a cooldown can start pass through it:
   *
   * - The runtime's. Whether the duration comes from the base `castSpec`
   *   (`legacyCastSpec(this.coolDown)`) or from a spell's own `get castSpec()`
   *   override — which invariably still writes `durationMs: this.coolDown` —
   *   `SpellRuntime` asks for it through the `cooldownDurationMs` delegate hook
   *   at the moment the countdown starts. It has to be asked *then* rather than
   *   folded into the spec: the runtime resolves its spec exactly once, on the
   *   first cast, so a multiplier baked in there is the multiplier that spell
   *   would keep for the rest of the match. The HUD reads `effectiveCoolDownMs`
   *   fresh every frame, so that bug showed as a ring counting down a duration
   *   the spell no longer used, curable only by picking a different spell —
   *   which builds a new instance.
   * - A spell's own, for the ones that set a cooldown mid-cast rather than
   *   letting the runtime start it: a recast phase ending (a second-cast kick,
   *   a shadow-swap ability's own
   *   swap, a delayed detonation), a hit-shortened cooldown (a spell that
   *   refunds on a landed hit), a
   *   partial refund (a channel's early cancel, a charge ability's cancel). Those write
   *   `this.currentCooldown = this.reducedCooldown(<tuning number>)`, which is
   *   the same call by hand.
   *
   * It cannot instead be a `coolDown` getter/setter pair on this class: about
   * a third of spells declare `coolDown = SOME_CONSTANT;` as a class field in
   * their own subclass body, and native class fields use *define* semantics —
   * that assignment creates its own own-property on the instance and quietly
   * shadows any accessor `Spell` declares under the same name, so a parent
   * getter would simply never run for them. Taking the duration as an argument
   * sidesteps that trap entirely.
   *
   * Not every mid-cast countdown is a cooldown: a recast window ("you have N
   * ms to press the key again") is a fixed input window and must stay raw, or
   * cooldown reduction would silently shorten the player's reaction time.
   * `tests/game/spells/MatchRules.test.ts` audits which is which.
   */
  protected reducedCooldown(durationMs: number): number {
    return durationMs * this.cooldownMultiplier;
  }

  /**
   * The cooldown this spell will actually run, after match rules (cooldown
   * reduction) are applied. `coolDown` stays the spell's own tuning number —
   * retuning it is still "edit the constant", not "edit a formula" — so
   * anything that displays a cooldown to the player (a HUD ring, a tooltip)
   * should read this instead.
   */
  get effectiveCoolDownMs(): number {
    return this.reducedCooldown(this.castSpec.cooldown.durationMs);
  }

  /**
   * What this spell's description says once this owner's build is counted —
   * the same "effective, not tuning" rule `effectiveCoolDownMs` above and
   * `effectiveManaCost` below already follow, for the same reason.
   *
   * `description` is authored text with its damage baked in, so the HUD used
   * to show first-frame numbers for the whole match while `takeDamage`
   * quietly multiplied them by `Stats.abilityPower`. A player buying ability
   * power had no way to see it working.
   *
   * Falls through untouched for a spell that declines the scaling rule
   * (`damageScalesWithAbilityPower`), for a description that is not a string
   * — `pregameCatalog` builds ownerless instances — and, inside
   * `amplifiedDamageText`, for an owner with no ability power at all.
   */
  get effectiveDescription(): string {
    if (typeof this.description !== 'string') return this.description;
    if (!this.damageScalesWithAbilityPower) return this.description;
    return amplifiedDamageText(this.description, this.owner);
  }

  /**
   * What any mana amount actually costs, after match rules (URF: `manaFree`).
   * The single expression of that rule in the codebase — `effectiveManaCost`
   * below and `spendMana` further down are both this function, so URF stays a
   * single flip rather than a per-spell edit.
   *
   * Takes an amount rather than reading `manaCost` because a spell's own cost
   * is not the only mana it charges: an upkeep tick (a channel that drains over
   * time) or a half
   * refund (three of this pack's charge-cancel spells) has to run through the same rule,
   * and before this existed the upkeep quietly did not.
   */
  effectiveMana(amount: number): number {
    // A LAN client's mana is snapshot truth, and its casts are replayed
    // visuals of decisions the host already priced — so on a net client every
    // cost is 0, exactly the way URF's manaFree works and through the same
    // single expression of the rule. Without this a puppet's cast event
    // would be refused whenever the 15Hz mana snapshot lags the host's spend.
    if (isNetClient()) return 0;
    return this.game?.matchRules?.manaFree ? 0 : amount;
  }

  /**
   * The mana this spell actually charges for one cast, after match rules.
   * `manaCost` stays the spell's own tuning number; every consumption/refund
   * path below reads through here instead.
   *
   * Three spells in this pack deduct a second,
   * cancel-triggered half-refund of their own mana cost outside this base
   * class's commit/refund path; they read this getter directly rather than
   * `manaCost` for the same reason.
   */
  get effectiveManaCost(): number {
    return this.effectiveMana(this.manaCost);
  }

  /**
   * Whether the caster can pay `amount` mana, priced by the rules in force.
   * Under URF everything is affordable, including on an empty pool — a channel
   * that costs nothing must not end for lack of what it is not spending.
   */
  protected canAffordMana(amount: number): boolean {
    return this.owner.stats.mana.value >= this.effectiveMana(amount);
  }

  /**
   * Bill the caster `amount` mana. The only sanctioned way for a spell to
   * spend mana outside the base class's own commit path, and the reason
   * `tests/game/spells/mana-spend-seam.test.ts` can forbid spell files from
   * touching a mana stat at all: check and deduction are one call, both priced
   * through `effectiveMana`, so neither half can be written without the rule.
   * Returns false — having spent nothing — when the pool is short.
   *
   * A sibling of `changeResource` rather than a change to it: that one is the
   * raw writer, shared with health (which URF does not touch) and with the
   * refund direction, and its three existing callers hand it an amount they
   * have already priced. Folding the rule in there would apply it twice on one
   * path and wrongly on another.
   */
  protected spendMana(amount: number): boolean {
    if (!this.canAffordMana(amount)) return false;
    this.changeResource(this.owner.stats.mana, -this.effectiveMana(amount));
    return true;
  }

  get targetingRequest(): Readonly<TargetingRequest> {
    return {};
  }

  protected playImpactVfx(context: CastContext): void {
    this.spellVfx?.impact(context);
  }

  /**
   * Moves the caster instantly — a blink, a shadow swap, anything that teleports.
   *
   * The single place a champion may relocate itself, so grounding is enforced
   * once here instead of in each spell. Self-propelled dashes get the same rule
   * inside the Dash buff; between the two, a spell has to opt into neither and
   * a new one cannot forget. `tests/game/buffs/Ground.test.ts` fails the build
   * if a spell reaches for `owner.teleportTo` directly and bypasses this.
   *
   * Returns false when the blink was refused, so a recast can tell.
   */
  protected blinkOwnerTo(x: number, y: number): boolean {
    if (this.owner.grounded) return false;
    this.owner.teleportTo(x, y);
    return true;
  }

  private get runtime(): SpellRuntime {
    if (!this.spellRuntime) {
      const spec = this.castSpec as CastSpec;
      this.resolvedSpec = spec;
      this.spellVfx = new SpellVfx(spec.vfx, spec.sfx);
      const delegate: SpellRuntimeDelegate = {
        canStart: context => this.canStart(context),
        commitResource: (context, point) => this.commitResource(context, point),
        refundResource: (context, reason) => this.refundResource(context, reason),
        onCastStart: context => {
          this.spellVfx?.castStart(context);
          this.onCastStart(context);
        },
        onChargeUpdate: (context, elapsedMs, ratio) => {
          let liveContext = context;
          if (
            this.activeCastSpec.activation === 'HOLD_RELEASE' &&
            this.game?.worldMouse &&
            this.owner === this.game.player
          ) {
            const dx = this.game.worldMouse.x - this.owner.position.x;
            const dy = this.game.worldMouse.y - this.owner.position.y;
            const dist = Math.hypot(dx, dy) || 1;
            liveContext = {
              ...context,
              cursorWorld: { x: this.game.worldMouse.x, y: this.game.worldMouse.y },
              direction: { x: dx / dist, y: dy / dist },
            };
          }
          this.onChargeUpdate(liveContext, elapsedMs, ratio);
        },
        onRelease: context => {
          let liveContext = context;
          if (
            this.activeCastSpec.activation === 'HOLD_RELEASE' &&
            this.game?.worldMouse &&
            this.owner === this.game.player
          ) {
            const dx = this.game.worldMouse.x - this.owner.position.x;
            const dy = this.game.worldMouse.y - this.owner.position.y;
            const dist = Math.hypot(dx, dy) || 1;
            liveContext = {
              ...context,
              cursorWorld: { x: this.game.worldMouse.x, y: this.game.worldMouse.y },
              direction: { x: dx / dist, y: dy / dist },
            };
          }
          this.spellVfx?.release(liveContext);
          this.onRelease(liveContext);
          this.onSpellCast(liveContext);
          this.game.eventManager.emit(EventType.ON_POST_CAST_SPELL, this);
        },
        onChannelTick: (context, tickIndex) => this.onChannelTick(context, tickIndex),
        onActivate: context => {
          this.spellVfx?.activate(context);
          this.onActivate(context);
        },
        onRecast: context => this.onRecast(context),
        onCancel: (context, reason) => {
          this.spellVfx?.cancel(context);
          this.onCancel(context, reason);
        },
        onComplete: context => {
          this.spellVfx?.complete();
          this.onComplete(context);
        },
        cooldownDurationMs: durationMs => this.reducedCooldown(durationMs),
      };
      this.spellRuntime = new SpellRuntime(spec, delegate);
    }
    return this.spellRuntime;
  }

  private canStart(_context: CastContext): boolean {
    return !this.castCancelCheck();
  }

  private commitResource(_context: CastContext, _point: ResourceCommitPoint): boolean {
    // Not `spendMana` + a health check: the two resources commit atomically,
    // so both have to clear before either moves.
    if (!this.canAffordMana(this.manaCost) || this.owner.stats.health.value < this.healthCost) {
      return false;
    }
    this.changeResource(this.owner.stats.mana, -this.effectiveManaCost);
    this.changeResource(this.owner.stats.health, -this.healthCost);
    return true;
  }

  private refundResource(_context: CastContext, _reason: CancelReason): void {
    this.changeResource(this.owner.stats.mana, this.effectiveManaCost);
    this.changeResource(this.owner.stats.health, this.healthCost);
  }

  protected changeResource(
    resource: { value: number; baseValue?: number; current?: number },
    amount: number
  ): void {
    if (typeof resource.baseValue === 'number') resource.baseValue += amount;
    else if (typeof resource.current === 'number') resource.current += amount;
    else resource.value += amount;
  }

  /**
   * Watches the caster and hands the runtime whatever went wrong. Which of
   * those the spell actually dies of is the form's decision, made in
   * `SpellRuntime.canInterrupt` — see `CancelPolicy`.
   */
  /**
   * **A cast time is a root.** That is what a cast time *is* in this genre, and
   * it was not one here: `castTimeMs` only delayed the release, so a champion
   * with a 340ms wind-up walked through the whole of it and the ability came
   * out of somebody who never broke stride. Nothing on the body said a cast was
   * happening, which is the other half of "chiêu xả ra mà tướng vẫn đi".
   *
   * Every frame rather than once, exactly as `BasicAttackController` holds an
   * attacker through a swing's wind-up: a move order arriving mid-cast has to
   * be refused too, not just the one that was standing when it began.
   *
   * Only `CASTING` — a charge (`CHARGING`) is aimed while walking on purpose,
   * and a channel is held by `press` above plus its own move interrupt.
   */
  private holdStillWhileCasting(): void {
    if (this.runtime.state !== 'CASTING') return;
    if (this.owner?.isDead) return;
    this.owner?.stopMovement?.();
  }

  private observeInterrupts(): void {
    if (!isInterruptibleState(this.runtime.state)) return;
    if (interruptsSuspended(this.owner, this.activeCastSpec.suspendedBy)) return;

    const reason = ownerInterruptReason(this.owner, this.ownerSnapshot);
    if (reason) this.runtime.cancel(reason);
  }

  private snapshotOwner(): void {
    this.ownerSnapshot = snapshotOwnerMovement(this.owner);
  }

  private syncVfxPhase(): void {
    if (this.runtime.state === 'CHANNELING' && this._castContext) {
      this.spellVfx?.channel(this._castContext);
    }
  }

  /**
   * The reach this spell declares, before any body-size correction.
   *
   * Public because the bot brain needs the same number `previewRadius` draws a
   * ring from, and `previewRadius` is `protected` *and* applies the `UNIT`
   * correction — which the brain must apply itself, per target, through
   * `Reach.effectiveRange`.
   */
  get declaredRange(): number | undefined {
    const declared =
      this.targetingRequest?.range ??
      (this as { range?: number }).range ??
      (this as { castRange?: number }).castRange;
    return typeof declared === 'number' && declared > 0 ? declared : undefined;
  }

  /**
   * The reach this spell should draw as its preview when nobody passes one.
   *
   * Same resolution order as `touchAimRange` in `src/game/input/SpellAim.ts`, on
   * purpose: the ring the mouse player reads and the telegraph the thumb player
   * drags must be the same number, or one of them is lying. The difference is the
   * fallback — the touch layer guesses `DEFAULT_TOUCH_AIM_RANGE` because a drag
   * has to go *somewhere*, while a preview that has nothing to state is better
   * off drawing nothing than drawing a confident 600px circle that is wrong.
   *
   * `UNIT` casts go through `TargetResolver`, which applies the body-size
   * correction from `Reach`; the ring has to take the same correction or it
   * shows a reach the cast will refuse. `POINT` and `DIRECTION` keep the authored
   * number — the far end of a point cast is ground, and ground has no body.
   */
  protected get previewRadius(): number | undefined {
    const declared = this.declaredRange;
    if (declared === undefined) return undefined;
    return this.castSpec.targeting === 'UNIT' ? effectiveRange(declared, this.owner) : declared;
  }

  /**
   * The range ring under the caster.
   *
   * Called with no argument from `Game.draw`, and it used to draw nothing at all
   * in that case — so every spell that did not override this (about seventy of
   * them, including eleven of the twelve abilities across three whole kits) gave
   * the player no way to know how far it reached short of casting it and
   * watching. Falling back to the declared reach makes the ring the default
   * rather than an opt-in.
   */
  drawPreview(radius?: number): void {
    const r = radius ?? this.previewRadius;
    if (!r) return;

    push();
    noFill();
    // a dark backing stroke so the ring survives being drawn over pale ground
    stroke(20, 25, 40, 120);
    strokeWeight(4);
    circle(this.owner.position.x, this.owner.position.y, r * 2);
    stroke(225, 235, 255, 150);
    strokeWeight(2);
    circle(this.owner.position.x, this.owner.position.y, r * 2);
    pop();
  }
}
