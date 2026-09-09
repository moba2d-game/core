import AssetManager from '@/managers/AssetManager';
import type { DamageType } from '@/game/combat/Mitigation';
import BuffAddType from '@/game/enums/BuffAddType';
import Buff from '@/game/gameObject/Buff';
import { DAMAGE_CLASS, DAMAGE_WORD, seconds } from '@/game/gameObject/buffs/describeBuff';
import ParticleSystem from '@/game/gameObject/helpers/ParticleSystem';
import { SPELL_EFFECT_Z_INDEX } from '@/game/managers/ObjectManager';
import type AttackableUnit from '@/game/gameObject/attackableUnits/AttackableUnit';

interface Flame {
  /** Offsets from the victim, not world coordinates — the fire rides the body. */
  baseX: number;
  baseY: number;
  riseSpeed: number;
  size: number;
  age: number;
  lifeTime: number;
  wobblePhase: number;
  wobbleAmp: number;
}

const MAX_FLAMES = 120;
const FLAME_SPAWN_INTERVAL = 13;
const FRAME_MS = 1000 / 60;

/**
 * The fire, as a real `ParticleSystem` object rather than a private array this
 * buff painted from inside `draw()`.
 *
 * **Why it had to become one.** A 13ms spawn against a 450–780ms life settles at
 * about fifty flames, and each was a `circle()` — so one burning body was ~55
 * additive circles a frame and the buff drew every one of them, every frame,
 * for as long as it lasted. That is a particle system in all but name, and
 * being unnamed was the problem: `ObjectManager.draw` rations particles under
 * load (`MOBILE_PARTICLE_DRAW_BUDGET`, `renderStressed`) by asking each
 * `ParticleSystem` for a subset, and this one was invisible to that budget
 * because it was not one. Measured on a wave of 46 minions with thirty of them
 * burning: **4.66 → 14.29 ms/frame**, the frame tripled, and the ration that
 * exists for exactly this could not reach it. `Speedup` had the right shape all
 * along.
 *
 * Two things it must not lose by moving out of the unit's own `draw()`:
 *
 *  - **Where it paints.** Inside `drawBuffs` the flames landed after the body,
 *    over it. A bare `ParticleSystem` sits at `PARTICLE_Z_INDEX` (1), under
 *    every unit — a burning champion would hide their own fire. `SPELL_EFFECT_Z_INDEX`
 *    is the slot whose own comment names "a buff aura", which is what this is.
 *  - **Who can see it.** A buff drawn inside a unit was fogged with that unit
 *    for free. Out here it needs to say so, the way `SpellObject` does.
 */
class FlameSystem extends ParticleSystem {
  zIndex = SPELL_EFFECT_Z_INDEX;
  constructor(
    private readonly victim: AttackableUnit,
    options: ConstructorParameters<typeof ParticleSystem>[0]
  ) {
    super(options);
  }
  override get visionAnchor(): AttackableUnit {
    return this.victim;
  }
}

/**
 * Deals damage on a fixed interval for as long as it lasts — burns, poisons,
 * bleeds. Damage is credited to `sourceUnit`, so kills score correctly.
 *
 *   const dot = new DamageOverTime(5000, caster, target);
 *   dot.damagePerTick = 6;   // 6 damage
 *   dot.tickInterval = 500;  // every 0.5s => 60 total over 5s
 *   target.addBuff(dot);
 *
 * Renders as a column of flame rising off the victim. Recolour it with
 * `flameColor` (hot core at the base) and `emberColor` (what it cools to on the
 * way up) — e.g. green + dark green reads as poison. Particles are spawned in
 * onUpdate and only drawn in draw, so the fire's density does not depend on how
 * many times the unit happens to be rendered.
 */
export default class DamageOverTime extends Buff {
  image: Buff['image'] = AssetManager.get('buff_poison');
  name = 'Thiêu Đốt';
  buffAddType = BuffAddType.RENEW_EXISTING;

