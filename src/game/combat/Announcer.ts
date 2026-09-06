import EventType from '@/game/enums/EventType';
import type EventManager from '@/managers/EventManager';
import type AttackableUnit from '@/game/gameObject/attackableUnits/AttackableUnit';
import type { UnitDeathEvent } from '@/game/gameObject/attackableUnits/AttackableUnit';

/**
 * The match's memory of who killed whom, told back as a kill feed and the
 * occasional banner.
 *
 * `MatchTally` keeps the *totals* and deliberately resets nothing on death;
 * this keeps the *rhythm* — the run of kills since a champion last died, the
 * kills that came fast enough to be one moment, the first kill of the match
 * — because those are what a fight feels like, and none of them is a total.
 * The five seconds after a kill used to be silent: the number on the health
 * bar went up by one and nothing else happened. Now they say something.
 *
 * One announcement per champion death, whoever or whatever did it, with the
 * tags a viewer would want beside it. Minion, monster and turret deaths do
 * not make the feed: nobody reads "Lính hạ Lính" forty times a minute.
 *
 * Host-authoritative. On a LAN client `die()` comes from the snapshot's dead
 * flag with no killer attached, so the client never runs `onDeath` — it
 * receives the host's announcements over the wire (`receive`), re-stamped to
 * its own clock. Both ends then read the same `recent()`/`banner()`.
 *
 * The callout names are the ones every MOBA player already hears in their
 * head — Double Kill, Penta Kill, First Blood, Killing Spree — because a
 * translation of them lands softer than the original (the user's call, on
 * hearing "Tam sát"). The sentences around them stay Vietnamese. None of
 * these words is a trademark; they predate this genre.
 */

/** Kills closer together than this are one multi-kill. */
export const MULTI_KILL_WINDOW_MS = 10_000;
/**
 * How long a feed row stays readable. Short on purpose: the feed sits over
 * the top of the fight, and a teamfight's worth of rows lingering there is a
 * screen nobody can play on. Six seconds is long enough to read a row twice.
 */
export const FEED_TTL_MS = 6_000;
/**
 * Rows the feed shows at once; older ones simply age out. Three on a
 * monitor; the touch layout hides the third (`hud.css`), so a phone gives up
 * at most two rows of its top edge.
 *
 * A *row* is a multi-kill, not a kill — `hud/killFeedGroups.ts` folds a run
 * into one — so three of these is a far larger share of a fight than it was
 * when a penta spent all three on one champion.
 */
export const FEED_ROWS = 3;
/**
 * How long a row stays *buffered*, as opposed to shown.
 *
 * Longer than `FEED_TTL_MS` because the feed draws a run as one row and the
 * window binding that run (ten seconds) outlives the six a row is visible
 * for. Pruned on the shorter clock, the first kill of a slow penta would drop
 * out from under the row still showing it, and the row would lose the seq it
 * is keyed on and re-enter mid-run — the dropped-callout flicker this whole
 * fold exists to remove. `recent` still hands out only the six-second rows.
 */
export const FEED_BUFFER_TTL_MS = FEED_TTL_MS + MULTI_KILL_WINDOW_MS;
/** Announcements held at once, whatever the clock says. Kills, not rows. */
export const FEED_BUFFER_ROWS = FEED_ROWS * 8;
/** How long a banner holds the centre of the screen. */
export const BANNER_TTL_MS = 2_200;
/**
 * The least time a banner keeps the centre before an *equally* loud one may
 * take it from it.
 *
 * A 1v10 practice fight makes a moment every few hundred milliseconds, and the
 * banner used to be whichever was newest: three kills inside a second were
 * three banners, each replacing one that had not finished arriving. What that
 * reads as on screen is a flicker, not a callout. A louder moment still wins
 * the instant it lands — a Penta never waits behind a plain kill — so this
 * only ever asks a tie to hold.
 */
export const BANNER_MIN_HOLD_MS = 700;
/** A kill run reaching one of these lengths is worth a banner even when it is not yours — each is a new tier name. */
export const STREAK_MILESTONES: readonly number[] = [3, 4, 5, 6, 7, 8];
/** Ending a run at least this long is a shutdown. */
export const SHUTDOWN_STREAK = 3;

/** One side of a kill as the feed shows it. Names and art only — never a unit reference on the wire. */
export interface AnnouncementSide {
  name: string;
  /** The avatar's asset path, as `HudState.avatar` is; '' when the unit has none. */
  avatar: string;
  team: string;
}

