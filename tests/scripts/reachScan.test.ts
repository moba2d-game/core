import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs tool, deliberately not part of the TS build.
import { RULES, scanSource } from '../../scripts/reach-scan.mjs';

/**
 * The scanner, held to the two bugs it was written from.
 *
 * `scripts/reach-scan.mjs` exists because two abilities shipped for weeks with
 * a picture that did not match their hitbox, and both were found by a player
 * rather than by anything in this repository — a test asserts on damage, and
 * nobody asserts on pixels.
 *
 * Every rule is proven twice here: it fires on a fixture that **is** the
 * mistake, and it stays quiet on the nearest thing that is not. The second half
 * is the one that matters. A reach scan that cries at correct code is a reach
 * scan somebody switches off, and each `stays quiet` case below is a shape that
 * made the first working version report something false — every one of them was
 * found by running it over the real packs and reading all 143 findings.
 */
const ids = (source: string): string[] =>
  scanSource(source).map((finding: { rule: string }) => finding.rule);

/** Enough of a spell for the scan to accept the file as one that hurts people. */
const HURT = 'unit.takeDamage(10, this.owner, "PHYSICAL");';

describe('reach-scan', () => {
  it('names every rule it ships, so a report can be read without the source', () => {
    expect(RULES.map((rule: { id: string }) => rule.id)).toEqual([
      'drawn-wider-than-it-hits',
      'drawn-narrower-than-it-hits',
      'reach-never-painted',
    ]);
    for (const rule of RULES) expect(rule.why.length).toBeGreaterThan(80);
  });

  describe('drawn-wider-than-it-hits', () => {
    // Riven_Q: the wedge cut at Q_RADIUS and the crescent was painted at
    // Q_RADIUS * 1.12, then * 1.16 again under her ultimate.
    const offender = `
      export const RADIUS = 130;
      class Spell {
        cast(unit: any) {
          this.game.objectManager.queryObjects({
            area: new Circle({ x: 0, y: 0, r: effectiveRange(RADIUS, this.owner) }),
          });
          ${HURT}
        }
      }
      class Fx {
        get outerRadius() { return this.big ? RADIUS * 1.12 : RADIUS; }
        draw() { circle(0, 0, this.outerRadius * 2); }
      }
    `;

    it('fires when the outermost mark is painted past the hit radius', () => {
      expect(ids(offender)).toContain('drawn-wider-than-it-hits');
    });

    it('stays quiet when the picture is drawn at the radius that cuts', () => {
      expect(ids(offender.replace('RADIUS * 1.12', 'RADIUS'))).toEqual([]);
    });

    it('ignores inner decoration, which is not a claim about reach', () => {
      const decorated = offender.replace(
        'draw() { circle(0, 0, this.outerRadius * 2); }',
        'draw() { circle(0, 0, RADIUS * 2); circle(0, 0, RADIUS * 0.68); }'
      );
      expect(ids(decorated)).toEqual([]);
    });

    it('sees a drawing made in an underscore-prefixed method', () => {
      // `_drawCage` is a drawing. Matching only /^draw/ hid two whole spells'
      // art from the comparison, so a mismatch inside one was invisible.
      const priv = `
        export const RADIUS = 100;
        class Spell {
          cast(unit: any) {
            this.game.objectManager.queryObjects({
              area: new Circle({ x: 0, y: 0, r: RADIUS }),
            });
            ${HURT}
          }
          draw() { this._drawCage(); }
          _drawCage() { circle(0, 0, RADIUS * 3); }
        }
      `;
      expect(ids(priv)).toContain('drawn-wider-than-it-hits');
    });

    it('reads a spoke divided outside its own product', () => {
      // `(cos(a) * d) / 2` with `d` a diameter is drawn to d / 2. Matching the
      // product alone read Ekko_Q's clock face as twice its real reach.
      const clock = `
        export const RADIUS = 100;
        class Spell {
          cast(unit: any) {
            this.game.objectManager.queryObjects({
              area: new Circle({ x: 0, y: 0, r: RADIUS }),
            });
            ${HURT}
          }
        }
        class Fx {
          draw() {
            const d = RADIUS * 2;
            line(0, 0, (cos(1) * d) / 2, (sin(1) * d) / 2);
          }
        }
      `;
      expect(ids(clock)).toEqual([]);
    });
  });

  describe('drawn-narrower-than-it-hits', () => {
    // Tryndamere_E: the query added half the wearer's body and the blades did not.
    const offender = `
      export const HIT_RADIUS = 85;
      class Spell {
        cast(unit: any) {
          this.game.objectManager.queryObjects({
            area: new Circle({
              x: 0,
              y: 0,
              r: HIT_RADIUS + (this.owner.stats.size.value ?? 0) / 2,
            }),
          });
          ${HURT}
        }
        draw() { circle(0, 0, HIT_RADIUS * 2); }
      }
    `;

    it('fires when the hit adds a term the drawing has no answer for', () => {
      expect(ids(offender)).toContain('drawn-narrower-than-it-hits');
    });

    it('stays quiet once the drawing adds the same term', () => {
      const fixed = offender.replace(
        'draw() { circle(0, 0, HIT_RADIUS * 2); }',
        'draw() { circle(0, 0, (HIT_RADIUS + (this.owner.stats.size.value ?? 0) / 2) * 2); }'
      );
      expect(ids(fixed)).toEqual([]);
    });

    it('stays quiet on a bounding circle around a line-shaped hit', () => {
      // `LENGTH / 2 + WIDTH` is the broad phase every line ability uses before
      // its real rectangle test. Four of the first run's findings were this.
      const bounding = `
        export const LENGTH = 400;
        export const WIDTH = 60;
        class Spell {
          cast(unit: any) {
            this.game.objectManager.queryObjects({
              area: new Circle({ x: 0, y: 0, r: LENGTH / 2 + WIDTH }),
            });
            ${HURT}
          }
          draw() { circle(0, 0, LENGTH); }
        }
      `;
      expect(ids(bounding)).toEqual([]);
    });

    it("stays quiet on a pre-filter built from the spell's own cast range", () => {
      // `this.range + <anything>` collects candidates before the real test
      // narrows them. The engine already draws a ring at `range`; the sum is
      // not a reach, and inlining `range` to the number behind it lost that.
      const prefilter = `
        export const CAST_RANGE = 600;
        class Spell {
          range = CAST_RANGE;
          cast(unit: any) {
            this.game.objectManager.queryObjects({
              area: new Circle({
                x: 0,
                y: 0,
                r: this.range + (this.owner.stats.size.value ?? 0),
              }),
            });
            ${HURT}
          }
          draw() { circle(0, 0, 24); }
        }
      `;
      expect(ids(prefilter)).toEqual([]);
    });

    it('stays quiet on a body radius added to a targeted check', () => {
      // `LATCH + target.collisionRadius` is how a targeted hit reaches a fat
      // body. Nobody is meant to see that, so it is not a drawing problem.
      const targeted = `
        export const LATCH = 70;
        class Spell {
          cast(unit: any) {
            if (Math.hypot(1, 2) <= LATCH + unit.collisionRadius) { ${HURT} }
          }
          draw() { circle(0, 0, LATCH * 2); }
        }
      `;
      expect(ids(targeted)).toEqual([]);
    });

    it('reads a mark scaled by an animation curve as reaching its full size', () => {
      // `RADIUS * 2 * eased` is the ring's real size. Dropping the term left a
      // decorative inner circle standing as the widest thing drawn, and
      // XinZhao_E was reported as hitting 2.2x past its own edge.
      const eased = `
        export const RADIUS = 160;
        class Spell {
          cast(unit: any) {
            this.game.objectManager.queryObjects({
              area: new Circle({ x: 0, y: 0, r: RADIUS }),
            });
            ${HURT}
          }
          draw() {
            const t = constrain(this.age / this.lifeTime, 0, 1);
            const eased = 1 - (1 - t) * (1 - t);
            circle(0, 0, RADIUS * 2 * eased);
            circle(0, 0, RADIUS * 0.9);
          }
        }
      `;
      expect(ids(eased)).toEqual([]);
    });
  });

  describe('reach-never-painted', () => {
    const offender = `
      export const BLAST_RADIUS = 200;
      class Spell {
        cast(unit: any) {
          this.game.objectManager.queryObjects({
            area: new Circle({ x: 0, y: 0, r: BLAST_RADIUS }),
          });
          ${HURT}
        }
        draw() { circle(0, 0, 24); }
      }
    `;

    it('fires when the radius that decides the damage is painted nowhere', () => {
      expect(ids(offender)).toEqual(['reach-never-painted']);
    });

    it('stays quiet when the radius is handed to the object that draws it', () => {
      // The shape both real fixes used, and the reason this scan is deliberately
      // silent past a constructor rather than guessing across it.
      const delegated = offender.replace(
        'draw() { circle(0, 0, 24); }',
        'spawn() { this.game.objectManager.addObject(new Blast(this.owner, BLAST_RADIUS)); }\n        draw() { circle(0, 0, 24); }'
      );
      expect(ids(delegated)).toEqual([]);
    });

    it('stays quiet when the radius is handed over by a property write', () => {
      // `blast.radius = BLAST_RADIUS` is as much a hand-off as a constructor
      // argument, and is what a SpellObject with a long constructor tends to
      // use. Counting only `new` read a whole family of correct spells as
      // findings.
      const assigned = offender.replace(
        'draw() { circle(0, 0, 24); }',
        'spawn() {\n          const blast = new Blast(this.owner);\n          blast.radius = BLAST_RADIUS;\n        }\n        draw() { circle(0, 0, 24); }'
      );
      expect(ids(assigned)).toEqual([]);
    });

    it('says nothing about a distance check, which is a test and not an area', () => {
      // `dist < speed` is "am I there yet"; a hook's stop gap is spacing. No
      // player wants a ring drawn around either, and half of this rule's first
      // list was that shape.
      const arrival = `
        export const SPEED = 12;
        class Spell {
          step(unit: any) {
            if (Math.hypot(1, 2) < SPEED) { ${HURT} }
          }
          draw() { circle(0, 0, 24); }
        }
      `;
      expect(ids(arrival)).toEqual([]);
    });

    it('stays quiet when the engine paints it as the cast-range ring', () => {
      // `Spell.range` is drawn by the base class whether or not a spell
      // overrides drawPreview. Missing that read sixty item auras as findings.
      const ranged = `
        export const R_RANGE = 600;
        class Spell {
          range = R_RANGE;
          cast(unit: any) {
            this.game.objectManager.queryObjects({
              area: new Circle({ x: 0, y: 0, r: this.range }),
            });
            ${HURT}
          }
          draw() { circle(0, 0, 24); }
        }
      `;
      expect(ids(ranged)).toEqual([]);
    });

    it('counts a reach stated with straight edges, not only with a radius', () => {
      // A bar-shaped ability states its half-width with `line` and `rect`, and
      // read as painting nothing. It needs no table of primitives: naming the
      // constant as an argument to *any* call is the hand-off.
      const bar = `
        export const HALF_WIDTH = 55;
        class Spell {
          cast(unit: any) {
            this.game.objectManager.queryObjects({
              area: new Circle({ x: 0, y: 0, r: HALF_WIDTH }),
            });
            ${HURT}
          }
          draw() {
            line(0, -HALF_WIDTH, 0, HALF_WIDTH);
            rect(0, -HALF_WIDTH, 40, HALF_WIDTH * 2);
          }
        }
      `;
      expect(ids(bar)).toEqual([]);
    });

    it('stays quiet when the radius is handed to a plain method call', () => {
      // `showImpact(victim, RADIUS * 2)` sets the radius of the pulse that
      // draws it. Following only `new` read that as a radius nobody paints.
      const handed = offender.replace(
        'draw() { circle(0, 0, 24); }',
        'hit(victim: any) { this.showImpact(victim, BLAST_RADIUS * 2); }\n        draw() { circle(0, 0, 24); }'
      );
      expect(ids(handed)).toEqual([]);
    });

    it('says nothing about a file that never hurts anyone', () => {
      expect(ids(offender.replace(HURT, ''))).toEqual([]);
    });
  });
});
