/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The other half of the shared layer: not display data but what a thumb or a
 * cursor *does* — opening the practice panel, hovering a description.
 *
 * One `HudInteractions` object is created once per game and `provide()`d to
 * the whole HUD Vue app, so `DesktopHudView`, `MobileHudView` and the practice
 * panel all read and mutate the same reactive state instead of three
 * independent copies that could drift — opening the panel from the corner
 * button has to be visible to the panel, which is a different component. See
 * `docs/ADDING_SPELLS.md` for the spell registration this drives.
 *
 * The spell-picking surface that used to live here — `draftSpells`, `pick`,
 * `confirmPicks`, the two mode flags and the icon long-press handlers — went
 * with the Chiêu thức tab. `RosterTab`'s loadout editor is a superset of it
 * (every unit, not just the player, and whole saved kits), so what is left
 * here is the way *in*: `openSpellPicker` for the corner button and
 * `openPlayerLoadout` for the desktop strip's per-slot shortcut.
 *
 * `GameScene` now cancels only touches whose target is the game canvas. DOM
 * controls layered above it retain native click, input and scroll behavior.
 */
import { markRaw, reactive, toRaw } from 'vue';
import type Game from '@/game/Game';
import type { RenderFps } from '@/game/Game';
import type MatchDirector from '@/game/MatchDirector';
import type Camera from '@/game/gameObject/map/Camera';
import type { RenderQuality } from '@/game/managers/ObjectManager';
import { removeAccents } from '@/utils/index';
import type { AssetKey } from '@/managers/AssetManager';
import type Champion from '@/game/gameObject/attackableUnits/Champion';
import type { NetGameHooks } from '@/game/net/hooks';
import { atOwnFountain, buyItem, sellItem, type ShopMode } from '@/game/economy/ItemShop';
import { captureCheckpoint, restoreCheckpoint } from '@/game/checkpoint/Checkpoint';
import { SAVED_MOMENT_NAME_MAX, saveSavedMoment } from '@/game/config/savedMoments';
import {
  canRedoShop,
  canUndoShop,
  redoShop,
  undoShop,
} from '@/game/economy/ShopHistory';
import { sellRows, shopRows, type SellRow, type ShopRow } from '@/game/hud/shop/shopState';
import { contentCatalog } from '@/content/catalog';
import { activePanelTab } from './config/panelTab';

export interface SpellItemDisplay {
  name: string;
  image: string;
  description: string;
  coolDown: number;
  manaCost: number;
  spellClass: any;
  assetKey: AssetKey | null;
}

/**
 * Case/accent-insensitive matching over a spell list, by name or description.
 *
 * A plain function of its inputs so the matching is testable without building
 * a whole `HudInteractions` (which needs a `Game`, `AssetManager`, the real
 * spell classes, ...). Nothing in the HUD renders a search box today — the
 * picker that would have grown one is gone, and the loadout editor searches
 * `pregameCatalog` instead — so this is a ready seam rather than a live path,
 * kept because it is the one piece of the picker that was never picker-shaped.
 */
export function filterSpells(spells: SpellItemDisplay[], searchText: string): SpellItemDisplay[] {
  const search = removeAccents(searchText.toLowerCase());
  if (search === '') return spells;
  return spells.filter(spell => {
    const name = removeAccents(spell.name.toLowerCase());
    const desc = removeAccents(spell.description.toLowerCase());
    return name.includes(search) || desc.includes(search);
  });
}

/**
 * One save point as the "Mốc đã lưu" modal lists it. A bare view model —
 * name, stamps, one summary line — so the modal never holds a live
 * `Checkpoint`, whose unit and constructor references belong to the game
 * graph.
 */
export interface CheckpointRow {
  id: string;
  name: string;
  /** True for rows the match saved on its own. */
  auto: boolean;
  /** Match time at capture, m:ss. */
  clock: string;
  /** "72% máu · 1450 vàng · 3 trang bị" — built at capture. */
  summary: string;
  /** Already kept to the cross-session library this session. */
  kept: boolean;
}