/** A champion's death, with everything the feed says about it. */
export interface Announcement {
  seq: number;
  /** `Game.matchTimeMs` when it happened — on a client, when it arrived. */
  atMs: number;
  /** Whatever landed the killing blow: a champion, a turret, a minion. `null` for a death nobody caused. */
  killer: AnnouncementSide | null;
  victim: AnnouncementSide;
  firstBlood: boolean;
  /** 1 for a lone kill, 2 for the second inside the window, and so on. 0 when the killer is not a champion. */
  multi: number;
  /** The killer's run of kills since it last died, this one included. 0 when the killer is not a champion. */
  streak: number;
  /** The run the victim was on, when it was at least `SHUTDOWN_STREAK`; else 0. */
  shutdown: number;
  /**
   * Set when the body was an objective rather than a champion. Such a death
   * moves nobody's run: `multi`, `streak` and `firstBlood` are all left at
   * zero, so a turret cannot be somebody's Double Kill.
   */
  objective?: ObjectiveKind;
  /** Local references, for "is this mine". Never serialised — see `HostSession`. */
  killerUnit?: AttackableUnit;
  victimUnit?: AttackableUnit;
}

/** The wire shape: the same minus the unit references, plus their net ids. */
export type WireAnnouncement = Omit<Announcement, 'killerUnit' | 'victimUnit'> & {
  kid?: string;
  vid?: string;
};

interface KillRun {
  streak: number;
  multi: number;
  lastKillAtMs: number;
}

const MULTI_KILL_LABEL: readonly string[] = [
  '',
  '',
  'Double Kill',
  'Triple Kill',
  'Quadra Kill',
  'Penta Kill',
  'Hexa Kill',
  // Seven and up. The source game stops naming them because five is a whole
  // team; a match here can field more, and a run that outgrows the vocabulary
  // should say so rather than repeat "Penta" for the rest of the evening.
  'Legendary Kill',
];

/** "Double Kill" for 2, through "Hexa Kill" at 6 to "Legendary Kill" beyond; '' below 2. */
export const multiKillLabel = (multi: number): string =>
  MULTI_KILL_LABEL[Math.min(multi, MULTI_KILL_LABEL.length - 1)] ?? '';

/**
 * How loud a multi-kill is drawn, 0 for "not one".
 *
 * Clamped at the top of the label table, so the banner stops growing exactly
 * where the words stop changing — a run of nine and a run of twenty are the
 * same sentence and get the same size.
 */
export const MAX_MULTI_TIER = MULTI_KILL_LABEL.length - 1;
export const multiKillTier = (multi: number): number =>
  multi >= 2 ? Math.min(multi, MAX_MULTI_TIER) : 0;

const STREAK_LABEL: Record<number, string> = {
  3: 'Killing Spree',
  4: 'Rampage',
  5: 'Unstoppable',
  6: 'Dominating',
  7: 'Godlike',
};

/** The tier a run of `streak` kills has reached; "Legendary" from 8 on; '' below 3. */
export const streakLabel = (streak: number): string =>
  streak >= 8 ? 'Legendary' : (STREAK_LABEL[streak] ?? '');

export const FIRST_BLOOD_LABEL = 'First Blood';
export const SHUTDOWN_LABEL = 'Shutdown';

/**
 * A death that is news without being a kill: a turret falling, an epic camp
 * taken. Declared by the body itself (`AttackableUnit.announceAs`) so nothing
 * here has to know which monster a pack calls its dragon.
 */
export type ObjectiveKind = 'turret' | 'epic';

/**
 * What made a kill more than a kill. Each kind wears its own colour in the
 * HUD so a run reads differently from a burst at a glance: first blood
 * crimson, a multi-kill gold, a run fire, a shutdown violet.
 */
export type AnnouncementKind = 'first' | 'multi' | 'streak' | 'shutdown';

export interface AnnouncementTag {
  kind: AnnouncementKind;
  label: string;
}

/** The badges beside a feed row, in the order they are worth reading. */
export function announcementTags(a: Announcement): AnnouncementTag[] {
  const tags: AnnouncementTag[] = [];
  if (a.firstBlood) tags.push({ kind: 'first', label: FIRST_BLOOD_LABEL });
  if (a.multi >= 2) tags.push({ kind: 'multi', label: multiKillLabel(a.multi) });
  if (a.shutdown > 0) tags.push({ kind: 'shutdown', label: SHUTDOWN_LABEL });
  if (a.streak >= SHUTDOWN_STREAK) tags.push({ kind: 'streak', label: streakLabel(a.streak) });
  return tags;
}

/** The banner's colour family: the four kinds above, a plain kill, your own death, or an objective. */
export type BannerKind = AnnouncementKind | 'kill' | 'death' | 'objective';

