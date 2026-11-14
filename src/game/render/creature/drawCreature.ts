import type { Chain } from './chain';
import type { LegRig } from './legRig';
import type { Spine } from './spine';
import type { ResolvedRig } from './creatureSpec';
import { cssColor } from '@/game/render/cssColor';

/**
 * The p5 half of a procedural creature, and the only file here that draws.
 *
 * Everything it needs has already been decided: `legRig.ts` worked out where
 * the joints are, `creatureSpec.ts` worked out how thick and what colour. This
 * strokes them and nothing else, which is what lets the map editor paint the
 * same rig with Canvas2D from the same numbers.
 *
 * **Locals are named for what they mean in the drawing**, never for the
 * quantity's generic word: `fill`, `stroke`, `line`, `image` and `color` are
 * all p5 globals in global mode, and a local that shadows one turns the call
 * that closes the block into a call on a number — at runtime, in the browser,
 * on a frame nobody is looking at.
 */

/** How much thinner the shin is than the thigh. */
const SHIN_TAPER = 0.72;

/** Foot dot diameter, in thicknesses. */
const FOOT_SIZE = 1.5;

/**
 * Legs, drawn under the body.
 *
 * Two strokes per leg rather than one three-point curve: the taper is what
 * makes a stick read as a limb, and a `curveVertex` chain cannot change weight
 * partway through.
 */
export function drawLegs(rig: LegRig, style: { thickness: number; color: number[] }, alpha = 255) {
  const [red, green, blue] = style.color;

  push();
  noFill();
  strokeCap(ROUND);
  stroke(red, green, blue, alpha);

  for (const leg of rig.legs) {
    const hip = rig.hipOf(leg);
    const knee = rig.kneeOf(leg);
    strokeWeight(style.thickness);
    line(hip.x, hip.y, knee.x, knee.y);
    strokeWeight(style.thickness * SHIN_TAPER);
    line(knee.x, knee.y, leg.footX, leg.footY);
  }

  noStroke();
  fill(red, green, blue, alpha);
  for (const leg of rig.legs) {
    circle(leg.footX, leg.footY, style.thickness * FOOT_SIZE);
  }
  pop();
}

/**
 * A chain drawn as one tapering ribbon: a whip, a tail, a length of leather.
 *
 * `drawChain` above strokes it segment by segment, which is right for a tether
 * and wrong for a whip. A stroke can only change weight *between* segments, so
 * every joint is a step in the taper with a round cap sitting on it — the
 * thing reads as a string of beads, and the joints are exactly what the eye
 * picks out. Reported that way: the segments show, and it does not look like
 * leather.
 *
 * So this builds the silhouette instead. Each joint contributes one point per
 * flank at its own half-width, and the width falls to **nothing** at the tip,
 * so the two flanks meet there in a point rather than a cap. The normal at a
 * joint is a central difference — the direction from the joint behind it to
 * the one ahead — because using each segment's own direction kinks the edge at
 * every vertex, which is the same bead problem one layer down.
 *
 * `curveVertex` then runs a Catmull-Rom through the ring, closed by repeating
 * a control point at each end, exactly as `drawSpineBody` does.
 */
export function drawWhip(
  chain: Chain,
  style: { thickness: number; color: number[]; glow?: number },
  alpha = 255
) {
  const joints = chain.joints;
  const last = joints.length - 1;
  if (last < 1) return;
  const [red, green, blue] = style.color;
  const glow = style.glow ?? 0;

  /** Nothing at the tip, `thickness` across at the root it is swung from. */
  const halfAt = (index: number) => (style.thickness * 0.5 * index) / last;

  const flankAt = (index: number, side: 1 | -1) => {
    const ahead = joints[Math.max(0, index - 1)];
    const behind = joints[Math.min(last, index + 1)];
    const runX = ahead.x - behind.x;
    const runY = ahead.y - behind.y;
    const run = Math.hypot(runX, runY) || 1;
    const half = halfAt(index) * side;
    return {
      x: joints[index].x + (-runY / run) * half,
      y: joints[index].y + (runX / run) * half,
    };
  };

  const ring: { x: number; y: number }[] = [];
  for (let i = 0; i <= last; i++) ring.push(flankAt(i, 1));
  for (let i = last; i >= 0; i--) ring.push(flankAt(i, -1));

  push();

  // A soft halo down the centreline, so a fast swing is still findable on a
  // dark map. Stroked rather than a second ring: it wants to be blurry, and a
  // wider outline would just be a second visible edge.
  if (glow > 0) {
    noFill();
    strokeCap(ROUND);
    stroke(red, green, blue, alpha * 0.18 * glow);
    for (let i = 1; i <= last; i++) {
      strokeWeight(halfAt(i) * 2 * (1 + glow * 1.8) + 2);
      line(joints[i - 1].x, joints[i - 1].y, joints[i].x, joints[i].y);
    }
  }

  fill(red, green, blue, alpha);
  // Darker than the fill and thin, the same rim `drawSpineBody` takes and for
  // the same reason: a bright even outline on a dark map reads as a polygon
  // somebody stroked, not as an edge.
  stroke(red * 0.4, green * 0.4, blue * 0.4, alpha);
  strokeWeight(1);
  beginShape();
  curveVertex(ring[ring.length - 1].x, ring[ring.length - 1].y);
  for (const point of ring) curveVertex(point.x, point.y);
  curveVertex(ring[0].x, ring[0].y);
  curveVertex(ring[1].x, ring[1].y);
  endShape(CLOSE);
  pop();
}

