import { Circle } from '@/libs/quadtree';
import { BASIC_ATTACK_SOURCE } from '@/game/combat/DamageAttribution';
import type { DamageType } from '@/game/combat/Mitigation';
import MissileSpellObject, { STALLED_CHASE_MS } from '@/game/gameObject/MissileSpellObject';
import { TURRET_BOUNTY } from '@/game/economy/Wallet';
import { cssColor } from '@/game/render/cssColor';
import AttackableUnit from '@/game/gameObject/attackableUnits/AttackableUnit';
import type { KillCredit } from '@/game/combat/MatchTally';
import type { ObjectiveKind } from '@/game/combat/Announcer';
import type { StructureMark } from '@/game/gameObject/Buff';
import type {
  AttackableUnitOptions,
  HitPresentationOptions,
  UnitDeathData,
} from '@/game/gameObject/attackableUnits/AttackableUnit';
import Champion from '@/game/gameObject/attackableUnits/Champion';
import Minion, {
  AGGRO_SCAN_INTERVAL_MS,
  teamColors,
} from '@/game/gameObject/attackableUnits/Minion';
import Monster from '@/game/gameObject/attackableUnits/Monster';
import Pet from '@/game/gameObject/attackableUnits/Pet';
import TrailSystem from '@/game/gameObject/helpers/TrailSystem';
import { OBJECTIVE_Z_INDEX, PredefinedFilters } from '@/game/managers/ObjectManager';
import { canSee } from '@/game/combat/Vision';
import { pickAggroTarget, type AggroChoice, type AggroLadder } from '@/game/combat/AggroPriority';
import { DEFAULT_TURRET_PRESET } from '@/game/config/tuningDefaults';

/**
 * How much further a turret defends an ally than it shoots.
 *
 * 1400 / 775 in the source game's own units. See `alliesInRange`.
 */
export const TURRET_DEFEND_RANGE_RATIO = 1.8;

/**
 * A passive a turret is built with — the shape `MonsterAbility` already has,
 * for the same reason.
 *
 * The source game's turrets carry named passives (Ohmwrecker's ramp, Reinforced
 * Armor, Warden's Eye), and writing them into this class would make every pack
 * play with core's idea of what a tower does. `onSpawn` hands the pack the
 * turret and lets it hang real buffs on it, exactly as a jungle camp's kit
 * hangs its own — a turret is an `AttackableUnit` and runs its buffs inside
 * `update()`, so nothing else is needed to make that work.
 *
 * What stays in core is the part that is a *rule* rather than a passive: which
 * body a turret shoots first, and how far it will answer for an ally.
 */
export interface TurretPassive {
  /** For a report to name; never shown to a player. */
  name: string;
  onSpawn(turret: Turret): void;
}

export interface TurretPresetData {
  health: number;
  size: number;
  attackRange: number;
  attackInterval: number;
  damage: number;
  /**
   * Kept for map/pack tuning compatibility (`TurretStats.rebuildTime` is a
   * published tuning key), but nothing counts it down since destroyed became
   * destroyed-for-the-match: a husk only stands back up through a rewind or a
   * match reset.
   */
  rebuildTime: number;
  /** ms without taking damage before it starts repairing itself. */
  repairDelay: number;
  /** health per frame once repairing. */
  repairRate: number;
  /**
   * Built-in passives — see `TurretPassive`. Core's own three by default
   * (`turretPassives.ts`), or a pack's list in place of them when one declares
   * any. `Game.spawnStructures` is where the two meet.
   */
  passives?: readonly TurretPassive[];
}

/**
 * Defined in `game/config/tuningDefaults.ts` and re-exported here, where every
 * caller already looks for it. It moved because `config/mapTuning.ts` has to
 * read it and that file is pinned to the `pregame` chunk — importing it from
 * this module put the whole match on the menu's first paint. See the defaults
 * module's own header.
 */
export { DEFAULT_TURRET_PRESET };

