import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AttackableUnit from '../../../src/game/gameObject/attackableUnits/AttackableUnit';
import AoePulse from '../../../src/game/gameObject/spellObjects/AoePulse';
import {
  DEATH_SHAKE_TRAUMA,
  KILL_SHAKE_TRAUMA,
  hitFlashMs,
  hitShakeTrauma,
} from '../../../src/game/render/hitFeedback';
import { hapticPattern } from '../../../src/game/input/haptics';
import { createGame, stubGameGlobals, type TestGame } from '../fixtures';

/**
 * `presentHit` is the one door a hit's *look* goes through — host from
 * `takeDamage`, LAN client from the `dmg` stream — so this file pins what
 * comes out of that door: the flash on the body, the camera when the body is
 * the player's, and the crit spark.
 */
describe('presentHit', () => {
  let spies: Record<string, ReturnType<typeof vi.fn>>;
  let game: TestGame;
  let shake: ReturnType<typeof vi.fn>;

  const unit = (x: number, teamId: string): AttackableUnit => {
    const created = new AttackableUnit({ game, position: createVector(x, 0), teamId });
    created.stats.maxHealth.baseValue = 100;
    created.stats.health.baseValue = 100;
    return created;
  };

  beforeEach(() => {
    spies = stubGameGlobals();
    vi.stubGlobal('deltaTime', 16);
    vi.stubGlobal('drawingContext', {
      globalAlpha: 1,
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      clip: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      drawImage: vi.fn(),
    });
    game = createGame();
    shake = vi.fn();
    Object.assign(game.camera, { shake });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lights the body for as long as the hit deserves, then lets it fade', () => {
    const victim = unit(0, 'red');
    victim.presentHit({ amount: 30, type: 'PHYSICAL' });
    expect(victim.hitFlashMs).toBe(hitFlashMs(0.3, false));
    expect(victim.hitFlashTotalMs).toBe(victim.hitFlashMs);
    victim.update();
    expect(victim.hitFlashMs).toBe(hitFlashMs(0.3, false) - 16);
    for (let i = 0; i < 20; i++) victim.update();
    expect(victim.hitFlashMs).toBeLessThanOrEqual(0);
  });

  it('paints a white disc over the body while lit, and nothing once it is not', () => {
    const victim = unit(0, 'red');
    // `drawAvatar` colours the team ring by `isAllied`, which reads the player.
    game.setPlayer(victim);
    victim.animatedValues.displaySize = 40;
    // The disc is native, like the frame it sits in: a fill of the body's own
    // circle in white, at the strength the hit earned.
    const ctx = drawingContext as unknown as { fillStyle: string; fill: ReturnType<typeof vi.fn> };

    victim.drawAvatar();
    expect(ctx.fill).not.toHaveBeenCalled();

    victim.presentHit({ amount: 30, type: 'PHYSICAL' });
    victim.drawAvatar();
    expect(ctx.fill).toHaveBeenCalledTimes(1);
    expect(ctx.fillStyle).toBe('rgba(255, 255, 255, 0.588)');
    expect(vi.mocked(drawingContext.arc)).toHaveBeenCalledWith(0, 0, 20, 0, Math.PI * 2);
  });

  it('does not light a corpse', () => {
    const victim = unit(0, 'red');
    game.setPlayer(victim);
    victim.die({ reviveAfter: 1000 });
    victim.presentHit({ amount: 30, type: 'PHYSICAL' });
    victim.drawAvatar();
    // A corpse gets the dead shade and nothing white over it.
    const ctx = drawingContext as unknown as { fillStyle: string };
    expect(ctx.fillStyle).toBe('rgba(0, 0, 0, 0.784)');
    expect(vi.mocked(drawingContext.fill)).toHaveBeenCalledTimes(1);
  });

  it('shakes the camera only when the player is the one hit', () => {
    const player = unit(0, 'blue');
    const other = unit(100, 'red');
    game.setPlayer(player);

    other.presentHit({ amount: 30, type: 'PHYSICAL' });
    expect(shake).not.toHaveBeenCalled();

    player.presentHit({ amount: 30, type: 'PHYSICAL' });
    expect(shake).toHaveBeenCalledWith(hitShakeTrauma(0.3, false));
  });

  it('buzzes the device with the same trauma the camera got', () => {
    const buzz = vi.fn();
    vi.stubGlobal('navigator', { vibrate: buzz });
    const player = unit(0, 'blue');
    const other = unit(100, 'red');
    game.setPlayer(player);

    other.presentHit({ amount: 30, type: 'PHYSICAL' });
    expect(buzz).not.toHaveBeenCalled();

    player.presentHit({ amount: 30, type: 'PHYSICAL' });
    expect(buzz).toHaveBeenCalledWith(hapticPattern('hit', hitShakeTrauma(0.3, false)));
  });

  it('leaves chip damage on the player off the camera', () => {
    const player = unit(0, 'blue');
    game.setPlayer(player);
    player.presentHit({ amount: 3, type: 'PHYSICAL' });
    expect(shake).toHaveBeenCalledWith(0);
  });

  it('sparks on a crit, owned by the victim', () => {
    const victim = unit(0, 'red');
    victim.presentHit({ amount: 30, type: 'PHYSICAL', crit: true });
    const sparks = game.objectManager._objectToBeAdd.filter(o => o instanceof AoePulse);
    expect(sparks).toHaveLength(1);
    expect((sparks[0] as AoePulse).owner).toBe(victim);
    expect(victim.hitFlashMs).toBe(hitFlashMs(0.3, true));
  });

  it('reaches the door from takeDamage with the swing crit flag', () => {
    const attacker = unit(0, 'blue');
    const victim = unit(100, 'red');
    victim.takeDamage(30, attacker, 'PHYSICAL', 'swing', { crit: true });
    expect(victim.hitFlashMs).toBe(hitFlashMs(0.3, true));
    expect(game.objectManager._objectToBeAdd.filter(o => o instanceof AoePulse)).toHaveLength(1);
  });
});

