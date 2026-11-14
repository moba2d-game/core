/**
 * The seam that made one match-config panel possible.
 *
 * There used to be two panels — the pregame setup screen over `localStorage`
 * and the in-game practice panel over `MatchDirector` — and they disagreed
 * about which settings existed at all: the setup screen alone could pick an
 * input mode, the panel alone could assign sides or switch the jungle off.
 * Neither was a superset. Two backends had grown two independent sets of
 * controls over the same config, and every new control landed in whichever
 * component its author happened to be editing.
 *
 * So the panel is one component now, and *this* is what it talks to. Two
 * implementations satisfy it: `PregameConfigSource` (no match exists;
 * everything is a read and a write of the stored config) and
 * `MatchDirectorSource` (a match is running; every mutation goes through
 * `MatchDirector`, which applies it and then persists it). A control added to
 * the panel has to be served by both, and the contract suite checks that it is.
 *
 * ## Nothing from the running game crosses this boundary
 *
 * No `Champion`, no `Spell`, no `Camera` — only view models and ids. That is
 * not tidiness, it is what keeps the panel out of the `game` chunk: the menu
 * mounts this same panel, and one value import of a `src/game/` runtime symbol
 * would put the whole match — every spell, the navigation grid, ~2MB — in
 * front of the logo. It is the same rule `game/input/touchPreferences.ts` was
 * split out to obey, and `tests/scenes/matchConfigChunk.test.ts` is what stops
 * it being quietly broken. Type-only imports are erased and are fine.
 *
 * ## `live` is the one capability flag
 *
 * A row carries no reference to a unit, because whether the live-only controls
 * render is a property of the *source*, not of a row: in a match every
 * participant is live, outside one none is. So `source.live !== null` is the
 * single gate, and the things that genuinely need a running match — KDA, refill,
 * clear cooldowns, stack counts, the camera zoom — hang off `MatchLiveControls`
 * where the type system can see they are unavailable.
 *
 * ## `canEditMatchSettings` is the second one, and it is about *whose* match
 *
 * `live` asks whether a match exists. This asks whether this device owns the
 * one that does. On a LAN client it is false, and every write that changes the
 * shared match — the rules, the world, the map, the cheats, the reset that
 * rewrites all three — refuses. It is a plain boolean rather than a nullable
 * group like `live` because the controls it gates are spread across two tabs
 * and are the *same* controls a host uses: a client should see the match's real
 * CDR and read that the jungle is on, greyed out, not find the rows missing.
 */
import type { MatchTeamId } from '@/game/config/MatchTeams';
import type {
  BotBehaviour,
  ChampionLoadout,
  CheatConfig,
  MatchRules,
  MatchRulesConfig,
  WorldConfig,
} from '@/game/config/PregameConfig';
import type { MatchModeId } from '@/game/config/matchModes';
import type { TouchModePreference } from '@/game/input/touchPreferences';
import type { MapGround, RenderFps, RenderScale } from '@/game/Game';
import type { RenderQuality } from '@/game/managers/ObjectManager';
import type { ScoreLine, StatGroup } from '@/game/hud/practice/participantStats';
import type { SpellDisplay } from '@/game/config/spellCatalog';
import type { QualifiedMapSummary } from '@/content/PackRegistry';
import type { StatLine } from '@/game/hud/itemStatLines';
import type { MapGeometry } from '@/content/ContentPack';
import type { MatchTemplateSetup } from '@/game/config/matchTemplates';

/** One Q/W/E/R icon on a roster row. */
export interface RosterAbility {
  /** `Q`, `W`, `E` or `R` — shown when the slot is empty or has no art. */
  letter: string;
  url: string | null;
  /**
   * Whether tapping the icon has a description to open. False for an empty
   * slot. The description itself comes from `describeAbility` rather than an id
   * on this object, because the two sources answer it from different places —
   * see that method.
   */
  describable: boolean;
}

