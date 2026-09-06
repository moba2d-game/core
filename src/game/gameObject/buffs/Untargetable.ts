import AssetManager from '@/managers/AssetManager';
import BuffAddType from '@/game/enums/BuffAddType';
import StatusFlags from '@/game/enums/StatusFlags';
import Buff from '@/game/gameObject/Buff';

/**
 * The unit cannot be picked as a target or hit by anything, but keeps acting.
 * Used by the brief invulnerable windows on leaps.
 *
 * `PredefinedFilters.canTakeDamageFromTeam` already tests `targetable`, so every
 * spell that queries for enemies skips the unit for free.
 */
export default class Untargetable extends Buff {
  image: Buff['image'] = AssetManager.get('buff_untargetable');
  name = 'Không Thể Chọn';
  buffAddType = BuffAddType.REPLACE_EXISTING;

  statusFlagsToDisable = StatusFlags.Targetable;

  draw(): void {
    const pos = this.targetUnit.position;
    const { displaySize: size, alpha } = this.targetUnit.animatedValues;
    // Scaled by the body's own alpha, not painted at a fixed one. Untargetable
    // travels with `Invisible` on anything that hides (`Pet.setHidden`), and a
    // stealthed unit fades to alpha 20 — so a fixed 130 here drew three bright
    // rings around a body nobody was supposed to be able to find, which is the
    // exact opposite of what hiding it was for.
    const fade = alpha / 255;
    if (fade <= 0) return;

    push();
    noFill();
    stroke(200, 230, 255, 130 * fade);
    strokeWeight(2);
    for (let i = 0; i < 3; i++) {
      circle(pos.x, pos.y, size + 8 + i * 9 + sin(frameCount / 6 + i) * 3);
    }
    pop();
  }
}
