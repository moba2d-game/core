/**
 * `MatchConfigSource` over a running match.
 *
 * **This file is the one place the panel's world touches the game's.** Every
 * `instanceof`, every `Champion` field, every `Spell` — all of it is here, and
 * `tests/scenes/matchConfigChunk.test.ts` exempts this file alone for that
 * reason. The panel above it sees ids and view models, which is what lets the
 * same panel mount over the menu without dragging the match into its chunk.
 *
 * It is a translation layer and nothing more: no rule about how a match works
 * lives here. `MatchDirector` still owns every mutation and still persists
 * afterwards; this only turns "the row with id `X`" back into the unit the
 * director wants, and turns units back into rows.
 *
 * ## Ids are unit ids
 *
 * Unlike `PregameConfigSource`, whose ids are positions, a row here is
 * identified by `unit.id` — a live object with a quadtree slot and a path agent
 * that keeps its identity when the bot above it is removed. The roster is
 * re-read after every mutation either way, so the difference never shows.
 */
import type MatchDirector from '@/game/MatchDirector';
import type { RosterEntry } from '@/game/MatchDirector';
import AIChampion from '@/game/gameObject/attackableUnits/AIChampion';
import type Champion from '@/game/gameObject/attackableUnits/Champion';
import type Spell from '@/game/gameObject/Spell';
import {
  AI_COUNT_MAX,
  DEFAULT_CHAMPION_LOADOUT,
  sanitizePregameConfig,
  type BotBehaviour,
  type ChampionLoadout,
  type CheatConfig,
  type MatchRules,
  type MatchRulesConfig,
  type WorldConfig,
} from '@/game/config/PregameConfig';
import { sanitizeTemplateItems, type MatchTemplateSetup } from '@/game/config/matchTemplates';
import type { MatchModeId } from '@/game/config/matchModes';
import type { MatchTeamId } from '@/game/config/MatchTeams';
import { isNetClient } from '@/game/net/netRole';
import { setZoomFactorPreference } from '@/game/gameObject/map/Camera';
import {
  setTouchModePreference,
  touchControlsPreference,
  touchModePreference,
  type TouchModePreference,
} from '@/game/input/touchPreferences';
import type { RenderFps, RenderScale } from '@/game/config/renderPreferences';
import type { RenderQuality } from '@/game/managers/ObjectManager';
import {
  scoreLine,
  statGroups,
  type ScoreLine,
  type StatGroup,
} from '../practice/participantStats';
import { grantItem, grantTemplateBag } from '@/game/economy/ItemShop';
import { INVENTORY_SIZE } from '@/game/items/Item';
import { shopItems } from '@/game/economy/itemCatalog';
import { contentCatalog } from '@/content/catalog';
import type { SpellDisplay } from '@/game/config/spellCatalog';
import type {
  ConfigRosterEntry,
  MatchConfigSource,
  MatchLiveControls,
  RosterAbility,
  RosterItem,
  RosterStack,
} from './MatchConfigSource';
import { ABILITY_LETTERS } from './rosterVisuals';
import type { QualifiedMapSummary } from '@/content/PackRegistry';
import { statLinesFor } from '@/game/hud/itemStatLines';
import type { MapGeometry } from '@/content/ContentPack';

/**
 * What this source needs from the HUD. `HudInteractions` satisfies it
 * structurally; the interface exists so the adapter can be exercised on a
 * bench, and so this file names only what it actually uses.
 */
