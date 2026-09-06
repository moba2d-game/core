/**
 * The death shortcut's arming rule: the auto "Đầu trận" anchor must never be
 * one press away from a death — a newcomer with twenty minutes of progress
 * would learn the feature by losing it. Only a save the player made on
 * purpose arms the instant rewind; otherwise the press opens the shelf.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHudInteractions } from '../../../src/game/hud/hudInteractions';
import { restoreCheckpoint } from '../../../src/game/checkpoint/Checkpoint';

vi.mock('@/game/checkpoint/Checkpoint', async importOriginal => ({
  ...(await importOriginal<object>()),
  restoreCheckpoint: vi.fn(() => true),
}));

const makeGame = (checkpoints: { id: string; auto: boolean }[], net: unknown = null) =>
  ({
    player: { spells: [] },
    pause: vi.fn(),
    unpause: vi.fn(),
    net,
    checkpoints,
  }) as never;

describe('retryFromCheckpoint', () => {
  beforeEach(() => vi.mocked(restoreCheckpoint).mockClear());

  it('with no deliberate save, opens the shelf and rewinds nothing', () => {
    const hud = createHudInteractions(makeGame([{ id: 'anchor', auto: true }]));
    hud.retryFromCheckpoint();
    expect(hud.showCheckpoints).toBe(true);
    expect(restoreCheckpoint).not.toHaveBeenCalled();
  });

  it('with deliberate saves, rewinds straight to the newest of them', () => {
    const saves = [
      { id: 'm2', auto: false },
      { id: 'm1', auto: false },
      { id: 'anchor', auto: true },
    ];
    const hud = createHudInteractions(makeGame(saves));
    hud.retryFromCheckpoint();
    expect(hud.showCheckpoints).toBe(false);
    expect(restoreCheckpoint).toHaveBeenCalledOnce();
    expect(vi.mocked(restoreCheckpoint).mock.calls[0][1]).toBe(saves[0]);
  });

  it('refuses wholesale in a LAN match', () => {
    const hud = createHudInteractions(makeGame([{ id: 'm1', auto: false }], {}));
    hud.retryFromCheckpoint();
    expect(hud.showCheckpoints).toBe(false);
    expect(restoreCheckpoint).not.toHaveBeenCalled();
  });
});
