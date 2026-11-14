import { readFileSync } from 'node:fs';
import { toRaw } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHudInteractions,
  filterSpells,
  type SpellItemDisplay,
} from '../../../src/game/hud/hudInteractions';
import { activePanelTab } from '../../../src/game/hud/config/panelTab';

const spell = (overrides: Partial<SpellItemDisplay>): SpellItemDisplay => ({
  name: 'Quả Cầu Ma Thuật',
  image: '',
  description: 'Phóng quả cầu theo hướng chỉ định',
  coolDown: 6000,
  manaCost: 40,
  spellClass: class {},
  assetKey: null,
  ...overrides,
});

describe('filterSpells', () => {
  const spells = [
    spell({ name: 'Ahri Q', description: 'a magic orb' }),
    spell({ name: 'Yasuo Q', description: 'steel tempest, a sword slash' }),
    spell({ name: 'Ném Băng', description: 'làm chậm mục tiêu' }),
  ];

  it('returns everything when the search is empty', () => {
    expect(filterSpells(spells, '')).toHaveLength(3);
  });

  it('matches on the name, case-insensitively', () => {
    expect(filterSpells(spells, 'yasuo').map(s => s.name)).toEqual(['Yasuo Q']);
  });

  it('matches on the description', () => {
    expect(filterSpells(spells, 'sword').map(s => s.name)).toEqual(['Yasuo Q']);
  });

  it("is accent-insensitive, the way removeAccents' NFD stripping supports", () => {
    // "Ném Băng" without the diacritics should still find it — the same
    // normalize('NFD') + combining-mark strip that `removeAccents` (and this
    // search) is built on. Note this does *not* cover every Vietnamese
    // letter: 'Đ'/'đ' is a distinct base letter, not a decomposable accent,
    // so a search for it has the same limitation the rest of the app already
    // has via `removeAccents` — not a regression introduced here.
    expect(filterSpells(spells, 'nem bang').map(s => s.name)).toEqual(['Ném Băng']);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterSpells(spells, 'nonexistent-champion')).toEqual([]);
  });
});

describe('practice range controls', () => {
  /**
   * The DOM half of "apply while dragging, save on release". That the *source*
   * honours `persist: false` is asserted behaviourally, against both
   * implementations, in `matchConfigSource.contract.test.ts`; what a behaviour
   * test cannot see is that the slider is wired to both events at all.
   */
  it('applies CDR live on input and commits on change', () => {
    const source = readFileSync('src/game/hud/config/MatchTab.vue', 'utf8');

    expect(source).toContain('@input="onCdrInput"');
    expect(source).toContain('@change="onCdrChange"');
    expect(source).toContain('setCdr(cdrValue(event), false)');
    expect(source).toContain('setCdr(cdrValue(event), true)');
  });

  it('lazy-loads below-fold catalogue art instead of decoding it all on modal open', () => {
    const roster = readFileSync('src/scenes/setup/KitRoster.vue', 'utf8');
    const icon = readFileSync('src/scenes/setup/SpellIcon.vue', 'utf8');

    expect(roster).toContain('loading="lazy"');
    expect(roster).toContain('<SpellIcon :display="item.entry.display" lazy />');
    expect(icon).toContain(":loading=\"lazy ? 'lazy' : 'eager'\"");
  });

  it('exposes persistent quality and FPS controls in the settings tab', () => {
    const source = readFileSync('src/game/hud/config/SettingsTab.vue', 'utf8');

    expect(source).toContain('id="practice-render-quality"');
    expect(source).toContain('id="practice-render-fps"');
    expect(source).toContain('source.setRenderQuality');
    expect(source).toContain('source.setRenderFps');
    expect(source).toContain('id="practice-render-scale"');
    expect(source).toContain('source.setRenderScale');
    expect(source).toContain('id="practice-map-ground"');
    expect(source).toContain('source.setMapGround');
    expect(source).toContain('Nền bản đồ');
    expect(source).toContain('Chi tiết — đẹp');
    expect(source).toContain('Đơn giản — dễ nhìn chiêu');
    // Folded summary: named only when it is not the default.
    expect(source).toMatch(/if \(mapGround\.value === 'plain'\) parts\.push/);
  });

  it('waits for a default reset and disables its button while kits are loading', () => {
    const source = readFileSync('src/game/hud/config/MatchTab.vue', 'utf8');

    expect(source).toContain('await source.resetToDefaults()');
    // `resetting` still disables it, and `canEdit` now does too — a LAN client
    // may not reset a match it does not own. Matched on the `resetting` term
    // alone rather than the whole expression, so adding a third reason to
    // disable this button is not a test edit; that a *client* cannot press it
    // is asserted properly in `config/netClientMatchSettings.test.ts`.
    expect(source).toMatch(/:disabled="[^"]*\bresetting\b[^"]*"/);
  });
});