export interface MatchDirectorHost {
  readonly director: MatchDirector;
  readonly camera: { zoomFactor: number; setZoomFactor(factor: number): void; snapToScale(): void };
  readonly touchUi: boolean;
  /** The qualified id of the map this match is actually running on. See `MatchConfigSource.getMap`. */
  readonly activeMapId: string;
  readonly renderQuality: RenderQuality;
  readonly renderFps: RenderFps;
  setRenderQuality(quality: RenderQuality): void;
  setRenderFps(fps: RenderFps): void;
  readonly renderScale: RenderScale;
  setRenderScale(scale: RenderScale): void;
  readonly screenShake: boolean;
  setScreenShake(enabled: boolean): void;
  /** Applies a touch/pointer switch to the live match — `Game.setTouchControlsEnabled`. */
  setTouchUiEnabled(enabled: boolean): void;
  /** Opens the shop panel aimed at a roster unit — `HudInteractions.openShopFor`. */
  openShopFor(id: string): void;
  requestExit(): void;
  /** Boot a new match on the persisted config — `HudInteractions.requestRestart`. */
  requestRestart(): void;
  /** The attached LAN session, if any (`Game.net`) — the Đội tab's read-only LAN rows. */
  readonly net?: {
    netRosterUnits(): Champion[];
    /**
     * Throw a LAN player out — host sessions only, hence optional. A client's
     * own session has no such power and does not implement it.
     */
    kickUnit?(unitId: string): boolean;
  } | null;
}

/** `spells` is indexed by `SpellHotKeys` — `[A, Q, W, E, R, D, F]` — so abilities are 1‑4. */
const ABILITY_SLOTS = [1, 2, 3, 4];

export default class MatchDirectorSource implements MatchConfigSource {
  readonly live: MatchLiveControls;

  constructor(private readonly host: MatchDirectorHost) {
    this.live = {
      refill: id => this.cheatOnUnit(id, unit => this.director.refill(unit)),
      clearCooldowns: id => this.cheatOnUnit(id, unit => this.director.clearCooldowns(unit)),
      scoreOf: id => this.scoreOf(id),
      statGroupsOf: id => this.statGroupsOf(id),
      stacksOf: id => this.stacksOf(id),
      addStacks: (id, spellId, amount) =>
        this.withStack(id, spellId, spell => spell.setStackCount((spell.stackCount ?? 0) + amount)),
      clearStacks: (id, spellId) => this.withStack(id, spellId, spell => spell.setStackCount(0)),

      goldOf: id => this.unitOf(id)?.wallet?.balance ?? 0,
      // Straight at the wallet, not through `MatchDirector`, for the same
      // reason `addStacks` above goes straight at the spell: this is an action
      // on a live unit, not a setting the match persists.
      grantGold: (id, amount) => this.cheatOnUnit(id, unit => unit.wallet?.earn(amount)),
      itemStock: () => shopItems().map(item => ({ id: item.id, name: item.name, cost: item.cost })),
      itemsOf: id => this.itemsOf(id),
      // Straight through: the HUD owns which panel is up, and this adapter's
      // whole job is to be the one file in the config directory that may talk
      // to the match.
      //
      // Gated with the rest of the cheat group even though the shop charges
      // gold and refuses like anyone's: on a client the panel hides that whole
      // section, and a door the UI does not draw should not be open behind it.
      // The player's *own* shop is a HUD button and is untouched.
      openShopFor: id => {
        if (this.canEditMatchSettings) this.host.openShopFor(id);
      },
      giveItem: (id, itemId) =>
        this.cheatOnUnit(id, unit => {
          const def = contentCatalog().item(itemId);
          if (def) grantItem(unit, def);
        }),
      clearItems: id =>
        this.cheatOnUnit(id, unit => {
          for (let slot = 0; slot < (unit.items?.length ?? 0); slot++) unit.unequipItem(slot);
        }),

      get zoom(): number {
        return host.camera.zoomFactor;
      },
      setZoom(factor: number): void {
        host.camera.setZoomFactor(factor);
        // The match is paused while the panel is open, so `Camera.update()`
        // cannot lerp `currentScale` toward the new target before the first
        // visible frame.
        host.camera.snapToScale();
      },
      persistZoom(): void {
        setZoomFactorPreference(host.camera.zoomFactor, host.touchUi);
      },
      requestExit(): void {
        host.requestExit();
      },

      // Read on every access rather than captured: a host's session attaches
      // asynchronously after the match is built (`HostSession.attach`), so a
      // boolean frozen here would say "offline" for the first match a host
      // ever runs. See `MatchConfigSource.canRestart` for why LAN refuses.
      get canRestart(): boolean {
        return !host.net;
      },
      restart(): void {
        if (!host.net) host.requestRestart();
      },
    };
  }

