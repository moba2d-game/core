import AttackableUnit from '@/game/gameObject/attackableUnits/AttackableUnit';
import Champion from '@/game/gameObject/attackableUnits/Champion';
import Minion from '@/game/gameObject/attackableUnits/Minion';
import Monster from '@/game/gameObject/attackableUnits/Monster';
import type { MonsterTier } from '@/content/ContentPack';
import Turret from '@/game/gameObject/structures/Turret';
import { effectiveHealth } from '@/game/combat/ExecuteTargeting';
import { canTeamSee, type Seeable } from '@/game/combat/Vision';
import { targetVelocity } from '@/game/ai/AimPredictor';
import {
  assignLanes,
  laneAdvance,
  laneNeed,
  laneProgressAt,
  nearestLane,
  LANE_MEMBERSHIP_PX,
  type LaneState,
} from '@/game/ai/LaneObjectives';
import { LANES } from '@/game/lanes';
import type GameObject from '@/game/gameObject/GameObject';
import type { Vec2 } from '@/game/spell/runtime/types';

/**
 * One shared snapshot of the match, rebuilt at most once per tick and read by
 * every bot on both teams — rosters, who the team is focusing, where it is
 * clustered, and a memory of where each enemy was last seen. This is what
 * turns bots from five independent agents into two teams.
 *
 * The memory records *terrain-honest* shared team sight, always. Three tiers
 * read the same board, so it must never carry one tier's advantage — and the
 * advantage a tier does get is `memoryTtlMs`, applied by the *reader*: how long
 * a bot keeps hunting what it lost, not whether it ever loses it. `sees` is
 * injectable only so tests can be deterministic; in the game it is always the
 * honest `canTeamSee`.
 */

/**
 * How long one snapshot serves. Matches the bot think tick, so a board is built
 * once per window for the whole match rather than once per bot: five bots asking
 * cost one pass, not five.
 */
export const BLACKBOARD_TTL_MS = 250;

/**
 * Hard ceiling on a memory entry, above the longest per-tier memory length any
 * bot uses. The per-tier limit is applied by the *reader*, because three
 * difficulties share one board and each forgets at its own pace; this one only
 * stops the map growing without bound over a long match.
 */
export const MEMORY_MAX_MS = 5000;

export interface SeenEnemy {
  unit: Champion;
  atMs: number;
  pos: Vec2;
  vel: Vec2;
}

/**
 * One jungle camp as the team sees it this tick: every body that ever stood
 * there, grouped by the slot they share (`Monster.camp` is the slot object
 * itself, by reference), with the ones still standing and how long until the
 * fallen come back. Team-independent — a camp is the same camp to both sides.
 */
export interface CampState {
  camp: { x: number; y: number; r: number };
  tier: MonsterTier;
  /** The bodies still standing. Empty is a cleared camp. */
  alive: readonly Monster[];
  total: number;
  /** Ms until the first fallen body returns; 0 while any body stands or none has ever died. */
  respawnInMs: number;
}

/** The team's standing call to an `epic` camp — see `pickObjective`. */
export interface ObjectiveCall {
  camp: CampState;
  /** The body to hit. The first still standing; a pit boss is a camp of one. */
  monster: Monster;
}

