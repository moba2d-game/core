import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TouchControls,
  type TouchControlsHost,
  type TouchSpellView,
} from '../../../src/game/input/TouchControls';
import { stubGameGlobals } from '../fixtures';

/**
 * The pad is on screen for every frame of every match on a phone. Drawn
 * through p5 it measured 5-7ms a frame on a Helio P35 (36 draw operations,
 * each paying p5's argument normalising and style re-apply); the same picture
 * through the native context is what `drawPad` paints. This holds the pad off
 * p5 — a `circle()` creeping back into a button is the regression.
 */
const PHONE = { width: 844, height: 390 };

const spellView = (over: Partial<TouchSpellView> = {}): TouchSpellView => ({
  targeting: 'DIRECTION',
  activation: 'PRESS',
  range: 800,
  label: 'Q',
  icon: null,
  cooldownRatio: 0,
  onCooldown: false,
  remainingSeconds: 0,
  manaCost: 0,
  affordable: true,
  castable: true,
  charging: false,
  ...over,
});

function controlsShowing(view: TouchSpellView): TouchControls {
  const host: TouchControlsHost = {
    viewport: () => PHONE,
    slotCount: () => 7,
    // The spell row only: an empty item row and no recall button keep the
    // frame down to the joystick and the seven buttons under test.
    spellView: (_slot, row) => (row === 'item' ? null : view),
    recallView: () => null,
    recall: () => undefined,
    playerPosition: () => ({ x: 0, y: 0 }),
    playerFacing: () => ({ x: 1, y: 0 }),
    autoTargetWithin: () => null,
    pickUnitNear: () => null,
    steer: () => undefined,
    setSlotAim: () => undefined,
    beginSlot: () => undefined,
    commitSlot: () => undefined,
    cancelSlot: () => undefined,
    withWorldTransform: draw => draw(),
  };
  return new TouchControls(host, true);
}

let spies: Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => {
  spies = stubGameGlobals();
  for (const name of ['noTint']) vi.stubGlobal(name, vi.fn());
  for (const name of ['CENTER', 'PIE', 'HALF_PI']) vi.stubGlobal(name, name);
});
afterEach(() => vi.unstubAllGlobals());

describe('the touch pad paints through the native context', () => {
  it('draws the joystick and every button without a single p5 shape call', () => {
    controlsShowing(spellView()).draw();

    for (const name of ['push', 'fill', 'stroke', 'circle', 'arc', 'text', 'image']) {
      expect(spies[name], `p5 ${name}()`).not.toHaveBeenCalled();
    }
    const ctx = drawingContext;
    // Joystick: ring, plate, knob. Each of seven buttons: backing and rim.
    expect(vi.mocked(ctx.arc).mock.calls.length).toBe(3 + 7 * 2);
    // One label per icon-less button, and one save/restore around the lot.
    expect(vi.mocked(ctx.fillText).mock.calls.map(call => call[0])).toEqual(Array(7).fill('Q'));
    expect(ctx.save).toHaveBeenCalledTimes(1);
    expect(ctx.restore).toHaveBeenCalledTimes(1);
  });

  it('keeps the lockout picture: dim, wedge, seconds and the mana badge', () => {
    controlsShowing(
      spellView({ onCooldown: true, cooldownRatio: 0.25, remainingSeconds: 3, manaCost: 40 })
    ).draw();

    const ctx = drawingContext;
    const texts = vi.mocked(ctx.fillText).mock.calls.map(call => call[0]);
    expect(texts.filter(t => t === '3')).toHaveLength(7);
    expect(texts.filter(t => t === '40')).toHaveLength(7);
    // The wedge is a quarter turn from twelve o'clock, closed through the centre.
    const wedges = vi
      .mocked(ctx.arc)
      .mock.calls.filter(call => Math.abs((call[3] as number) + Math.PI / 2) < 1e-9);
    expect(wedges).toHaveLength(7);
    expect((wedges[0][4] as number) - (wedges[0][3] as number)).toBeCloseTo(Math.PI / 2, 9);
    expect(ctx.closePath).toHaveBeenCalledTimes(7);
    expect(spies.arc).not.toHaveBeenCalled();
  });
});