export interface TurretOptions {
  game: AttackableUnitOptions['game'];
  position?: p5.Vector;
  preset?: TurretPresetData;
  /** The base this turret defends, from TeamId. */
  teamId?: string;
}

/**
 * A team building. It carries the TeamId of the base it defends — `turret1` in
 * summoner_map.json is the blue row, `turret2` the red one — and shoots the
 * nearest hostile thing inside `attackRange`, preferring minions over champions
 * the way a real turret does.
 *
 * ## Destroyed is destroyed: the husk
 *
 * A turret at 0 HP becomes a dead husk that stays in the world — in
 * `Game.turrets`, in the object list — for the rest of the match. It never
 * attacks, never acquires a target, blocks nobody's walking
 * (`collidesWithUnits` already excludes corpses), lights no fog, and every
 * scan that aims at buildings already drops it through the standard
 * `isDead` exclusions. The rubble stands for `rebuildTime`, then the base
 * class's countdown stands the tower back up through `respawn()` — towers
 * are paper enough that two champions with an item flatten one in seconds,
 * so permanent loss was too harsh, went the owner's verdict. A rewind
 * ("Mốc đã lưu" restores it in place, exactly like a jungle camp's body)
 * and a match reset (`MatchDirector.applyConfig`) revive a husk early.
 *
 * The killing blow itself is unchanged: bounty, assists, the announcer line
 * and the tally are all paid at death, once.
 *
 * Production champions share one of the two lane team ids, so the same
 * `canTakeDamageFromTeam(this.teamId)` rule rejects allied champions and
 * minions while keeping the opposing side targetable. No turret-specific ally
 * exception is needed.
 */
export default class Turret extends AttackableUnit {
  /** See `Wallet`. Killer-only, like every bounty here — no team split yet. */
  goldBounty = TURRET_BOUNTY;

  /** A building is not farm — killing one moves nobody's CS. */
  killCredit: KillCredit = 'none';

  /** A turret falling is news, though nobody's kill count moves for it. */
  announceAs: ObjectiveKind = 'turret';
  // Yes, despite `killCredit: 'none'` right above. Nobody's kill count moves
  // for a tower, but "who helped take that tower" is a real question and the
  // gold that answers it is the second-biggest purse on the map.
  awardsAssists = true;

  /** Above plain units, below champions. */
  zIndex = OBJECTIVE_Z_INDEX;
  /** A building the player has seen stays drawn through the fog. */
  alwaysVisible = true;
  /**
   * Units bounce off a turret, they never shove it. It re-anchors after its
   * buffs run each frame, so a body that pushed it would only make it snap back.
   */
  isImmovable = true;

  name = 'Trụ';
  attackRange: number;
  attackInterval: number;
  /**
   * What one shot lands for, read live off the stat rather than held.
   *
   * A field here would be the number a preset set once and nothing could ever
   * change; going through `stats.attackDamage` is what lets a passive ramp it
   * (the source game's "Warming Up") without that ramp having to live inside
   * this class. Every other attacker in the game already amplifies through
   * this slot.
   */
  get damage(): number {
    return this.stats.attackDamage.value;
  }
  rebuildTime: number;
  repairDelay: number;
  repairRate: number;

  target: AttackableUnit | null = null;
  /**
   * The rung `target` was taken on. Held between scans for the same reason a
   * minion holds one — `combat/AggroPriority`'s header. A tower's ladder only
   * defends champions, so it churned less than a wave did, but it churned:
   * two enemies trading on the same ally under the tower took the shots in
   * turn and neither of them died.
   */
  private _targetRank = Infinity;
  _attackCooldown = 0;
  /** Time left until the next full target scan — see `update`. */
  _scanCooldown = 0;
  /** ms since the last hit taken — gates self-repair. */
  _sinceDamaged = Infinity;
  /** ms left on the muzzle flash. */
  _fireFlash = 0;
  /** ms left on the hit flash. */
  _hitFlash = 0;
  _spin = 0;
  /**
   * Where the turret was built. Buffs that displace a unit (Dash — which is what
   * a hook or a lantern-pull ability constructs) write straight to `position` and never
   * consult canMove, so a hook could otherwise drag a building across the map.
   */
  _anchor: p5.Vector;