  damagePerTick = 5;

  /**
   * What kind of damage a tick is. Magic by default, which is what a burn or a
   * poison usually is and what this has always dealt — stated here rather than
   * left to `takeDamage`'s own default, because "nobody said" and "magic on
   * purpose" look identical from the outside and one of them is a bug. A
   * bleed sets `'PHYSICAL'`; an execute-style burn sets `'TRUE'`.
   */
  damageType: DamageType = 'MAGIC';
  tickInterval = 500;

  /**
   * **A tick of this reveals nobody**, and it is the only thing in the engine
   * that says so. Core's rule is that a hit ends a stealth on both ends of it
   * (`combat/StealthBreak.ts`); a poison is the case that rule gets wrong, at
   * both ends and for the same reason — *nobody is acting*. The cast that
   * applied this returned seconds ago and the clock has been running by itself
   * ever since.
   *
   *   - **The source.** A poisoner who vanishes while their own poison is still
   *     ticking would be given away by it, every half second, which is a kit
   *     that cannot use its own stealth at all. This is the ability the carve-out
   *     was asked for.
   *   - **The victim.** Otherwise a single burn is a hard counter to *every*
   *     stealth in the game: nobody hiding could stay hidden through one, and
   *     a champion carrying a burn would deny the mechanic outright.
   *
   * What still reveals is everything somebody does about it: applying the
   * poison in the first place, swinging, and every other hit either end takes.
   */
  revealsStealth = false;

  flameColor: [number, number, number] = [255, 230, 120];
  emberColor: [number, number, number] = [210, 35, 10];

  _timeSinceLastTick = 0;

  /**
   * Written here rather than derived from flags because a burn sets none: its
   * whole meaning is the two numbers above, and neither is knowable from
   * anything but this instance. Both are read after the caster has set them —
   * see `Buff.activateBuff`.
   */
  onCreate(): void {
    this.description ??=
      `Gây <span class="damage ${DAMAGE_CLASS[this.damageType]}">` +
      `${Math.round(this.damagePerTick * 10) / 10} sát thương ${DAMAGE_WORD[this.damageType]}</span>` +
      ` mỗi ${seconds(this.tickInterval)}.`;

    this.flameSystem = this.buildFlameSystem();
    this.game.objectManager.addObject(this.flameSystem);
  }

  /**
   * Drained rather than dropped, exactly as `Speedup` does it: the flames
   * already on screen finish rising instead of vanishing the frame the burn
   * ends, and the system takes itself out once the last one is gone.
   */
  onDeactivate(): void {
    if (this.flameSystem) this.flameSystem.autoRemoveIfEmpty = true;
  }

  flameSystem: FlameSystem | null = null;
  _timeSinceLastSpawn = 0;

  /** Where a flame is *now*: an offset carried on the body, plus how far it has climbed. */
  private flamePos(flame: Flame): { x: number; y: number } {
    const pos = this.targetUnit.position;
    const t = flame.age / flame.lifeTime;
    const risen = (flame.riseSpeed * flame.age) / FRAME_MS;
    return {
      x: pos.x + flame.baseX * (1 - t * 0.8) + sin(flame.wobblePhase + t * 7) * flame.wobbleAmp * t,
      y: pos.y + flame.baseY - risen,
    };
  }