export interface TeamView {
  allies: readonly Champion[];
  enemies: readonly Champion[];
  focusTarget: Champion | null;
  rally: Vec2 | null;
  memory: ReadonlyMap<Champion, SeenEnemy>;
  /**
   * One entry per lane in `LANES`, scored from this team's side of the map.
   * `LANES` is the active match's own lane set (`lanes.ts`'s
   * `setActiveLanes`, installed by `Game`'s constructor from `map.lanes`) —
   * empty on a map that declares none, which is what leaves `BotBrain`'s
   * PUSH posture with no objective to fall through from.
   */
  lanes: ReadonlyMap<string, LaneState>;
  /** Which lane each of this team's bots is working. Humans are not in it. */
  laneAssignments: ReadonlyMap<Champion, string>;
  /**
   * Every living hostile turret, for `TurretThreat`.
   *
   * Deliberately not the same answer as `LaneState.nextEnemyTurret`, which is
   * the lane *economy* — the next building this team has to break, bucketed by
   * lane and therefore missing any turret standing further than
   * `LANE_MEMBERSHIP_PX` from a waypoint path. A turret nowhere near a lane
   * still shoots, and "may I stand here" has to be asked of all of them.
   */
  enemyTurrets: readonly Turret[];
  /** Every camp on the map, from the same one pass. Optional so a hand-built view in a suite need not list them. */
  camps?: readonly CampState[];
  /** Where the team is going together, if anywhere. `null`/absent: no call. */
  objective?: ObjectiveCall | null;
  /** The bot living in the jungle — kept out of `laneAssignments`. Only a team of `JUNGLER_MIN_BOTS` bots has one. */
  jungler?: Champion | null;
}

/** A team of this many bots or more spares one for the jungle. */
export const JUNGLER_MIN_BOTS = 4;
/** An enemy the team has seen within this of a pit, this recently, counts against going there. */
export const OBJECTIVE_DANGER_PX = 900;
export const OBJECTIVE_MEMORY_MS = 4_000;
/** An ally below this share of health is not counted as fit to contest. */
export const OBJECTIVE_HEALTH_PCT = 0.5;
/** A fight the fit allies cannot finish inside this is not one they are ready for. */
export const OBJECTIVE_MAX_TTK_MS = 30_000;
/** ...and one that would cost them more than this share of their pooled health is not either. */
export const OBJECTIVE_RISK_SHARE = 0.6;
/** The same two questions for a lone bot at an ordinary camp, tighter: it has nobody to lean on. */
export const CAMP_MAX_TTK_MS = 20_000;
export const CAMP_RISK_SHARE = 0.5;

/**
 * "Lượng sức mình": what a fight against `bodies` would cost `attackers`,
 * from basic-attack numbers alone. Time to kill is the bodies' standing
 * health over the attackers' summed swing DPS; the cost is the bodies' summed
 * DPS over that time, as a share of the attackers' pooled current health.
 * Abilities are ignored on both sides on purpose — the estimate is meant to
 * be pessimistic, and a bot that has not bought anything yet should read as
 * exactly that. Buying is how the number moves.
 */
export interface FightOdds {
  /** Infinity when nobody swings. */
  ttkMs: number;
  /** Share of pooled health lost by the time the last body falls. */
  costShare: number;
}

export function fightOdds(attackers: readonly Champion[], bodies: readonly Monster[]): FightOdds {
  let dps = 0;
  let pooled = 0;
  for (const ally of attackers) {
    dps += Math.max(0, ally.stats.attackDamage.value) * Math.max(0, ally.stats.attackSpeed.value);
    pooled += Math.max(0, ally.stats.health.value);
  }
  let health = 0;
  let incomingDps = 0;
  for (const body of bodies) {
    if (body.isDead || body.toRemove) continue;
    health += Math.max(0, body.stats.health.value);
    if (body.attackInterval > 0) incomingDps += (Math.max(0, body.damage) * 1000) / body.attackInterval;
  }
  if (!(dps > 0)) return { ttkMs: Number.POSITIVE_INFINITY, costShare: Number.POSITIVE_INFINITY };
  const ttkMs = (health / dps) * 1000;
  const costShare = pooled > 0 ? (incomingDps * ttkMs) / 1000 / pooled : Number.POSITIVE_INFINITY;
  return { ttkMs, costShare };
}

/** Whether `odds` is a fight worth starting under the given ceilings. */
export const worthFighting = (odds: FightOdds, maxTtkMs: number, riskShare: number): boolean =>
  odds.ttkMs <= maxTtkMs && odds.costShare <= riskShare;

