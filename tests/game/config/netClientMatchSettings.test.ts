/**
 * On a LAN client the match belongs to the host, and the panel has to say so.
 *
 * A LAN match is host-authoritative: the host runs the one simulation and every
 * client draws what it is told. The match-config panel never knew that. A
 * client could drag the CDR slider, switch the jungle off, pick a different map
 * or make itself invulnerable, and each of those edited *only this device's
 * half* — the host went on playing the match it had, and the two sims disagreed
 * about the rules they were running. The LAN design spec listed exactly this
 * ("A client's *other* panel mutations — rules, world, reset, bots — still edit
 * only the local half and desync; gating those controls on `isNetClient()` is
 * v2 work"); `MatchConfigSource.canEditMatchSettings` is that gate.
 *
 * The gate is asserted here at the **source**, not through the tabs. The tabs
 * disable their controls too, but a disabled control is a courtesy and this is
 * the rule: `v-tap` binds touch events straight to the element and they still
 * fire on a disabled `<button>`, so the refusal has to hold underneath.
 *
 * Both halves matter and both are checked: what a client may **not** do, and
 * what it still **may** — its own kit and side (which cross the wire as a
 * request to the host), the way out, and every setting that describes this
 * screen rather than the match.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MatchDirector from '../../../src/game/MatchDirector';
import MatchDirectorSource, {
  type MatchDirectorHost,
} from '../../../src/game/hud/config/MatchDirectorSource';
import {
  DEFAULT_MAP_ID,
  DEFAULT_PREGAME_CONFIG,
  savePregameConfig,
} from '../../../src/game/config/PregameConfig';
import { MatchTeam } from '../../../src/game/config/MatchTeams';
import { resetNetRoleForTests, setNetRole } from '../../../src/game/net/netRole';
import { context as practiceContext } from '../practice/helpers';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

const OTHER_MAP_ID = 'probe:elsewhere';

let director: MatchDirector;
let source: MatchDirectorSource;
let exits: number;
let restarts: number;
let shopsOpened: string[];

const fakeHost = (host: MatchDirector): MatchDirectorHost => {
  let zoom = 1;
  return {
    director: host,
    camera: {
      get zoomFactor() {
        return zoom;
      },
      setZoomFactor(factor: number) {
        zoom = factor;
      },
      snapToScale() {},
    },
    touchUi: false,
    openShopFor: (id: string) => shopsOpened.push(id),
    activeMapId: DEFAULT_MAP_ID,
    renderQuality: 'auto',
    renderFps: 60,
    renderScale: 'auto',
    mapGround: 'detailed',
    setRenderQuality() {},
    setRenderFps() {},
    setRenderScale() {},
    setMapGround() {},
    setTouchUiEnabled() {},
    requestExit() {
      exits++;
    },
    requestRestart() {
      restarts++;
    },
    // A client is in a LAN match by definition, so the seam that reads this
    // must see a session — see the `canRestart` assertion below.
    net: { netRosterUnits: () => [] },
  };
};

/** The player's row id — the only row on a client that is not a remote one. */
const playerId = (): string => source.roster()[0].id;

const build = async (): Promise<void> => {
  const storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage, location: { search: '' } });
  vi.stubGlobal('document', { body: { classList: { toggle: () => {} } } });
  savePregameConfig({ ...DEFAULT_PREGAME_CONFIG, ai: { ...DEFAULT_PREGAME_CONFIG.ai, count: 0 } });

  exits = 0;
  restarts = 0;
  shopsOpened = [];
  const { context } = practiceContext();
  director = new MatchDirector(context, {
    loadPreset: async loadout => ({
      name: loadout.championName === 'random' ? 'Ngẫu Nhiên' : loadout.championName,
      spells: [],
    }),
  });
  source = new MatchDirectorSource(fakeHost(director));
};

beforeEach(build);

afterEach(() => {
  // The role is process-wide (see `net/netRole.ts`), so a suite that sets it
  // and does not clear it hands the next file a client.
  resetNetRoleForTests();
  vi.unstubAllGlobals();
});

describe('a host (or a match with no network at all)', () => {
  it('may edit the match settings', () => {
    expect(source.canEditMatchSettings).toBe(true);

    source.setRules({ cooldownReductionPercent: 40, manaFree: true, recall: true }, true);
    source.setWorld({ jungle: false, minions: false });
    source.setMap(OTHER_MAP_ID);

    expect(source.getRules()).toEqual({ cooldownReductionPercent: 40, manaFree: true, recall: true });
    expect(source.getWorld()).toEqual({ jungle: false, minions: false });
    expect(director.mapChoice).toBe(OTHER_MAP_ID);
  });

  it('may use the practice cheats', () => {
    const id = playerId();
    const refill = vi.spyOn(director, 'refill');
    // A champion starts the match with a purse, so the assertion is the
    // difference rather than the total.
    const purse = source.live.goldOf(id);

    source.setInvulnerable(id, true);
    source.live.refill(id);
    source.live.grantGold(id, 500);
    source.live.openShopFor(id);

    expect(source.roster()[0].invulnerable).toBe(true);
    expect(refill).toHaveBeenCalledTimes(1);
    expect(source.live.goldOf(id)).toBe(purse + 500);
    expect(shopsOpened).toEqual([id]);
  });
});

