/**
 * "sao ko thấy con trỏ khi click di chuyển": the move click's mark was a green
 * dot that lost 10% of its size every sim tick — under 5 px after a third of a
 * second. It is a ring on the match clock now.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOVE_MARKER_MS, moveMarkerPose } from '../../../src/game/render/moveMarker';

describe('the move marker', () => {
  const marker = { x: 100, y: 200, atMs: 10_000 };

  it('is still plainly visible 0.4 s after the click', () => {
    const pose = moveMarkerPose(marker, 10_400);
    expect(pose).not.toBeNull();
    expect(pose!.radius).toBeGreaterThan(15);
    expect(pose!.alpha).toBeGreaterThan(0.3);
  });

  it('is gone once its time is up, and absent before the click', () => {
    expect(moveMarkerPose(marker, 10_000 + MOVE_MARKER_MS)).toBeNull();
    expect(moveMarkerPose(marker, 9_999)).toBeNull();
    expect(moveMarkerPose(null, 10_000)).toBeNull();
  });

  it('Game times it on the match clock, not by shrinking it per tick', () => {
    const src = readFileSync(join(__dirname, '../../../src/game/Game.ts'), 'utf8').replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      ''
    );
    expect(src).not.toMatch(/clickedPoint/);
    expect(src).toMatch(/moveMarkerPose\(this\.moveMarker, this\.matchTimeMs\)/);
  });

  it("is painted after the world objects, so a pack's floor art cannot cover it", () => {
    // Mặt Băng paints its ice with a ground object; drawn before it, the ring was invisible.
    const src = readFileSync(join(__dirname, '../../../src/game/Game.ts'), 'utf8');
    const body = src.slice(src.indexOf('this.camera.makeDraw(() => {'));
    expect(body.indexOf('drawMoveMarker(')).toBeGreaterThan(body.indexOf('this.objectManager.draw(alpha);'));
  });
});