/**
 * Whether **any** of `observers` can see `target`.
 *
 * A team question rather than a pair one, because that is the question
 * `refreshMemory` actually asks and because asking it a pair at a time is what
 * made this the most expensive thing in the AI layer: `canSee`'s borrowed-eye
 * scan walks every ward, minion and turret lighting a circle for the observer's
 * *team*, and depends on nothing else about the observer, so a five-champion
 * roster ran the same scan five times for one answer.
 *
 * Injectable only so tests can be deterministic. In the game it is always
 * `canTeamSee`, which is `observers.some(o => canSee(o, target))` with that one
 * scan hoisted out — `canTeamSee.test.ts` drives the two against each other
 * rather than trusting the claim.
 */
export type TeamSeesFn = (observers: readonly Champion[], target: Champion) => boolean;

export interface BlackboardHost {
  objectManager?: { objects: GameObject[] };
}

export const EMPTY_VIEW: TeamView = Object.freeze({
  allies: Object.freeze([]) as readonly Champion[],
  enemies: Object.freeze([]) as readonly Champion[],
  focusTarget: null,
  rally: null,
  memory: new Map<Champion, SeenEnemy>(),
  lanes: new Map<string, LaneState>(),
  laneAssignments: new Map<Champion, string>(),
  enemyTurrets: Object.freeze([]) as readonly Turret[],
});

const defaultSees: TeamSeesFn = (observers, target) =>
  canTeamSee(observers as unknown as Seeable[], target as unknown as Seeable);

/** A unit and how far along its lane it is, 0 at the blue end and 1 at the red. */
interface LaneUnit<T> {
  unit: T;
  progress: number;
}

export class TeamBlackboard {
  private views = new Map<unknown, TeamView>();
  private memories = new Map<unknown, Map<Champion, SeenEnemy>>();
  private laneMemories = new Map<unknown, Map<Champion, string>>();
  private builtAtMs = Number.NEGATIVE_INFINITY;

  viewFor(teamId: unknown): TeamView {
    return this.views.get(teamId) ?? EMPTY_VIEW;
  }

  refreshIfStale(game: BlackboardHost, nowMs: number, sees: TeamSeesFn): void {
    if (nowMs - this.builtAtMs < BLACKBOARD_TTL_MS) return;
    this.builtAtMs = nowMs;
    this.rebuild(game, nowMs, sees);
  }

  /**
   * A rewound match: this board was built at a moment that no longer exists,
   * and `refreshIfStale` would keep trusting it until the clock caught back
   * up. Forget everything; the next tick rebuilds from what actually stands.
   */
  rewind(): void {
    this.builtAtMs = Number.NEGATIVE_INFINITY;
    this.views.clear();
    this.memories.clear();
    this.laneMemories.clear();
  }

