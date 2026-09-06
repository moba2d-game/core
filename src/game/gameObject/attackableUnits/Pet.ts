import { Circle } from '@/libs/quadtree';
import { PredefinedFilters } from '@/game/managers/ObjectManager';
import type Wallet from '@/game/economy/Wallet';
import Champion, { type ChampionOptions } from './Champion';
import type { KillCredit } from '@/game/combat/MatchTally';
import type AttackableUnit from './AttackableUnit';
import type { AttackableUnitRenderOptions, UnitDeathData } from './AttackableUnit';
import Invisible from '@/game/gameObject/buffs/Invisible';
import Untargetable from '@/game/gameObject/buffs/Untargetable';
import { isNetClient } from '@/game/net/netRole';

/** How often a pet re-picks its target. Cheaper than a query per frame, and it also stops it twitching between two equidistant enemies. */
export const PET_SCAN_INTERVAL_MS = 250;
/** Past this from its summoner a pet stops fighting and comes back. */
export const PET_LEASH_RANGE = 700;
/** How close it tries to sit when it has nothing to kill. */
export const PET_FOLLOW_DISTANCE = 90;
/**
 * How long a locally-spawned pet on a LAN client waits to be claimed by the
 * host's spawn event (`ClientSession.adoptLocalPet`) before it is judged a
 * misprediction and removed. The claim normally lands within a tick or two
 * of the cast replay; seconds of slack cover a stalled event flush.
 */
export const NET_PET_ADOPT_GRACE_MS = 2_500;

export interface PetOptions extends ChampionOptions {
  /** The unit this pet belongs to. Its death is the pet's death. */
  ownerUnit: AttackableUnit;
  /** Milliseconds the pet lives for. */
  lifeTimeMs: number;
  /** How far it looks for something to attack. */
  aggroRadius?: number;
  /**
   * Whether the pet walks back to its summoner when it has nothing to fight.
   * False for a pet the player steers themselves (a recastable decoy clone, which is
   * recast to send it somewhere) — it still leashes and still picks its own
   * fights, it just does not undo the order it was given.
   */
  followsOwner?: boolean;
  /**
   * A pet that never moves: a box, a trap, a turret. It stands where it was
   * put and only fights what walks into its reach.
   */
  stationary?: boolean;
}

/**
 * A summoned unit that fights on its own — Tibbers, the Maiden, a voidling.
 *
 * ## Why a `Champion` and not a `SpellObject`
 *
 * Everything the game already summons (a trap box, a scattered ward-trap, a
 * lantern) is a `SpellObject`: an effect with a position and a timer, which
 * cannot be targeted, cannot be attacked, and does not appear to anything that
 * queries for units. That is right for a trap and wrong for a pet — half of
 * what makes a summon interesting in League is that the enemy can *kill* it,
 * and that it soaks a skillshot meant for you.
 *
 * So a pet is a real unit. Subclassing `Champion` rather than `AttackableUnit`
 * is what buys the fighting: `BasicAttackController`, the reach rules, the
 * ranged/melee split and the on-hit event all come with it, so a pet's swing
 * is the same swing as everyone else's — it feeds `ON_ATTACK_HIT`, it can
 * crit, and it is subject to disarm.
 *
 * ## Three rules it does not share with a champion
 *
 *   - **It expires.** `lifeTimeMs` is the whole point of a summon.
 *   - **It dies with its summoner.** Nothing in this game outlives its caster
 *     (see `SpellObject.attachTo`), and a pet outliving the champion who paid
 *     for it would be the loudest possible exception.
 *   - **It is leashed.** Left alone, a pet chasing a fleeing enemy walks across
 *     the map. Past `PET_LEASH_RANGE` from its summoner it drops the target
 *     and comes home, the same shape `Minion`'s lane leash uses.
 *
 * It does *not* respawn: `reviveTime` is zero and the corpse is removed, so
 * killing it is worth something.
 */
export default class Pet extends Champion {
  /**
   * True once this pet is the host's authoritative summon on a LAN client —
   * either *adopted*: the summoning spell plays out in the client's sim too,
   * spawning the pack subclass with its own draw, and `ClientSession` claims
   * that local body for the host's spawn event instead of building a
   * lookalike; or built fresh by `ClientSession` for a summon with no local
   * twin (one that predates the join). An unclaimed local pet past
   * `NET_PET_ADOPT_GRACE_MS` was a misprediction the host never committed —
   * removed quietly in `update`, no parting gift.
   */
  isNetPuppet = false;

