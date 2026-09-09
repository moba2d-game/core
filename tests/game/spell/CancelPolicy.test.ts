import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import StatusFlags from '../../../src/game/enums/StatusFlags';
import {
  SPELL_FORM_NAMES,
  SpellForm,
  foreignControlBuff,
  interruptSwitchFor,
  interruptsSuspended,
  isInterruptibleState,
  ownerInterruptReason,
  resolveInterrupts,
  snapshotOwnerMovement,
  spellFormNameOf,
  type InterruptibleOwner,
  type SpellFormName,
} from '../../../src/game/spell/runtime/CancelPolicy';
import {
  SpellRuntime,
  type SpellRuntimeDelegate,
} from '../../../src/game/spell/runtime/SpellRuntime';
import Spell from '../../../src/game/gameObject/Spell';
import Champion from '../../../src/game/gameObject/attackableUnits/Champion';
import { createGame, indexObjects, stubGameGlobals, type TestGame } from '../fixtures';
import {
  installSketchMathGlobals,
  installSpellObjectGlobals,
  pressSpell,
} from '../spell/fixtures';
import type { BuffConstructor } from '../../../src/game/gameObject/Buff';
import type {
  CancelReason,
  CastSpec,
  InterruptPolicy,
  SpellRuntimeState,
} from '../../../src/game/spell/runtime/types';

const caster = (overrides: Partial<InterruptibleOwner> = {}): InterruptibleOwner => ({
  isDead: false,
  canCast: true,
  status: StatusFlags.None,
  position: { x: 0, y: 0 },
  destination: { x: 0, y: 0 },
  movementRevision: 0,
  displacementRevision: 0,
  ...overrides,
});

/** A caster with no revision counters, which is the fallback comparison path. */
const countlessCaster = (
  position: { x: number; y: number },
  destination?: { x: number; y: number }
): InterruptibleOwner => ({
  isDead: false,
  canCast: true,
  status: StatusFlags.None,
  position,
  ...(destination ? { destination } : {}),
});

class ControlBuff {
  constructor(public sourceUnit: unknown) {}
}
class UnrelatedBuff {
  constructor(public sourceUnit: unknown) {}
}
const controlClasses = [ControlBuff as unknown as BuffConstructor];

const delegate = (): { delegate: SpellRuntimeDelegate; cancelled: CancelReason[] } => {
  const cancelled: CancelReason[] = [];
  return {
    cancelled,
    delegate: {
      canStart: () => true,
      commitResource: () => true,
      refundResource: () => undefined,
      onCastStart: () => undefined,
      onChargeUpdate: () => undefined,
      onRelease: () => undefined,
      onChannelTick: () => undefined,
      onActivate: () => undefined,
      onRecast: () => undefined,
      onCancel: (_context, reason) => cancelled.push(reason),
      onComplete: () => undefined,
    },
  };
};

const specFor = (form: SpellFormName, overrides: Partial<CastSpec> = {}): CastSpec => ({
  activation: 'PRESS',
  targeting: 'SELF',
  castTimeMs: 1_000,
  resource: { commitAt: 'start', refundOn: [] },
  cooldown: { startAt: 'end', durationMs: 0 },
  interrupts: SpellForm[form],
  ...overrides,
});