export interface BannerText {
  kind: BannerKind;
  title: string;
  subtitle: string;
}

/**
 * Whether this kill interrupts the centre of the screen. Yours always does;
 * anyone else's only when it is a moment — first blood, a triple or more, a
 * shutdown, a run hitting a milestone.
 */
export function deservesBanner(
  a: Announcement,
  player: AttackableUnit | null | undefined
): boolean {
  // An epic camp is a call the whole map answers, so it interrupts for both
  // sides. A turret is not: a match has a dozen of them, and a banner each
  // would spend the centre of the screen on the most ordinary objective there
  // is — landing on top of a Penta as often as not.
  if (a.objective) return a.objective === 'epic';
  if (player && (a.killerUnit === player || a.victimUnit === player)) return true;
  return a.firstBlood || a.multi >= 3 || a.shutdown > 0 || STREAK_MILESTONES.includes(a.streak);
}

/**
 * How loud a moment is, for choosing which one holds the centre while several
 * are on screen at once.
 *
 * Only ever compared, never shown, so the numbers themselves mean nothing; the
 * gaps between the bands are what matter, because they let a tier grow inside
 * its own band (a Penta over a Double) without reaching the band above. Your
 * own death sits over first blood and under a run: the recap says the same
 * thing a moment later and says it better, so the banner is the half of that
 * pair that can afford to lose.
 */
export function bannerPriority(
  a: Announcement,
  player: AttackableUnit | null | undefined
): number {
  if (a.objective) return 30;
  let score = player && a.killerUnit === player ? 20 : 10;
  if (a.firstBlood) score = Math.max(score, 40);
  if (player && a.victimUnit === player) score = Math.max(score, 45);
  if (a.shutdown > 0) score = Math.max(score, 50);
  if (STREAK_MILESTONES.includes(a.streak)) score = Math.max(score, 60 + a.streak);
  if (a.multi >= 2) score = Math.max(score, 80 + multiKillTier(a.multi));
  return score;
}

/** What the banner says, from the player's side of it. */
export function bannerText(a: Announcement, player: AttackableUnit | null | undefined): BannerText {
  const killer = a.killer?.name ?? 'Không rõ';
  const pair = `${killer} hạ ${a.victim.name}`;
  // The objective is the headline, because that is what the four players on
  // the losing side need to read; who landed it is the detail.
  if (a.objective) {
    return {
      kind: 'objective',
      title: a.victim.name,
      subtitle: a.killer ? `${killer} hạ gục` : '',
    };
  }
  const milestone = STREAK_MILESTONES.includes(a.streak);
  if (player && a.victimUnit === player) {
    return { kind: 'death', title: 'Bạn đã bị hạ', subtitle: a.killer ? `bởi ${killer}` : '' };
  }
  if (player && a.killerUnit === player) {
    // One headline, the loudest thing first: a burst over a run over a first
    // blood over a plain kill. Whatever did not make the headline rides the
    // subtitle, so nothing is lost — only ordered.
    const extras: string[] = [a.victim.name];
    let head: BannerText;
    if (a.multi >= 2) head = { kind: 'multi', title: multiKillLabel(a.multi), subtitle: '' };
    else if (milestone) head = { kind: 'streak', title: streakLabel(a.streak), subtitle: '' };
    else if (a.firstBlood) head = { kind: 'first', title: FIRST_BLOOD_LABEL, subtitle: '' };
    else head = { kind: 'kill', title: 'Hạ gục', subtitle: '' };
    if (a.firstBlood && head.kind !== 'first') extras.push(FIRST_BLOOD_LABEL);
    if (a.shutdown > 0) extras.push(SHUTDOWN_LABEL);
    if (milestone && head.kind !== 'streak') extras.push(streakLabel(a.streak));
    return { ...head, subtitle: extras.join(' · ') };
  }
  if (a.firstBlood) return { kind: 'first', title: FIRST_BLOOD_LABEL, subtitle: pair };
  if (a.multi >= 3) return { kind: 'multi', title: multiKillLabel(a.multi), subtitle: killer };
  if (a.shutdown > 0) return { kind: 'shutdown', title: SHUTDOWN_LABEL, subtitle: pair };
  if (milestone) return { kind: 'streak', title: streakLabel(a.streak), subtitle: killer };
  return { kind: 'kill', title: 'Hạ gục', subtitle: pair };
}

const sideOf = (unit: AttackableUnit): AnnouncementSide => ({
  name: (unit as { name?: string }).name ?? 'Không rõ',
  avatar: unit.avatar?.path ?? '',
  team: unit.teamId,
});