  /**
   * Overrides `Champion`'s `'champion'`. A summon is not a takedown: without
   * this, every decoy clone and shadow pet killed would land on someone's kill
   * count, because a `Pet` *is* a `Champion` as far as `instanceof` goes.
   */
  killCredit: KillCredit = 'none';
  // Off again, for the same reason `killCredit` is: a pet *is* a `Champion`
  // by inheritance, and killing somebody's summon is not a team achievement.
  awardsAssists = false;

  /**
   * Both halves of the same override, and both are needed for the same reason
   * `killCredit` above is: a `Pet` *is* a `Champion` as far as inheritance
   * goes, so without these lines every decoy clone would carry its own 500
   * gold and be worth a 200-gold kill to whoever popped it.
   */
  wallet: Wallet | null = null;

  /**
   * A summon's kills belong to whoever summoned it.
   *
   * The other half of `wallet` being `null`: without this the crediting site
   * paid the pet, which cannot hold money, and the bounty simply evaporated —
   * so clearing a wave with a clone was strictly worse than clearing it
   * yourself. See `AttackableUnit.killCreditedTo`.
   */
  get killCreditedTo(): AttackableUnit {
    return this.ownerUnit;
  }

  goldBounty = 0;

  ownerUnit: AttackableUnit;
  lifeTimeMs: number;
  aggroRadius: number;
  followsOwner: boolean;
  stationary: boolean;
  age = 0;

  private hiddenInvisible: Invisible | null = null;
  private hiddenUntargetable: Untargetable | null = null;
  /** Where the player last sent it, until it gets there. See `commandTo`. */
  private ordered: p5.Vector | null = null;

  private scanCooldown = 0;
  private targetLock: AttackableUnit | null = null;

  constructor(options: PetOptions) {
    super(options);
    this.ownerUnit = options.ownerUnit;
    this.lifeTimeMs = options.lifeTimeMs;
    this.aggroRadius = options.aggroRadius ?? 450;
    this.followsOwner = options.followsOwner ?? true;
    this.stationary = options.stationary ?? false;
  }

  /**
   * Hidden means hidden *from targeting too*, which is the whole reason this
   * pairs the two buffs instead of just stealthing the pet.
   *
   * `Invisible` only sets `StatusFlags.Stealthed` — it hides the body and
   * nothing else, so a box nobody can see was still a perfectly good click
   * target and still showed up in every `canTakeDamageFromTeam` query: enemies
   * shot an invisible box out of the air before it ever triggered. Adding
   * `Untargetable` is what makes "you cannot see it" mean "you cannot hit it",
   * and revealing the pet has to take both off together, which is why this is
   * one call rather than two.
   *
   * Deliberately not folded into the `Invisible` buff itself: a stealthed
   * *champion* is a different question with its own balance, and this
   * change should not silently answer it.
   */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;

    if (!hidden) {
      this.hiddenInvisible?.deactivateBuff?.();
      this.hiddenUntargetable?.deactivateBuff?.();
      this.hiddenInvisible = null;
      this.hiddenUntargetable = null;
      return;
    }