export interface HudInteractions {
  /**
   * Every mutation of the running match — roster, world, rules — so the panel's
   * tabs never reach into `objectManager` or `minionSpawner` themselves. Read
   * off `game` on access rather than captured: `Game` builds its `InGameHUD`
   * (and so this object) part-way through its own constructor, before
   * `game.director` exists.
   */
  readonly director: MatchDirector;
  /**
   * The live camera, for the zoom slider. Same lazy `markRaw` shape as
   * `director` and for the same two reasons: the HUD is built part-way through
   * `Game`'s constructor, and a `reactive()` camera would hand back proxied p5
   * vectors on every read, every frame.
   */
  readonly camera: Camera;
  /**
   * Whether this client has lost the host — `null` on a host, and on any
   * offline match, which is what "there is no wire to lose" looks like here.
   *
   * A getter off `game.net` rather than a copy, for `director`'s own reason:
   * a session is attached *after* this object is built, and the answer changes
   * every few seconds once it is.
   */
  readonly netLink: { lost: boolean } | null;
  /**
   * Whether the practice panel is up. Keeps the `SpellsPicker` name it was
   * born with: it is read by all three e2e scripts off
   * `game.inGameHUD.vueInstance.hud`, and renaming it would reach into every
   * one of them for no behaviour.
   */
  showSpellsPicker: boolean;
  /**
   * Which of the player's slots the panel should open the loadout editor on,
   * or `null` for "just open the panel". Set by the desktop strip's per-icon
   * shortcut (`openPlayerLoadout`) and consumed once, on mount, by
   * `RosterTab` — the gesture crosses two components that never meet, so it
   * travels through the object both of them already inject.
   */
  editPlayerSlot: number | null;
  spellHover: any;
  spellInfo: { top: string; bottom: string; left: string; width: string };
  /** Mirrors game.touchControls.enabled; both views read it, neither owns it. */
  touchUi: boolean;
  /**
   * The qualified id of the map this match is actually running on —
   * `game.activeMapId`, fixed for the whole match. `MatchDirectorSource.getMap()`
   * reads this directly, the same way it reads `renderQuality`/`renderFps`
   * off this object rather than through `director`: a fact about the match,
   * not one of its mutable settings.
   */
  readonly activeMapId: string;
  /**
   * The attached LAN session, or null offline — `Game.net`, read lazily
   * because the session attaches *after* the game (the transport connect is
   * async), so a value captured at construction would be null for ever. The
   * Đội tab's LAN rows read it through `MatchDirectorSource`
   * (`MatchDirectorHost.net`) — forgetting this getter was exactly why those
   * rows compiled fine (the member is optional) and never appeared.
   */
  readonly net: NetGameHooks | null;
  readonly renderQuality: RenderQuality;
  readonly renderFps: RenderFps;
  setRenderQuality(quality: RenderQuality): void;
  setRenderFps(fps: RenderFps): void;
  /** The camera-shake toggle — `Game.screenShake` / `Game.setScreenShake`. */
  readonly screenShake: boolean;
  setScreenShake(enabled: boolean): void;
  /**
   * Apply a touch/pointer switch to the *running* match — the on-screen
   * controls and the HUD layout both. The config panel's Cài đặt tab is the
   * only caller: that control used to exist only on the pregame screen, so a
   * player who had already pressed Chơi could not reach it at all.
   *
   * It does not remember anything. The panel stores the tri-state
   * (`'auto' | 'touch' | 'pointer'`) through `setTouchModePreference` itself,
   * and the boolean this takes cannot express `'auto'` — so `remember` is
   * `false` here on purpose, or picking `Tự động` would be written back as
   * whichever side detection happened to resolve to.
   */
  setTouchUiEnabled(enabled: boolean): void;

  /**
   * Set by whichever component has a layer open *over* the panel — today only
   * `RosterTab`, while its loadout editor is up. Returns whether it consumed
   * the Escape. `null` when there is no inner layer, which is the usual case.
   *
   * It lives here rather than in the component because the key never reaches
   * the DOM: p5 binds `keydown` on `window` and `GameScene` routes it, so the
   * only thing the two ends share is this object.
   */
  onEscapeInner: (() => boolean) | null;

