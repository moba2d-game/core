/**
 * Bodies drawn on the raw 2D context instead of through p5.
 *
 * The point of both is the same pixels for less JavaScript, so what is pinned
 * is the PATH: p5's own, down to the redundant vertices nobody would write on
 * purpose. Each one dropped moved the outline's antialiasing on a phone's GPU
 * canvas (measured: up to 37 levels on the tower's octagon).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Turret from '../../../src/game/gameObject/structures/Turret';
import TeamId from '../../../src/game/enums/TeamId';
import { Spine } from '@/game/render/creature/spine';
import { drawSpineBody, traceClosedCurve } from '@/game/render/creature/drawCreature';
import { createGame, stubGameGlobals } from '../fixtures';

const context = () => drawingContext as unknown as Record<string, ReturnType<typeof vi.fn>>;
const p5Call = (name: string) => (globalThis as any)[name] as ReturnType<typeof vi.fn>;

describe('raw-context drawing', () => {
  beforeEach(() => stubGameGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('traces p5\'s closed curveVertex ring, quirk included', () => {
    const ring = [
      { x: 0, y: 0 },
      { x: 12, y: 0 },
      { x: 12, y: 6 },
      { x: 0, y: 6 },
    ];
    const calls: string[] = [];
    const ctx = {
      beginPath: () => calls.push('begin'),
      moveTo: (x: number, y: number) => calls.push(`M${x},${y}`),
      bezierCurveTo: (...v: number[]) => calls.push(`C${v.join(',')}`),
      lineTo: (x: number, y: number) => calls.push(`L${x},${y}`),
      closePath: () => calls.push('close'),
    };
    traceClosedCurve(ctx, ring);
    expect(calls).toEqual([
      'begin',
      'M0,0',
      // control points a sixth of the chord between each point's neighbours
      'C2,-1,10,-1,12,0',
      'C14,1,14,5,12,6',
      'C10,7,2,7,0,6',
      'C-2,5,-2,1,0,0',
      // p5 walks on to the SECOND point before it closes
      'L12,0',
      'close',
    ]);
  });

  it('draws a spine body without p5\'s shape builder: one fill a halo, one outline', () => {
    const spine = new Spine({ widths: [10, 12, 9, 5], spacing: 14 } as never);
    drawSpineBody(spine, { color: [80, 200, 220], glow: 1 }, 255);
    expect(p5Call('beginShape')).not.toHaveBeenCalled();
    expect(p5Call('curveVertex')).not.toHaveBeenCalled();
    expect(context().fill).toHaveBeenCalledTimes(spine.joints.length + 1);
    expect(context().stroke).toHaveBeenCalledTimes(1);
    // circles as p5 issues them — `ellipse` + `closePath`, never `arc`
    expect(context().ellipse).toHaveBeenCalledTimes(spine.joints.length);
    expect(context().arc).not.toHaveBeenCalled();
  });

  it('draws a standing tower as p5 did, on the context', () => {
    const game = createGame();
    const turret = new Turret({ game, position: createVector(300, 300), teamId: TeamId.BLUE });
    (turret as any).drawHealthBar = () => {};
    (turret as any)._spin = 0.7;
    turret.draw();

    expect(p5Call('beginShape')).not.toHaveBeenCalled();
    expect(p5Call('circle')).not.toHaveBeenCalled();
    // the spin is the context's transform, not folded into the vertices
    expect(context().translate).toHaveBeenCalledWith(300, 300);
    expect(context().rotate).toHaveBeenCalledWith(0.7);
    // 7 edges + p5's two redundant returns to the first vertex + the barrel
    expect(context().lineTo).toHaveBeenCalledTimes(10);
    const size = turret.stats.size.value;
    const returns = context().lineTo.mock.calls.filter(([x, y]) => x === size * 0.34 && y === 0);
    expect(returns).toHaveLength(2);
    expect(context().arc).not.toHaveBeenCalled();
  });
});