  private rebuild(game: BlackboardHost, nowMs: number, sees: TeamSeesFn): void {
    // One pass over the object list for the whole game. `filter` cannot narrow
    // types here — the polyfilled prototype in `src/main.ts` puts the
    // non-predicate overload first — so this is a plain loop, as MatchDirector.bots() is.
    //
    // It is also the ONLY full-list walk the whole AI layer is allowed, and
    // `tests/game/ai/TeamBlackboard.lanes.test.ts` scans `src/game/ai/` to keep
    // it that way. The lane economy — where each wave has got to, which turret
    // is next — is gathered here rather than in a second pass or a per-frame
    // quadtree query for exactly that reason: five bots asking cost one walk.
    // The list holds every particle and trail in the match, so the
    // `AttackableUnit` test comes first and the three subtype tests only run on
    // what survives it.
    const living: Champion[] = [];
    /** Every standing turret, whatever lane it does or does not belong to. */
    const turrets: Turret[] = [];
    // Seeded from `LANES` — the active match's own lane set, empty on a map
    // with none — so this loop's cost tracks how many lanes the map actually
    // declares, not a fixed three. Bucketing by id inside the walk below,
    // rather than filtering `objects` once per lane afterwards, is what keeps
    // the object-list read singular whatever `LANES` turns out to hold.
    const laneMinions = new Map<string, LaneUnit<Minion>[]>();
    const laneTurrets = new Map<string, LaneUnit<Turret>[]>();
    for (const lane of LANES) {
      laneMinions.set(lane, []);
      laneTurrets.set(lane, []);
    }
    // Camps, keyed by the slot object every member shares by reference.
    const campsBySlot = new Map<object, { state: CampState; alive: Monster[] }>();

    for (const object of game.objectManager?.objects ?? []) {
      if (!(object instanceof AttackableUnit)) continue;
      if (object.toRemove) continue;

      // Before the dead-skip below: a fallen camp still matters, because when
      // it comes back is half of what a jungler wants to know.
      if (object instanceof Monster) {
        let entry = campsBySlot.get(object.camp);
        if (!entry) {
          const alive: Monster[] = [];
          entry = {
            alive,
            state: { camp: object.camp, tier: object.tier, alive, total: 0, respawnInMs: 0 },
          };
          campsBySlot.set(object.camp, entry);
        }
        entry.state.total += 1;
        // An `epic` anywhere in the camp makes the camp epic.
        if (object.tier === 'epic') entry.state.tier = 'epic';
        if (object.isDead) {
          const left = object.deathData?.reviveAfter ?? 0;
          if (entry.state.respawnInMs === 0 || left < entry.state.respawnInMs) {
            entry.state.respawnInMs = left;
          }
        } else {
          entry.alive.push(object);
        }
        continue;
      }

      if (object.isDead) continue;

      if (object instanceof Minion) {
        const bucket = laneMinions.get(object.lane);
        if (bucket) {
          bucket.push({
            unit: object,
            progress: laneProgressAt(object.lane, object.position.x, object.position.y),
          });
        }
        continue;
      }

      if (object instanceof Turret) {
        // Threat first, lane second: the buckets below drop a building that
        // stands off every waypoint path, and one of those still shoots.
        turrets.push(object);
        // A turret never moves, so its lane and its place along that lane are
        // measured once for the match rather than four times a second.
        const placed = turretPlacement(object);
        if (placed) laneTurrets.get(placed.lane)?.push({ unit: object, progress: placed.progress });
        continue;
      }

      if (!(object instanceof Champion)) continue;
      // `instanceof Champion` is not "is a champion": `Pet extends Champion`
      // (a summoned bear, a decoy clone and its box, a homing pet, a
      // stationary voidling)
      // and so does a self-copying clone, and every one of them carries its
      // summoner's `teamId`. Counting them made `enemies.length - allies.length
      // >= 2` fire on summons and send healthy bots home, dragged `rally` toward a
      // stationary box, and let `pickFocus` hand the whole team a decoy clone to
      // converge on. `killCredit` is the discriminator the codebase already
      // treats as authoritative for exactly this question — `Pet` sets it to
      // `'none'` *because* `instanceof` cannot tell them apart (see CLAUDE.md).
      if (object.killCredit !== 'champion') continue;
      living.push(object);
    }

    const camps: CampState[] = [];
    for (const { state } of campsBySlot.values()) {
      // A standing body means nobody is waiting on a timer.
      if (state.alive.length > 0) state.respawnInMs = 0;
      camps.push(state);
    }

    const teams = new Set<unknown>();
    for (const champion of living) teams.add(champion.teamId);

    // Where each champion stands, measured once for the whole rebuild rather
    // than once per team: the answer does not change with who is asking.
    const laneOfChampion = new Map<Champion, string>();
    for (const champion of living) {
      const nearest = nearestLane(champion.position.x, champion.position.y);
      // `nearest.lane` is `null` only when `LANES` is empty, in which case
      // `distance` stays `Infinity` and this branch never runs — the extra
      // check is what makes that provable here rather than merely true today.
      if (nearest.distance <= LANE_MEMBERSHIP_PX && nearest.lane !== null) {
        laneOfChampion.set(champion, nearest.lane);
      }
    }

    this.views.clear();
    for (const teamId of teams) {
      const allies: Champion[] = [];
      const enemies: Champion[] = [];
      for (const champion of living) {
        if (champion.teamId === teamId) allies.push(champion);
        else enemies.push(champion);
      }
      const enemyTurrets: Turret[] = [];
      for (const turret of turrets) {
        if (turret.teamId !== teamId) enemyTurrets.push(turret);
      }
      const lanes = this.buildLanes(teamId, enemies, laneOfChampion, laneMinions, laneTurrets);
      const memory = this.refreshMemory(teamId, allies, enemies, nowMs, sees);
      const { assignments, jungler } = this.refreshLaneAssignments(teamId, allies, lanes);
      this.views.set(teamId, {
        allies,
        enemies,
        enemyTurrets,
        focusTarget: pickFocus(allies, enemies),
        rally: centroid(allies),
        memory,
        lanes,
        laneAssignments: assignments,
        camps,
        objective: pickObjective(camps, allies, memory, nowMs),
        jungler,
      });
    }
  }