  /**
   * What Escape means now. Innermost layer first — the same "the backdrop
   * steps back one layer" rule the setup screen follows — then the panel:
   * closed opens it, open closes it the way the close button does.
   */
  escape(): void;
  /**
   * Leave the match. Calls `Game.onExitRequested`, which `GameScene` set to
   * its own `showScene(MenuScene)`: quitting is a scene transition, not a
   * mutation of the running match, so it is deliberately not a
   * `MatchDirector` method.
   */
  requestExit(): void;
  /**
   * Boot a new match on the config as it now stands. Calls
   * `Game.onRestartRequested`, which `GameScene` set to `showScene(GameScene)`
   * — a scene transition for the same reason `requestExit` is one.
   *
   * The map is why this exists: a live `Game` reads its geometry once, at
   * construction, so it is the one thing the config panel can change and not
   * apply. See `MapPickerModal.vue`.
   */
  requestRestart(): void;
  /**
   * Opens the panel with no slot in mind — the corner button's entry point,
   * in both modes.
   */
  openSpellPicker(): void;
  /**
   * Open the panel **on Đội** — the bottom-HUD portrait's entry point.
   *
   * Not `openSpellPicker`, and the difference is the whole reason this exists:
   * `activePanelTab` deliberately outlives the panel, the match and the scene
   * (`config/panelTab.ts` says why), so the corner button reopens wherever the
   * player last was. That is right for a general way in and wrong for a
   * gesture that names what it wants — a portrait wired to it would open the
   * display settings for anyone who was last on Cài đặt.
   *
   * Desktop only, because there is no portrait to press anywhere else:
   * `MobileHudView` renders no bottom strip, on the grounds that a unit's
   * on-map body already *is* its avatar.
   */
  openRoster(): void;
  /**
   * The desktop strip's shortcut: open the panel on Đấu thủ with the player's
   * loadout editor already open, aimed at the slot whose icon was clicked.
   * The gesture the old picker's `changeSpell(index)` had, pointed at the
   * editor that replaced it.
   */
  openPlayerLoadout(index: number): void;
  closeSpellPicker(): void;
  /**
   * Hồi Thành, from the desktop HUD's button.
   *
   * Nothing but a forward to `Game.recall()`, which owns both halves of it —
   * press to go home, press again to call the trip off. The `B` key, this
   * button and the on-canvas touch button are three ways into one action, and
   * a second copy of "is it already channelling?" in any of them is how they
   * would come to disagree. It does **not** pause: unlike every other control
   * on this object it is a move in the match, not a way into the panel.
   */
  recall(): void;
  /**
   * The next living ally for the death camera — the spectate pill's press.
   * A move in the match like `recall`, not a way into the panel: it does not
   * pause. `Game.deathCamera.next()`, one line.
   */
  spectateNext(): void;
  /**
   * The "Mốc đã lưu" modal is open over the paused match.
   *
   * A pausing layer like `showSpellsPicker` and unlike the shop: rewinding
   * writes half the world back and nothing may tick between the reads and
   * the writes. Mutually exclusive with both other modals for the same
   * full-width reason they are with each other.
   *
   * In a LAN match this whole surface does not exist: the corner button and
   * the death shortcut hide (`HudState.hasCheckpoint`), every method below
   * refuses, and `restoreCheckpoint` itself refuses again underneath — the
   * protocol is forward-only and a rewind under a session would desync it.
   */
  showCheckpoints: boolean;
  /** The corner button's entry point. Pauses; closes the other modals first. */
  openCheckpoints(): void;
  closeCheckpoints(): void;
  /**
   * This match's save points as rows, newest first — plain view models, no
   * live references, so the modal renders without touching the game graph.
   */
  checkpointRows(): CheckpointRow[];
  /**
   * Write the moment down, named "Mốc N". Cheap enough to spam — scalars and
   * references, no cloning — which is the point of the button being one
   * press with no dialog.
   */
  saveCheckpoint(): void;
  /** Rewind the running match to this save point and close the modal. */
  rewindToCheckpoint(id: string): void;
  /**
   * The death screen's shortcut. Armed only by a save the player made on
   * purpose: with one, it rewinds straight to the newest such save; with
   * none, it opens the "Mốc đã lưu" modal instead — the auto "Đầu trận"
   * anchor must never be a single press away from a death, or a newcomer
   * with twenty minutes of progress learns the feature by losing it.
   */
  retryFromCheckpoint(): void;
  renameCheckpoint(id: string, name: string): void;
  deleteCheckpoint(id: string): void;
  /**
   * Persist this save point to the cross-session library
   * (`config/savedMoments.ts`), so the menu can reopen the moment in a later
   * session. Answers whether it was written. Transient buffs stay behind —
   * the library's own header says why — and the shelf's row says so.
   */
  keepCheckpoint(id: string): boolean;
  /**
   * The shop is open over the match.
   *
   * A separate layer from `showSpellsPicker`, and the two are mutually
   * exclusive by construction — opening either closes the other — because both
   * are full-width modals and stacking them leaves a player looking at two
   * close buttons.
   *
   * **It does not pause.** Every other panel here does, and this one must not:
   * pausing at will would make the shop a way to freeze a fight, and the
   * fountain rule is only a rule while the world keeps moving. It also means
   * the panel's own "can I buy this" reads stay live — walk off the platform
   * and every card greys out under the cursor, which is how the rule teaches
   * itself.
   */
  showShop: boolean;
  /**
   * Whose shop is open — `null` for the player's own, which is the default and
   * the only thing the corner button and the `P` key ever set. See
   * `openShopFor`; it is an id rather than a champion because a captured
   * reference outlives the unit it points at.
   */
  shopSubjectId: string | null;
  /**
   * Whether closing the shop should put the config panel back. Set only by
   * `openShopFor`, and only when that panel was actually up — see its own
   * comment for why the shop replaces the panel rather than stacking over it.
   */
  shopReturnsToPanel: boolean;
  /** Open it. Refuses nothing: the cards carry their own refusals. */
  openShop(): void;
  closeShop(): void;
  /** What the `P` key does — one key in, one key out. */
  toggleShop(): void;
  /**
   * The quick scoreboard is up: both teams, K/D/A, CS, gold, items. Held on
   * Tab on a keyboard (`Game.keyPressed`/`keyReleased`), toggled from a corner
   * button on touch. A glance, not a panel: it does not pause, it takes no
   * input of its own beyond a tap to dismiss, and the config panel's Đội tab
   * stays the place to *change* anything.
   */
  showScoreboard: boolean;
  setScoreboard(visible: boolean): void;
  toggleScoreboard(): void;
  /**
   * Open the shop **aimed at another champion** — the roster's entry point.
   *
   * Everything the panel then shows is that champion's: their gold, their bag,
   * their refusals. Buying spends their wallet. It is a cheat only in that the
   * fountain rule is waived (`ShopMode`), because the subject is a bot standing
   * wherever the match put it; the gold is real.
   *
   * Refuses an id nobody has, rather than opening a panel with nothing behind
   * it.
   */
  openShopFor(id: string): void;
  /** '' when the shop is the player's own — there is nothing to label. */
  shopSubjectName(): string;
  /** The **subject's** balance, which is not `HudState.gold` when a bot is being shopped for. */
  shopGold(): number;
  /** Whether the subject may trade right now. False only ever means "not at the fountain". */
  shopCanTrade(): boolean;
  /** Everything on sale right now, each row carrying why it cannot be bought. */
  shopStock(): ShopRow[];
  /** What is in the bag, sellable, with what each would pay back. */
  shopBag(): SellRow[];
  /**
   * Buy by qualified id. Goes through `ItemShop`, which re-checks every rule —
   * the card's `refusal` is what the player *sees*, never what is trusted.
   */
  buy(itemId: string): void;
  /** Sell whatever is in `slot`. Same seam, same re-check. */
  sell(slot: number): void;
  /**
   * Take back the last purchase or sale, at the price it was made.
   *
   * Deliberately not "sell it again": a sale refunds 70%, which is the price
   * of changing your mind, and a misclick is not a change of mind. See
   * `economy/ShopHistory.ts`.
   */
  undoShop(): void;
  /** Do the undone transaction again, through the ordinary buy/sell rules. */
  redoShop(): void;
  /** Whether there is anything to take back — for a button that greys itself. */
  canUndoShop(): boolean;
  canRedoShop(): boolean;
  /**
   * Rearrange the bag — a swap, and a hotkey change with it.
   *
   * Deliberately **not** gated on the fountain the way buying and selling are.
   * Nothing enters or leaves the champion, no gold moves, and the whole point
   * of the gesture is putting the item you are about to need under the key you
   * can reach; refusing it mid-fight would refuse it exactly when it matters.
   */
  moveItem(from: number, to: number): void;
  mouseover(spellProxy: any, event: any): void;
  /** Drops the description panel when the buff it describes has ended. */
  releaseEndedHover(before: readonly any[], after: readonly any[]): void;
  mouseout(spellProxy: any): void;
  showSpellInfo(spellProxy: any, element: any): void;
  showPreview(spellProxy: any, show: boolean): void;
}