  private get director(): MatchDirector {
    return this.host.director;
  }

  /**
   * False on a LAN client — see `MatchConfigSource.canEditMatchSettings` for
   * what that gates and, just as importantly, what it does not.
   *
   * `isNetClient()` is a process-wide read, not a question about `this.host`,
   * because that is what the role is (`net/netRole.ts` documents why). Reading
   * it live rather than latching it in the constructor matters: the panel
   * outlives a session close, which resets the role, and a latched `false`
   * would leave the controls dead for the rest of the process.
   */
  get canEditMatchSettings(): boolean {
    return !isNetClient();
  }

  private entries(): RosterEntry[] {
    return this.director.roster();
  }

  private unitOf(id: string): Champion | null {
    for (const entry of this.entries()) if (entry.unit.id === id) return entry.unit;
    // The Đội tab's LAN rows resolve here too, for their live *reads* — the
    // stat sheet, the wallet, the bag. Mutations aimed at one of these are
    // unreachable from the tab (`ConfigRosterEntry.remote` hides the
    // controls), so extending the lookup does not extend what can be done.
    for (const unit of this.host.net?.netRosterUnits() ?? []) if (unit.id === id) return unit;
    return null;
  }

  private withUnit(id: string, run: (unit: Champion) => void): void {
    const unit = this.unitOf(id);
    if (unit) run(unit);
  }

  /**
   * `withUnit` for a cheat, which on a LAN client is refused outright.
   *
   * Deliberately not folded into `withUnit` itself: `setTeam` and
   * `setBotBehaviour` go through that too, and đổi phe is one of the two panel
   * mutations a client is *supposed* to make — it crosses the wire and comes
   * back as the host's own change. A single gate on the shared helper would
   * have taken it with the cheats, which is the wrong half.
   */
  private cheatOnUnit(id: string, run: (unit: Champion) => void): void {
    if (!this.canEditMatchSettings) return;
    this.withUnit(id, run);
  }

  private stackSpells(unit: Champion): Spell[] {
    const spells: Spell[] = [];
    // A hand-rolled loop rather than `filter` with a type predicate: this
    // codebase re-declares `Array.prototype.filter` (see CLAUDE.md), so the
    // predicate overload never gets a look in and the result comes back wide.
    for (const spell of unit.spells ?? []) {
      if (spell && spell.stackCount !== undefined) spells.push(spell);
    }
    return spells;
  }

  /** Stack counts are a cheat and have no non-cheat caller, so the gate lives here. */
  private withStack(id: string, spellId: string, run: (spell: Spell) => void): void {
    this.cheatOnUnit(id, unit => {
      for (const spell of this.stackSpells(unit)) {
        if (spell.id === spellId) {
          run(spell);
          return;
        }
      }
    });
  }

  /**
   * `entry.behaviour` being present already implies a bot, but implying is not
   * proving and the roster is built from live objects this source does not own.
   */
  private botOf(id: string): AIChampion | null {
    const unit = this.unitOf(id);
    return unit instanceof AIChampion ? unit : null;
  }

  private spellAt(unit: Champion, letter: string): Spell | null {
    const index = ABILITY_LETTERS.indexOf(letter as (typeof ABILITY_LETTERS)[number]);
    if (index < 0) return null;
    return unit.spells?.[ABILITY_SLOTS[index]] ?? null;
  }