  /**
   * The kit this tower was built with, kept so a revive can hang it again:
   * `die()` unwinds every buff through `clearBuffs`, so a turret stood back
   * up by a rewind or a match reset without this would fight the rest of the
   * match without its armor, its ramp, or a pack's own passives.
   */
  private readonly _passives: readonly TurretPassive[];

  constructor({ game, position, preset = DEFAULT_TURRET_PRESET, teamId }: TurretOptions) {
    super({ game, position, visionRadius: 0, teamId });

    this.stats.size.baseValue = preset.size;
    this.stats.speed.baseValue = 0;
    this.stats.maxHealth.baseValue = preset.health;
    this.stats.health.baseValue = preset.health;
    this.stats.healthRegen.baseValue = 0;
    this.stats.manaRegen.baseValue = 0;
    this.stats.visionRadius.baseValue = 0;

    this.attackRange = preset.attackRange;
    this.attackInterval = preset.attackInterval;
    // Through the stat, not a plain field. A turret's outgoing damage was the
    // one attacker's number in the game that nothing could touch — no buff, no
    // item, no passive — so a "warming up" ramp could only ever have been
    // written inside this class. `stats.attackDamage` is the same slot every
    // other attacker already amplifies through.
    this.stats.attackDamage.baseValue = preset.damage;
    this.rebuildTime = preset.rebuildTime;
    this.repairDelay = preset.repairDelay;
    this.repairRate = preset.repairRate;
    // The base class's death countdown rebuilds a fallen tower on the
    // preset's clock (see the class header). `die()` normalizes callers
    // that pass a clock of their own onto the same wait.
    this.reviveTime = preset.rebuildTime;

    this._anchor = this.position.copy();

    // Last, with the body finished: a passive that reads `stats.attackDamage`
    // or hangs a buff needs the turret it is given to be a complete one.
    this._passives = preset.passives ?? [];
    for (const passive of this._passives) passive.onSpawn(this);
  }

  update() {
    this._sinceDamaged += deltaTime;
    // Stats.update() inside super.update() applies this, so set it first
    this.stats.healthRegen.baseValue =
      !this.isDead && this._sinceDamaged > this.repairDelay ? this.repairRate : 0;

    super.update();

    // buffs ran inside super.update(); undo anything that tried to move us
    this.position.set(this._anchor.x, this._anchor.y);
    this.destination.set(this._anchor.x, this._anchor.y);

    this._spin += deltaTime * 0.0006;
    if (this._fireFlash > 0) this._fireFlash -= deltaTime;
    if (this._hitFlash > 0) this._hitFlash -= deltaTime;

    if (this.isDead) {
      this.target = null;
      return;
    }

    this._attackCooldown -= deltaTime;

    // Re-scan on a cadence, the way minions and camps already do. A turret
    // fires at most once per `attackInterval` (1300ms), so re-picking its
    // target 60 times a second bought nothing and cost a quadtree query plus
    // a Circle and four filter closures every frame, per turret.
    //
    // The cadence never delays *dropping* a target: `stillValidTarget` re-runs
    // the same predicates `findTarget` filters on, against the one unit we
    // already hold, every frame. So stealth, death, untargetability, a team
    // change or walking out of range still break aggro on the frame they
    // happen — only *acquiring* a new target waits for the next scan, and it
    // rescans immediately when the current one is lost.
    // A target that is still shootable is *kept*, not re-picked: see
    // `combat/AggroPriority`. Re-picking "nearest" every scan is what made a
    // tower spread its shots over a whole wave and kill none of it.
    this._scanCooldown -= deltaTime;
    const holds = this.stillValidTarget(this.target);
    if (this._scanCooldown <= 0 || !holds) {
      this._scanCooldown = AGGRO_SCAN_INTERVAL_MS;
      const picked = this.findTarget(
        holds ? this.target : null,
        holds ? this._targetRank : Infinity
      );
      this.target = picked?.unit ?? null;
      this._targetRank = picked?.rank ?? Infinity;
    }

    // `canAttack` for the same reason minions and camps need it: a building
    // fires on its own timer and never went through `BasicAttackController`, so
    // crowd control spent on a turret bought nothing at all.
    if (this.target && this.canAttack && this._attackCooldown <= 0) {
      this._attackCooldown = this.attackInterval;
      this._fireFlash = 220;
      this.fireAt(this.target);
    }
  }