/**
 * `game` and everything reachable from it (`player`, `objectManager`, spell
 * instances) is a plain, un-proxied reference here — it arrives by closure,
 * never passed through Vue's `data()` — so none of *that* needs unwrapping.
 * The one exception is `spellProxy.instance` in `showPreview`: that object
 * comes from `HudState.spells`, which the view layers *do* receive through
 * reactive `data()`, so it is Vue-proxied by the time it reaches here.
 */
export function createHudInteractions(game: Game): HudInteractions {
  let director: MatchDirector | null = null;
  let camera: Camera | null = null;

  /**
   * The champion behind a roster id, resolved fresh every time.
   *
   * `game.director.roster()` rather than a map kept here: the roster is the
   * one place that knows who is in the match, and a bot can join or leave it
   * mid-match through the Đội tab. A cache would be a second answer to the
   * same question, out of date exactly when it matters.
   */
  const subjectUnit = (id: string): Champion | null => {
    for (const entry of game.director?.roster() ?? []) {
      if (entry.unit?.id === id) return entry.unit;
    }
    return null;
  };

  /**
   * Who the shop is for, and under which rules — or `null`, which means the
   * shop should not be open at all.
   *
   * The `null` case is a unit that has left the roster while its shop was up.
   * Falling back to the player would be worse than closing: the panel would
   * keep drawing, and the only sign that the gold on screen had become
   * somebody else's is a number nobody is looking at.
   */
  const shopSubject = (): { champion: Champion; mode: ShopMode } | null => {
    if (state.shopSubjectId === null) {
      return game.player ? { champion: game.player, mode: 'PLAYER' } : null;
    }
    const champion = subjectUnit(state.shopSubjectId);
    if (!champion) {
      // Read on the panel's own repaint, so this is where a vanished subject
      // is noticed and where the panel is taken down.
      state.showShop = false;
      state.shopSubjectId = null;
      return null;
    }
    return { champion, mode: 'CHEAT' };
  };

  /** Shuts the config panel *and* unpauses, but only if it was up. */
  const leaveConfigPanel = (): void => {
    if (state.showSpellsPicker) state.closeSpellPicker();
    state.editPlayerSlot = null;
  };

  /**
   * Which save points were already kept to the library, so the row's button
   * can say "Đã lưu" instead of writing a twin on a double press. Session
   * state like the checkpoints themselves — a fresh match starts clean.
   */
  const keptCheckpointIds = new Set<string>();
  /** "Mốc 1", "Mốc 2", … — never reused within a match, deletions included. */
  let nextCheckpointOrdinal = 1;

  const checkpointById = (id: string) => {
    for (const checkpoint of game.checkpoints) if (checkpoint.id === id) return checkpoint;
    return null;
  };

  const checkpointClock = (ms: number): string => {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };

  const state = reactive({
    /**
     * Resolved on first read, not here: `Game` constructs its `InGameHUD` —
     * which is what calls this factory — some 60 lines before it assigns
     * `this.director`, so a value captured at this point would be `undefined`
     * for the rest of the match.
     *
     * `markRaw` because everything below is inside a `reactive()`, and Vue
     * deep-proxies any object a reactive getter returns. A proxied director
     * would hand back a proxied `objectManager`, proxied units, proxied
     * position vectors — the whole game graph — on every roster read. See this
     * function's own doc comment: `game` is deliberately un-proxied here.
     */
    get director(): MatchDirector {
      if (!director && game.director) director = markRaw(game.director);
      return director as MatchDirector;
    },
    /** Same lazy `markRaw` getter as `director` above, for the same reasons. */
    get netLink(): { lost: boolean } | null {
      return game.net?.link ?? null;
    },
    get camera(): Camera {
      if (!camera && game.camera) camera = markRaw(game.camera);
      return camera as Camera;
    },
    showSpellsPicker: false,
    editPlayerSlot: null as number | null,
    onEscapeInner: null as (() => boolean) | null,
    showShop: false,
    showScoreboard: false,
    setScoreboard(visible: boolean): void {
      state.showScoreboard = visible;
    },
    toggleScoreboard(): void {
      state.showScoreboard = !state.showScoreboard;
    },
    /**
     * Whose shop is open — `null` for the player's own, which is the default
     * and the only thing the corner button and the `P` key ever set.
     *
     * An **id**, not a champion: a captured reference outlives the unit it
     * points at, and a bot removed from the roster while its shop is open
     * would leave the panel spending gold into an object nothing else in the
     * match can see. Re-resolved on every read.
     */
    shopSubjectId: null as string | null,
    /**
     * Whether closing the shop should put the config panel back.
     *
     * The roster's shop button closes that panel — deliberately, rather than
     * stacking over it: the panel holds the match **paused**, and a purchase
     * is a mutation (`equipItem` installs a `StatsModifier`) with nothing
     * ticking to settle it, which `CLAUDE.md` names as having caused four bugs
     * already. The two are also the same width, so on the 390px phone the
     * layout is sized for, "stacked" would look identical to "replaced" with
     * two close buttons and an ambiguous Escape.
     *
     * What was actually wrong was losing your place. So the way back is
     * remembered instead — and cleared the moment the shop is opened by any
     * other door, or a corner-button shop would drop the player into a paused
     * panel they never asked for.
     */
    shopReturnsToPanel: false,
    spellHover: null as any,
    spellInfo: { top: 'auto', bottom: '0px', left: '0px', width: '300px' },
    touchUi: false,
    get activeMapId(): string {
      return game.activeMapId;
    },
    get net(): NetGameHooks | null {
      return game.net;
    },
    get renderQuality(): RenderQuality {
      return game.renderQuality;
    },
    get renderFps(): RenderFps {
      return game.renderFps;
    },
    setRenderQuality(quality: RenderQuality): void {
      game.setRenderQuality(quality);
    },
    setRenderFps(fps: RenderFps): void {
      game.setRenderFps(fps);
    },
    get screenShake(): boolean {
      return game.screenShake;
    },
    setScreenShake(enabled: boolean): void {
      game.setScreenShake(enabled);
    },
    setTouchUiEnabled(enabled: boolean): void {
      // `remember: false` — see the interface comment. The panel owns the
      // stored tri-state; this only applies a resolved side to the live match.
      game.setTouchControlsEnabled(enabled, false);
    },

    escape(): void {
      // The innermost layer gets it first, and only it: closing a modal and
      // the panel under it on one keypress is the mis-hit this whole change
      // exists to design out.
      if (state.onEscapeInner?.()) return;
      // The glance goes first: it is over everything and costs nothing to drop.
      if (state.showScoreboard) return state.setScoreboard(false);
      // The shop is a layer over the match too, and it is the innermost thing
      // Escape can reach when it is up — closing the whole config panel out
      // from under someone who meant to leave the shop is the same mis-hit
      // `onEscapeInner` exists for.
      if (state.showShop) return state.closeShop();
      // Same rung as the shop: a layer over the match, dropped before the
      // panel underneath would toggle.
      if (state.showCheckpoints) return state.closeCheckpoints();
      if (state.showSpellsPicker) state.closeSpellPicker();
      else state.openSpellPicker();
    },

    requestExit(): void {
      // Closed first so the panel is not left standing over a scene that is
      // about to be torn down.
      state.showSpellsPicker = false;
      state.showShop = false;
      state.showCheckpoints = false;
      state.editPlayerSlot = null;
      game.onExitRequested?.();
    },

    requestRestart(): void {
      // The same teardown as the exit above, and for the same reason: this
      // scene is about to run its own `exit()`, and a panel left standing
      // would be a panel over a match that no longer exists.
      state.showSpellsPicker = false;
      state.showShop = false;
      state.showCheckpoints = false;
      state.editPlayerSlot = null;
      game.onRestartRequested?.();
    },

    /**
     * The corner button's entry point, in both modes. It does not toggle:
     * there is one way in and the panel carries its own close, so a second
     * press on a button that is hidden behind the panel cannot happen.
     */
    openShop(): void {
      // The two modals are mutually exclusive: both are full-width, and
      // stacking them leaves the player looking at two close buttons.
      leaveConfigPanel();
      if (state.showCheckpoints) state.closeCheckpoints();
      // Opened from the HUD, so there is nothing to go back to — and saying so
      // here is what stops a stale flag from an earlier roster shop reopening
      // the panel behind this one.
      state.shopReturnsToPanel = false;
      state.shopSubjectId = null;
      state.showShop = true;
      state.spellHover = null;
      // Deliberately no `game.pause()`. See `showShop`.
    },

    openShopFor(id: string): void {
      // Checked before anything opens: a panel whose subject does not resolve
      // has no gold to show and no bag to draw, and the player would be
      // looking at an empty shelf with no way to tell why.
      if (!subjectUnit(id)) return;
      // Read before the panel is closed, or it is always false.
      state.shopReturnsToPanel = state.showSpellsPicker;
      leaveConfigPanel();
      if (state.showCheckpoints) state.closeCheckpoints();
      state.shopSubjectId = id;
      state.showShop = true;
      state.spellHover = null;
    },

    shopSubjectName(): string {
      // '' for the player's own shop. The header only labels the exception,
      // because a title that always names somebody stops being read.
      if (state.shopSubjectId === null) return '';
      const champion = subjectUnit(state.shopSubjectId);
      if (!champion) return '';
      // The same fallback the roster row uses. An unlabelled *cheat* shop is
      // the one case where the label is load-bearing, so a nameless champion
      // must not produce one.
      return champion.name || 'Không tên';
    },

    shopGold(): number {
      return shopSubject()?.champion.wallet?.balance ?? 0;
    },

    shopCanTrade(): boolean {
      const subject = shopSubject();
      if (!subject) return false;
      // A cheat's subject is never "at the fountain" and never needs to be.
      return subject.mode === 'CHEAT' || atOwnFountain(subject.champion, game);
    },

    closeShop(): void {
      state.showShop = false;
      state.spellHover = null;
      // Back to the player, or the next press of the corner button silently
      // opens a bot's shop and the only sign is a gold figure nobody looks at.
      state.shopSubjectId = null;

      if (!state.shopReturnsToPanel) return;
      state.shopReturnsToPanel = false;
      // `openSpellPicker` re-pauses and re-mounts the panel. Which tab and
      // which rows were open survive that, because both live in modules rather
      // than in `<script setup>` — see `panelTab.ts` and `expandedRows.ts`.
      state.openSpellPicker();
    },

    toggleShop(): void {
      if (state.showShop) state.closeShop();
      else state.openShop();
    },

    shopStock(): ShopRow[] {
      const subject = shopSubject();
      return subject ? shopRows(subject.champion, game, subject.mode) : [];
    },

    shopBag(): SellRow[] {
      const subject = shopSubject();
      return subject ? sellRows(subject.champion, game, subject.mode) : [];
    },

    /**
     * The card's `refusal` is what the player *sees*; this is what is trusted.
     * `ItemShop.buyItem` re-checks every rule from scratch — the panel repaints
     * on a 20Hz tick, so a card can be a fifth of a second out of date by the
     * time it is clicked, which is exactly long enough to walk off the
     * platform.
     */
    buy(itemId: string): void {
      // On a LAN client the order goes to the host and nothing happens here —
      // the gold and the fountain rule are its, and the answer comes back as a
      // `bag` event with a wallet beside it. A host answers `false` and buys
      // outright, for its own champion and for its clients' alike.
      if (game.net?.interceptShop({ kind: 'buy', itemId })) return;
      const subject = shopSubject();
      const def = contentCatalog().item(itemId);
      if (subject && def) buyItem(subject.champion, def, game, subject.mode);
    },

    sell(slot: number): void {
      if (game.net?.interceptShop({ kind: 'sell', slot })) return;
      const subject = shopSubject();
      if (subject) sellItem(subject.champion, slot, game, subject.mode);
    },

    undoShop(): void {
      // Across the wire like every other bag change: the gold and the
      // inventory are the host's, and a client reversing its own copy of a
      // purchase the host still holds would be undone again by the next `bag`
      // event.
      if (game.net?.interceptShop({ kind: 'undo' })) return;
      const subject = shopSubject();
      if (subject) undoShop(subject.champion, game, subject.mode);
    },

    redoShop(): void {
      if (game.net?.interceptShop({ kind: 'redo' })) return;
      const subject = shopSubject();
      if (subject) redoShop(subject.champion, game, subject.mode);
    },

    canUndoShop(): boolean {
      const subject = shopSubject();
      return !!subject && canUndoShop(subject.champion);
    },

    canRedoShop(): boolean {
      const subject = shopSubject();
      return !!subject && canRedoShop(subject.champion);
    },

    moveItem(from: number, to: number): void {
      // A drag is a bag change like any other: the host owns the arrangement,
      // or the next `bag` event puts the item back where the host still has it.
      if (game.net?.interceptShop({ kind: 'swap', a: from, b: to })) return;
      game.player?.moveItem(from, to);
    },

    openSpellPicker(): void {
      if (state.showCheckpoints) state.closeCheckpoints();
      state.showShop = false;
      state.editPlayerSlot = null;
      state.showSpellsPicker = true;
      game.pause();
      state.spellHover = null;
    },

    /** See the interface: the tab is the point. */
    openRoster(): void {
      if (state.showCheckpoints) state.closeCheckpoints();
      activePanelTab.value = 'roster';
      state.showShop = false;
      state.editPlayerSlot = null;
      state.showSpellsPicker = true;
      game.pause();
      state.spellHover = null;
    },

    /**
     * The desktop strip's per-icon shortcut. It used to open the picker
     * pre-aimed at the clicked slot; it now opens the panel on Đấu thủ with
     * the player's loadout editor open on that slot, which is the same
     * gesture pointed at the editor that replaced the picker. `RosterTab`
     * reads `editPlayerSlot` once on mount and clears it.
     */
    openPlayerLoadout(index: number): void {
      if (state.showCheckpoints) state.closeCheckpoints();
      state.editPlayerSlot = index;
      state.showSpellsPicker = true;
      game.pause();
      state.spellHover = null;
    },

    closeSpellPicker(): void {
      state.showSpellsPicker = false;
      state.editPlayerSlot = null;
      game.unpause();
    },

    /** See the interface: one line, on purpose. */
    recall(): void {
      game.recall();
    },

    spectateNext(): void {
      game.deathCamera?.next();
    },

    showCheckpoints: false,

    openCheckpoints(): void {
      // No surface at all in a LAN match — see the interface.
      if (game.net) return;
      leaveConfigPanel();
      state.showShop = false;
      state.shopSubjectId = null;
      state.showCheckpoints = true;
      state.spellHover = null;
      game.pause();
    },

    closeCheckpoints(): void {
      state.showCheckpoints = false;
      game.unpause();
    },

    checkpointRows(): CheckpointRow[] {
      const rows: CheckpointRow[] = [];
      for (const checkpoint of game.checkpoints) {
        rows.push({
          id: checkpoint.id,
          name: checkpoint.name,
          auto: checkpoint.auto,
          clock: checkpointClock(checkpoint.matchTimeMs),
          summary: checkpoint.summary,
          kept: keptCheckpointIds.has(checkpoint.id),
        });
      }
      return rows;
    },

    saveCheckpoint(): void {
      if (game.net) return;
      // Newest first, so "mốc gần nhất" is always index 0 and the anchor
      // "Đầu trận" sinks to the bottom of the shelf.
      game.checkpoints.unshift(captureCheckpoint(game, `Mốc ${nextCheckpointOrdinal++}`));
    },

    rewindToCheckpoint(id: string): void {
      if (game.net) return;
      const checkpoint = checkpointById(id);
      if (!checkpoint) return;
      if (restoreCheckpoint(game, checkpoint)) state.closeCheckpoints();
    },

    retryFromCheckpoint(): void {
      if (game.net) return;
      // Newest first, so the first deliberate save is the newest one. The
      // auto anchor never auto-applies — see the interface.
      for (const checkpoint of game.checkpoints) {
        if (!checkpoint.auto) {
          restoreCheckpoint(game, checkpoint);
          return;
        }
      }
      this.openCheckpoints();
    },

    renameCheckpoint(id: string, name: string): void {
      const trimmed = name.trim().slice(0, SAVED_MOMENT_NAME_MAX);
      if (!trimmed) return;
      const checkpoint = checkpointById(id);
      if (checkpoint) checkpoint.name = trimmed;
    },

    deleteCheckpoint(id: string): void {
      const index = game.checkpoints.findIndex(checkpoint => checkpoint.id === id);
      if (index >= 0) game.checkpoints.splice(index, 1);
    },

    keepCheckpoint(id: string): boolean {
      if (game.net) return false;
      const checkpoint = checkpointById(id);
      if (!checkpoint) return false;
      try {
        saveSavedMoment(
          checkpoint.name,
          checkpoint.matchSeed,
          checkpoint.setup,
          checkpoint.overlay
        );
      } catch {
        // A blank name cannot happen from the modal, and a full storage
        // costs this save, nothing more.
        return false;
      }
      keptCheckpointIds.add(id);
      return true;
    },

    mouseover(spellProxy: any, event: any): void {
      // Hover is a mouse gesture. On a touch screen the browser fires one
      // anyway on the way to a click, which would flash the description for
      // an instant every time a player opened the picker.
      if (state.touchUi) return;
      state.showPreview(spellProxy, true);
      state.showSpellInfo(spellProxy, event.currentTarget || event.target);
    },

    /**
     * Place the description panel next to `element`.
     *
     * Above it with a mouse, because the spell bar is along the bottom of the
     * screen. Below it under a thumb, because in touch mode the bar used to
     * be at the top and "above" would have been off the screen entirely —
     * the bar is gone now (see `MobileHudView.vue`), but the picker's own
     * roster this is reached from is still anchored near the top of a
     * viewport-filling modal, so the reasoning still holds. The panel also
     * stops being a fixed 300px there — that is most of a phone held sideways
     * — and is kept inside the viewport on all four edges, not just the two
     * sides: an icon long-pressed near the top of the picker's roster (the
     * basic attack, first in the list, is the easy way to hit this) used to
     * push the panel's bottom edge past the bottom of the screen, because
     * only `left` was ever clamped. Caught by retargeting
     * `drive-touch-controls.mjs`'s long-press check from the strip (always
     * near the very top, so "below" always had the whole screen to work
     * with) to a picker roster icon after the strip came out — a case that
     * was always reachable, just never exercised.
     */
    showSpellInfo(spellProxy: any, element: any): void {
      if (!element?.getBoundingClientRect) return;
      state.spellHover = spellProxy;
      const { width, x, y, bottom } = element.getBoundingClientRect();

      if (!state.touchUi) {
        state.spellInfo = {
          top: 'auto',
          bottom: 'calc(100vh - ' + (y - 5) + 'px)',
          left: Math.max(x + width / 2 - 150, 0) + 'px',
          width: '300px',
        };
        return;
      }

      const panelWidth = Math.min(300, window.innerWidth * 0.78);
      const left = Math.min(
        Math.max(x + width / 2 - panelWidth / 2, 6),
        Math.max(6, window.innerWidth - panelWidth - 6)
      );
      // Matches body.touch-ui .spell-info's `max-height: 60vh` in
      // styles/hud.css — the panel scrolls its own overflow past that, but
      // nothing stopped its *top* from landing so low the whole box, or most
      // of it, sat below the viewport.
      const maxPanelHeight = window.innerHeight * 0.6;
      const top = Math.min(bottom + 8, Math.max(6, window.innerHeight - maxPanelHeight - 6));
      state.spellInfo = {
        top: top + 'px',
        bottom: 'auto',
        left: left + 'px',
        width: panelWidth + 'px',
      };
    },

    /**
     * Lets go of a description panel whose buff has ended underneath it.
     *
     * A buff row is the one thing on this HUD that can vanish while the
     * pointer is still on it, and removing a hovered element does not fire
     * `mouseout` — the browser sends it on the next mouse move, which may be
     * seconds away or never. So the panel went on describing a buff that was
     * over, with a countdown frozen at whatever it said when the buff expired.
     *
     * **Both lists, and only buffs.** Membership in the *previous* snapshot is
     * what identifies the pinned object as a buff at all, and it has to be:
     * `buildItems` mints a fresh object every tick, so "not in the new snapshot"
     * on its own would release an item hover twenty times a second. Buffs are
     * the opposite by design — `hudState.ts` reuses one display per kind exactly
     * so the countdown in this panel keeps counting — and that reuse is what
     * makes identity a safe question to ask about them.
     *
     * Raw on both sides. The pinned object is a reactive proxy and `next` has not
     * been assigned into the ref yet, so one side is a proxy and the other is
     * not; `includes` would answer no every tick and release every hover.
     */
    releaseEndedHover(before: readonly any[], after: readonly any[]): void {
      const pinned = state.spellHover ? toRaw(state.spellHover) : null;
      if (!pinned) return;
      const wasABuff = before.some(row => toRaw(row) === pinned);
      if (!wasABuff) return;
      const stillLive = after.some(row => toRaw(row) === pinned);
      if (stillLive) return;
      state.spellHover = null;
    },

    mouseout(spellProxy: any): void {
      if (state.touchUi) return;
      state.showPreview(spellProxy, false);
      state.spellHover = null;
    },

    showPreview(spellProxy: any, show: boolean): void {
      try {
        const s = toRaw(spellProxy.instance);
        if (s) s.willDrawPreview = show || false;
      } catch (e) {
        console.error(e);
      }
    },
  }) as unknown as HudInteractions;

  return state;
}