  private buildFlameSystem(): FlameSystem {
    const [hotR, hotG, hotB] = this.flameColor;
    const [coolR, coolG, coolB] = this.emberColor;
    return new FlameSystem(this.targetUnit, {
      owner: this.targetUnit,
      maxParticles: MAX_FLAMES,
      // The burn owns the lifetime; `onDeactivate` hands it back.
      autoRemoveIfEmpty: false,
      getParticlePosFn: (flame: Flame) => this.flamePos(flame),
      getParticleSizeFn: (flame: Flame) => flame.size,
      isDeadFn: (flame: Flame) => flame.age >= flame.lifeTime,
      updateFn: (flame: Flame) => {
        flame.age += deltaTime;
      },
      preDrawFn: (flames: Flame[]) => {
        if (flames.length === 0) return;
        noStroke();
        blendMode(ADD); // overlapping tongues of flame build into a glow
        // pool of light at the feet, so the fire looks anchored to the ground
        const pos = this.targetUnit.position;
        const radius = this.targetUnit.animatedValues.displaySize / 2;
        fill(coolR, coolG, coolB, 70);
        ellipse(pos.x, pos.y + radius * 0.35, radius * 2.1, radius * 0.9);
      },
      // One pass, where there used to be two: the tongue and the white-hot core
      // at its base. Under additive blending the order the two are laid down in
      // does not change the pixel, and a second full walk of the list is a
      // second walk the draw budget would have to ration separately.
      drawFn: (flame: Flame) => {
        const t = flame.age / flame.lifeTime; // 0 at the base, 1 at burnout
        const { x, y } = this.flamePos(flame);
        const size = flame.size * (1 - t * 0.75);
        // kept low because additive blending stacks these into a solid glow
        const alpha = 140 * (1 - t) * (1 - t * 0.6);

        // cools from the hot colour to the ember colour as it climbs
        fill(
          hotR + (coolR - hotR) * t,
          hotG + (coolG - hotG) * Math.min(1, t * 1.4),
          hotB + (coolB - hotB) * Math.min(1, t * 1.8),
          alpha
        );
        circle(x, y, size);

        // white-hot core only right at the base, where the fire is hottest
        if (t > 0.22) return;
        const risen = (flame.riseSpeed * flame.age) / FRAME_MS;
        const pos = this.targetUnit.position;
        fill(255, 250, 225, 70 * (1 - t / 0.22));
        circle(
          pos.x + flame.baseX * (1 - t * 0.8),
          pos.y + flame.baseY - risen,
          flame.size * 0.3
        );
      },
      postDrawFn: (flames: Flame[]) => {
        if (flames.length === 0) return;
        blendMode(BLEND);
      },
    });
  }

  onUpdate(): void {
    if (this.targetUnit.isDead) {
      this.deactivateBuff();
      return;
    }

    this._timeSinceLastTick += deltaTime;

    // at most one tick per frame; the remainder carries over so the rate holds
    // even if the frame took longer than a whole interval
    if (this._timeSinceLastTick >= this.tickInterval) {
      this._timeSinceLastTick -= this.tickInterval;
      this.targetUnit.takeDamage(this.damagePerTick, this.sourceUnit, this.damageType);
    }

    this._updateFlames();
  }

  /**
   * Spawning only. Ageing and reaping are the particle system's own `update`,
   * which `ObjectManager` drives once a tick like every other object — so the
   * fire's density still does not depend on how often the victim is drawn,
   * which is the property the old hand-rolled loop existed to keep.
   */
  _updateFlames(): void {
    const system = this.flameSystem;
    if (!system) return;
    const radius = this.targetUnit.animatedValues.displaySize / 2;

    this._timeSinceLastSpawn += deltaTime;
    while (
      this._timeSinceLastSpawn >= FLAME_SPAWN_INTERVAL &&
      system.particles.length < MAX_FLAMES
    ) {
      this._timeSinceLastSpawn -= FLAME_SPAWN_INTERVAL;
      system.addParticle({
        // wide at the feet; the draw pulls them toward the centre as they climb
        baseX: random(-radius * 0.85, radius * 0.85),
        baseY: random(radius * 0.15, radius * 0.55),
        riseSpeed: random(2.2, 4.4),
        size: random(radius * 0.55, radius * 1.05),
        age: 0,
        lifeTime: random(450, 780),
        wobblePhase: random(0, TWO_PI),
        wobbleAmp: random(2, 7),
      } satisfies Flame);
    }
    if (this._timeSinceLastSpawn > FLAME_SPAWN_INTERVAL) this._timeSinceLastSpawn = 0;
  }
}