  /**
   * The predicates `findTarget` filters on, re-checked against a single unit
   * we already hold. Kept in step with the filter list below by hand — there
   * is no way to run a `PredefinedFilters` chain against one object without
   * rebuilding the closures this exists to avoid.
   */
  private stillValidTarget(target: AttackableUnit | null): boolean {
    if (!target) return false;
    if (target.isDead || !target.targetable) return false;
    if (target.isStealthed) return false;
    if (target.teamId === this.teamId) return false;
    if (!(target instanceof Champion || target instanceof Minion || target instanceof Monster)) {
      return false;
    }

    const dx = target.position.x - this.position.x;
    const dy = target.position.y - this.position.y;
    if (dx * dx + dy * dy > this.attackRange * this.attackRange) return false;

    return canSee(this, target);
  }

  /**
   * A tower's ladder, in the source game's own order: defend a champion from a
   * champion, then from a minion, then shoot the nearest minion, then the
   * nearest champion.
   *
   * Minions before champions on the floor is what makes a turret a lane
   * obstacle rather than a champion tax — a wave under an enemy tower soaks
   * the shots while its champion pushes. The two rungs above it are what makes
   * standing under your own tower safe, and rung 2 is new: a minion beating on
   * an allied champion used to be answered only if it happened to be the
   * nearest thing in range.
   *
   * ## The jungle rung, and why it is only on the defend half
   *
   * A tower used to be blind to a monster outright — the query admitted
   * champions and minions and nothing else, on the argument that a tower
   * standing near a camp would otherwise farm it for ever. That argument is
   * about a camp *at home*, and it is right about one; it was answering a
   * different question than the one a player asks after dragging a boss out of
   * its pit and watching their own tower ignore it while it eats them.
   *
   * So a monster is a target when it is **fighting one of ours**, and never
   * otherwise. It appears on the defend half, below both champion rungs — a
   * diver still outranks a crab — and deliberately not on `nearest`, which is
   * what a turret falls back to when nobody is being attacked. A camp minding
   * its own business beside a tower is exactly as invisible as it was, on
   * every frame of every match where nobody dragged it anywhere, because
   * nothing it did put it in the candidate set's defend rungs.
   *
   * Structures stay out by construction: `Minion`, `Champion` and `Monster`
   * are the whole include list, so a tower still cannot shoot a tower.
   */
  private static readonly LADDER: AggroLadder<AttackableUnit> = {
    defend: [
      { attacker: unit => unit instanceof Champion, victim: ally => ally instanceof Champion },
      { attacker: unit => unit instanceof Minion, victim: ally => ally instanceof Champion },
      { attacker: unit => unit instanceof Monster, victim: ally => ally instanceof Champion },
    ],
    // The source game's own order, which core had flattened to "any minion,
    // then a champion". Wiki, *Turret* § Target Selection: pets, then siege and
    // super minions, then melee, then casters, then champions.
    //
    // It is the difference between a turret that shoots whatever wandered in
    // and one you can dive behind: the siege minion is the body that out-ranges
    // the tower and shells it, so it is the one the tower answers first, and a
    // champion is last because a wave standing in front of them is cover.
    //
    // `Pet` is checked before `Champion` on purpose — it extends it, so the
    // champion rung would otherwise swallow every summon.
    nearest: [
      unit => unit instanceof Pet,
      unit => unit instanceof Minion && unit.kind === 'cannon',
      unit => unit instanceof Minion && unit.kind === 'melee',
      unit => unit instanceof Minion && unit.kind === 'ranged',
      unit => unit instanceof Champion,
    ],
  };