  /**
   * The three lanes as this team reads them.
   *
   * Everything here is a walk of buckets the one object pass already filled, so
   * the cost is the wave and the turret rows, twice — not the object list.
   */
  private buildLanes(
    teamId: unknown,
    enemies: readonly Champion[],
    laneOfChampion: ReadonlyMap<Champion, string>,
    laneMinions: ReadonlyMap<string, LaneUnit<Minion>[]>,
    laneTurrets: ReadonlyMap<string, LaneUnit<Turret>[]>
  ): Map<string, LaneState> {
    const side = String(teamId);
    const lanes = new Map<string, LaneState>();

    for (const lane of LANES) {
      let alliedMinions = 0;
      let enemyMinions = 0;
      let frontier: Vec2 | null = null;
      let frontierAdvance = Number.NEGATIVE_INFINITY;

      for (const entry of laneMinions.get(lane) ?? []) {
        if (entry.unit.teamId !== teamId) {
          enemyMinions++;
          continue;
        }
        alliedMinions++;
        const advance = laneAdvance(side, entry.progress);
        if (advance > frontierAdvance) {
          frontierAdvance = advance;
          frontier = { x: entry.unit.position.x, y: entry.unit.position.y };
        }
      }

      let nextEnemyTurret: Turret | null = null;
      let nextEnemyAdvance = Number.POSITIVE_INFINITY;
      let ownTurret: Turret | null = null;
      let ownAdvance = Number.NEGATIVE_INFINITY;

      for (const entry of laneTurrets.get(lane) ?? []) {
        const advance = laneAdvance(side, entry.progress);
        if (entry.unit.teamId === teamId) {
          // Ours: the one furthest from our base is the one their push meets.
          if (advance > ownAdvance) {
            ownAdvance = advance;
            ownTurret = entry.unit;
          }
        } else if (advance < nextEnemyAdvance) {
          // Theirs: the one nearest our base is the one we have to break first.
          nextEnemyAdvance = advance;
          nextEnemyTurret = entry.unit;
        }
      }

      let enemyChampions = 0;
      for (const enemy of enemies) {
        if (laneOfChampion.get(enemy) === lane) enemyChampions++;
      }

      const state: LaneState = {
        lane,
        alliedMinions,
        enemyMinions,
        frontier,
        nextEnemyTurret,
        ownTurret,
        ownTurretHealthPct: healthFraction(ownTurret),
        enemyTurretHealthPct: healthFraction(nextEnemyTurret),
        enemyChampions,
        need: 0,
      };
      state.need = laneNeed(state);
      lanes.set(lane, state);
    }
    return lanes;
  }