  /**
   * The bag, as six slots.
   *
   * Built by counting to `INVENTORY_SIZE` rather than mapping `unit.items` —
   * which is already that long — so the seam keeps its shape for an id with no
   * unit behind it. That is not hypothetical: a bot removed from the Đội tab
   * leaves the roster before `ObjectManager.update()` sweeps it, and a row
   * mid-repaint can still ask.
   *
   * `icon.url`, not `icon.path`. `hudState.buildItems` reads `path` for the
   * player's own bar, but every other picture this file hands a row — the
   * avatar, an ability icon — comes off `.url`, and one row drawing its
   * squares from two different fields of the same handle is how a broken
   * image gets shipped in only one of the two places.
   */
  private itemsOf(id: string): RosterItem[] {
    const held = this.unitOf(id)?.items ?? [];
    const slots: RosterItem[] = [];

    for (let slot = 0; slot < INVENTORY_SIZE; slot++) {
      const item = held[slot];
      if (!item) {
        slots.push({ filled: false, url: '', name: '', cost: 0, stats: [], description: '' });
        continue;
      }
      // The def's own numbers and prose, so the panel a square opens says the
      // same thing the shop card does — `statLinesFor` is the shop's own
      // builder, not a second one that could format `+8%` differently here.
      slots.push({
        filled: true,
        url: item.icon?.url ?? '',
        name: item.def?.name ?? '',
        cost: item.def?.cost ?? 0,
        stats: statLinesFor(item.def),
        description: item.def?.description ?? '',
      });
    }

    return slots;
  }

  private abilitiesOf(unit: Champion): RosterAbility[] {
    return ABILITY_SLOTS.map((slot, i) => {
      const spell = unit.spells?.[slot];
      const image = spell?.image as { url?: string } | null | undefined;
      return {
        letter: ABILITY_LETTERS[i],
        url: image?.url ?? null,
        describable: !!spell,
      };
    });
  }

  /**
   * Built from the live spell rather than looked up in the catalogue, and that
   * is the better answer rather than a fallback: the numbers are this match's,
   * so a cooldown quoted here is after the CDR slider and a mana cost is zero
   * under URF. `effectiveCoolDownMs` and `effectiveManaCost` are the seams that
   * apply those rules (see `Spell.effectiveMana`), so this cannot express them
   * differently from a cast.
   *
   * **`effectiveDescription`, not `description`** — the third of those seams,
   * and it was the one this read past. `description` is authored text with a
   * first-frame number baked into it, while `takeDamage` scales that number by
   * the owner's `Stats.abilityPower`; quoting the raw string here meant the
   * roster's ability card showed a champion's damage *before its build*, and
   * kept showing it after six items. Reported as not being able to read
   * another champion's real damage. `Spell.effectiveDescription` is the same
   * accessor the player's own HUD bar reads (`hudState.ts`), so the two
   * surfaces cannot quote one spell two ways.
   */
  describeAbility(id: string, letter: string): SpellDisplay | null {
    const unit = this.unitOf(id);
    const spell = unit ? this.spellAt(unit, letter) : null;
    if (!spell) return null;
    const image = spell.image as { url?: string } | null | undefined;
    return {
      iconUrl: image?.url ?? null,
      name: spell.name,
      description: String(spell.effectiveDescription ?? spell.description ?? ''),
      coolDownMs: spell.coolDown,
      manaCost: spell.manaCost,
      effectiveCoolDownMs: spell.effectiveCoolDownMs,
      effectiveManaCost: spell.effectiveManaCost,
    };
  }

  // ------------------------------------------------------------------ roster