    // Outlasts the pet on purpose: the pet's own clock ends the buff, and a
    // buff that expired first would quietly reveal it.
    const forever = this.lifeTimeMs + 1000;
    this.hiddenInvisible = new Invisible(forever, this, this);
    this.hiddenUntargetable = new Untargetable(forever, this, this);
    this.addBuff(this.hiddenInvisible);
    this.addBuff(this.hiddenUntargetable);
  }

  get hidden(): boolean {
    return !!this.hiddenInvisible && !this.hiddenInvisible.toRemove;
  }

  /**
   * A summon is spent, not benched — the same rule `Minion` states, and for
   * the same reason: `AttackableUnit.update()` runs a respawn timer off
   * `deathData`, so a killed pet would come back at a fountain with its clock
   * reset. Retiring the object is the only way off that path. Killing a pet
   * has to be worth something.
   */
  die(deathData: UnitDeathData): void {
    super.die(deathData);
    this.expire();
  }

  /** Belt and braces: nothing should reach this, and if it does it must not revive. */
  respawn(): void {
    this.toRemove = true;
  }

  /** Seconds of life left, for anything that wants to draw a timer. */
  get remainingMs(): number {
    return Math.max(0, this.lifeTimeMs - this.age);
  }

  update(): void {
    super.update();

    this.age += deltaTime;
    // A LAN client's pet keeps only the clock (the timer bar reads `age`):
    // its brain, leash and expiry are the host's — expiring here on the
    // local clock would race the authoritative 'gone', and a scan that
    // issued attack orders would double every swing the host forwards. A pet
    // the host never claims within the grace was a misprediction: removed
    // quietly — no `expire()`, because a ghost owes nobody a parting gift.
    if (isNetClient()) {
      if (!this.isNetPuppet && this.age >= NET_PET_ADOPT_GRACE_MS) this.toRemove = true;
      return;
    }
    // Timed out or outlived its summoner. Being killed is handled in `die`,
    // which the damage pipeline reaches before this ever runs — all three are
    // the end of the same life and all three owe the pet its parting effect
    // (a decoy clone explodes whichever way it goes).
    if (
      this.isDead ||
      this.age >= this.lifeTimeMs ||
      this.ownerUnit.isDead ||
      this.ownerUnit.toRemove
    ) {
      this.expire();
      return;
    }

    if (this.ordered) {
      // Arrived — near enough that another step would just jitter.
      if (this.position.dist(this.ordered) <= PET_FOLLOW_DISTANCE / 2) this.ordered = null;
      else return;
    }

    this.scanCooldown -= deltaTime;
    if (this.scanCooldown <= 0) {
      this.scanCooldown = PET_SCAN_INTERVAL_MS;
      this.targetLock = this.leashed || this.hidden ? null : this.findTarget();
      if (this.targetLock) this.orderAttack(this.targetLock);
      else this.stopAttack();
    }

    if (this.followsOwner && (!this.targetLock || this.targetLock.isDead)) this.followOwner();
    // A standing attack order owns a unit's movement (`BasicAttackController`
    // writes `destination` every frame it has a target), so a box with a
    // target would walk to it. Cleared after the controller has had its say.
    if (this.stationary) this.stopMovement();
  }

  /**
   * Send the pet somewhere, as a real move order.
   *
   * Two things this has to get right, both of which the first version got
   * wrong and both of which look identical from the outside — the pet takes
   * one step and stops:
   *
   *   - **`orderMove`, not `moveTo`.** `moveTo` writes a destination and
   *     clears the path agent, so the pet walks straight at the point and is
   *     stuck the moment a wall is in the way. `orderMove` is the move *order*
   *     every right click uses: it routes.
   *   - **The order outranks the pet's own targeting.** `update` re-picks a
   *     target every 250ms and `orderAttack` owns movement while it holds one
   *     (`BasicAttackController` writes `destination` every frame), so an
   *     autonomous pet standing anywhere near an enemy would overwrite the
   *     order before the player saw it take effect. While `ordered` is
   *     outstanding the scan is skipped; arriving hands control back.
   */
  commandTo(point: p5.Vector): void {
    this.ordered = point.copy();
    this.orderMove(point.x, point.y);
  }

  /** True while a commanded move is still being walked. */
  get underOrders(): boolean {
    return !!this.ordered;
  }

  /**
   * Only an *autonomous* pet leashes. The leash exists to stop a pet that
   * picks its own fights from chasing a fleeing enemy across the map; a pet
   * the player steers (`followsOwner: false` — a summoned bear, a decoy clone) was
   * sent where it is on purpose, and refusing to fight once it got there is
   * the ability not working.
   */
  get leashed(): boolean {
    return this.followsOwner && this.position.dist(this.ownerUnit.position) > PET_LEASH_RANGE;
  }

  /** Nearest enemy of the *summoner's* team — a pet inherits who it is angry at. */
  findTarget(): AttackableUnit | null {
    const candidates = this.game.objectManager.queryObjects({
      area: new Circle({
        x: this.position.x,
        y: this.position.y,
        r: this.aggroRadius,
      }),
      filters: [
        PredefinedFilters.canTakeDamageFromTeam(this.teamId),
        PredefinedFilters.visibleTo(this),
      ],
    }) as AttackableUnit[];

    let nearest: AttackableUnit | null = null;
    let nearestDistance = Infinity;
    for (const candidate of candidates) {
      if (candidate === this) continue;
      const distance = this.position.dist(candidate.position);
      if (distance >= nearestDistance) continue;
      nearestDistance = distance;
      nearest = candidate;
    }
    return nearest;
  }

  /**
   * Walks back toward its summoner, stopping a body's width short so it does
   * not stand on top of them. Written as a destination rather than a position
   * so terrain, body separation and slows all still apply to a pet.
   */
  followOwner(): void {
    const away = this.ownerUnit.position.copy().sub(this.position);
    const distance = away.mag();
    if (distance <= PET_FOLLOW_DISTANCE) {
      this.stopMovement();
      return;
    }
    this.destination = this.position.copy().add(away.setMag(distance - PET_FOLLOW_DISTANCE));
  }

  stopAttack(): void {
    this.basicAttack.clear();
  }

  /** The end of its life, however it arrives. Idempotent — `update` can reach it twice. */
  expire(): void {
    if (this.toRemove) return;
    this.onExpire();
    this.basicAttack.clear();
    this.toRemove = true;
  }

  /** For subclasses with a parting gift (an explosion, a last swing). */
  onExpire(): void {}

  /**
   * Whether this summon is *presented* as one.
   *
   * A summon normally wears a summon's badge — the narrow health frame
   * (`drawHealthBar` below) and the lifetime clock under its feet — and both
   * exist so a player can tell a summoned body from the champion standing next
   * to it at a glance.
   *
   * A decoy is the one summon that has to fail that test. Its whole job is to
   * be mistaken for the champion that made it, and a decoy wearing the summon
   * badge is a decoy with a label on it: the enemy reads the bar before they
   * read the picture, and the ability does nothing. Set this and the body
   * presents itself exactly as a champion does — the full frame, no clock.
   *
   * Only the *presentation* changes. `killCredit`, `wallet` and `goldBounty`
   * stay a summon's, and that is not an oversight: `TeamBlackboard` reads
   * `killCredit` precisely so a bot team does not rally onto a clone, and a
   * decoy that paid out a champion kill would be a lie the scoreboard told.
   * The copy a decoy needs — the same pool, the same reach, the same picture —
   * belongs to the spell that summoned it, which is the only code that knows
   * who is being impersonated.
   */
  disguisedAsChampion = false;

  draw(options: AttackableUnitRenderOptions = {}): void {
    // A hidden summon is a trap, and a trap stops being one the moment
    // anything around it can be read. Every part of the standard frame is a
    // tell — the team ring, the health badge, the facing line, the clock below
    // — and the loudest was `Untargetable`'s three pulsing rings, which
    // `setHidden` pairs with `Invisible`: a stealthed body fades to alpha 20,
    // but those rings were painted at a fixed alpha, so a buried box was a
    // ring of light sitting on an empty patch of ground. Hidden, a pet paints
    // its own picture and nothing else; whether that picture is a faint
    // outline or nothing at all belongs to the subclass that drew it.
    if (this.hidden) {
      this.drawAvatar();
      return;
    }

    super.draw(options);
    if (this.isDead || this.toRemove) return;

    // The clock, under the body: a summon the player cannot time is a summon
    // they cannot plan around. Below the unit on purpose — the health bar and
    // the buff row already own the space above it. A decoy gets none: it is
    // the one summon whose job is to be mistaken for a champion, and a timer
    // under its feet answers the question it exists to pose.
    if (this.disguisedAsChampion) return;
    const left = this.remainingMs / this.lifeTimeMs;
    const width = (this.animatedValues?.displaySize ?? 50) * 0.9;
    push();
    noStroke();
    fill(0, 0, 0, 140);
    rect(this.position.x - width / 2, this.position.y + width * 0.62, width, 4, 2);
    fill(210, 230, 255, 220);
    rect(this.position.x - width / 2, this.position.y + width * 0.62, width * left, 4, 2);
    pop();
  }

  /**
   * A summon always wears the compact frame, whatever the zoom — unless it is
   * a decoy, which wears the champion's (see `disguisedAsChampion`) and so
   * passes the camera's own answer straight through.
   *
   * `Champion`'s full frame is 125px wide and paints a score box, a mana strip,
   * level ticks, buff icons and status text around the bar. A pet has none of
   * that to say: it inherits `score = 0` and never changes it, it casts nothing
   * so its mana pool stays empty, and it is gone in seconds. On a summoned bear or a
   * row of trap boxes that frame is almost entirely empty chrome, and several
   * at once cover the fight they exist to explain.
   *
   * The compact frame was built for mobile, where the reason was the camera. The
   * reason here is the unit, so this ignores the `compact` argument rather than
   * passing it through — zooming in must not put a score box on a box.
   */
  /**
   * A summon's compact frame stays the narrow one it always was, with no buff
   * row. `Champion` widened both for the case where compact is the *camera's*
   * doing and the bar still has to be readable; a pet is compact because of
   * what it is, and the whole point of that is being visibly subordinate to
   * the champion it belongs to.
   */
  /**
   * Accessors rather than the two constants they used to be, because the
   * answer now depends on a flag a *subclass* sets, and a subclass's field
   * initialisers run after this class's — a decoy would have been measured
   * before it had declared itself. `super` rather than a second copy of 88 and
   * `true`: a decoy is asking for whatever a champion currently wears, not for
   * a number that happened to match one on the day this was written.
   */
  protected override get compactBarWidth(): number {
    return this.disguisedAsChampion ? super.compactBarWidth : 52;
  }
  protected override get compactShowsBuffIcons(): boolean {
    return this.disguisedAsChampion ? super.compactShowsBuffIcons : false;
  }

  drawHealthBar(compact = false): void {
    super.drawHealthBar(this.disguisedAsChampion ? compact : true);
  }
}