describe('death and kills reach the camera', () => {
  let game: TestGame;
  let shake: ReturnType<typeof vi.fn>;

  const unit = (x: number, teamId: string): AttackableUnit => {
    const created = new AttackableUnit({ game, position: createVector(x, 0), teamId });
    created.stats.maxHealth.baseValue = 100;
    created.stats.health.baseValue = 100;
    return created;
  };

  beforeEach(() => {
    stubGameGlobals();
    vi.stubGlobal('deltaTime', 16);
    game = createGame();
    shake = vi.fn();
    Object.assign(game.camera, { shake });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shakes hardest on the player's own death, once per death", () => {
    const player = unit(0, 'blue');
    game.setPlayer(player);
    player.die({ reviveAfter: 1000 });
    player.die({ reviveAfter: 1000 });
    expect(shake.mock.calls.filter(([t]) => t === DEATH_SHAKE_TRAUMA)).toHaveLength(1);
  });

  it('kicks when the player kills a champion-credit body, and not a minion', () => {
    const player = unit(0, 'blue');
    game.setPlayer(player);
    const champion = unit(100, 'red');
    Object.defineProperty(champion, 'killCredit', { value: 'champion' });
    const minion = unit(200, 'red');
    Object.defineProperty(minion, 'killCredit', { value: 'minion' });

    minion.die({ attacker: player, reviveAfter: 1000 });
    expect(shake).not.toHaveBeenCalledWith(KILL_SHAKE_TRAUMA);

    champion.die({ attacker: player, reviveAfter: 1000 });
    expect(shake).toHaveBeenCalledWith(KILL_SHAKE_TRAUMA);
  });

  it("stays still for somebody else's death", () => {
    const player = unit(0, 'blue');
    game.setPlayer(player);
    const bystander = unit(100, 'red');
    const other = unit(200, 'blue');
    Object.defineProperty(bystander, 'killCredit', { value: 'champion' });
    bystander.die({ attacker: other, reviveAfter: 1000 });
    expect(shake).not.toHaveBeenCalled();
  });
});