  /**
   * @param current The target being held, or null when there is none to keep —
   *   `update` passes it only while `stillValidTarget` still says yes.
   * @param currentRank The rung `current` was taken on, carried between scans
   *   rather than re-derived from a victim's `recentAttacker` — see
   *   `combat/AggroPriority`, which has the account of why that slot cannot be
   *   asked twice and give the same answer.
   */
  findTarget(
    current: AttackableUnit | null = null,
    currentRank = Infinity
  ): AggroChoice<AttackableUnit> | null {
    const candidates = this.game.objectManager.queryObjects({
      area: new Circle({
        x: this.position.x,
        y: this.position.y,
        r: this.attackRange,
      }),
      filters: [
        PredefinedFilters.includeTypes([Champion, Minion, Monster]),
        PredefinedFilters.canTakeDamageFromTeam(this.teamId),
        PredefinedFilters.visibleTo(this),
        PredefinedFilters.excludeStealthed,
      ],
    }) as AttackableUnit[];

    // Nothing to shoot means nothing to defend either, and this is the state a
    // turret spends most of the match in — so the ally query below never runs
    // for a tower standing in an empty lane.
    if (candidates.length === 0) return null;

    return pickAggroTarget<AttackableUnit>({
      origin: this.position,
      current,
      held: current !== null,
      currentRank,
      candidates,
      allies: this.alliesInRange(),
      ladder: Turret.LADDER,
    });
  }

  /**
   * The allied champions standing under this turret — the units its ladder
   * defends, and the only ones: `recentAttacker` on an allied *minion* is not
   * a rung a tower has, because a tower that answered every minion trading in
   * front of it would never shoot the wave it is supposed to hold.
   */
  /**
   * The allies this turret will answer for, which reach further than it shoots.
   *
   * The source game defends a champion within **1400** units of a turret whose
   * own range is 775 — an ally can be attacked well outside what the tower can
   * hit, and the tower still turns. Core had this at exactly the attack range,
   * so a champion attacked one step outside it bought nothing at all from
   * standing by their tower.
   *
   * Written as the ratio rather than the raw 1400 because this canvas is not
   * the source game's grid: distances here are pixels and that number is
   * theirs. The ratio is scale-free and survives a map that widens
   * `attackRange`, which a copied constant would not.
   */
  private alliesInRange(): AttackableUnit[] {
    return this.game.objectManager.queryObjects({
      area: new Circle({
        x: this.position.x,
        y: this.position.y,
        r: this.attackRange * TURRET_DEFEND_RANGE_RATIO,
      }),
      filters: [PredefinedFilters.type(Champion), PredefinedFilters.teamId(this.teamId)],
    }) as AttackableUnit[];
  }

  /** A turret lights its own reach for the team; it carries no combat sight. */
  get fogRevealRadius(): number {
    return this.attackRange;
  }

  fireAt(target: AttackableUnit) {
    const bolt = new TurretBolt(this);
    bolt.target = target;
    bolt.damage = this.damage;
    bolt.position.set(this.position.x, this.position.y - this.stats.size.value * 0.35);
    bolt.destination.set(target.position.x, target.position.y);
    this.game.objectManager.addObject(bolt);
  }