/**
 * A body drawn from code, for a creature that has no sprite.
 *
 * Deliberately not a flat disc: the halo and the lighter core are what stop it
 * reading as a debug circle, and they cost two more `circle` calls on a body
 * that has no image to load at all.
 */
export function drawOrbBody(
  x: number,
  y: number,
  radius: number,
  body: { color: number[]; glow: number },
  alpha = 255
) {
  const [red, green, blue] = body.color;

  push();
  noStroke();
  if (body.glow > 0) {
    fill(red, green, blue, alpha * 0.22 * body.glow);
    circle(x, y, radius * 2 * (1 + body.glow * 0.6));
  }
  fill(red, green, blue, alpha);
  circle(x, y, radius * 2);
  // A highlight up and left of centre, so the ball has a light source rather
  // than being a filled shape.
  fill(255, 255, 255, alpha * 0.18);
  circle(x - radius * 0.28, y - radius * 0.28, radius * 0.9);
  pop();
}

/**
 * A segmented body: one closed outline traced around the whole spine.
 *
 * Drawn as an outline rather than as its circles, and that is the difference
 * between a creature and a string of beads. Each vertebra contributes one point
 * per flank at its own half-width, the snout rounds the front off and the tail
 * comes to a point, and `curveVertex` runs a Catmull-Rom through the lot — so
 * the body reads as one skin over a skeleton, which is what it is.
 *
 * The ring is closed by repeating control points at both ends: a Catmull-Rom
 * segment needs a point either side of it, so without them the shape opens up
 * with a straight chord across the neck.
 */
export function drawSpineBody(
  spine: Spine,
  body: { color: number[]; glow: number },
  alpha = 255
) {
  const ring = spine.outline();
  if (ring.length < 3) return;
  const [red, green, blue] = body.color;

  // The raw 2D context, not p5: every champion carries one of these, and
  // `beginShape`/`curveVertex`/`endShape` allocate an array per vertex and
  // then walk them again to do what `traceClosedCurve` does in one pass.
  const ctx = drawingContext as CanvasRenderingContext2D;
  ctx.save();
  if (body.glow > 0) {
    // One fill per joint on purpose: the halos overlap and are translucent,
    // so a single path would lose the brighter spine the overlaps build.
    ctx.fillStyle = cssColor(red, green, blue, Math.round(alpha * 0.16 * body.glow));
    for (let i = 0; i < spine.joints.length; i++) {
      const joint = spine.joints[i];
      const radius = spine.widthAt(i) * (1 + body.glow * 0.7);
      // `ellipse` + `closePath`, the path p5's `circle` issues, not `arc`:
      // the two rasterise a few levels apart on a GPU canvas.
      ctx.beginPath();
      ctx.ellipse(joint.x, joint.y, radius, radius, 0, 0, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
    }
  }

  ctx.fillStyle = cssColor(red, green, blue, Math.round(alpha));
  // A rim **darker** than the fill, and thin.
  //
  // It was lighter, and on a map this dark a bright even outline reads as
  // exactly what it is — a polygon somebody stroked — rather than as an edge.
  // Darker is the shadow a body casts along its own silhouette, which is what
  // the eye expects and what stops the shape looking like a debug draw.
  ctx.strokeStyle = cssColor(
    Math.round(red * 0.45),
    Math.round(green * 0.45),
    Math.round(blue * 0.45),
    Math.round(alpha)
  );
  ctx.lineWidth = 1;
  traceClosedCurve(ctx, ring);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * A closed Catmull-Rom through `ring`, as one Canvas2D path.
 *
 * This is p5's own `curveVertex` conversion (tightness 0: each control point
 * a sixth of the chord between a point's neighbours), written out so that the
 * outline is the same outline to the pixel — including the one thing p5 does
 * that nobody would write on purpose: its closed curve ends with a straight
 * `lineTo` to the *second* point before closing. Kept, because dropping it
 * moves pixels at the neck and this change is meant to move none.
 */
export function traceClosedCurve(
  ctx: Pick<CanvasRenderingContext2D, 'beginPath' | 'moveTo' | 'bezierCurveTo' | 'lineTo' | 'closePath'>,
  ring: readonly { x: number; y: number }[]
): void {
  const n = ring.length;
  ctx.beginPath();
  ctx.moveTo(ring[0].x, ring[0].y);
  for (let k = 0; k < n; k++) {
    const before = ring[(k + n - 1) % n];
    const from = ring[k];
    const to = ring[(k + 1) % n];
    const after = ring[(k + 2) % n];
    ctx.bezierCurveTo(
      from.x + (to.x - before.x) / 6,
      from.y + (to.y - before.y) / 6,
      to.x + (from.x - after.x) / 6,
      to.y + (from.y - after.y) / 6,
      to.x,
      to.y
    );
  }
  ctx.lineTo(ring[1].x, ring[1].y);
  ctx.closePath();
}

/**
 * Whether this rig replaces the sprite, rather than being drawn under it.
 *
 * Only `orb` does. `orb` means "this creature has no art, draw it a body", so
 * standing in for the sprite is its whole job — while a **chain is additive**,
 * like the legs: it is a body the camp's own portrait sits on the head of.
 * Reported the other way round, as picking a segmented body silently hiding the
 * monster's avatar behind a default-coloured blob.
 */
export const hasOrbBody = (
  rig: ResolvedRig | undefined
): rig is ResolvedRig & { body: { kind: 'orb'; color: number[]; glow: number } } =>
  rig !== undefined && typeof rig.body === 'object' && rig.body.kind === 'orb';
