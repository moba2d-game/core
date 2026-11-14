/**
 * The second pass of draws moved off p5, and what each may give up per tier.
 *
 * Two promises, and every case here is one or the other:
 *
 *  - **Tier 0 is the same picture.** One canvas paint a shape, in the order
 *    p5 issued them, with the path p5 emits (`ellipse` + `closePath` for a
 *    circle, never `arc`). Counted here; pixel-diffed on a phone.
 *  - **Sharing a path waits for the tier.** Several shapes in one fill is
 *    cheaper and is not the same antialiasing on a phone's GPU canvas
 *    (`docs/TRAPS.md`, rendering), so it happens at `stressTier` 1 and up and
 *    never before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AttackableUnit from '../../../src/game/gameObject/attackableUnits/AttackableUnit';
import AoePulse from '../../../src/game/gameObject/spellObjects/AoePulse';
import Root from '../../../src/game/gameObject/buffs/Root';
import Speedup, { SPEEDUP_BATCHED_STREAK_ALPHA } from '../../../src/game/gameObject/buffs/Speedup';
import { Spine } from '@/game/render/creature/spine';
import { drawSpineBody } from '@/game/render/creature/drawCreature';
import { cssColor, p5Rgba } from '@/game/render/cssColor';
import { createGame, stubGameGlobals, type TestGame } from '../fixtures';

const context = () => drawingContext as unknown as Record<string, ReturnType<typeof vi.fn>>;
const p5Call = (name: string) => (globalThis as any)[name] as ReturnType<typeof vi.fn>;

let game: TestGame;

const atTier = (tier: 0 | 1 | 2) => {
  const g = game as any;
  g.renderQuality = tier === 0 ? 'high' : tier === 2 ? 'low' : 'auto';
  g.renderStressed = tier === 1;
  g.deeplyStressed = false;
};

const unitAt = (x: number, y: number) =>
  new AttackableUnit({ game, position: createVector(x, y), teamId: 'team-blue' });

beforeEach(() => {
  stubGameGlobals();
  game = createGame();
});
afterEach(() => vi.unstubAllGlobals());

describe('p5Rgba', () => {
  it('is the string p5 hands the context: rounded channels, unrounded alpha', () => {
    expect(p5Rgba(120.4, 220.6, 255, 100)).toBe(`rgba(120,221,255,${100 / 255})`);
    expect(p5Rgba(1, 2, 3, 300)).toBe('rgba(1,2,3,1)');
    expect(p5Rgba(1, 2, 3, -5)).toBe('rgba(1,2,3,0)');
  });
});

describe('the facing tick', () => {
  it('is one two-point path on the context, not five p5 calls', () => {
    const unit = unitAt(100, 100);
    (game as any).worldMouse = createVector(400, 100);
    const size = unit.animatedValues.displaySize;
    unit.drawDir();

    expect(p5Call('line')).not.toHaveBeenCalled();
    expect(p5Call('push')).not.toHaveBeenCalled();
    expect(context().moveTo).toHaveBeenCalledWith(100, 100);
    // `setMag(size / 2 + 2)` toward the mouse
    expect(context().lineTo).toHaveBeenCalledWith(100 + size / 2 + 2, 100);
    expect(context().stroke).toHaveBeenCalledTimes(1);
    expect(context().save).toHaveBeenCalledTimes(context().restore.mock.calls.length);
  });

  it('draws nothing for a dead unit', () => {
    const unit = unitAt(100, 100);
    (game as any).worldMouse = createVector(400, 100);
    vi.spyOn(unit, 'isDead', 'get').mockReturnValue(true);
    unit.drawDir();
    expect(context().stroke).not.toHaveBeenCalled();
  });
});

describe('the root ring', () => {
  it('is the path p5\'s circle emits, on the context', () => {
    const unit = unitAt(50, 60);
    const root = new Root(1000, unit, unit);
    root.draw();

    expect(p5Call('circle')).not.toHaveBeenCalled();
    expect(context().ellipse).toHaveBeenCalledTimes(1);
    expect(context().ellipse.mock.calls[0].slice(0, 2)).toEqual([50, 60]);
    expect(context().closePath).toHaveBeenCalledTimes(1);
    expect(context().arc).not.toHaveBeenCalled();
    expect(context().stroke).toHaveBeenCalledTimes(1);
    expect(context().fill).not.toHaveBeenCalled();
  });
});

describe('the speed streaks', () => {
  const streaking = () => {
    const unit = unitAt(0, 0);
    const buff = new Speedup(1000, unit, unit);
    for (let i = 0; i < 6; i++) {
      buff.particleSystem.addParticle({ x: i * 10, y: 0, vx: 1, vy: 0, age: i * 5 });
    }
    return buff;
  };

  it('keeps a stroke a streak, each with its own fade, at full quality', () => {
    atTier(0);
    const styles: string[] = [];
    const ctx = context();
    ctx.stroke.mockImplementation(() => styles.push((drawingContext as any).strokeStyle));
    streaking().particleSystem.draw();

    expect(p5Call('line')).not.toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalledTimes(6);
    expect(ctx.beginPath).toHaveBeenCalledTimes(6);
    // p5's own colour string, fade included: newest opaque, each older fainter
    expect(styles[0]).toBe('rgba(255,255,255,1)');
    expect(new Set(styles).size).toBe(6);
  });

  it('strokes them all at once when the machine is behind', () => {
    for (const tier of [1, 2] as const) {
      atTier(tier);
      const ctx = context();
      ctx.stroke.mockClear();
      ctx.beginPath.mockClear();
      ctx.moveTo.mockClear();
      streaking().particleSystem.draw();

      expect(ctx.moveTo).toHaveBeenCalledTimes(6);
      expect(ctx.beginPath).toHaveBeenCalledTimes(1);
      expect(ctx.stroke).toHaveBeenCalledTimes(1);
      expect((drawingContext as any).strokeStyle).toBe(
        cssColor(255, 255, 255, SPEEDUP_BATCHED_STREAK_ALPHA)
      );
    }
  });
});

describe('AoePulse on the context', () => {
  const pulse = (style: AoePulse['style']) => {
    const made = new AoePulse(unitAt(200, 200));
    made.style = style;
    made.age = made.lifeTime * 0.4;
    made.spokes = 10;
    made.rings = 2;
    return made;
  };

  it('paints a splash as p5 did at full quality: a fill a droplet', () => {
    atTier(0);
    pulse('splash').draw();

    expect(p5Call('circle')).not.toHaveBeenCalled();
    expect(p5Call('fill')).not.toHaveBeenCalled();
    expect(context().translate).toHaveBeenCalledWith(200, 200);
    // the disc, ten droplets, the puddle — then the rim
    expect(context().fill).toHaveBeenCalledTimes(12);
    expect(context().stroke).toHaveBeenCalledTimes(1);
    expect(context().ellipse).toHaveBeenCalledTimes(13);
    expect(context().closePath).toHaveBeenCalledTimes(13);
    expect(context().arc).not.toHaveBeenCalled();
  });

  it('gives the droplets one fill between them once the machine is behind', () => {
    for (const tier of [1, 2] as const) {
      atTier(tier);
      for (const spy of Object.values(context())) if (typeof spy === 'function') spy.mockClear();
      pulse('splash').draw();
      expect(context().ellipse).toHaveBeenCalledTimes(13);
      expect(context().fill).toHaveBeenCalledTimes(3);
      expect(context().stroke).toHaveBeenCalledTimes(1);
    }
  });

  it('strokes a crater crack by crack at full quality, and as one path when behind', () => {
    atTier(0);
    pulse('crater').draw();
    expect(p5Call('line')).not.toHaveBeenCalled();
    expect(context().stroke).toHaveBeenCalledTimes(11); // the rim and ten cracks
    expect(context().fill).toHaveBeenCalledTimes(1);

    atTier(1);
    context().stroke.mockClear();
    context().lineTo.mockClear();
    pulse('crater').draw();
    expect(context().lineTo).toHaveBeenCalledTimes(10);
    expect(context().stroke).toHaveBeenCalledTimes(2);
  });

  it('keeps a stroke a ring on every tier: each has its own weight', () => {
    for (const tier of [0, 2] as const) {
      atTier(tier);
      context().stroke.mockClear();
      pulse('ring').draw();
      expect(p5Call('circle')).not.toHaveBeenCalled();
      expect(context().stroke).toHaveBeenCalledTimes(2);
    }
  });

  it('leaves the styles it has not ported on p5', () => {
    pulse('shards').draw();
    expect(p5Call('triangle')).toHaveBeenCalledTimes(10);
    expect(context().fill).not.toHaveBeenCalled();
  });
});

describe('the spine halo', () => {
  const spine = () => new Spine({ widths: [10, 12, 9, 5], spacing: 14 } as never);
  const body = { color: [80, 200, 220], glow: 1 };

  it('is a fill a vertebra at full quality', () => {
    const s = spine();
    drawSpineBody(s, body, 255, 0);
    expect(context().fill).toHaveBeenCalledTimes(s.joints.length + 1);
    expect(context().stroke).toHaveBeenCalledTimes(1);
  });

  it('is one fill for every vertebra when the machine is behind', () => {
    const s = spine();
    drawSpineBody(s, body, 255, 1);
    expect(context().ellipse).toHaveBeenCalledTimes(s.joints.length);
    expect(context().fill).toHaveBeenCalledTimes(2);
    expect(context().stroke).toHaveBeenCalledTimes(1);
  });

  it('is gone when the machine is drowning, and the body is not', () => {
    drawSpineBody(spine(), body, 255, 2);
    expect(context().ellipse).not.toHaveBeenCalled();
    expect(context().fill).toHaveBeenCalledTimes(1);
    expect(context().stroke).toHaveBeenCalledTimes(1);
  });
});