  /**
   * The full signature, and it has to be the full signature: TypeScript lets
   * an override take *fewer* parameters than the method it replaces, so a
   * two-argument version of this compiles perfectly and silently drops `type`
   * and `source` on the floor — every typed hit on one of these bodies fell
   * back to `DEFAULT_DAMAGE_TYPE`. All four subclasses that override this had
   * that shape, which is how a basic attack against a bot came to be mitigated
   * by magic resist while the same swing against a human was mitigated by
   * armour. `takeDamageSignature.test.ts` is the guard.
   */
  takeDamage(
    damage: number,
    attacker?: AttackableUnit,
    type?: DamageType,
    source?: string,
    presentation?: HitPresentationOptions
  ) {
    if (this.isDead) return;
    super.takeDamage(damage, attacker, type, source, presentation);
    this._sinceDamaged = 0;
    this._hitFlash = 180;
  }

  /**
   * The killing blow, paid exactly as before — bounty, assists, announcer,
   * tally all run in `super.die` on the transition — and then the clock is
   * normalized onto the preset's rebuild time for every caller: the turret's
   * own `takeDamage` path (which already passes `reviveTime`) and a LAN
   * client's snapshot-driven `die`, whose hardcoded far-future clock would
   * otherwise leave a client's rubble standing an hour under a host whose
   * tower is long back.
   */
  die(deathData: UnitDeathData): void {
    super.die(deathData);
    if (this.deathData) this.deathData.reviveAfter = this.rebuildTime;
  }

  /**
   * Called by the base countdown when the rebuild clock runs out, and early
   * by a rewind ("Mốc đã lưu") or a match reset. The passives are hung
   * again because `die()` unwound them; on the transition only, so a caller
   * sweeping every turret cannot double-stack a living one's kit.
   */
  respawn() {
    const wasDead = this.isDead;
    // the base drops the unit on a spawn point; a building rebuilds where it stood
    this.stats.health.baseValue = this.stats.maxHealth.value;
    this.deathData = null;
    this.position.set(this._anchor.x, this._anchor.y);
    this.destination.set(this._anchor.x, this._anchor.y);
    this._sinceDamaged = Infinity;
    this._attackCooldown = 0;
    this.target = null;
    this._targetRank = Infinity;
    if (wasDead) {
      for (const passive of this._passives) passive.onSpawn(this);
    }
  }

  // ---------------------------------------------------------------- rendering

  draw() {
    const pos = this.position;
    const size = this.stats.size.value;

    push();
    if (this.isDead) {
      // Rubble, no health bar, no threat ring — plus the one number a fallen
      // tower owes the player: when it stands back up.
      this.drawRubble(pos, size);
      this.drawRebuildTimer(pos, size);
      pop();
      return;
    }

    // threat ring, only while something is in range
    if (this.target) {
      noFill();
      stroke(255, 90, 60, 60);
      strokeWeight(3);
      circle(pos.x, pos.y, this.attackRange * 2);
    }

    // The stone stays dark, but the pad and tower take the base's team colour
    // so a turret row reads as its side's at a glance — the same blue/red a
    // minion carries, shared through `teamColors` so the two never disagree.
    const team = teamColors(this.teamId);

    // stone base
    noStroke();
    fill(28, 30, 38, 230);
    circle(pos.x, pos.y, size * 1.15);
    fill(team.trim[0], team.trim[1], team.trim[2]);
    circle(pos.x, pos.y, size);

    // body — an octagonal tower
    push();
    translate(pos.x, pos.y);
    rotate(this._spin);
    fill(team.body[0], team.body[1], team.body[2]);
    stroke(20, 22, 28);
    strokeWeight(3);
    beginShape();
    for (let i = 0; i < 8; i++) {
      const a = (TWO_PI / 8) * i;
      vertex(cos(a) * size * 0.34, sin(a) * size * 0.34);
    }
    endShape(CLOSE);
    pop();

    // the barrel points at whatever it is shooting
    const aim = this.target ? p5.Vector.sub(this.target.position, pos) : createVector(0, -1);
    if (aim.magSq() === 0) aim.set(0, -1);
    aim.setMag(size * 0.55);
    stroke(this.target ? [255, 170, 70] : [130, 136, 150]);
    strokeWeight(9);
    line(pos.x, pos.y, pos.x + aim.x, pos.y + aim.y);

    // core: brightens when charged, flares on the shot
    const charge = 1 - Math.max(0, this._attackCooldown) / this.attackInterval;
    const flash = Math.max(0, this._fireFlash) / 220;
    noStroke();
    fill(255, 200 - 80 * (1 - charge), 90, 120 + 135 * charge);
    circle(pos.x, pos.y, size * 0.26 + flash * size * 0.35);

    if (this._hitFlash > 0) {
      noFill();
      stroke(255, 80, 80, (this._hitFlash / 180) * 220);
      strokeWeight(5);
      circle(pos.x, pos.y, size * 1.2);
    }
    pop();

    this.drawHealthBar();
  }

