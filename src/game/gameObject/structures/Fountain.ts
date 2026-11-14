import { cssColor } from '@/game/render/cssColor';
import { Circle, Rectangle } from '@/libs/quadtree';
import GameObject from '@/game/gameObject/GameObject';
import type { GameObjectRuntimeContext } from '@/game/gameObject/GameObject';
import Champion from '@/game/gameObject/attackableUnits/Champion';
import { FOUNTAIN_Z_INDEX, PredefinedFilters } from '@/game/managers/ObjectManager';

export interface FountainPresetData {
  name: string;
  x: number;
  y: number;
  /** Healing radius, also the drawn platform radius. */
  r: number;
  /** Which base this platform is, from TeamId. Its minions inherit it. */
  teamId?: string;
  /** ms between restore ticks. */
  tickInterval?: number;
  /** Fraction of max health restored per tick. */
  healPercent?: number;
  /** Fraction of max mana restored per tick. */
  manaPercent?: number;
  /**
   * How far out the shop still works. `0` or absent means the platform itself
   * — see `FountainStats.shopRange`, which is where a map sets it.
   */
  shopRange?: number;
}

/**
 * How far out the shop ring starts fading in, as a multiple of the reach.
 *
 * Wide enough that it arrives before a player walking home has to guess, short
 * enough that it is not simply always on — which is the whole objection to
 * drawing it at all.
 */
export const SHOP_RING_FADE = 1.9;

/** Peak opacity, and how many dashes the ring is cut into. */
const SHOP_RING_ALPHA = 190;
const SHOP_RING_SEGMENTS = 40;


/**
 * Bệ Đá Cổ — the spawn platform. Allied champions standing inside get a slice
 * of health and mana back on every tick, so it is somewhere to retreat to
 * rather than just a spawn marker.
 *
 * Deliberately a plain GameObject, not an AttackableUnit: it has no health, it
 * cannot be attacked, and FogOfWar's visibleToPlayerTeam reset only touches units.
 *
 * Its TeamId is shared with that base's turrets, minions and champions. Enemy
 * champions may cross the platform, but never receive its restoration.
 */
export default class Fountain extends GameObject {
  declare game: GameObjectRuntimeContext;
  /** Under everything else — it is a floor. */
  zIndex = FOUNTAIN_Z_INDEX;

  name: string;
  radius: number;
  tickInterval: number;
  healPercent: number;
  manaPercent: number;
  /**
   * How far from here the shop reaches, resolved once.
   *
   * `radius` is where a body is *restored* and where the platform is drawn;
   * this is where it can *buy*. They were one number only because nothing had
   * needed them apart — and a map that widened `radius` to let people shop
   * further out would also be handing out a huge healing pad and drawing a
   * floor over a quarter of itself. `ItemShop.atOwnFountain` reads this one.
   */
  shopRadius: number;

  _tickCooldown = 0;

  constructor({ game, preset }: { game: GameObjectRuntimeContext; preset: FountainPresetData }) {
    super({
      game,
      position: createVector(preset.x, preset.y),
      visionRadius: 0,
      teamId: preset.teamId,
    });

    this.name = preset.name;
    this.radius = preset.r;
    this.tickInterval = preset.tickInterval ?? 500;
    this.healPercent = preset.healPercent ?? 0.12;
    this.manaPercent = preset.manaPercent ?? 0.12;
    // The sentinel resolved: a map that says nothing gets exactly the rule it
    // had before this field existed, and never a shop radius of zero — which
    // would be a fountain nobody can buy at, from a map that asked for nothing.
    this.shopRadius = preset.shopRange && preset.shopRange > 0 ? preset.shopRange : this.radius;
  }

  update() {
    this._tickCooldown -= deltaTime;
    if (this._tickCooldown > 0) return;
    this._tickCooldown = this.tickInterval;

    for (const champion of this.championsInside()) {
      const stats = champion.stats;

      // takeHeal spawns a CombatText, so only heal something that is missing
      const missingHealth = stats.maxHealth.value - stats.health.value;
      if (missingHealth > 0.5) {
        const heal = Math.min(missingHealth, stats.maxHealth.value * this.healPercent);
        champion.takeHeal(Math.round(heal), this);
      }

      const missingMana = stats.maxMana.value - stats.mana.value;
      if (missingMana > 0.5) {
        stats.mana.baseValue = Math.min(
          stats.maxMana.value,
          stats.mana.baseValue + stats.maxMana.value * this.manaPercent
        );
      }
    }
  }

  championsInside(): Champion[] {
    return this.game.objectManager.queryObjects({
      area: new Circle({ x: this.position.x, y: this.position.y, r: this.radius }),
      filters: [
        PredefinedFilters.type(Champion),
        PredefinedFilters.teamId(this.teamId),
        PredefinedFilters.excludeDead,
      ],
    });
  }