export interface ConfigRosterEntry {
  /** `unit.id` in a match; `'player'` / `'bot-<i>'` outside one. Stable within one source. */
  id: string;
  /**
   * Position in the **full** roster — 0 is always the player — kept even though
   * the list is rendered grouped by side.
   *
   * It is what the DOM ids are built from (`practice-row-toggle-2`), and that
   * is deliberate rather than incidental: `id` is a uuid in a running match,
   * which no test can name, while a position is stable, readable and the thing
   * a person would say out loud. Several e2e scripts address rows this way.
   */
  index: number;
  /** "Bạn" / "Bot 1" — a position in the roster, never a unit identity. */
  label: string;
  isPlayer: boolean;
  team: MatchTeamId;
  /**
   * The champion the row names. In a match this is the unit standing on the
   * map; outside one it is what the *loadout* says — "Ngẫu Nhiên" for a bot
   * left rolling. The two are different facts and the row must not substitute
   * one for the other: reading a rolled champion back as a setting would
   * silently pin a bot that is meant to keep re-rolling on every respawn.
   */
  title: string;
  avatarUrl: string | null;
  abilities: RosterAbility[];
  loadout: ChampionLoadout;
  /**
   * Bots only — the player drives itself and has no behaviour to configure.
   * Carries the tier this bot plays at as well as its three switches, so the
   * row renders the whole of its AI from one field and writes it back through
   * one setter (`setBotBehaviour`). `undefined` here is what makes those
   * controls a bot's — the tab guards them behind it, and
   * `tests/game/hud/rosterTabDifficulty.test.ts` is what keeps them there,
   * because `tsconfig.json` sets `strict: false` and the compiler will not.
   */
  behaviour?: BotBehaviour;
  invulnerable: boolean;
  /**
   * A LAN-borne unit the local director cannot mutate — a remote player on a
   * host, everything remote on a client. The row renders (name, side, kit,
   * live stats) and offers no controls: its loadout, team and behaviour
   * belong to whoever is actually driving it, on the other machine. Only
   * `MatchDirectorSource` ever sets it; pregame has no network.
   */
  remote?: boolean;
}

export interface RosterStack {
  spellId: string;
  name: string;
  count: number;
}

/**
 * One buyable item, as the panel's cheat menu lists it. A bare shape rather
 * than `QualifiedItem` — this file may name a `src/game/` type but must never
 * import one, and the panel needs three fields of it.
 */
export interface ItemOption {
  id: string;
  name: string;
  cost: number;
}

/**
 * One slot of a participant's bag, as a roster row draws it. **Always
 * `INVENTORY_SIZE` of them**, filled or not — the same decision, for the same
 * reason, that `ItemSlotDisplay` makes about the player's own bar: a fixed
 * shape is one a reader learns the width of, and a strip that grew as items
 * were bought would shift the numbers beside it every time a bot bought
 * something.
 *
 * A bare shape rather than `ItemSlotDisplay` itself, which carries a hot key,
 * a cooldown wedge and `canCast` — all of them facts about *casting* an item,
 * which a roster row does not offer. Same reasoning as `ItemOption` above.
 */
export interface RosterItem {
  filled: boolean;
  /** '' for an empty slot, and for an item whose pack named art nothing registered. */
  url: string;
  name: string;
  /**
   * What the item grants and what it does, for the panel that opens when a
   * square is tapped.
   *
   * These squares carried a `title` and nothing else, on the argument that a
   * shop-sized description belongs in the shop and the shop is one button away
   * in the drawer. That holds for *your own* bag and stops holding for anyone
   * else's: the Đội tab is the only place a player sees what the other nine
   * champions are carrying, and the shop button beside a row opens a shop for
   * that champion to *buy* in — it is not a way to read what they already own.
   * A hover title also does not exist under a thumb.
   */
  cost: number;
  /** One line per stat, in `ITEM_STAT_KEYS` order — the shop card's own list. */
  stats: StatLine[];
  /** The pack's prose: the passive, the active, whatever the numbers cannot say. */
  description: string;
}

/**
 * The controls that need a match to be running. Reachable only through
 * `MatchConfigSource.live`, which is `null` on the menu — so a tab cannot
 * render a button that would do nothing, and cannot compile one either.
 */
export interface MatchLiveControls {
  /** Health and mana to full. */
  refill(id: string): void;
  clearCooldowns(id: string): void;
  scoreOf(id: string): ScoreLine;
  statGroupsOf(id: string): StatGroup[];
  /** Only the unit's spells that count something; most kits have none. */
  stacksOf(id: string): RosterStack[];
  /** Relative, because the buttons are `+1 / +10 / +100`. */
  addStacks(id: string, spellId: string, amount: number): void;
  clearStacks(id: string, spellId: string): void;