  /** The clock on the rubble. A clock something pinned to forever draws nothing. */
  drawRebuildTimer(pos: p5.Vector, size: number) {
    const left = this.deathData?.reviveAfter ?? 0;
    if (!Number.isFinite(left)) return;
    push();
    noStroke();
    fill(190, 190, 200, 200);
    textAlign(CENTER, CENTER);
    // Overlay, not world — see Camera.constantSize.
    textSize(13 * (this.game?.camera?.constantSize?.(1) ?? 1));
    text(`Xây lại sau ${Math.ceil(left / 1000)}s`, pos.x, pos.y - size * 0.75);
    pop();
  }

  drawRubble(pos: p5.Vector, size: number) {
    noStroke();
    fill(26, 28, 34, 200);
    circle(pos.x, pos.y, size * 1.05);
    fill(64, 60, 56, 220);
    for (let i = 0; i < 6; i++) {
      const a = (TWO_PI / 6) * i + 0.4;
      circle(pos.x + cos(a) * size * 0.24, pos.y + sin(a) * size * 0.24, size * 0.2);
    }
  }

  /** Compact bar: the base one is champion-sized and reads as a unit. */
  drawHealthBar() {
    const pos = this.position;
    const size = this.stats.size.value;
    // Overlay, not world: the bar and its text compensate together, so a
    // turret's health reads the same on a phone as on a desktop.
    const k = this.game?.camera?.constantSize?.(1) ?? 1;
    const w = 84 * k;
    const h = 7 * k;
    const x = pos.x - w / 2;
    const y = pos.y - size * 0.75;
    const percent = Math.max(0, this.stats.health.value / this.stats.maxHealth.value);

    // Native context, not p5 — the same move as `Minion.drawHealthBar` and
    // for the same reason: this measured 202us/call at 6x throttle and every
    // one of those microseconds was p5 overhead around four primitives.
    // Same geometry, same colors.
    const ctx = drawingContext;
    ctx.save();
    ctx.fillStyle = cssColor(12, 14, 18, 220);
    ctx.fillRect(x - 2 * k, y - 2 * k, w + 4 * k, h + 4 * k);
    // Team-coloured fill, the same bar shade a minion carries, so a turret's
    // side is legible from its health bar as well as its body.
    const bar = teamColors(this.teamId).bar;
    ctx.fillStyle = cssColor(bar[0], bar[1], bar[2]);
    ctx.fillRect(x, y, w * percent, h);
    ctx.fillStyle = cssColor(200, 200, 210);
    ctx.font = `${11 * k}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      `${~~this.stats.health.value} / ${~~this.stats.maxHealth.value}`,
      pos.x,
      y - 9 * k
    );
    ctx.restore();

    this.drawPassiveMarks(y + h + 4 * k, k);
  }

  /**
   * The passives this tower is currently running, as a row of pips under its
   * health bar.
   *
   * ## Why on the building and not on a buff bar
   *
   * There is no buff bar for a turret and there should not be: these passives
   * belong to a building somebody is deciding whether to walk under, and that
   * decision is made looking at the building. Both of them shipped invisible —
   * a tower currently taking 20% damage looked exactly like one that is not,
   * and the ramp that makes standing under it progressively lethal had no tell
   * at all.
   *
   * ## What is drawn and what is not
   *
   * Whatever `Buff.structureMark` answers, and nothing else — the turret does
   * not know which passives exist. That matters because a pack declaring
   * `turretPassives` replaces core's list outright, so a pack's own tower
   * draws here without core having heard of its classes.
   *
   * A passive that is always on returns `null` and draws nothing. The ward is
   * the case: a mark that is never absent teaches nothing after the first
   * glance, and the whole value of this row is the difference between a lit
   * pip and an unlit one.
   *
   * Overlay units (`camera.constantSize`), like the bar it hangs under, so the
   * row is the same size on a phone as on a desktop.
   */
  drawPassiveMarks(top: number, k: number): void {
    const marks: StructureMark[] = [];
    for (const buff of this.buffs) {
      if (buff.toRemove) continue;
      const mark = buff.structureMark;
      if (mark) marks.push(mark);
    }
    if (marks.length === 0) return;

    const pip = 5 * k;
    const gap = 2 * k;
    const groupGap = 5 * k;
    const width =
      marks.reduce((sum, mark) => sum + mark.total * pip + (mark.total - 1) * gap, 0) +
      (marks.length - 1) * groupGap;

    push();
    noStroke();
    let x = this.position.x - width / 2;
    for (const mark of marks) {
      for (let slot = 0; slot < mark.total; slot++) {
        // Unlit slots are drawn too, so a ramp at one of three reads as "one of
        // three" rather than as a lone dot of unknown ceiling.
        const lit = slot < mark.filled;
        const [r, g, b] = mark.color;
        fill(r, g, b, lit ? 235 : 60);
        rect(x, top, pip, pip * 0.8, 1 * k);
        x += pip + gap;
      }
      x += groupGap - gap;
    }
    pop();
  }

  drawDir() {}

  getDisplayBoundingBox() {
    return this.squareDisplayBoundingBox(this.stats.size.value * 1.6);
  }
}

/**
 * Turret shot. Homes on its one target and damages nobody else, so a bolt cannot
 * clip a jungle camp or a bystander on the way (`maxHitCount = 0` switches the
 * base class's in-flight collision off entirely).
 */
export class TurretBolt extends MissileSpellObject {
  speed = 13;
  size = 16;
  maxHitCount = 0;
  removeOnArrive = true;
  damage = 12;
  target: AttackableUnit | null = null;
  /**
   * It chases until it lands, or until its target dies and it finishes the
   * flight to where that target last was. It gives up only on a target that
   * is outrunning it — which nothing on foot does to 780 units a second. This
   * was `_life = 4000`: a hard 3120px cap on a turret's reach, whatever its
   * map said `attackRange` was. See `MissileSpellObject.stalledChaseMs`.
   */
  stalledChaseMs = STALLED_CHASE_MS;

  trailSystem: TrailSystem = new TrailSystem({
    trailColor: '#ffb04daa',
    trailSize: 7,
    maxLength: 10,
    trailLifeTime: 220,
  });

  onBeforeMove() {
    // keep homing while the target lives; once it dies the bolt flies to the last
    // known point and expires there
    if (this.target && !this.target.isDead && !this.target.toRemove) {
      this.destination.set(this.target.position.x, this.target.position.y);
    }
  }

  onArrive() {
    const t = this.target;
    if (t && !t.isDead && !t.toRemove && t.targetable) {
      t.takeDamage(this.damage, this.owner, 'PHYSICAL', BASIC_ATTACK_SOURCE);
    }
  }

  draw() {
    push();
    noStroke();
    fill(255, 210, 130, 90);
    circle(this.position.x, this.position.y, this.size * 1.9);
    fill(255, 236, 190);
    circle(this.position.x, this.position.y, this.size * 0.75);
    pop();
  }
}
