/**
 * The shop panel's "you can trade here" must agree with `ItemShop.refusalFor`,
 * which lets a dead champion buy from anywhere. It once asked only whether the
 * champion stood at its fountain, so a dead player far from home saw "Chỉ mua
 * bán được khi ở trong tầm mua đồ…" over a purchase the shop would have made.
 */
import { describe, expect, it } from 'vitest';
import { createHudInteractions } from '../../../src/game/hud/hudInteractions';

const gameWith = (isDead: boolean): any => ({
  player: { isDead, teamId: 'team-blue', position: { x: 5_000, y: 5_000 } },
  fountains: [{ teamId: 'team-blue', position: { x: 0, y: 0 }, radius: 300 }],
});

describe('HudInteractions.shopCanTrade', () => {
  it('refuses a living champion away from its fountain', () => {
    expect(createHudInteractions(gameWith(false)).shopCanTrade()).toBe(false);
  });

  it('lets a dead champion trade from anywhere, as the shop itself does', () => {
    expect(createHudInteractions(gameWith(true)).shopCanTrade()).toBe(true);
  });
});