  /**
   * What this participant can spend, and a way to hand them more.
   *
   * Relative like `addStacks`, because the buttons are `+200 / +1000`: an
   * absolute setter would need a text field, and a text field in a panel with
   * no keyboard on a phone is a control that does not work.
   *
   * A cheat, not a setting, so it is here and not on `CheatConfig`: it changes
   * the match rather than describing it, and `PregameConfig` has no wallet to
   * write it into. The same reasoning that keeps refill and clear-cooldowns
   * out of the persisted config.
   */
  goldOf(id: string): number;
  grantGold(id: string, amount: number): void;
  /**
   * Everything any installed pack sells, so a bot can be handed one directly.
   *
   * This is the answer to "the player buys items and the bots never do": until
   * a bot has a shop of its own, the way to a fair match is the panel. Bots
   * were deliberately not given an automatic buy path — that is a design
   * decision about how the AI plays, and this is the manual door that does not
   * pre-empt it.
   */
  itemStock(): ItemOption[];
  /**
   * What this participant is **holding**, which is the question the rest of
   * this group could not answer: `giveItem` and `openShopFor` put items in a
   * bag, `itemStock` lists what a shelf sells, and nothing read the bag back.
   * A row could hand a bot an item and then show no sign it had.
   *
   * Live-only for the same reason the wallet is: outside a match there is no
   * bag, and a strip of six empty squares under every name on the menu would
   * be six lies about a match that has not started.
   */
  itemsOf(id: string): RosterItem[];
  /**
   * Hand the *shop panel* to this unit: same shelf, same recipes, same
   * refusals, but showing that champion's gold and spending it.
   *
   * The tab used to pick items from a `<select>` and hand them over free. Two
   * things were wrong with that and only one was the dropdown: an item chosen
   * from a list of names is chosen without its stats, its description or its
   * build path, all of which the shop already draws — and gold that is never
   * spent makes the roster's own `+200 / +1000` meaningless.
   *
   * Closes this panel on the way, which also unpauses: the shop deliberately
   * does not pause, and two overlapping full-width panels in 390px is not a
   * layout.
   */
  openShopFor(id: string): void;
  /** Into the first free slot. No gold charged and no fountain required — it is a cheat. */
  giveItem(id: string, itemId: string): void;
  /** Everything in the bag, back off. */
  clearItems(id: string): void;

  readonly zoom: number;
  setZoom(factor: number): void;
  /** Separate from `setZoom` because the slider writes on every frame of a drag and persists once. */
  persistZoom(): void;

  /** Leave the match. A scene transition, which is why it is not a config write. */
  requestExit(): void;

  /**
   * Whether a new match can be booted from here.
   *
   * False in a LAN match, and that is not a permission — a host may change
   * every other setting on the tab. It is that `restart()` tears the session
   * down with the match (`GameScene.stopGame` closes the socket) and boots a
   * fresh room from the URL, so every client would be dropped into a room
   * whose code they were never given. A LAN match is remade by its room, not
   * by one player's map pick.
   *
   * A getter, not a captured boolean: a host's session attaches *after* the
   * match is constructed (`HostSession.attach`), so a value read at
   * construction would answer for the wrong match.
   */
  readonly canRestart: boolean;

  /**
   * Tear this match down and boot a new one on the config as it now stands.
   *
   * The map's escape hatch. Every other setting on the panel is either applied
   * live (CDR, URF) or applied by the next tick (jungle, minions); the map is
   * neither, because a `Game` reads its geometry once in its constructor and a
   * running world cannot be swapped out from under itself (`setMap`'s own doc
   * comment). Without this, "chọn bản đồ" in a match writes a promise about a
   * match the player has no way to start from where they are standing.
   *
   * Ends the current match, with everything in it. The caller confirms — see
   * `MapPickerModal.vue`, which is the only one.
   */
  restart(): void;
}

export interface MatchConfigSource {
  /** `null` outside a match. The single gate on every live-only control. */
  readonly live: MatchLiveControls | null;