  /**
   * Which lane each of this team's bots takes, remembered between rebuilds.
   *
   * The memory is what makes `LANE_SWITCH_MARGIN` mean anything: without a
   * record of where a bot already is there is no incumbent, and the assignment
   * is recomputed from scratch four times a second off numbers that move with
   * every wave.
   */
  private refreshLaneAssignments(
    teamId: unknown,
    allies: readonly Champion[],
    lanes: ReadonlyMap<string, LaneState>
  ): { assignments: ReadonlyMap<Champion, string>; jungler: Champion | null } {
    // Roster order, which is spawn order — not a uuid, so the answer is the
    // same on every machine and a test can assert it. `filter` cannot narrow
    // here (see the note on the object pass above), so this is a plain loop.
    const bots: Champion[] = [];
    for (const ally of allies) {
      if (ally.isBot) bots.push(ally);
    }
    // The last bot in roster order lives in the jungle once there are enough
    // to spare one: three lanes hold three, and a fourth doubling a lane adds
    // less than a jungler adds. Roster order, again, so it never flickers.
    const jungler = bots.length >= JUNGLER_MIN_BOTS ? (bots.pop() ?? null) : null;

    const needs = new Map<string, number>();
    for (const [lane, state] of lanes) needs.set(lane, state.need);

    let remembered = this.laneMemories.get(teamId);
    if (!remembered) {
      remembered = new Map<Champion, string>();
      this.laneMemories.set(teamId, remembered);
    }

    const assigned = assignLanes(bots, needs, remembered);
    remembered.clear();
    for (const [bot, lane] of assigned) remembered.set(bot, lane);
    return { assignments: assigned, jungler };
  }

  private refreshMemory(
    teamId: unknown,
    allies: readonly Champion[],
    enemies: readonly Champion[],
    nowMs: number,
    sees: TeamSeesFn
  ): ReadonlyMap<Champion, SeenEnemy> {
    let memory = this.memories.get(teamId);
    if (!memory) {
      memory = new Map<Champion, SeenEnemy>();
      this.memories.set(teamId, memory);
    }

    for (const enemy of enemies) {
      // One call for the whole roster, not one per ally. The pair-at-a-time
      // loop that used to be here re-ran `canSee`'s borrowed-eye scan — every
      // ward, minion and turret lighting a circle for this team, each with its
      // own line-of-sight test — once per ally, for an answer that does not
      // vary with which ally is asking. In the case that costs the most (an
      // enemy nobody can see, so nothing short-circuits) that was five scans
      // where one does, twice a second, for both teams.
      if (!sees(allies, enemy)) continue;
      memory.set(enemy, {
        unit: enemy,
        atMs: nowMs,
        pos: { x: enemy.position.x, y: enemy.position.y },
        vel: targetVelocity(enemy),
      });
    }

    for (const [unit, entry] of memory) {
      if (unit.isDead || unit.toRemove || nowMs - entry.atMs > MEMORY_MAX_MS) memory.delete(unit);
    }

    return memory;
  }
}

const boards = new WeakMap<object, TeamBlackboard>();

/** Rewinds `host`'s board if one was ever built — see `TeamBlackboard.rewind`. */
export function rewindBlackboardFor(host: object): void {
  boards.get(host)?.rewind();
}

/**
 * The board for this game, rebuilt if the window has elapsed.
 *
 * `sees` is injectable only so tests can be deterministic. In the game it is
 * always the honest `canTeamSee` — the board holds what a team legitimately knows,
 * and must not carry one difficulty tier's privileges, because every tier reads
 * this same object.
 */
/**
 * The team's call, if any: an `epic` camp with a body standing, where the
 * enemies the team has *seen* lately are outnumbered by the allies fit to go.
 * Numbers, not bravado — one more fit body than enemies seen at the pit — and
 * memory rather than a scan, so a pit nobody has looked at recently reads as
 * empty, which is what a team without vision actually knows.
 *
 * Deliberately blind to whether anyone is mid-fight: each bot's own posture
 * chain puts FIGHT above OBJECTIVE, so a bot with an enemy in front of it
 * ignores the call and the rest go.
 */