  roster(): ConfigRosterEntry[] {
    const local = this.entries().map((entry, index) => ({
      id: entry.unit.id,
      index,
      label: index === 0 ? 'Bạn' : `Bot ${index}`,
      isPlayer: entry.isPlayer,
      team: entry.unit.teamId as MatchTeamId,
      // The unit standing on the map, not the loadout — see
      // `ConfigRosterEntry.title` for why the two must not be substituted.
      title: entry.unit.name || 'Không tên',
      avatarUrl: entry.unit.avatar?.url ?? null,
      abilities: this.abilitiesOf(entry.unit),
      loadout: this.director.loadoutOf(entry.unit),
      behaviour: entry.behaviour,
      invulnerable: this.director.isInvulnerable(entry.unit),
    }));
    // The LAN-borne champions the director does not own — remote players on
    // a host, everything remote on a client (`NetGameHooks.netRosterUnits`).
    // Read-only rows: every mutation this source offers resolves its unit
    // through `entries()`, so a control aimed at one of these ids no-ops by
    // construction, and the tab hides those controls off `remote` besides.
    const netUnits = this.host.net?.netRosterUnits() ?? [];
    return local.concat(
      netUnits.map((unit, i) => ({
        id: unit.id,
        index: local.length + i,
        label: `LAN ${i + 1}`,
        isPlayer: false,
        team: unit.teamId as MatchTeamId,
        title: unit.name || 'Không tên',
        avatarUrl: unit.avatar?.url ?? null,
        abilities: this.abilitiesOf(unit),
        loadout: DEFAULT_CHAMPION_LOADOUT,
        behaviour: undefined,
        invulnerable: false,
        // Read-only on a *client*, where these rows are the host's world and
        // nothing local may touch them — but a host owns the authoritative
        // copy of every champion in the match, its clients' included, so the
        // controls belong to it. The mutations already resolve these units
        // (`unitOf` falls through to the net roster); this is what stops the
        // tab from hiding the buttons that drive them. Health, mana and
        // cooldowns then reach the client through the ordinary snapshot, and
        // a kit or side change through an imposed champ event.
        remote: isNetClient(),
      }))
    );
  }

  botCount(): number {
    return this.director.bots().length;
  }

  /**
   * The roster is the match's, so on a LAN client it is the host's — a bot
   * added here would be a body only this device can see. `Game`'s constructor
   * already forces a client's local bot count to 0 for exactly that reason;
   * this closes the door the panel left open behind it.
   */
  canAddBot(): boolean {
    return this.canEditMatchSettings && this.botCount() < AI_COUNT_MAX;
  }

  async addBot(team: MatchTeamId): Promise<void> {
    if (!this.canEditMatchSettings) return;
    await this.director.addBotLoaded(DEFAULT_CHAMPION_LOADOUT, team);
  }

  removeBot(id: string): void {
    if (!this.canEditMatchSettings) return;
    const bot = this.botOf(id);
    if (bot) {
      this.director.removeBot(bot);
      return;
    }
    // Not a bot: on a host, the Đội tab shows this same control on every LAN
    // row (`remote` is false there, because a host owns the authoritative copy
    // of its clients' champions), and it used to resolve to nothing at all —
    // `botOf` misses, and the press did nothing, for ever. That is the whole
    // of *"host ko đuổi lan nào ra khỏi phòng đc luôn"*: the button was there
    // and was never wired to anything.
    this.host.net?.kickUnit?.(id);
  }

  setTeam(id: string, team: MatchTeamId): void {
    this.withUnit(id, unit => this.director.setTeam(unit, team));
  }

  setBotBehaviour(id: string, flags: Partial<BotBehaviour>): void {
    const bot = this.botOf(id);
    if (bot) this.director.setBotBehaviour(bot, flags);
  }

  loadoutOf(id: string): ChampionLoadout {
    const unit = this.unitOf(id);
    return unit ? this.director.loadoutOf(unit) : DEFAULT_CHAMPION_LOADOUT;
  }

  async applyLoadout(id: string, loadout: ChampionLoadout): Promise<void> {
    const unit = this.unitOf(id);
    if (unit) await this.director.applyLoadoutLoaded(unit, loadout);
  }

  // ------------------------------------------------------------- live detail