describe('cancel policy: the forms', () => {
  it('holds three distinct tables: held, channeled, independent', () => {
    // HELD, AIMED and TETHERED converged on purpose — the distinctions they
    // drew were degrees of movement-fragility that no longer exist (a cast is
    // not a self-root; a blink mid-charge is a combo, not a cancel). The
    // names stay because a spell stating TETHERED still says what it *is*.
    expect(SpellForm.AIMED).toEqual(SpellForm.HELD);
    expect(SpellForm.TETHERED).toEqual(SpellForm.HELD);
    const tables = SPELL_FORM_NAMES.map(name => JSON.stringify(SpellForm[name]));
    expect(new Set(tables).size).toBe(3);
  });

  it('never lets the caster’s own feet end a held spell', () => {
    expect(SpellForm.HELD.move).toBe(false);
    expect(SpellForm.HELD.displacement).toBe(false);
  });

  it('keeps a channel fragile: a move order or a shove ends it', () => {
    expect(SpellForm.CHANNELED.move).toBe(true);
    expect(SpellForm.CHANNELED.displacement).toBe(true);
    expect(SpellForm.CHANNELED.stun).toBe(true);
  });

  it('names the distinct tables back, and the synonyms as HELD', () => {
    expect(spellFormNameOf(SpellForm.HELD)).toBe('HELD');
    expect(spellFormNameOf(SpellForm.CHANNELED)).toBe('CHANNELED');
    expect(spellFormNameOf(SpellForm.INDEPENDENT)).toBe('INDEPENDENT');
    expect(spellFormNameOf(SpellForm.AIMED)).toBe('HELD');
    expect(spellFormNameOf(SpellForm.TETHERED)).toBe('HELD');
  });

  it('treats an omitted table as HELD, the default form', () => {
    expect(resolveInterrupts(undefined)).toEqual(SpellForm.HELD);
    expect(spellFormNameOf(undefined)).toBe('HELD');
  });

  it('refuses to name a table that is not one of the forms', () => {
    expect(spellFormNameOf({ death: false })).toBeUndefined();
  });

  it('lets death through in every form, so nothing outlives its caster', () => {
    for (const name of SPELL_FORM_NAMES) {
      expect(SpellForm[name].death, name).toBe(true);
    }
  });

  it('governs exactly the five reasons a form can refuse', () => {
    const governed = (['DEATH', 'STUN', 'SILENCE', 'DISPLACEMENT', 'MOVE'] as const).map(
      interruptSwitchFor
    );
    const ungoverned: readonly CancelReason[] = [
      'PLAYER_CANCEL',
      'TARGET_INVALID',
      'OUT_OF_RANGE',
      'OUT_OF_RESOURCE',
      'MAX_DURATION',
      'EFFECT_ENDED',
      'SCENE_EXIT',
    ];

    expect(governed).toEqual(['death', 'stun', 'silence', 'displacement', 'move']);
    for (const reason of ungoverned) expect(interruptSwitchFor(reason), reason).toBeUndefined();
  });
});

describe('cancel policy: the runtime honours the form it was given', () => {
  const reasons: readonly CancelReason[] = ['DEATH', 'STUN', 'SILENCE', 'DISPLACEMENT', 'MOVE'];

  for (const name of SPELL_FORM_NAMES) {
    for (const reason of reasons) {
      const key = interruptSwitchFor(reason) as keyof InterruptPolicy;
      const expected = SpellForm[name][key];

      it(`${name} ${expected ? 'ends on' : 'survives'} ${reason}`, () => {
        const { delegate: spellDelegate, cancelled } = delegate();
        const runtime = new SpellRuntime(specFor(name), spellDelegate);
        runtime.press({
          spellId: 'spell',
          activationId: 'activation',
          startedAtMs: 0,
          caster: {},
          origin: { x: 0, y: 0 },
          cursorWorld: { x: 1, y: 0 },
          direction: { x: 1, y: 0 },
        });

        expect(runtime.cancel(reason)).toBe(expected);
        expect(cancelled).toEqual(expected ? [reason] : []);
        expect(runtime.state).toBe(expected ? 'READY' : 'CASTING');
      });
    }
  }

  it('always allows a reason no form governs', () => {
    const { delegate: spellDelegate, cancelled } = delegate();
    const runtime = new SpellRuntime(specFor('INDEPENDENT'), spellDelegate);
    runtime.press({
      spellId: 'spell',
      activationId: 'activation',
      startedAtMs: 0,
      caster: {},
      origin: { x: 0, y: 0 },
      cursorWorld: { x: 1, y: 0 },
      direction: { x: 1, y: 0 },
    });

    expect(runtime.cancel('EFFECT_ENDED')).toBe(true);
    expect(cancelled).toEqual(['EFFECT_ENDED']);
  });

  it('rejects a refund promised for an interrupt the form never fires', () => {
    const { delegate: spellDelegate } = delegate();

    expect(
      () =>
        new SpellRuntime(
          specFor('INDEPENDENT', {
            resource: { commitAt: 'start', refundOn: ['STUN'] },
          }),
          spellDelegate
        )
    ).toThrow(/refundOn lists STUN/);
  });

  it('accepts a refund for an interrupt the form does fire', () => {
    const { delegate: spellDelegate } = delegate();

    expect(
      () =>
        new SpellRuntime(
          specFor('AIMED', { resource: { commitAt: 'start', refundOn: ['STUN', 'MAX_DURATION'] } }),
          spellDelegate
        )
    ).not.toThrow();
  });
});

