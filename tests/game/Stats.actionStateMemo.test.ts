/**
 * `Stats.updateActionState` re-derives nothing when nothing changed.
 *
 * Every unit calls it once per simulation step, and a status changes only when
 * a buff lands or expires — so nearly every call used to set the same thirteen
 * bits to the values they already had. It now returns early when the flag is
 * the one it last resolved *and* `actionState` is still what that left behind.
 *
 * Both halves of that condition are load-bearing, and each has a test: the
 * action state is also written from outside (a LAN client copies the host's, a
 * pack's cleanse sets a bit directly), and a write from outside has to be put
 * right by the very next call exactly as it always was.
 */
import { describe, expect, it, vi } from 'vitest';
import Stats from '@/game/gameObject/Stats';
import ActionState from '@/game/enums/ActionState';
import StatusFlags from '@/game/enums/StatusFlags';

/** What a brand-new `Stats` resolves `flag` to — the unmemoised answer. */
const fresh = (flag: number, startingFrom?: number) => {
  const stats = new Stats();
  if (startingFrom !== undefined) stats.actionState = startingFrom;
  stats.updateActionState(flag);
  return stats.actionState;
};

const FLAGS = [
  StatusFlags.None,
  StatusFlags.Targetable,
  StatusFlags.Stunned,
  StatusFlags.Stunned | StatusFlags.Targetable,
  StatusFlags.Silenced | StatusFlags.Stealthed,
  StatusFlags.Taunted | StatusFlags.Ghosted | StatusFlags.Targetable,
  StatusFlags.Charmed | StatusFlags.Feared | StatusFlags.NearSighted,
];

describe('Stats.updateActionState', () => {
  it('names real flags, so the table below is not seven zeroes', () => {
    expect(new Set(FLAGS).size).toBe(FLAGS.length);
    expect(fresh(StatusFlags.Stunned)).not.toBe(fresh(StatusFlags.None));
  });

  it('gives the answer a fresh Stats gives, through any sequence of flags', () => {
    const stats = new Stats();
    const sequence = [0, 0, 2, 2, 3, 0, 4, 4, 4, 5, 1, 1, 6, 0, 0, 3, 3];
    for (const index of sequence) {
      const before = stats.actionState;
      stats.updateActionState(FLAGS[index]);
      expect(stats.actionState, `flag #${index}`).toBe(fresh(FLAGS[index], before));
    }
  });

  it('does not set a single bit again for the status it resolved last time', () => {
    const stats = new Stats();
    stats.updateActionState(StatusFlags.Stunned);
    const sets = vi.spyOn(stats, 'setActionState');

    for (let i = 0; i < 5; i++) stats.updateActionState(StatusFlags.Stunned);
    expect(sets).not.toHaveBeenCalled();

    // A different status is derived, in full.
    stats.updateActionState(StatusFlags.None);
    expect(sets.mock.calls.length).toBeGreaterThan(0);
    expect(stats.actionState).toBe(fresh(StatusFlags.None, fresh(StatusFlags.Stunned)));
  });

  it('puts right an action state somebody else wrote, on the very next call', () => {
    const stats = new Stats();
    stats.updateActionState(StatusFlags.Stunned);
    const resolved = stats.actionState;
    expect(resolved & ActionState.CAN_MOVE).toBe(0);

    // A pack's cleanse sets the bit by hand; a LAN client assigns the lot.
    stats.setActionState(ActionState.CAN_MOVE, true);
    stats.updateActionState(StatusFlags.Stunned);
    expect(stats.actionState).toBe(resolved);

    stats.actionState = 0;
    stats.updateActionState(StatusFlags.Stunned);
    expect(stats.actionState).toBe(fresh(StatusFlags.Stunned, 0));
  });
});