  private scoreOf(id: string): ScoreLine {
    const unit = this.unitOf(id);
    return unit ? scoreLine(unit) : { kills: 0, deaths: 0, assists: 0, cs: 0 };
  }

  private statGroupsOf(id: string): StatGroup[] {
    const unit = this.unitOf(id);
    return unit ? statGroups(unit) : [];
  }

  private stacksOf(id: string): RosterStack[] {
    const unit = this.unitOf(id);
    if (!unit) return [];
    return this.stackSpells(unit).map(spell => ({
      spellId: spell.id,
      name: spell.name,
      count: spell.stackCount ?? 0,
    }));
  }

  // ------------------------------------------------------------------- rules

  get matchRules(): MatchRules {
    return this.director.matchRules;
  }

  getRules(): MatchRulesConfig {
    return this.director.getRules();
  }

  setRules(rules: MatchRulesConfig, persist: boolean): void {
    if (!this.canEditMatchSettings) return;
    if (persist) this.director.setRules(rules);
    else this.director.seedRules(rules);
  }

  getWorld(): WorldConfig {
    return { jungle: this.director.jungleEnabled, minions: this.director.minionsEnabled };
  }

  setWorld(world: Partial<WorldConfig>): void {
    if (!this.canEditMatchSettings) return;
    if (world.jungle !== undefined) this.director.jungleEnabled = world.jungle;
    if (world.minions !== undefined) this.director.minionsEnabled = world.minions;
  }

  getMode(): MatchModeId {
    return this.director.mode;
  }

  async setMode(id: MatchModeId): Promise<void> {
    if (!this.canEditMatchSettings) return;
    await this.director.setMode(id);
  }

  // --------------------------------------------------------------------- map

  availableMaps(): QualifiedMapSummary[] {
    return [...contentCatalog().maps()];
  }

  /** Straight through to the registry — see `MatchConfigSource.loadMapGeometry`. */
  loadMapGeometry(id: string): Promise<MapGeometry | null> {
    return contentCatalog().loadMapGeometry(id);
  }

  /**
   * The live map, read straight off the host — never `this.director.mapChoice`,
   * which is what the *next* match will boot onto and moves the moment
   * `setMap` is called. See `MatchConfigSource.getMap`'s own doc comment.
   */
  getMap(): string {
    return this.host.activeMapId;
  }

  /**
   * Persists the choice for next time. Does not touch the running world — see
   * `MatchConfigSource.setMap`.
   *
   * Refused on a client even though it only writes a *local* preference for the
   * next match, and so is the one gated write that cannot desync anything. It
   * is gated because of what the control says: in a LAN match the next map is
   * the host's hello (`net/clientBoot.ts`), so a client picking one is being
   * told it chose something it did not.
   */
  setMap(id: string): void {
    if (!this.canEditMatchSettings) return;
    this.director.setMapChoice(id);
  }

  // ------------------------------------------------------------------ cheats

  getCheats(): CheatConfig {
    return this.director.cheats();
  }

  setCheats(cheats: Partial<CheatConfig>): void {
    if (cheats.revealMap !== undefined) this.director.revealMap = cheats.revealMap;
    if (cheats.debug) {
      for (const [key, on] of Object.entries(cheats.debug)) {
        this.director.setDebugFlag(key as keyof CheatConfig['debug'], on);
      }
    }
    // `playerInvulnerable` / `botInvulnerable` are deliberately not handled
    // here: out here a cheat lands on a *unit*, and `setInvulnerable(id, on)`
    // is the call that names one. Writing the array would mean guessing which
    // row each index meant, which is the pregame source's question, not this
    // one's.
  }

  setInvulnerable(id: string, on: boolean): void {
    this.cheatOnUnit(id, unit => this.director.setInvulnerable(unit, on));
  }

  // --------------------------------------------------------------- templates