export default class MatchAnnouncer {
  private readonly runs = new WeakMap<AttackableUnit, KillRun>();
  private readonly rows: Announcement[] = [];
  private readonly listeners = new Set<(a: Announcement) => void>();
  private firstBloodTaken = false;
  private firstBloodAtMs = Number.POSITIVE_INFINITY;
  private seq = 0;
  private stop: (() => void) | null = null;

  constructor(
    private readonly events: EventManager | undefined,
    private readonly clock: () => number
  ) {}

  /** Start listening for deaths. Idempotent; `detach` undoes it. */
  attach(): void {
    if (this.stop || !this.events) return;
    this.stop = this.events.on(EventType.ON_DIE, (event: UnitDeathEvent) => this.onDeath(event));
  }

  detach(): void {
    this.stop?.();
    this.stop = null;
  }

  /** Hear every announcement as it is made — the host forwards these. Returns the unsubscribe. */
  onAnnounce(listener: (a: Announcement) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** The host's announcement, arriving on a client. Stamped to *this* clock; the host's is not ours. */
  receive(
    wire: WireAnnouncement,
    units: { killerUnit?: AttackableUnit; victimUnit?: AttackableUnit }
  ): void {
    const { kid: _kid, vid: _vid, ...rest } = wire;
    this.push({
      ...rest,
      atMs: this.clock(),
      killerUnit: units.killerUnit,
      victimUnit: units.victimUnit,
    });
  }

  /** The rows still worth showing, oldest first, at most `FEED_ROWS`. */
  recent(nowMs: number): Announcement[] {
    this.prune(nowMs);
    return this.rows.filter(row => nowMs - row.atMs <= FEED_TTL_MS).slice(-FEED_ROWS);
  }

  /**
   * Everything still buffered, oldest first, on the wider `FEED_BUFFER_TTL_MS`
   * clock. The HUD folds these into multi-kill rows and applies `FEED_TTL_MS`
   * to each row's newest kill, which is why it cannot use `recent`: that one
   * caps at three *kills*, and a penta is five.
   */
  buffered(nowMs: number): Announcement[] {
    this.prune(nowMs);
    return this.rows.slice();
  }

  /**
   * The moment holding the centre of the screen, if any is.
   *
   * The *loudest* one still young enough, not the newest: a Penta that has
   * been up for half a second is not something the plain kill after it should
   * be allowed to overwrite. Between two of equal weight the newer one wins,
   * but only once `BANNER_MIN_HOLD_MS` has passed — which is measured between
   * the two kills rather than against `nowMs`, so the answer depends on the
   * rows alone and cannot change between two ticks of the same fight.
   */
  banner(nowMs: number, player: AttackableUnit | null | undefined): Announcement | null {
    let chosen: Announcement | null = null;
    for (const row of this.rows) {
      if (nowMs - row.atMs > BANNER_TTL_MS) continue;
      if (!deservesBanner(row, player)) continue;
      if (
        !chosen ||
        bannerPriority(row, player) > bannerPriority(chosen, player) ||
        row.atMs - chosen.atMs >= BANNER_MIN_HOLD_MS
      ) {
        chosen = row;
      }
    }
    return chosen;
  }

  /** The killer's run so far — what a shutdown would end. Exposed for the scoreboard and tests. */
  streakOf(unit: AttackableUnit): number {
    return this.runs.get(unit)?.streak ?? 0;
  }

  /**
   * A rewound match un-announces its future.
   *
   * Age here is always `now - atMs`, and a row stamped after the rewind
   * target has negative age forever — it would never prune, so its banner
   * would never leave the screen. Rows from after the target are dropped,
   * and the runs are rebuilt from the rows that survive: each row recorded
   * its killer's streak and multi at the moment it was made, so the newest
   * surviving row per killer is that run's state, and a surviving death
   * still ends its victim's run. First blood is untaken again only when its
   * own moment sits in the discarded future.
   */
  rewindTo(nowMs: number): void {
    const surviving: Announcement[] = [];
    const dropped: Announcement[] = [];
    for (const row of this.rows) (row.atMs <= nowMs ? surviving : dropped).push(row);
    if (dropped.length === 0) return;
    this.rows.length = 0;
    this.rows.push(...surviving);
    for (const row of dropped) {
      if (row.killerUnit) this.runs.delete(row.killerUnit);
      if (row.victimUnit) this.runs.delete(row.victimUnit);
    }
    for (const row of surviving) {
      if (row.killerUnit) {
        this.runs.set(row.killerUnit, {
          streak: row.streak,
          multi: row.multi,
          lastKillAtMs: row.atMs,
        });
      }
      if (row.victimUnit) {
        const run = this.runs.get(row.victimUnit);
        if (run) {
          run.streak = 0;
          run.multi = 0;
        }
      }
    }
    if (this.firstBloodAtMs > nowMs) {
      this.firstBloodTaken = false;
      this.firstBloodAtMs = Number.POSITIVE_INFINITY;
    }
  }

  private onDeath(event: UnitDeathEvent): void {
    const { unit: victim } = event;
    // The feed names whoever the kill was *booked* to, which for a summon's
    // last hit is the player who summoned it — the same unit `die()` gave the
    // kill and the gold to. Announced off the clone instead, the row reads
    // "Không rõ hạ X": a `Pet`'s own `killCredit` is `'none'`, so it does not
    // clear the champion-on-champion gate below and nobody's spree moves.
    const killer = event.creditedTo ?? event.killer;
    const now = this.clock();

    // The victim's run ends whatever killed it — a turret ends a spree too.
    const victimRun = this.runs.get(victim);
    const ended = victimRun?.streak ?? 0;
    if (victimRun) {
      victimRun.streak = 0;
      victimRun.multi = 0;
      victimRun.lastKillAtMs = Number.NEGATIVE_INFINITY;
    }

    // An objective is news on its own terms: announced, but never folded into
    // anybody's run, and never first blood. Taken before the champion gate
    // below, which exists to keep minions out of the feed.
    const objective = victim.announceAs;
    if (objective) {
      const announcement: Announcement = {
        seq: ++this.seq,
        atMs: now,
        killer: killer && killer !== victim ? sideOf(killer) : null,
        victim: sideOf(victim),
        firstBlood: false,
        multi: 0,
        streak: 0,
        shutdown: 0,
        objective,
        killerUnit: killer && killer !== victim ? killer : undefined,
        victimUnit: victim,
      };
      this.push(announcement);
      for (const listener of this.listeners) listener(announcement);
      return;
    }

    if (event.credit !== 'champion') return;

    let multi = 0;
    let streak = 0;
    let firstBlood = false;
    const killerIsChampion = !!killer && killer !== victim && killer.killCredit === 'champion';
    if (killerIsChampion) {
      const run = this.runOf(killer);
      run.streak += 1;
      run.multi = now - run.lastKillAtMs <= MULTI_KILL_WINDOW_MS ? run.multi + 1 : 1;
      run.lastKillAtMs = now;
      multi = run.multi;
      streak = run.streak;
      // Champion on champion only: a tower's first kill is not anyone's blood.
      firstBlood = !this.firstBloodTaken;
      this.firstBloodTaken = true;
      if (firstBlood) this.firstBloodAtMs = now;
    }

    const announcement: Announcement = {
      seq: ++this.seq,
      atMs: now,
      killer: killer && killer !== victim ? sideOf(killer) : null,
      victim: sideOf(victim),
      firstBlood,
      multi,
      streak,
      shutdown: ended >= SHUTDOWN_STREAK ? ended : 0,
      killerUnit: killer && killer !== victim ? killer : undefined,
      victimUnit: victim,
    };
    this.push(announcement);
    for (const listener of this.listeners) listener(announcement);
  }

  private runOf(unit: AttackableUnit): KillRun {
    let run = this.runs.get(unit);
    if (!run) {
      run = { streak: 0, multi: 0, lastKillAtMs: Number.NEGATIVE_INFINITY };
      this.runs.set(unit, run);
    }
    return run;
  }

  private push(announcement: Announcement): void {
    this.rows.push(announcement);
    this.prune(announcement.atMs);
  }

  private prune(nowMs: number): void {
    // Rows older than the buffer holds are gone for good; a banner never
    // outlives a row, so the same cut serves both. The cut is the buffer's
    // clock, not the feed's — `recent` narrows to the feed's on the way out,
    // and the extra ten seconds are what keep a slow run whole for the fold.
    let drop = 0;
    while (drop < this.rows.length && nowMs - this.rows[drop].atMs > FEED_BUFFER_TTL_MS) drop++;
    if (drop > 0) this.rows.splice(0, drop);
    // And never more than a few beyond what is shown, whatever the clock says.
    // Counted in kills while a row is a run: three rows of a penta each is
    // fifteen, and `multi` keeps climbing past the five the label stops at.
    if (this.rows.length > FEED_BUFFER_ROWS) {
      this.rows.splice(0, this.rows.length - FEED_BUFFER_ROWS);
    }
  }
}