export function pickObjective(
  camps: readonly CampState[],
  allies: readonly Champion[],
  memory: ReadonlyMap<Champion, SeenEnemy>,
  nowMs: number
): ObjectiveCall | null {
  const fitAllies: Champion[] = [];
  for (const ally of allies) {
    if (ally.isDead) continue;
    const max = ally.stats.maxHealth.value;
    if (max > 0 && ally.stats.health.value / max >= OBJECTIVE_HEALTH_PCT) fitAllies.push(ally);
  }
  const fit = fitAllies.length;
  if (fit === 0) return null;

  let best: ObjectiveCall | null = null;
  let bestDanger = Number.POSITIVE_INFINITY;
  for (const camp of camps) {
    if (camp.tier !== 'epic' || camp.alive.length === 0) continue;
    // Lượng sức mình: a team that cannot finish the boss quickly, or would be
    // shredded doing it, farms instead — buying is what changes this answer.
    if (!worthFighting(fightOdds(fitAllies, camp.alive), OBJECTIVE_MAX_TTK_MS, OBJECTIVE_RISK_SHARE)) {
      continue;
    }
    let danger = 0;
    for (const seen of memory.values()) {
      if (seen.unit.isDead || seen.unit.toRemove) continue;
      if (nowMs - seen.atMs > OBJECTIVE_MEMORY_MS) continue;
      if (Math.hypot(seen.pos.x - camp.camp.x, seen.pos.y - camp.camp.y) <= OBJECTIVE_DANGER_PX) {
        danger++;
      }
    }
    if (danger > fit - 1) continue;
    if (danger < bestDanger) {
      bestDanger = danger;
      best = { camp, monster: camp.alive[0] };
    }
  }
  return best;
}

export function blackboardFor(
  game: BlackboardHost,
  nowMs: number,
  sees: TeamSeesFn = defaultSees
): TeamBlackboard {
  let board = boards.get(game as object);
  if (!board) {
    board = new TeamBlackboard();
    boards.set(game as object, board);
  }
  board.refreshIfStale(game, nowMs, sees);
  return board;
}

/** The enemy the most allies are already committed to; ties go to the weakest. */
function pickFocus(allies: readonly Champion[], enemies: readonly Champion[]): Champion | null {
  if (enemies.length === 0) return null;

  const votes = new Map<Champion, number>();
  for (const ally of allies) {
    const target = ally.basicAttack?.target;
    if (target instanceof Champion && target.teamId !== ally.teamId) {
      votes.set(target, (votes.get(target) ?? 0) + 1);
    }
  }

  let best: Champion | null = null;
  let bestVotes = -1;
  let bestHealth = Number.POSITIVE_INFINITY;
  for (const enemy of enemies) {
    const count = votes.get(enemy) ?? 0;
    const health = effectiveHealth(enemy);
    if (count > bestVotes || (count === bestVotes && health < bestHealth)) {
      best = enemy;
      bestVotes = count;
      bestHealth = health;
    }
  }
  return best;
}

/**
 * Where a turret stands, worked out once and kept.
 *
 * A turret is `isImmovable` and re-anchors every frame, so its lane and its
 * place along that lane are properties of the map rather than of the tick. A
 * destroyed one rebuilds where it stood, so this survives that too.
 */
const turretPlaces = new WeakMap<Turret, { lane: string; progress: number } | null>();

function turretPlacement(turret: Turret): { lane: string; progress: number } | null {
  const known = turretPlaces.get(turret);
  if (known !== undefined) return known;

  const nearest = nearestLane(turret.position.x, turret.position.y);
  // Same `!== null` reasoning as `laneOfChampion` above: unreachable on a
  // laneless map today (distance is `Infinity` there), stated so rather than
  // trusted.
  const placed =
    nearest.distance <= LANE_MEMBERSHIP_PX && nearest.lane !== null
      ? { lane: nearest.lane, progress: nearest.progress }
      : null;
  turretPlaces.set(turret, placed);
  return placed;
}

/**
 * How much of a structure is left, as a fraction.
 *
 * **No turret reads as 0, not as 1.** An undefended lane is the urgent case,
 * and `laneNeed` prices `1 - pct`; handing it 1 would make a lane whose turrets
 * are all rubble look exactly as calm as one behind three full-health ones.
 */
const healthFraction = (unit: AttackableUnit | null): number => {
  if (!unit) return 0;
  const max = unit.stats.maxHealth.value;
  return max > 0 ? Math.max(0, Math.min(1, unit.stats.health.value / max)) : 0;
};

function centroid(units: readonly Champion[]): Vec2 | null {
  if (units.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const unit of units) {
    x += unit.position.x;
    y += unit.position.y;
  }
  return { x: x / units.length, y: y / units.length };
}