describe('cancel policy: reading the caster', () => {
  it('only watches a spell that is live', () => {
    const live: readonly SpellRuntimeState[] = ['CASTING', 'CHARGING', 'CHANNELING', 'ACTIVE'];
    const idle: readonly SpellRuntimeState[] = ['READY', 'COOLDOWN'];

    for (const state of live) expect(isInterruptibleState(state), state).toBe(true);
    for (const state of idle) expect(isInterruptibleState(state), state).toBe(false);
  });

  it('reports nothing while the caster is calm', () => {
    const owner = caster();

    expect(ownerInterruptReason(owner, snapshotOwnerMovement(owner))).toBeNull();
  });

  it.each([
    ['DEATH', caster({ isDead: true })],
    ['STUN', caster({ status: StatusFlags.Stunned })],
    ['STUN', caster({ status: StatusFlags.Suppressed })],
    ['SILENCE', caster({ status: StatusFlags.Silenced })],
    ['SILENCE', caster({ canCast: false })],
  ] as const)('reads %s off the caster', (reason, owner) => {
    expect(ownerInterruptReason(owner, snapshotOwnerMovement(owner))).toBe(reason);
  });

  it('reads a move order off the movement counter', () => {
    const owner = caster();
    const snapshot = snapshotOwnerMovement(owner);
    owner.movementRevision = 1;

    expect(ownerInterruptReason(owner, snapshot)).toBe('MOVE');
  });

  it('reads being shoved off the displacement counter, ahead of the move order', () => {
    const owner = caster();
    const snapshot = snapshotOwnerMovement(owner);
    owner.movementRevision = 1;
    owner.displacementRevision = 1;

    expect(ownerInterruptReason(owner, snapshot)).toBe('DISPLACEMENT');
  });

  it('puts losing control of the caster ahead of the caster moving', () => {
    const owner = caster({ status: StatusFlags.Stunned });
    const snapshot = snapshotOwnerMovement(owner);
    owner.movementRevision = 1;

    expect(ownerInterruptReason(owner, snapshot)).toBe('STUN');
  });

  it('falls back to position and destination for a caster with no counters', () => {
    const walking = countlessCaster({ x: 0, y: 0 }, { x: 100, y: 0 });
    const walkingSnapshot = snapshotOwnerMovement(walking);
    walking.position.x = 5;

    expect(ownerInterruptReason(walking, walkingSnapshot)).toBe('MOVE');

    const shoved = countlessCaster({ x: 0, y: 0 }, { x: 0, y: 0 });
    const shovedSnapshot = snapshotOwnerMovement(shoved);
    shoved.position.x = 5;

    expect(ownerInterruptReason(shoved, shovedSnapshot)).toBe('DISPLACEMENT');
  });

  it('advances the fallback snapshot, so one step is not read forever', () => {
    const owner = countlessCaster({ x: 0, y: 0 }, { x: 0, y: 0 });
    const snapshot = snapshotOwnerMovement(owner);
    owner.position.x = 5;

    expect(ownerInterruptReason(owner, snapshot)).toBe('DISPLACEMENT');
    expect(ownerInterruptReason(owner, snapshot)).toBeNull();
  });

  it('reports nothing without a snapshot to compare against', () => {
    expect(ownerInterruptReason(caster())).toBeNull();
  });
});

describe('cancel policy: suspension', () => {
  it('is off unless the spell named a buff', () => {
    expect(interruptsSuspended(caster(), undefined)).toBe(false);
    expect(interruptsSuspended(caster(), [])).toBe(false);
  });

  it('holds only while the caster actually has the named buff', () => {
    const has = vi.fn(() => true);
    const lacks = vi.fn(() => false);

    expect(interruptsSuspended(caster({ hasBuff: has }), controlClasses)).toBe(true);
    expect(interruptsSuspended(caster({ hasBuff: lacks }), controlClasses)).toBe(false);
    expect(has).toHaveBeenCalledWith(controlClasses[0]);
  });
});

describe('cancel policy: control applied by somebody else', () => {
  const source = { name: 'caster' };
  const enemy = { name: 'enemy' };

  it('finds control applied by another unit', () => {
    const self = new ControlBuff(source);
    const buffs = [self, new ControlBuff(enemy)];

    expect(foreignControlBuff(buffs, self, source, controlClasses)).toBe(buffs[1]);
  });

  it('ignores control this effect came with, so a spell cannot cancel itself', () => {
    const self = new ControlBuff(source);
    const buffs = [self, new ControlBuff(source)];

    expect(foreignControlBuff(buffs, self, source, controlClasses)).toBeUndefined();
  });

  it('ignores a buff of a class that is not on the list', () => {
    const self = new ControlBuff(source);
    const buffs: { sourceUnit: unknown }[] = [self, new UnrelatedBuff(enemy)];

    expect(foreignControlBuff(buffs, self, source, controlClasses)).toBeUndefined();
  });
});