describe('createHudInteractions — the Tab scoreboard', () => {
  const fakeGame = () =>
    ({
      player: { spells: [{}, {}] },
      objectManager: { objects: [] },
      renderQuality: 'auto',
      renderFps: 60,
      renderScale: 'auto',
      mapGround: 'detailed',
      setRenderQuality: vi.fn(),
      setRenderFps: vi.fn(),
      setRenderScale: vi.fn(),
      setMapGround: vi.fn(),
      pause: vi.fn(),
      unpause: vi.fn(),
    }) as any;

  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
  });

  it('is held, not toggled, from the key — and toggled from the corner button', () => {
    const hud = createHudInteractions(fakeGame());
    expect(hud.showScoreboard).toBe(false);
    hud.setScoreboard(true);
    hud.setScoreboard(true);
    expect(hud.showScoreboard).toBe(true);
    hud.setScoreboard(false);
    expect(hud.showScoreboard).toBe(false);
    hud.toggleScoreboard();
    expect(hud.showScoreboard).toBe(true);
    hud.toggleScoreboard();
    expect(hud.showScoreboard).toBe(false);
  });

  it('is the first thing Escape drops, and never pauses the match', () => {
    const game = fakeGame();
    const hud = createHudInteractions(game);
    hud.setScoreboard(true);
    hud.escape();
    expect(hud.showScoreboard).toBe(false);
    expect(hud.showSpellsPicker).toBe(false);
    expect(game.pause).not.toHaveBeenCalled();
  });
});

