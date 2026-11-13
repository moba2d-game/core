/**
 * "Truy Nã": the champion on the longest kill run is wanted.
 *
 * No counters of its own. A run is `MatchAnnouncer.streakOf`, the same number
 * the scoreboard and the Shutdown tag read; the pay-out rides the existing
 * kill bounty in `AttackableUnit.die` (one extra term on the same `earn`),
 * and the feed line is an `Announcement.bounty` field, so a LAN client gets
 * it over the wire without a new message.
 *
 * Pure functions only: the rule is one sentence and `Bounty.test.ts` pins it.
 */

/** A run this long makes its owner wanted. Same number as a Shutdown. */
export const BOUNTY_MIN_STREAK = 3;
/** Extra gold at the minimum run. */
export const BOUNTY_BASE_GOLD = 200;
/** Each kill past the minimum adds this much. */
export const BOUNTY_PER_STREAK_GOLD = 100;
/** Ceiling, so a runaway run is a prize and not a game-ender. */
export const BOUNTY_MAX_GOLD = 1000;

/** The extra gold on a head whose owner is on a run of `streak` kills; 0 below the minimum. */
export const bountyGold = (streak: number): number =>
  streak < BOUNTY_MIN_STREAK
    ? 0
    : Math.min(BOUNTY_MAX_GOLD, BOUNTY_BASE_GOLD + (streak - BOUNTY_MIN_STREAK) * BOUNTY_PER_STREAK_GOLD);

interface Body {
  teamId: string;
  killCredit?: string;
}

/**
 * What a kill pays on top of the normal bounty. Only a champion killing an
 * enemy champion collects: a turret or a teammate cannot cash a head in.
 */
export function bountyForKill(
  enabled: boolean,
  victim: Body,
  killer: Body | null | undefined,
  victimStreak: number
): number {
  if (!enabled || !killer || killer === victim) return 0;
  if (victim.killCredit !== 'champion' || killer.killCredit !== 'champion') return 0;
  if (killer.teamId === victim.teamId) return 0;
  return bountyGold(victimStreak);
}

/** The live champion with the highest run (>= minimum); the first wins a tie. `null` when nobody is wanted. */
export function wantedOf<T extends { isDead?: boolean }>(
  champions: readonly T[],
  streakOf: (unit: T) => number
): T | null {
  let best: T | null = null;
  let bestStreak = BOUNTY_MIN_STREAK - 1;
  for (const unit of champions) {
    if (unit.isDead) continue;
    const streak = streakOf(unit);
    if (streak > bestStreak) {
      best = unit;
      bestStreak = streak;
    }
  }
  return best;
}