describe('a LAN client', () => {
  beforeEach(() => setNetRole('client', { playerTeam: MatchTeam.BLUE }));

  it('reports that it may not edit the match settings', () => {
    expect(source.canEditMatchSettings).toBe(false);
  });

  it('cannot change the rules — CDR or URF', () => {
    const before = source.getRules();

    source.setRules({ cooldownReductionPercent: 90, manaFree: true, recall: true }, true);
    // The mid-drag path too: `persist: false` still applies the value to the
    // running match, which is exactly what must not happen here.
    source.setRules({ cooldownReductionPercent: 90, manaFree: true, recall: true }, false);

    expect(source.getRules()).toEqual(before);
  });

  it('cannot switch the jungle or the minions off', () => {
    expect(source.getWorld()).toEqual({ jungle: true, minions: true });

    source.setWorld({ jungle: false });
    source.setWorld({ minions: false });

    expect(source.getWorld()).toEqual({ jungle: true, minions: true });
  });

  it('cannot pick a different map', () => {
    source.setMap(OTHER_MAP_ID);
    expect(director.mapChoice).toBe(DEFAULT_MAP_ID);
  });

  it('cannot make anyone invulnerable', () => {
    source.setInvulnerable(playerId(), true);
    expect(source.roster()[0].invulnerable).toBe(false);
  });

  it('cannot refill, clear cooldowns, grant gold or hand out items', () => {
    const id = playerId();
    const refill = vi.spyOn(director, 'refill');
    const clearCooldowns = vi.spyOn(director, 'clearCooldowns');
    const purse = source.live.goldOf(id);

    source.live.refill(id);
    source.live.clearCooldowns(id);
    source.live.grantGold(id, 5_000);
    source.live.openShopFor(id);

    expect(refill).not.toHaveBeenCalled();
    expect(clearCooldowns).not.toHaveBeenCalled();
    expect(source.live.goldOf(id)).toBe(purse);
    expect(shopsOpened).toEqual([]);
  });

  it('cannot add a bot — it would walk a lane only this device can see', async () => {
    const before = source.botCount();
    expect(source.canAddBot()).toBe(false);

    await source.addBot(MatchTeam.RED);

    expect(source.botCount()).toBe(before);
  });

  it('cannot remove one either', async () => {
    // Added by the host side of the same bench, before the role flips.
    resetNetRoleForTests();
    await source.addBot(MatchTeam.RED);
    const bot = source.roster().find(row => !row.isPlayer)!;
    setNetRole('client', { playerTeam: MatchTeam.BLUE });

    source.removeBot(bot.id);

    expect(source.roster().some(row => row.id === bot.id)).toBe(true);
  });

  it('cannot pick a mode — that is the host’s room', async () => {
    setNetRole('client', { playerTeam: MatchTeam.BLUE });

    await source.setMode('urf');

    expect(source.getMode()).toBe('classic');
    expect(source.getRules().cooldownReductionPercent).toBe(0);
  });

  it('cannot reset the match to defaults — the one press that undoes every other refusal', async () => {
    // Seeded by a host-side path, so there is something a reset would move.
    director.setRules({ cooldownReductionPercent: 30, manaFree: true, recall: true });
    setNetRole('client', { playerTeam: MatchTeam.BLUE });

    await source.resetToDefaults();

    expect(source.getRules()).toEqual({ cooldownReductionPercent: 30, manaFree: true, recall: true });
  });

  // ------------------------------------------------------------ still allowed

  it('may still move itself to the other side — that one crosses the wire', () => {
    const id = playerId();
    expect(source.roster()[0].team).toBe(MatchTeam.BLUE);

    source.setTeam(id, MatchTeam.RED);

    expect(source.roster()[0].team).toBe(MatchTeam.RED);
  });

  it('may still leave the match', () => {
    source.live.requestExit();
    expect(exits).toBe(1);
  });

  /**
   * But not remake it — and that one is not about the client's authority, since
   * a *host* is refused too. `GameScene.stopGame` closes the socket with the
   * match, so the reboot hosts a fresh room and everyone else is dropped into
   * one whose code they were never given. A LAN match is remade by its room.
   */
  it('may not boot a new match over the top of the room', () => {
    expect(source.live.canRestart).toBe(false);

    source.live.restart();

    expect(restarts).toBe(0);
  });

  it('may still change what only this screen shows', () => {
    // `revealMap` and the debug layers are on `CheatConfig` but are not cheats
    // on the match: they change what this device draws and nothing else.
    source.setCheats({ revealMap: true });
    expect(source.getCheats().revealMap).toBe(true);

    source.live.setZoom(1.5);
    expect(source.live.zoom).toBe(1.5);
  });
});