  /**
   * One participant's bag as stored ids. The ids are already qualified —
   * everything a bag can hold arrived through the shop or `grantItem`, both
   * of which take a `QualifiedItem` — so this is a read, not a translation.
   */
  private bagOf(unit: Champion): string[] {
    const ids: string[] = [];
    for (const held of unit.items ?? []) {
      const id = held?.def?.id;
      if (typeof id === 'string' && id.length > 0) ids.push(id);
    }
    return ids;
  }

  /**
   * `toPregameConfig()` — the exact blob `persist()` writes, i.e. this match
   * as the config that would boot it again — plus what everyone is holding.
   * Bags are read in roster order, which is bot-slot order (`bots()` and the
   * per-slot arrays in the config are index-aligned by construction).
   */
  templateSetup(): MatchTemplateSetup {
    let player: Champion | null = null;
    for (const entry of this.entries()) if (entry.isPlayer) player = entry.unit;
    return {
      config: this.director.toPregameConfig(),
      items: {
        player: player ? this.bagOf(player) : [],
        bots: this.director.bots().map(bot => this.bagOf(bot)),
      },
    };
  }

  /**
   * Applies on the spot through the reset's own machinery
   * (`MatchDirector.applyConfig`): bots respawned on the template's roster,
   * rules and world moved, storage written — then the bags, granted onto the
   * fresh roster the way the give-item cheat grants. Gated like
   * `resetToDefaults` below and for the same reason: it is the rules, the
   * world, the roster and the cheats in one press.
   */
  async applyTemplateSetup(setup: MatchTemplateSetup): Promise<void> {
    if (!this.canEditMatchSettings) return;
    const config = sanitizePregameConfig(setup.config);
    // False when a newer reset or roster edit superseded this apply while its
    // kits were loading — the match then belongs to that newer edit, and
    // granting this template's bags onto it would mix two setups.
    const applied = await this.director.applyConfig(config);
    if (!applied) return;

    const items = sanitizeTemplateItems(setup.items);
    for (const entry of this.entries()) {
      if (entry.isPlayer) grantTemplateBag(entry.unit, items.player);
    }
    const bots = this.director.bots();
    for (let i = 0; i < bots.length; i++) grantTemplateBag(bots[i], items.bots[i] ?? []);
  }

  // ------------------------------------------------------------------ device

  get touchUi(): boolean {
    return this.host.touchUi;
  }

  get inputMode(): TouchModePreference {
    return touchModePreference();
  }

  /**
   * Mid-match, so it applies as well as remembers: `setTouchUiEnabled` swaps
   * the on-screen controls and the HUD layout on the spot. `remember` is left
   * to `setTouchModePreference` above it, which stores the tri-state — the
   * boolean the match takes cannot express `'auto'`.
   */
  setInputMode(mode: TouchModePreference): void {
    setTouchModePreference(mode);
    this.host.setTouchUiEnabled(touchControlsPreference());
  }

  get renderQuality(): RenderQuality {
    return this.host.renderQuality;
  }

  get renderFps(): RenderFps {
    return this.host.renderFps;
  }

  setRenderQuality(quality: RenderQuality): void {
    this.host.setRenderQuality(quality);
  }

  setRenderFps(fps: RenderFps): void {
    this.host.setRenderFps(fps);
  }

  get renderScale(): RenderScale {
    return this.host.renderScale;
  }

  setRenderScale(scale: RenderScale): void {
    this.host.setRenderScale(scale);
  }

  get screenShake(): boolean {
    return this.host.screenShake;
  }

  setScreenShake(enabled: boolean): void {
    this.host.setScreenShake(enabled);
  }

  /**
   * Gated: it is the rules, the world, the map and the cheats in one press, so
   * leaving it open would be a single button that undoes every other refusal.
   */
  async resetToDefaults(): Promise<void> {
    if (!this.canEditMatchSettings) return;
    await this.director.resetToDefaults();
  }
}
