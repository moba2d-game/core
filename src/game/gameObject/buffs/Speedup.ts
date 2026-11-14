import AssetManager from '@/managers/AssetManager';
import BuffAddType from '@/game/enums/BuffAddType';
import Buff from '@/game/gameObject/Buff';
import { percent, term } from '@/game/gameObject/buffs/describeBuff';
import { StatsModifier } from '@/game/gameObject/Stats';
import ParticleSystem from '@/game/gameObject/helpers/ParticleSystem';
import { cssColor } from '@/game/render/cssColor';
import { stressTier } from '@/game/render/renderStress';

/** The one alpha every streak wears when they are stroked as one path. */
export const SPEEDUP_BATCHED_STREAK_ALPHA = 140;

function streakTier(game: unknown): 0 | 1 | 2 {
  const g = game as
    | { renderQuality?: 'auto' | 'low' | 'high'; renderStressed?: boolean; deeplyStressed?: boolean }
    | undefined;
  return stressTier(g?.renderQuality, g?.renderStressed, g?.deeplyStressed);
}

interface SpeedupParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
}

export default class Speedup extends Buff {
  image: Buff['image'] = AssetManager.get('buff_haste');
  name = 'Tăng Tốc';
  buffAddType = BuffAddType.STACKS_AND_CONTINUE;
  maxStacks = 10;

  percent = 0;

  maxParticleAge = 30;
  private batchedStreaks = false;
  particleSystem = new ParticleSystem({
    autoRemoveIfEmpty: false,
    getParticlePosFn: (p: SpeedupParticle) => ({ x: p.x, y: p.y }),
    getParticleSizeFn: () => 30,
    isDeadFn: (p: SpeedupParticle) => {
      return p.age > this.maxParticleAge;
    },
    updateFn: (p: SpeedupParticle) => {
      p.x += p.vx;
      p.y += p.vy;
      p.age += 1;
    },
    // The streaks go to the raw context. At full quality each keeps its own
    // fade — the two-point path p5's `line` emits, one stroke apiece, the same
    // pixels. Once the machine is behind (`stressTier` 1 and up) they share
    // one path and one stroke at a single mid-fade alpha: twenty strokes
    // become one, and what is lost is a gradient along a wake.
    preDrawFn: () => {
      this.batchedStreaks = streakTier(this.game) >= 1;
      const ctx = drawingContext;
      ctx.lineWidth = 3;
      if (this.batchedStreaks) {
        ctx.strokeStyle = cssColor(255, 255, 255, SPEEDUP_BATCHED_STREAK_ALPHA);
        ctx.beginPath();
      }
    },
    drawFn: (p: SpeedupParticle) => {
      const ctx = drawingContext;
      if (!this.batchedStreaks) {
        const alpha = 255 - (245 * p.age) / this.maxParticleAge;
        // p5's own string, float alpha and all: rounding it first came out one
        // level off on a phone's canvas.
        ctx.strokeStyle = `rgba(255,255,255,${alpha / 255})`;
        ctx.beginPath();
      }
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + p.vx * 10, p.y + p.vy * 10);
      if (!this.batchedStreaks) ctx.stroke();
    },
    postDrawFn: () => {
      if (this.batchedStreaks) drawingContext.stroke();
    },
  });

  statsModifier: StatsModifier = new StatsModifier();

  onCreate(): void {
    this.statsModifier = new StatsModifier();
    this.statsModifier.speed.percentBaseBonus = this.percent;
    this.description ??= `Tăng ${term(percent(this.percent))} tốc chạy.`;

    this.game.objectManager.addObject(this.particleSystem);
  }

  onActivate(): void {
    this.targetUnit.stats.addModifier(this.statsModifier);
  }

  onDeactivate(): void {
    this.targetUnit.stats.removeModifier(this.statsModifier);
    this.particleSystem.autoRemoveIfEmpty = true;
  }

  onUpdate(): void {
    if (random(1) < 0.2) {
      const targetDestination = p5.Vector.sub(
        this.targetUnit.destination,
        this.targetUnit.position
      );
      const vel = targetDestination.normalize().mult(random(-2, -1));

      const size = this.targetUnit.stats.size.value / 2;
      this.particleSystem.addParticle({
        x: this.targetUnit.position.x + random(-size, size),
        y: this.targetUnit.position.y + random(-size, size),
        vx: vel.x,
        vy: vel.y,
        age: 0,
      });
    }
  }
}