  /**
   * A platform, drawn as a platform.
   *
   * This used to be four translucent discs (the widest at the full healing
   * diameter), a stroked ring, eight separate `arc()` paths turning one way, a
   * six-sided sigil turning the other, and up to twenty-six rising motes — and
   * it profiled as the most expensive single body on a crowded board, 0.40ms of
   * a 6.0ms frame, for two objects that stand still and cannot be attacked.
   *
   * What it costs is **fill**: baking the whole thing into buffers was tried and
   * measured identical (0.396ms against 0.398ms), because a blit fills the same
   * pixels the discs did. So the art itself is the thing that had to change.
   *
   * The outermost disc was the expensive one *and* the only one carrying
   * information — its edge is where the healing reaches. Drawn as a rim instead
   * of a disc it says the same thing more plainly, at the cost of a stroke
   * rather than the largest fill on the map: about a third of the fill area
   * this had before, and no per-frame animation state at all.
   */
  draw() {
    const { x, y } = this.position;
    const r = this.radius;

    push();

    // The pad you stand on.
    noStroke();
    fill(22, 44, 60, 235);
    circle(x, y, r * 1.5);
    fill(30, 62, 82, 235);
    circle(x, y, r * 1.32);

    // The rim: exactly where the restoring stops, which is the one fact a
    // player walking home needs from this object.
    noFill();
    stroke(120, 230, 255, 150);
    strokeWeight(3);
    circle(x, y, r * 2);

    pop();

    this.drawShopReach();
  }

  /**
   * Where the shop reaches, drawn only when that is news.
   *
   * Nothing in a match said how far `shopRadius` went. On the default map that
   * was fine, because the reach *is* the platform and the platform is drawn —
   * but a map that widens it (`FountainStats.shopRange`, the field maps like
   * "mua đồ ở giữa đường" are built out of) left a player with no way to learn
   * the rule except opening the shop and reading whether the tiles were grey.
   *
   * The obvious fix is a ring, and the obvious objection is that a ring is
   * clutter. Both are right, so it is gated twice — and what is left is a
   * circle that is invisible on every ordinary map and, on the maps that do
   * widen it, appears only while somebody is walking home:
   *
   *   - **Only when the map widened it.** `shopRadius === radius` by default,
   *     and a second circle drawn on an edge already drawn is a new line that
   *     says nothing.
   *   - **Only the player's own, and only near it.** A ring on the far side of
   *     the map is decoration. A ring under your feet as you come back is the
   *     answer to the question you are actually asking, which is "am I close
   *     enough yet" — so it fades in over the last stretch of the approach and
   *     goes solid the moment you cross it. Crossing it is the moment the shop
   *     becomes usable, and it is now a thing you can see happen.
   */
  private drawShopReach(): void {
    const alpha = this.shopRingAlpha();
    if (alpha <= 0) return;

    // Dashed by hand, and it stays dashed inside the reach too: a solid ring
    // reads as a wall, and this one stops nothing.
    //
    // **One path, one stroke.** This was forty `arc()` calls, each its own
    // stroke, and on a phone's GPU canvas the cost of a frame is the number of
    // draw operations far more than what they cover: with the player standing
    // in the reach this ring alone was a tenth of every draw call in a
    // ten-champion fight. The dashes are the same forty arcs, as subpaths.
    const ctx = drawingContext;
    const { x, y } = this.position;
    const r = this.shopRadius;
    const step = (Math.PI * 2) / SHOP_RING_SEGMENTS;
    ctx.save();
    ctx.strokeStyle = cssColor(150, 235, 255, alpha * SHOP_RING_ALPHA);
    ctx.lineWidth = alpha === 1 ? 3 : 2;
    ctx.beginPath();
    for (let i = 0; i < SHOP_RING_SEGMENTS; i++) {
      const a0 = step * i;
      ctx.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r);
      ctx.arc(x, y, r, a0, a0 + step * 0.55);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * How strongly to draw the ring, 0 (not at all) to 1 (the player is inside).
   *
   * Separate from the drawing because the *decision* is the part with rules in
   * it — three gates and a fade — and the drawing is p5 calls that no test can
   * run. `Fountain.test.ts` holds the gates.
   */
  shopRingAlpha(): number {
    if (this.shopRadius <= this.radius) return 0;
    const player = this.game.player;
    if (!player || player.teamId !== this.teamId) return 0;

    const dx = player.position.x - this.position.x;
    const dy = player.position.y - this.position.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= this.shopRadius) return 1;

    const fadeFrom = this.shopRadius * SHOP_RING_FADE;
    if (distance >= fadeFrom) return 0;
    return 1 - (distance - this.shopRadius) / (fadeFrom - this.shopRadius);
  }

  getDisplayBoundingBox() {
    // Covers the shop ring as well as the platform: this object paints past
    // its own radius on a map that widened the reach, and a box sized to the
    // platform culls the fountain — ring included — while a corner of that
    // ring is still on screen.
    const size = Math.max(this.radius * 2.2, this.shopRadius * 2.1);
    return new Rectangle({
      x: this.position.x - size / 2,
      y: this.position.y - size / 2,
      w: size,
      h: size,
      data: this,
    });
  }

  getCollideBoundingBox(): Circle {
    return new Circle({
      x: this.position.x,
      y: this.position.y,
      r: this.radius,
      data: this,
    });
  }

  /** A jittered point on the platform, used as a spawn / respawn location. */
  randomPointInside(): p5.Vector {
    const a = random(TWO_PI);
    const d = random(this.radius * 0.65);
    return createVector(this.position.x + cos(a) * d, this.position.y + sin(a) * d);
  }
}