describe('createHudInteractions — the ways into the practice panel', () => {
  const fakeGame = () =>
    ({
      player: { spells: [{}, {}] },
      objectManager: { objects: [] },
      renderQuality: 'auto',
      renderFps: 60,
      renderScale: 'auto',
      mapGround: 'detailed',
      setRenderQuality: vi.fn(),
      setRenderFps: vi.fn(),
      setRenderScale: vi.fn(),
      setMapGround: vi.fn(),
      pause: vi.fn(),
      unpause: vi.fn(),
    }) as any;

  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
  });

  /**
   * Reported from a real match: hover a buff to read what it does, wait for
   * it to expire, and the panel stays open describing a buff that is over.
   *
   * A buff row is the one thing on this HUD that can vanish under the pointer,
   * and removing a hovered element does not fire `mouseout` — the browser sends
   * it on the next mouse move, which may be seconds away or never. So nothing
   * was ever going to close it.
   */
  describe('a description panel does not outlive the buff it describes', () => {
    const buff = (name: string) => ({ name, note: 0, description: name });

    it('lets go when the buff ends underneath the pointer', () => {
      const hud = createHudInteractions(fakeGame());
      const chill = buff('Chậm');
      hud.spellHover = chill;

      hud.releaseEndedHover([chill], []);
      expect(hud.spellHover).toBeNull();
    });

    it('holds on while the buff is still running', () => {
      const hud = createHudInteractions(fakeGame());
      const chill = buff('Chậm');
      hud.spellHover = chill;

      // `hudState.ts` reuses one display object per kind of buff, which is
      // what makes this identity question answerable at all — and what keeps
      // the countdown in the panel counting.
      hud.releaseEndedHover([chill], [chill, buff('Choáng')]);
      expect(toRaw(hud.spellHover)).toBe(chill);
    });

    it('never touches a hover that was not a buff row', () => {
      // The case that makes the *previous* list load-bearing rather than
      // decorative. `buildItems` mints a fresh object every tick, so an item
      // hover is never in the new snapshot either — and releasing on that
      // alone would close an item tooltip twenty times a second.
      const hud = createHudInteractions(fakeGame());
      const sword = { name: 'Kiếm Dài', filled: true };
      hud.spellHover = sword;

      hud.releaseEndedHover([buff('Chậm')], []);
      expect(toRaw(hud.spellHover)).toBe(sword);
    });

    it('survives having nothing hovered at all', () => {
      const hud = createHudInteractions(fakeGame());
      expect(() => hud.releaseEndedHover([], [buff('Chậm')])).not.toThrow();
      expect(hud.spellHover).toBeNull();
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('the corner button opens the panel with no slot in mind, and pauses', () => {
    const game = fakeGame();
    const hud = createHudInteractions(game);
    hud.openSpellPicker();
    expect(hud.showSpellsPicker).toBe(true);
    expect(hud.editPlayerSlot).toBeNull();
    expect(game.pause).toHaveBeenCalledOnce();
  });

  /**
   * Tapping the bottom-HUD portrait means "show me the team", and saying that
   * takes a way in of its own.
   *
   * `openSpellPicker` cannot serve it: `activePanelTab` deliberately outlives
   * the panel, the match and even the scene (see `panelTab.ts`), so the corner
   * button reopens wherever the player last was. For anyone who was last on
   * Cài đặt, a portrait wired to it would open the display settings.
   */
  it('the avatar gesture opens the panel on Đội, wherever it was left', () => {
    const hud = createHudInteractions(fakeGame());
    activePanelTab.value = 'settings';

    hud.openRoster();

    expect(activePanelTab.value).toBe('roster');
    expect(hud.showSpellsPicker).toBe(true);
  });

  it('pauses on the way in, the way every other door into the panel does', () => {
    const game = fakeGame();

    createHudInteractions(game).openRoster();

    expect(game.pause).toHaveBeenCalledOnce();
  });

  /**
   * The shop does not pause and the panel does, so both being up at once is
   * two full-width panels arguing over a 390px screen — the same reason
   * `openShopFor` closes the panel going the other way.
   */
  it('closes the shop on the way in', () => {
    const hud = createHudInteractions(fakeGame());
    hud.showShop = true;

    hud.openRoster();

    expect(hud.showShop).toBe(false);
  });

  /**
   * `GameScene` cancels touches on the canvas, so a thumb synthesises no
   * `click` — the same thing the recall button's scan below checks, and the
   * one thing no behaviour test of `hudInteractions` can see. The portrait is
   * desktop-only (`MobileHudView` renders no bottom strip at all), but the
   * desktop view is what a touch laptop shows too.
   */
  it('the portrait answers a thumb as well as a mouse', () => {
    const source = readFileSync('src/game/hud/DesktopHudView.vue', 'utf8');

    expect(source).toContain('@click="hud.openRoster()"');
    // the guard form, not a bare `@touchend` — a drag that merely began on
    // the portrait must not open the roster on release (tapGuard.ts)
    expect(source).toContain('v-tap="() => hud.openRoster()"');
  });

  it('does not build or expose an unused full spell catalogue', () => {
    const hud = createHudInteractions(fakeGame());

    expect('allSpells' in hud).toBe(false);
    expect('spellGroups' in hud).toBe(false);
    expect('preloadSpellIcons' in hud).toBe(false);
  });

  it('routes render preferences to the live game', () => {
    const game = fakeGame();
    const hud = createHudInteractions(game);

    expect((hud as any).setRenderQuality).toBeTypeOf('function');
    expect((hud as any).setRenderFps).toBeTypeOf('function');
    (hud as any).setRenderQuality('low');
    (hud as any).setRenderFps(30);

    expect(game.setRenderQuality).toHaveBeenCalledWith('low');
    expect(game.setRenderFps).toHaveBeenCalledWith(30);

    (hud as any).setRenderScale(75);
    expect(game.setRenderScale).toHaveBeenCalledWith(75);
    expect((hud as any).renderScale).toBe('auto');

    (hud as any).setMapGround('plain');
    expect(game.setMapGround).toHaveBeenCalledWith('plain');
    expect((hud as any).mapGround).toBe('detailed');
  });

  it('always opens: a second press cannot toggle an open panel shut', () => {
    const hud = createHudInteractions(fakeGame());
    hud.openSpellPicker();
    hud.openSpellPicker();
    expect(hud.showSpellsPicker).toBe(true);
  });

  /**
   * The desktop strip's per-icon shortcut. `RosterTab` reads `editPlayerSlot`
   * on mount to open the player's loadout editor on that slot — the gesture
   * the deleted picker's `changeSpell(index)` used to carry.
   */
  it('a strip icon opens the panel carrying the slot that was clicked', () => {
    const game = fakeGame();
    const hud = createHudInteractions(game);
    hud.openPlayerLoadout(3);
    expect(hud.showSpellsPicker).toBe(true);
    expect(hud.editPlayerSlot).toBe(3);
    expect(game.pause).toHaveBeenCalledOnce();
  });

  it('closing clears the requested slot, so reopening does not reopen the editor', () => {
    const game = fakeGame();
    const hud = createHudInteractions(game);
    hud.openPlayerLoadout(3);
    hud.closeSpellPicker();
    expect(hud.showSpellsPicker).toBe(false);
    expect(hud.editPlayerSlot).toBeNull();
    expect(game.unpause).toHaveBeenCalledOnce();
  });
});

/**
 * Hồi Thành has two surfaces now — the desktop button here and the on-canvas
 * touch button — and one action. `Game.recall()` already owns "start it, or
 * call the trip off"; neither surface is allowed a second copy of that rule.
 */
describe('createHudInteractions — Hồi Thành', () => {
  const fakeGame = () =>
    ({
      player: { spells: [{}, {}] },
      objectManager: { objects: [] },
      renderQuality: 'auto',
      renderFps: 60,
      renderScale: 'auto',
      mapGround: 'detailed',
      setRenderQuality: vi.fn(),
      setRenderFps: vi.fn(),
      setRenderScale: vi.fn(),
      setMapGround: vi.fn(),
      pause: vi.fn(),
      unpause: vi.fn(),
      recall: vi.fn(),
    }) as any;

  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards to Game.recall() rather than reaching for the spell itself', () => {
    const game = fakeGame();
    const hud = createHudInteractions(game);

    (hud as any).recall();
    (hud as any).recall();

    expect(game.recall).toHaveBeenCalledTimes(2);
  });

  it('does not pause the match the way the panel buttons do', () => {
    const game = fakeGame();
    createHudInteractions(game).recall();

    expect(game.pause).not.toHaveBeenCalled();
  });

  /**
   * `GameScene` cancels touches on the canvas, so a thumb never synthesises a
   * `click` — a control with only `@click` is perfect under a mouse and dead
   * under a finger. This is the one thing about the button no behaviour test
   * of `hudInteractions` can see.
   */
  it('the desktop button answers a thumb as well as a mouse, and shows its key', () => {
    const source = readFileSync('src/game/hud/DesktopHudView.vue', 'utf8');

    expect(source).toContain('class="recall-btn"');
    expect(source).toContain('@click="hud.recall()"');
    // the guard form, not a bare `@touchend` — see tapGuard.ts
    expect(source).toContain('v-tap="() => hud.recall()"');
    expect(source).toContain('state.recall.hotKey');
    expect(source).toContain('state.recall.progressPercent');
  });
});