  /**
   * Whether this device may change settings that belong to the whole match.
   *
   * False on a LAN client and true everywhere else. A LAN match is
   * host-authoritative — the host runs the one simulation and the client draws
   * what it is told — so a client that moved the CDR slider, switched the
   * jungle off or made itself invulnerable changed only its own half and
   * desynced from the match everyone else was playing. The panel's own design
   * spec listed this as v2 work; this is it.
   *
   * **What it does not gate**, because none of it is the shared match:
   *
   * - the Cài đặt tab — input mode, render quality, FPS, zoom, `revealMap` and
   *   the debug layers. Those describe this screen, not the match, and two
   *   players are meant to be able to set them differently;
   * - the way out. A client must always be able to leave;
   * - the kit and the side (`applyLoadout`, `setTeam`), which are the two panel
   *   mutations that already cross the wire as a request to the host
   *   (`NetGameHooks.onLoadoutApplied` / `onTeamChanged`) and come back as
   *   real changes — they are the client asking, not the client diverging.
   *
   * Adding and removing bots **is** gated, through `canAddBot()` as well as
   * the two mutations: `Game`'s constructor already forces a client's local bot
   * count to 0, so a bot added from the panel was a body only that device could
   * see, walking a lane nobody else had.
   *
   * The gate is enforced in the *source*, not only in the tabs: a refused write
   * has to be refused wherever it is called from, and `MatchDirectorSource` is
   * the only implementation that can ever answer false.
   */
  readonly canEditMatchSettings: boolean;

  // ------------------------------------------------------------------ roster
  roster(): ConfigRosterEntry[];
  /** False at `AI_COUNT_MAX`, so the button explains itself instead of silently refusing. */
  canAddBot(): boolean;
  botCount(): number;
  /**
   * Adds a bot **to a named side**, because the control that calls this sits at
   * the end of that side's list rather than in a bar of its own. There is no
   * "add a bot and work out where" any more — the player already said where by
   * pressing the button under Đội Xanh instead of the one under Đội Đỏ.
   */
  addBot(team: MatchTeamId): Promise<void>;
  removeBot(id: string): void;
  setTeam(id: string, team: MatchTeamId): void;
  /**
   * Writes only the fields it is handed — one toggle, or the difficulty row,
   * can send its own without restating the rest. A no-op on the player.
   */
  setBotBehaviour(id: string, flags: Partial<BotBehaviour>): void;
  /**
   * The loadout the editor opens on — the *setting*, not the champion currently
   * standing on the map. See `ConfigRosterEntry.title`.
   */
  loadoutOf(id: string): ChampionLoadout;
  applyLoadout(id: string, loadout: ChampionLoadout): Promise<void>;
  /**
   * The description behind one of a row's ability icons, or `null` for an empty
   * slot.
   *
   * A method rather than a catalogue id on `RosterAbility`, because the honest
   * answer differs by source and neither can produce the other's. Outside a
   * match there is only a loadout, so the catalogue is the only thing that can
   * be asked. Inside one there is a live `Spell` — which has the description,
   * the icon and this match's *actual* cooldown and mana cost on it — and no
   * reliable way back to a catalogue id (`Spell.name` is a constructor name,
   * which a minifier is free to mangle).
   *
   * The icons used to be tappable only on the setup screen and decorative in the
   * practice panel. That was one of the divergences the single panel exists to
   * remove, so this is the seam that makes them the same control in both places.
   */
  describeAbility(id: string, letter: string): SpellDisplay | null;

  // ------------------------------------------------------------------- rules
  readonly matchRules: MatchRules;
  getRules(): MatchRulesConfig;
  /**
   * `persist: false` is the CDR slider mid-drag: apply it so the number on
   * screen is true, but do not write a value the player is still dragging past.
   */
  setRules(rules: MatchRulesConfig, persist: boolean): void;

  getWorld(): WorldConfig;
  setWorld(world: Partial<WorldConfig>): void;

  // -------------------------------------------------------------------- mode
  /** The mode last picked — `config/matchModes.ts`. A label once its knobs move; see `modeDrift`. */
  getMode(): MatchModeId;
  /**
   * Pick a mode: its rules, world and bot count are written through the same
   * paths the controls above use, so the tab re-reads them afterwards. Async
   * because in a match the roster is reshaped, and a bot arriving fetches its
   * kit. The mode's tuning overlay and random roster wait for the next match
   * — the tab says so — which is the map picker's shape exactly.
   */
  setMode(id: MatchModeId): Promise<void>;

