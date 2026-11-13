/**
 * Map terrain that comes and goes mid-match (`NavGrid.setBlocker`). Reported
 * on a pack's collapsing-bridge map: the grid was built once, so bots kept
 * routing over a fallen bridge, were shoved back to the bank, and walked in
 * again for the whole collapse. These hold the three halves of the fix — the
 * field changes and changes back exactly, a match's blocker never reaches the
 * cached grid the next match gets, and a unit already walking re-plans.
 */
import { describe, expect, it } from 'vitest';
import NavigationSystem from '../../../src/game/nav/NavigationSystem';
import PathAgent, { type PathAgentHost } from '../../../src/game/nav/PathAgent';
import { clearNavigationCacheForTests } from '../../../src/game/nav/NavigationSystem';

const SIZE = 2_000;
const RADIUS = 27.5;
const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
/** A channel down x 950..1050 with two crossings: middle (y 900..1100) and south (1600..1800). */
const WALLS = [rect(950, 0, 1050, 900), rect(950, 1100, 1050, 1600), rect(950, 1800, 1050, SIZE)];
const MIDDLE = { x0: 950, y0: 900, x1: 1050, y1: 1100 };

class Host implements PathAgentHost {
  position: { x: number; y: number };
  destination: { x: number; y: number; set(x: number, y: number): unknown };
  terrainRadius = RADIUS;
  moveSpeed = 4;
  constructor(x: number, y: number) {
    this.position = { x, y };
    this.destination = {
      x,
      y,
      set(nx: number, ny: number) {
        this.x = nx;
        this.y = ny;
        return this;
      },
    };
  }
  step(): void {
    const dx = this.destination.x - this.position.x;
    const dy = this.destination.y - this.position.y;
    const d = Math.hypot(dx, dy);
    if (d <= this.moveSpeed) {
      this.position.x = this.destination.x;
      this.position.y = this.destination.y;
      return;
    }
    this.position.x += (dx / d) * this.moveSpeed;
    this.position.y += (dy / d) * this.moveSpeed;
  }
}

const inMiddle = (p: { x: number; y: number }) =>
  p.x + RADIUS > MIDDLE.x0 && p.x - RADIUS < MIDDLE.x1 && p.y + RADIUS > MIDDLE.y0 && p.y - RADIUS < MIDDLE.y1;

describe('NavGrid.setBlocker', () => {
  it('closes a crossing to every line through it, and reopens it to the exact field', () => {
    const nav = new NavigationSystem(WALLS, SIZE);
    const before = nav.grid.clearance.slice();
    expect(nav.isLineClear(500, 1000, 1500, 1000, RADIUS)).toBe(true);

    expect(nav.setBlocker('bridge', MIDDLE)).toBe(true);
    expect(nav.isLineClear(500, 1000, 1500, 1000, RADIUS)).toBe(false);
    expect(nav.grid.isWalkable(1000, 1000, RADIUS)).toBe(false);
    // the other crossing is untouched
    expect(nav.isLineClear(500, 1700, 1500, 1700, RADIUS)).toBe(true);
    // re-setting the same rectangle is not a change
    expect(nav.setBlocker('bridge', { ...MIDDLE })).toBe(false);

    expect(nav.setBlocker('bridge', null)).toBe(true);
    expect(nav.isLineClear(500, 1000, 1500, 1000, RADIUS)).toBe(true);
    expect(Array.from(nav.grid.clearance)).toEqual(Array.from(before));
  });

  it("one match's blocker never reaches the cached grid the next match is given", () => {
    clearNavigationCacheForTests();
    const first = new NavigationSystem(WALLS, SIZE, undefined, 'blocker-map');
    first.setBlocker('bridge', MIDDLE);
    const next = new NavigationSystem(WALLS, SIZE, undefined, 'blocker-map');
    expect(next.isLineClear(500, 1000, 1500, 1000, RADIUS)).toBe(true);
    expect(first.isLineClear(500, 1000, 1500, 1000, RADIUS)).toBe(false);
    clearNavigationCacheForTests();
  });

  it('a unit already walking across re-plans the moment the crossing closes, and never steps on it', () => {
    const nav = new NavigationSystem(WALLS, SIZE);
    const host = new Host(500, 1000);
    const agent = new PathAgent(host, nav);
    agent.order(1500, 1000);
    nav.update();
    expect(agent.state).toBe('DIRECT');

    for (let i = 0; i < 40; i++) {
      agent.update(16);
      nav.update();
      host.step();
    }
    nav.setBlocker('bridge', MIDDLE);

    let touched = 0;
    let frames = 0;
    while (frames++ < 3_000 && Math.hypot(host.position.x - 1500, host.position.y - 1000) > 8) {
      agent.update(16);
      nav.update();
      host.step();
      if (inMiddle(host.position)) touched++;
    }
    expect(touched).toBe(0);
    expect(Math.hypot(host.position.x - 1500, host.position.y - 1000)).toBeLessThanOrEqual(8);
  });

  it('a unit that gave up goes the moment a crossing reopens', () => {
    const nav = new NavigationSystem(
      [rect(950, 0, 1050, 900), rect(950, 1100, 1050, SIZE)],
      SIZE
    );
    nav.setBlocker('bridge', MIDDLE);
    const host = new Host(500, 1000);
    const agent = new PathAgent(host, nav);
    agent.order(1500, 1000);
    for (let i = 0; i < 600; i++) {
      agent.update(16);
      nav.update();
      host.step();
    }
    expect(host.position.x).toBeLessThan(950);

    nav.setBlocker('bridge', null);
    for (let i = 0; i < 600; i++) {
      agent.update(16);
      nav.update();
      host.step();
    }
    expect(Math.hypot(host.position.x - 1500, host.position.y - 1000)).toBeLessThanOrEqual(8);
  });
});