/**
 * **A cast that movement ends has to end the movement first.**
 *
 * `ownerInterruptReason` watches `movementRevision`, which counts move
 * *orders* — so a champion who was already walking when a channel started
 * issued no new order, the watcher saw nothing, and she crossed the lane
 * firing an ultimate she is supposed to be standing still for. Reported from a
 * real match, against two different abilities.
 *
 * Driven through a real `Champion` rather than the stub the file uses above:
 * the fix is `stopMovement()`, and only a body with feet has one.
 */
describe('cancel policy: a cast plants the caster', () => {
  class Channelled extends Spell {
    name = 'Channelled';
    manaCost = 0;
    coolDown = 0;

    get castSpec(): CastSpec {
      return {
        activation: 'PRESS',
        targeting: 'SELF',
        channel: { durationMs: 2_000, tickEveryMs: 250 },
        interrupts: SpellForm.CHANNELED,
        resource: { commitAt: 'start', refundOn: [] },
        cooldown: { startAt: 'start', durationMs: 0 },
      };
    }

    onSpellCast(): void {}
  }

  /** The same spell with the form that is *not* movement-fragile. */
  class Aimed extends Channelled {
    name = 'Aimed';

    get castSpec(): CastSpec {
      return { ...super.castSpec, interrupts: SpellForm.AIMED };
    }
  }

  /** A wind-up, which is a root — that is what a cast time is. */
  class WindUp extends Channelled {
    name = 'WindUp';

    get castSpec(): CastSpec {
      return {
        activation: 'PRESS',
        targeting: 'SELF',
        castTimeMs: 300,
        resource: { commitAt: 'start', refundOn: [] },
        cooldown: { startAt: 'start', durationMs: 0 },
      };
    }
  }

  const walking = (game: TestGame): Champion => {
    const champion = new Champion({ game, teamId: 'blue' });
    champion.position.set(0, 0);
    champion.moveTo(600, 0);
    expect(champion.destination.x, 'the fixture never started walking').toBe(600);
    return champion;
  };

  let game: TestGame;
  beforeEach(() => {
    stubGameGlobals();
    installSpellObjectGlobals();
    installSketchMathGlobals();
    game = createGame();
    game.setPlayer(new Champion({ game, teamId: 'player-uuid' }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('plants a walking champion when a channel starts', () => {
    const champion = walking(game);
    indexObjects(game, [champion]);

    expect(pressSpell(new Channelled(champion))).toBe(true);

    expect(champion.destination.x, 'she kept walking through her own channel').toBe(
      champion.position.x
    );
  });

  it('does not cancel the channel it just planted', () => {
    const champion = walking(game);
    indexObjects(game, [champion]);
    const spell = new Channelled(champion);
    expect(pressSpell(spell)).toBe(true);

    vi.stubGlobal('deltaTime', 100);
    spell.update();
    vi.stubGlobal('deltaTime', 16);

    expect(spell.state).toBe('CHANNELING');
  });

  it('still ends on a move order given after it started', () => {
    const champion = walking(game);
    indexObjects(game, [champion]);
    const spell = new Channelled(champion);
    pressSpell(spell);

    champion.moveTo(-400, 0);
    vi.stubGlobal('deltaTime', 16);
    spell.update();

    expect(spell.state).not.toBe('CHANNELING');
  });

  it('leaves a form that movement does not end alone', () => {
    const champion = walking(game);
    indexObjects(game, [champion]);

    expect(pressSpell(new Aimed(champion))).toBe(true);

    expect(champion.destination.x, 'an aimed spell rooted its caster').toBe(600);
  });

  it('holds her still for the whole of a cast time', () => {
    const champion = walking(game);
    indexObjects(game, [champion]);
    const spell = new WindUp(champion);
    expect(pressSpell(spell)).toBe(true);

    // Mid-cast, and a move order arriving inside the wind-up is refused too —
    // every frame, the way a swing's wind-up holds an attacker.
    vi.stubGlobal('deltaTime', 100);
    spell.update();
    champion.moveTo(600, 0);
    spell.update();
    vi.stubGlobal('deltaTime', 16);

    expect(spell.state).toBe('CASTING');
    expect(champion.destination.x).toBe(champion.position.x);
  });
});