  // --------------------------------------------------------------------- map
  /**
   * Every map an installed pack offers, qualified —
   * `contentCatalog().maps()` verbatim. Never empty: the bundled pack always
   * installs at least Summoner's Rift.
   */
  availableMaps(): QualifiedMapSummary[];
  /**
   * The chosen map's qualified id (`<packId>:<localId>`).
   *
   * Outside a match this is a plain setting, round-tripped through
   * `PregameConfig.mapId` — `setMap` writes it and this reads it straight
   * back. **In a running match it is read-only**: a live match already has a
   * terrain map, a nav grid and objects standing on that geometry, and
   * nothing in this seam rebuilds any of it (see `MatchDirectorSource`'s own
   * doc comment for the reasoning and the alternative it deliberately did not
   * take). There, this always reports the map that is actually running,
   * unmoved by `setMap` — a live world cannot be swapped from under it.
   */
  getMap(): string;
  /**
   * Writes the choice for the *next* match. Outside one, `getMap()` reads it
   * straight back. In a running match it changes nothing about the running
   * world — see `getMap`'s own doc comment — it only decides what boots the
   * next time this match is left and a new one started.
   */
  setMap(id: string): void;
  /**
   * A map's heavy half, for the picker's preview.
   *
   * Async and lazy because that is what a map's geometry *is*: `MapSummary`
   * is the cheap half a menu can hold — name, size, factions, tuning — and the
   * polygons sit behind `MapGeometrySource` precisely so the menu never pays
   * for them (`ContentPack.ts`'s own split, and the reason
   * `contentApiChunk.test.ts` exists). A preview is the one menu-side thing
   * that genuinely wants them, so it asks for them, once, when a player opens
   * the picker.
   *
   * `null` for an id nothing installed, and for a loader that failed — the
   * caller draws a map without a preview rather than an error, because a
   * preview that cannot load is not a reason to stop somebody picking the map.
   */
  loadMapGeometry(id: string): Promise<MapGeometry | null>;

  // ------------------------------------------------------------------ cheats
  getCheats(): CheatConfig;
  setCheats(cheats: Partial<CheatConfig>): void;
  setInvulnerable(id: string, on: boolean): void;

  // --------------------------------------------------------------- templates
  /**
   * The setup this source currently describes, whole, for saving as a named
   * "Trận mẫu" (`config/matchTemplates.ts`): the config that would boot it
   * again, plus every participant's bag as qualified item ids. Outside a
   * match the bags are empty — there are no bags on the menu, and inventing
   * some would save a scenario nobody built.
   */
  templateSetup(): MatchTemplateSetup;
  /**
   * Make a saved setup the one this source describes. On the menu it is a
   * config write plus a one-shot bag stash for the boot that follows; in a
   * running match it applies on the spot the way `resetToDefaults` does —
   * bots respawned on the template's roster, rules and world moved, bags
   * granted (the map, as ever, waits for the next boot). Refused on a LAN
   * client like every other whole-match write. A template piece naming
   * content nothing installed is skipped, never thrown on — the panel says
   * so beside the row (`templateGaps.ts`).
   */
  applyTemplateSetup(setup: MatchTemplateSetup): Promise<void>;

  // ------------------------------------------------------------------ device
  /**
   * The resolved layout, and the stored choice, which are different questions:
   * `'auto'` on a phone and `'touch'` on a phone render identically, so the
   * three-option row has to select on the choice while the hint reports the
   * result.
   */
  readonly touchUi: boolean;
  readonly inputMode: TouchModePreference;
  setInputMode(mode: TouchModePreference): void;

  readonly renderQuality: RenderQuality;
  readonly renderFps: RenderFps;
  setRenderQuality(quality: RenderQuality): void;
  setRenderFps(fps: RenderFps): void;
  /** Canvas resolution — `canvasDensity` in `renderPreferences.ts` is what it means. */
  readonly renderScale: RenderScale;
  setRenderScale(scale: RenderScale): void;
  /** The pack's painted ground, or core's solid polygons with the decoration left out. */
  readonly mapGround: MapGround;
  setMapGround(ground: MapGround): void;
  /** Camera shake on the player's own heavy hits, kills and death — `Camera.shake`. */
  readonly screenShake: boolean;
  setScreenShake(enabled: boolean): void;

  /** Writes `DEFAULT_PREGAME_CONFIG` and — in a match — applies it on the spot. */
  resetToDefaults(): Promise<void>;
}
