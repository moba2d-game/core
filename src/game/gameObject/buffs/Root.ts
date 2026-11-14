// https://leagueoflegends.fandom.com/wiki/Root
import AssetManager from '@/managers/AssetManager';
import BuffAddType from '@/game/enums/BuffAddType';
import StatusFlags from '@/game/enums/StatusFlags';
import Buff from '@/game/gameObject/Buff';
import { cssColor } from '@/game/render/cssColor';

// Trói chân
export default class Root extends Buff {
  image: Buff['image'] = AssetManager.get('buff_root');
  name = 'Trói';
  buffAddType = BuffAddType.STACKS_AND_CONTINUE;
  maxStacks = 10;

  effectColor: [number, number, number, number] = [255, 255, 255, 200];
  statusFlagsToEnable = StatusFlags.Rooted;
  statusFlagsToDisable = StatusFlags.CanMove;

  draw(): void {
    // draw buff on target unit
    const pos = this.targetUnit.position;
    const size = this.targetUnit.animatedValues.displaySize;

    // The raw context, with the path p5's `circle` emits (`ellipse` then
    // `closePath`): same ring, without five p5 calls around one stroke.
    const [r, g, b, a] = this.effectColor;
    const radius = (size + random(-3, 3)) / 2;
    const ctx = drawingContext;
    ctx.save();
    ctx.strokeStyle = cssColor(r, g, b, a);
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(pos.x, pos.y, radius, radius, 0, 0, Math.PI * 2);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
}
