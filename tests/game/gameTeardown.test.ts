/**
 * `Game.destroy()` does not remove objects one by one, so `onRemoved` never
 * runs at a restart or an exit. A pack's DOM end card stayed over the next
 * match and ate every click ("Trận mới" restarted forever). `onMatchTeardown`
 * is the hook that reaches them; this proves destroy calls it — for live and
 * pending objects, past a throwing one, and with the rest of teardown intact.
 */
import { describe, expect, it, vi } from 'vitest';
import Game from '../../src/game/Game';

const stub = (objects: unknown[], pending: unknown[] = []) => {
  const torn = { fog: false, minimap: false, hud: false };
  return {
    torn,
    game: {
      objectManager: { objects, _objectToBeAdd: pending },
      fogOfWar: { destroy: () => (torn.fog = true) },
      minimap: { destroy: () => (torn.minimap = true) },
      inGameHUD: { destroy: () => (torn.hud = true) },
    },
  };
};

describe('Game.destroy() tears down every object', () => {
  it('calls onMatchTeardown on live and pending objects', () => {
    const live = { onMatchTeardown: vi.fn() };
    const pending = { onMatchTeardown: vi.fn() };
    const { game } = stub([live], [pending]);
    Game.prototype.destroy.call(game);
    expect(live.onMatchTeardown).toHaveBeenCalledOnce();
    expect(pending.onMatchTeardown).toHaveBeenCalledOnce();
  });

  it('one throwing object does not stop the others, or the rest of teardown', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = {
      onMatchTeardown: () => {
        throw new Error('boom');
      },
    };
    const after = { onMatchTeardown: vi.fn() };
    const { game, torn } = stub([bad, after]);
    Game.prototype.destroy.call(game);
    expect(after.onMatchTeardown).toHaveBeenCalledOnce();
    expect(torn).toEqual({ fog: true, minimap: true, hud: true });
    errors.mockRestore();
  });
});
