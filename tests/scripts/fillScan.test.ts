import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs tool, deliberately not part of the TS build.
import { RULES, scanSource } from '../../scripts/fill-scan.mjs';

/**
 * The scanner, held to the bug it was written from and to every wrong number it
 * produced on the way there.
 *
 * `scripts/fill-scan.mjs` exists because a phone dropped to 15fps in a fight
 * that held 60 on a desktop, and every instrument here said the game was fine —
 * correctly, because they all measure calls and a phone pays per *pixel it
 * blends*. One champion's poison trail was blending 1.34x the whole phone
 * screen every frame, half of it overdraw.
 *
 * The `stays quiet` cases below are the important half. Each one is a real
 * number this scan reported before it was tuned — a negative radius, a 35px
 * disc read as 833, a fade read as 5.56x — and a report whose top row is
 * fiction discredits every true row under it.
 */
const ids = (source: string): string[] =>
  scanSource(source).map((finding: { rule: string }) => finding.rule);

const note = (source: string): string =>
  scanSource(source)
    .map((finding: { note: string }) => finding.note)
    .join(' | ');

describe('fill-scan', () => {
  it('names every rule it ships, so a report can be read without the source', () => {
    expect(RULES.map((rule: { id: string }) => rule.id)).toEqual([
      'fill-inside-fill',
      'large-fill',
      'effect-over-budget',
    ]);
    for (const rule of RULES) expect(rule.why.length).toBeGreaterThan(80);
  });

  describe('fill-inside-fill', () => {
    // The poison cloud: a body disc, and four more discs painted inside it that
    // cannot reach past its edge.
    const offender = `
      export const R = 90;
      class Cloud {
        radius = R;
        draw() {
          push();
          noStroke();
          fill(148, 100, 205, 44);
          circle(0, 0, this.radius * 2);
          for (let i = 0; i < 4; i++) {
            fill(175, 125, 225, 58);
            circle(cos(i) * this.radius * 0.26, sin(i) * this.radius * 0.26, this.radius);
          }
          pop();
        }
      }
    `;

    it('fires on a fill that cannot escape the fill beneath it', () => {
      expect(ids(offender)).toContain('fill-inside-fill');
      expect(note(offender)).toContain('blended twice for nothing');
    });

    it('stays quiet once the inner shapes are strokes instead', () => {
      const fixed = offender.replace(
        `for (let i = 0; i < 4; i++) {
            fill(175, 125, 225, 58);
            circle(cos(i) * this.radius * 0.26, sin(i) * this.radius * 0.26, this.radius);
          }`,
        `noFill();
          stroke(185, 140, 235, 70);
          for (let i = 0; i < 3; i++) arc(0, 0, this.radius, this.radius, i, i + 1.7);`
      );
      expect(ids(fixed)).not.toContain('fill-inside-fill');
    });

    it('stays quiet when the inner shape reaches past the outer one', () => {
      const reaching = offender.replace('this.radius * 0.26,', 'this.radius * 1.4,');
      expect(ids(reaching)).not.toContain('fill-inside-fill');
    });
  });

  describe('what it must not miscount', () => {
    const around = (body: string) => `
      export const R = 100;
      class Fx {
        radius = R;
        draw() { ${body} }
      }
    `;

    it('honours pop(), which restores the fill p5 had before the push', () => {
      // Ignoring the stack left this believing a fill was still on for the rest
      // of a method and costing stroked decoration as though it were solid.
      const stroked = around(`
        push();
        fill(1, 2, 3);
        circle(0, 0, 10);
        pop();
        circle(0, 0, this.radius * 6);
      `);
      expect(note(stroked)).not.toContain('r=300');
    });

    it('costs an arc by its sweep, not as a whole ellipse', () => {
      // Same ellipse both ways: a quarter of it is under the per-shape budget
      // and the whole of it is well over.
      const quarter = around(`
        fill(1, 2, 3);
        arc(0, 0, this.radius * 4, this.radius * 4, 0, 1.57);
      `);
      const whole = around(`
        fill(1, 2, 3);
        circle(0, 0, this.radius * 4);
      `);
      expect(ids(quarter)).toEqual([]);
      expect(ids(whole)).toContain('large-fill');
    });

    it('takes the largest value of a subtraction, not the smallest', () => {
      // `max(a) - max(b)` is not the largest value of `a - b`. It produced
      // seven negative radii on the first real run, and — worse — it *hid* the
      // shapes it inverted: a size that comes out negative is skipped, so the
      // wrong arithmetic reported a 200px disc as nothing at all.
      const shrinking = around(`
        const t = constrain(this.age / 500, 0, 1);
        fill(1, 2, 3);
        circle(0, 0, 800 - t * 1600);
      `);
      expect(ids(shrinking)).toContain('large-fill');
      expect(note(shrinking)).toContain('r=400');
      expect(note(shrinking)).not.toMatch(/r=-/);
    });

    it('resolves a field from its own class, not from another in the file', () => {
      // Two classes, same field name. Reading whichever came first turned a
      // 46px disc into an 833px one — six screens of fill that do not exist.
      // `Missile` inherits its size from a base class in another file, so this
      // scan cannot see it — and *unknown* is the right answer. Borrowing the
      // other class's field instead turned a 46px disc into an 833px one.
      const twoClasses = `
        class Aura { size = 2000; draw() { noFill(); circle(0, 0, this.size); } }
        class Missile extends MissileSpellObject {
          draw() { fill(1, 2, 3); circle(0, 0, this.size * 1.5); }
        }
      `;
      expect(ids(twoClasses)).toEqual([]);
    });

    it('resolves a local by lexical scope, not by a file-wide table', () => {
      // Draw methods are full of short names. A flat map resolved one method's
      // `const d` to another's.
      const shadowed = `
        class Fx {
          size = 46;
          other() { const d = 4000; return d; }
          draw() {
            const d = this.size;
            fill(1, 2, 3);
            circle(0, 0, d * 1.5);
          }
        }
      `;
      expect(ids(shadowed)).toEqual([]);
    });

    it('reads the guard on an ease instead of ignoring it', () => {
      // `t > 0.82 ? 1 - (t - 0.82) / 0.18 : 1` never leaves 0..1, but an
      // interval that ignores the condition reads it as 5.56 and multiplies a
      // 100px radius into a 556px one.
      const eased = around(`
        const t = constrain(this.age / 500, 0, 1);
        const shut = t > 0.82 ? 1 - (t - 0.82) / 0.18 : 1;
        fill(1, 2, 3);
        circle(0, 0, this.radius * shut);
      `);
      expect(note(eased)).not.toMatch(/r=(2|3|4|5)\d\d/);
    });

    it('answers unknown for a call it cannot read, rather than guessing', () => {
      // "the span of its arguments" looked conservative and was the opposite:
      // it read a 6px head as r=2104.
      const opaque = around(`
        const power = someUnknownHelper(this.age / 500, 0, 1);
        fill(1, 2, 3);
        circle(0, 0, 8 + power * 6);
      `);
      expect(ids(opaque)).toEqual([]);
    });
  });
});
