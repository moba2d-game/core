import type {
  ActiveMap,
  MapTuning,
  NeutralSlot,
  SpawnSlot,
  StructureSlot,
} from '@/content/ContentPack';
import { drawMoveMarker, moveMarkerPose, type MoveMarker } from './render/moveMarker';
import { HotKeys, ItemHotKeys, SpellHotKeys } from './constants';
import { withSimulationStep } from './simulationClock';
import { contentRegistry } from '@/content/registry';
import { randomMatchSeed } from './matchSeed';
import { freshRenderStress, nextStressState, stressTier } from './render/renderStress';
import { resolveEconomy } from './config/mapTuning';
import { matchModeFor, mergeTuning, type MatchModeId } from './config/matchModes';
import EventDirector from './events/EventDirector';
import EventType from './enums/EventType';
import { reachablePoints, type Point } from './events/randomEvents';
import { clearActiveLanes, setActiveLanes } from './lanes';
import AttackableUnit from './gameObject/attackableUnits/AttackableUnit';
import Champion from './gameObject/attackableUnits/Champion';
import Pet from './gameObject/attackableUnits/Pet';
import AIChampion from './gameObject/attackableUnits/AIChampion';
import Monster from './gameObject/attackableUnits/Monster';
import { teamBodyColor } from './gameObject/attackableUnits/Minion';
import Camera, { zoomFactorPreference } from './gameObject/map/Camera';
import FogOfWar from './gameObject/map/FogOfWar';
import TerrainMap from './gameObject/map/TerrainMap';
import ZoneController from './zone/ZoneController';
import { drawZone, zoneBanner } from './zone/drawZone';
import { ZoneEndCard, zoneEndCardView } from './zone/zoneEndCard';
import { zoneLivesLabel } from './zone/zoneRules';
import Minimap, {
  hitTest,
  MINIMAP_LIVE_INTERVAL_MS,
  MINIMAP_LIVE_INTERVAL_DROWNING_MS,
  MINIMAP_LIVE_INTERVAL_STRESSED_MS,
  type MinimapBlip,
  type MinimapHost,
} from './gameObject/map/Minimap';
import Fountain from './gameObject/structures/Fountain';
import Turret from './gameObject/structures/Turret';
import { turretPassivesFor } from './gameObject/structures/turretPassives';
import InGameHUD from './hud/InGameHUD';
import {
  attachRecall,
  fountainsFromSlots,
  getChampionPresetFromLoadout,
  minionMusterSlotsFrom,
  monsterBodyPreset,
  neutralSlotFill,
  loadoutFromPlan,
  planLoadout,
  planMatchKits,
  presetFromPlan,
  turretsFromSlots,
  type MatchPlan,
  type MinionMusterPoint,
} from './preset';
import {
  loadPregameConfig,
  toMatchRules,
  type ChampionLoadout,
  type MatchRules,
} from './config/PregameConfig';
import { takeTemplateItems } from './config/matchTemplates';
import { takeMomentBoot, type MomentBoot } from './config/savedMoments';
import { applyMomentOverlay, captureCheckpoint, type Checkpoint } from './checkpoint/Checkpoint';
import { grantTemplateBag } from './economy/ItemShop';
import ObjectManager from './managers/ObjectManager';
import type { RenderQuality } from './managers/ObjectManager';
import MinionSpawner from './managers/MinionSpawner';
import MatchDirector from './MatchDirector';
import NavigationSystem from './nav/NavigationSystem';
import { drawNavDebug } from './nav/NavDebugOverlay';
import { drawExecuteMarks } from './combat/ExecuteMarks';
import { drawDebugOverlay } from './debug/DebugOverlay';
import { FpsMeter, drawFpsOverlay } from './debug/FpsOverlay';
import EventManager from '@/managers/EventManager';
import MatchAnnouncer from '@/game/combat/Announcer';
import { bountyForKill, wantedOf } from '@/game/combat/Bounty';
import { invalidateSafeArea } from '@/game/render/safeArea';
import { DeathCamera, type SpectateCandidate } from './render/deathCamera';
import { MatchRecorder } from './combat/MatchRecorder';
import { uuidv4 } from '@/utils';
import SpellInputController from './spell/input/SpellInputController';
import TargetResolver, {
  defaultIsTargetable,
  defaultTargetInfo,
} from './spell/targeting/TargetResolver';
import AssetManager from '@/managers/AssetManager';
import { findAttackTargetAlongRay, findAttackTargetNearPoint } from './combat/AttackTargeting';
import TouchControls, {
  touchControlsPreference,
  rememberTouchControlsPreference,
  type TouchControlsHost,
  type TouchPoint,
  type TouchRow,
  type TouchSpellView,
} from './input/TouchControls';
import { touchAimRange } from './input/SpellAim';
import type { AimCandidate } from './input/SpellAim';
import type { JoystickVector } from './input/VirtualJoystick';
import { issuePointerOrder } from './input/PointerOrders';
import type Spell from './gameObject/Spell';
import type { CastContext, Vec2 } from './spell/runtime/types';
import { isNetClient, netClientBoot } from './net/netRole';
import type { NetGameHooks } from './net/hooks';
import { MAP_BACKGROUND_GREY } from './render/palette';

/**
 * How far ahead of the champion the joystick plants its destination, as frames
 * of travel at the current move speed.
 *
 * The engine walks a unit at `destination`; a stick gives a held direction. The
 * two meet by re-planting a destination in front of the champion every frame
 * the stick is held, which keeps every existing modifier — roots, slows, the
 * `canMove` gate, terrain push-out — working untouched, where steering
 * `position` directly would bypass all of them.
 *
 * It has to be more than one frame of travel or `move()` snaps onto the
 * destination and the champion stutters in place; 30 frames is half a second of
 * walking. Nothing coasts when the thumb lifts, because releasing calls
 * `stopMovement()`, which pins the destination back onto the position.
 */
const JOYSTICK_LOOKAHEAD_FRAMES = 30;
const JOYSTICK_LOOKAHEAD_MIN = 120;

/**
 * The four render preferences now live in `game/config/renderPreferences.ts` —
 * `localStorage` with no p5 and no imports of its own, so the match-config
 * panel can read them from the menu without pulling this file (and the match
 * with it) into the menu's chunk. Re-exported here so every existing
 * `from '@/game/Game'` still resolves; this file remains the only thing that
 * *applies* them.
 */
export {
  renderQualityPreference,
  setRenderQualityPreference,
  renderFpsPreference,
  setRenderFpsPreference,
  screenShakePreference,
  setScreenShakePreference,
  type RenderFps,
} from './config/renderPreferences';

// A re-export does not bind the names locally; this file applies all six.
import {
  renderQualityPreference,
  setRenderQualityPreference,
  renderFpsPreference,
  setRenderFpsPreference,
  screenShakePreference,
  setScreenShakePreference,
  type RenderFps,
} from './config/renderPreferences';

/** Truy Nã: the wanted champion's minimap dot, gold. */
const WANTED_BLIP_COLOR = [255, 205, 40] as const;

export default class Game {
  /**
   * The active map's edge length in world units — `map.size`, set in the
   * constructor. Used to be a `6400` literal here (and a matching `|| 6400`
   * fallback in `TerrainMap`); both now read the map instead. See the
   * `map` constructor parameter's own doc comment for what guarantees the
   * map is present.
   */
  readonly mapSize: number;
  /**
   * The active map's own qualified id — `map.id`, set in the constructor.
   * The one fact `MatchDirectorSource.getMap()` reads about a running
   * match's world: a live match cannot swap its terrain, nav grid or
   * standing objects out from under itself, so the panel reports this,
   * unmoved, rather than whatever the player has since picked for next time
   * (`MatchDirector`'s own `_mapChoice`). Read through `HudInteractions`
   * (`hudInteractions.ts`), not through `MatchDirector` — the same seam
   * `renderQuality`/`renderFps` already use for a fact about the match that
   * is not one of its mutable settings.
   */
  readonly activeMapId: string;

  /**
   * The active map's own numbers — `MapSummary.tuning`, or `undefined` for a
   * map that stated none, which is every map written before it existed.
   * Published on the runtime context (`GameObjectRuntimeContext.mapTuning`)
   * so a unit can resolve its own slice at the moment it needs it.
   */
  readonly mapTuning?: MapTuning;
  /**
   * The mode this match booted under — `config/matchModes.ts`. What it
   * decided is already folded into `mapTuning` and the kits; this is kept so
   * the host can tell a joining client (`hello.mode`) and the director can
   * report it back to the panel.
   */
  readonly matchMode: MatchModeId;
  private _zone: ZoneController | null | undefined;
  /** The zone mode's end card: Trận mới / Về menu / Xem tiếp. */
  private zoneEndCard: ZoneEndCard | null = null;
  /**
   * The poison zone of the `zone` mode, or null in every other. Built on first
   * use because a net client's `matchSeed` is set after the constructor.
   */
  get zone(): ZoneController | null {
    if (this._zone === undefined) {
      this._zone =
        matchModeFor(this.matchMode).zone ? new ZoneController(this.mapSize, this.matchSeed) : null;
    }
    return this._zone;
  }
  /**
   * What a sale pays back in this match — `EconomyTuning.sellRefund`.
   *
   * A field on `Game` because `Game` *is* the `ShopHost` every shop call is
   * handed (`hudInteractions`, `HostSession` and `ShopHistory` all pass it
   * straight through), so putting the number here is what makes it reach both
   * the sale and the panel that prints it without touching a single call site.
   * Resolved once: a map's tuning cannot change mid-match.
   */
  readonly sellRefund: number;
  /**
   * The active map's own `slots.minion`, teamId-bridged — where each team's
   * wave forms up, per lane. Set in the constructor, read by `MinionSpawner`
   * (`MinionSpawnerContext.minionMuster`) once per spawn rather than derived
   * from the live turrets the way `musterPointFor` used to.
   */
  readonly minionMuster: MinionMusterPoint[];
  /**
   * The active map's own `slots.neutral` — where each jungle camp sits. Set
   * in the constructor and read by `spawnJungle()`, which stays a no-arg
   * method (`MatchDirectorContext.spawnJungle`) so `MatchDirector` can
   * respawn the whole jungle when `jungleEnabled` is flipped back on
   * mid-match without needing to hold the map itself.
   */
  readonly neutralSlots: NeutralSlot[];
  /*
   * There is no `readonly lanes: LaneDefinition[]` field beside the two
   * above: `getLaneWaypoints`, `LANES` and the rest of `lanes.ts` have to
   * stay callable without a `Game` in hand (see that module's own doc
   * comment), so the constructor installs `map.lanes` into its live state
   * (`setActiveLanes`) instead of holding it here.
   */
  readonly fps = 60;
  /**
   * The one random number this match agrees on, across the wire.
   *
   * Drawn here and overwritten from the handshake on a LAN client, before
   * anything derives from it — see `matchSeed.ts` for why content that wants
   * "different every match" has to ask for this rather than call
   * `Math.random()` itself.
   */
  matchSeed = randomMatchSeed();

  renderFps: RenderFps = renderFpsPreference();
  /**
   * Whether this machine is currently missing its own frame target, which is
   * what `auto` quality degrades on. Derived once a frame in `draw()` from the
   * same meter the FPS readout prints.
   *
   * See `render/renderStress.ts` for why it takes a *sustained* stretch in
   * either direction rather than one reading: the first version flipped on a
   * single smoothed sample and an M4 Pro — which does not struggle — could be
   * parked in the degraded state by one hitch.
   */
  renderStressed = false;
  /**
   * And the deeper rung: not merely missing the target but a long way under it.
   *
   * Separate from `renderStressed` because what the two are allowed to take
   * away is different. The first gives up decoration; this one is permitted to
   * make the *fight itself* simpler — a thinner crowd, shorter-lived numbers,
   * a fog that recomputes less often — which is only an acceptable trade when
   * the alternative is fifteen frames a second.
   */
  deeplyStressed = false;
  private stressState = freshRenderStress();
  renderQuality: RenderQuality = renderQualityPreference();

  camera!: Camera;
  objectManager!: ObjectManager;
  eventManager!: EventManager;
  /** Who killed whom, as the kill feed tells it. See `combat/Announcer.ts`. */
  announcer!: MatchAnnouncer;
  /** Sự Kiện Ngẫu Nhiên's schedule; only in that mode, never on a LAN client. See `events/`. */
  eventDirector: EventDirector | null = null;
  /** Where the camera goes while the player is dead. See `render/deathCamera.ts`. */
  deathCamera!: DeathCamera<Champion>;
  /**
   * This match's identity in the local history — what makes the recorder's
   * repeated saves one entry. See `combat/MatchRecorder.ts`.
   */
  readonly matchId = uuidv4();
  recorder!: MatchRecorder;
  terrainMap!: TerrainMap;
  navigation!: NavigationSystem;
  fogOfWar!: FogOfWar;
  inGameHUD!: InGameHUD;
  player!: Champion;
  spellInputController!: SpellInputController;
  /**
   * The inventory's own input, a second instance of the same controller. See
   * `ItemHotKeys` for why the row is parallel to the kit rather than part of
   * it; the consequence here is that an item active gets press, hold-and-
   * release and charging for free, and that neither controller can see the
   * other's slots.
   */
  itemInputController!: SpellInputController;
  minionSpawner!: MinionSpawner;
  touchControls!: TouchControls;
  minimap!: Minimap;
  /** Backs the Cài đặt tab's FPS toggle (`director.debug.fps`); see `debug/FpsOverlay.ts`. */
  private readonly fpsMeter = new FpsMeter();

  /**
   * Every mutation of this match once it is running — roster, world, rules —
   * goes through here, so the HUD never reaches into `objectManager` or
   * `minionSpawner` on its own. Nothing in this constructor uses it; it is the
   * entry point for changes made *during* the match. See `MatchDirector`'s
   * file comment.
   */
  director!: MatchDirector;

  /**
   * How the match asks to be left. `GameScene` sets it to its own
   * `sceneManager.showScene(MenuScene)` right after constructing this.
   *
   * A callback rather than a scene-manager reference because the dependency
   * runs the other way everywhere else: scenes know about games, games do not
   * know about scenes. Left `null` in a bench that never built a scene, where
   * "leave the match" has no meaning.
   */
  onExitRequested: (() => void) | null = null;

  /**
   * How the match asks to be *replaced* — torn down and booted again on the
   * config as it now stands. `GameScene` sets it to `showScene(GameScene)`,
   * which runs its own `exit()` then `enter()`: the same path a match takes on
   * the way back in from the menu, minus the menu.
   *
   * Separate from `onExitRequested` because the two differ in where the player
   * ends up, and only one of them is a way *out*. It exists because the map is
   * the one setting the panel cannot apply to a running world (a live `Game`
   * holds its geometry from construction), so "use this map" has to mean
   * "start again" or it means nothing.
   */
  onRestartRequested: (() => void) | null = null;
  onPauseChanged: ((paused: boolean) => void) | null = null;

  /**
   * The attached LAN session, or null for every offline match. Set by
   * `HostSession`/`ClientSession` after construction; `Game` only ever calls
   * through the `NetGameHooks` interface — see `net/hooks.ts` for the whole
   * (deliberately small) coupling.
   */
  net: NetGameHooks | null = null;

  /**
   * Cooldown reduction and URF, resolved from the pregame config at
   * construction. `Spell.ts` reads this off `owner.game.matchRules` — see
   * `Spell.reducedCooldown` — rather than this class pushing the numbers into
   * every spell it creates, so a spell built at any point in a match (a
   * respawn's fresh kit, a champion swap) picks the same rules up on its own.
   *
   * Not fixed for the match any more: the practice panel retunes them through
   * `director.setRules()`, which *mutates this object in place* for exactly the
   * reason above — every spell already holds this reference, so replacing it
   * would leave all of them reading the old numbers.
   */
  matchRules!: MatchRules;

  /**
   * Where each slot is aimed by a thumb, when one is on it. Empty on the
   * keyboard, and `createSpellContext` falls back to the cursor — which is what
   * makes this the only coupling the touch layer needs to the cast path.
   */
  private touchAim = new Map<number, Vec2>();
  /**
   * The same thing for the inventory row. A second map rather than a shared
   * one, because both rows are indexed from 0 — item slot 2 and kit slot 2 are
   * different buttons, and one map would have a thumb on an item aim the
   * champion's W.
   */
  private itemTouchAim = new Map<number, Vec2>();
  /**
   * Every finger currently on the glass, and the subset of them the minimap
   * claimed. Both live here rather than in `TouchControls` because the whole
   * point is to decide *before* the controls are told anything.
   */
  private seenTouches = new Set<number>();
  private minimapTouches = new Set<number>();
  /** Last direction the champion was driven, for aiming a tap with no target. */
  private lastFacing = { x: 1, y: 0 };

  fountains: Fountain[] = [];
  turrets: Turret[] = [];
  monsters: Monster[] = [];

  /** The last move click, drawn as a fading ring (`render/moveMarker.ts`). */
  moveMarker: MoveMarker | null = null;
  worldMouse!: p5.Vector;
  paused = false;
  /**
   * Milliseconds of unpaused match. The single time domain every bot shares.
   *
   * Deliberately not per-bot: bots are added mid-match (`MatchDirector.addBot`,
   * the panel's Đội tab) and `TeamBlackboard` is one time-keyed object per
   * game, so a second clock domain reading it never expires a memory and can
   * stall the whole board's refresh. Behind the pause gate on purpose, so the
   * practice panel holding the match does not age anyone's memory.
   */
  matchTimeMs = 0;
  /**
   * This session's fight save points — "Mốc đã lưu" — newest first. Held in
   * memory only (live references inside; see `checkpoint/Checkpoint.ts`);
   * the persisted, cross-session shape lives in `config/savedMoments.ts` and
   * is written when a row is kept to the library. Managed by the HUD
   * (`hudInteractions`), which also refuses every entry point in a LAN match.
   */
  checkpoints: Checkpoint[] = [];
  touchUi: boolean;

  /**
   * @param map The world this match plays on, geometry already resolved —
   *   not the lazy `MapDefinition` a pack declares. Required, not defaulted:
   *   `validate.ts` refuses a pack whose map has no size, so a `Game` built
   *   without one is a programming error to surface loudly rather than a
   *   `6400` to fall back to. `GameScene.startGame()` is what guarantees
   *   this exists before construction — it awaits
   *   `contentCatalog().loadMapGeometry(...)` alongside the spell/art loads
   *   it already awaits, and only then calls `new Game(...)`. This
   *   constructor itself stays synchronous on purpose: `AIChampion` rebuilds
   *   mid-`update()`, and the engine's read side is synchronous by design —
   *   see `CLAUDE.md`'s note on the trap this avoids.
   * @param plan Which kits every unit will play, with all randomness already
   *   rolled. `GameScene` passes one because it has to: the spell classes are
   *   fetched per champion now, so *something* has to decide what a match needs
   *   before it can be loaded, and that decision has to be the same one this
   *   constructor then builds from. Omitted, this plans for itself — which is
   *   correct only when the catalogue is already loaded, i.e. in tests.
   */
  /**
   * The only way `GameScene` builds a match, and the difference is what happens
   * when the constructor throws.
   *
   * `setActiveLanes` claims a process-wide slot early — before anything queues
   * a wave or builds a blackboard, because those read it — and everything after
   * it can fail. A throw there left the slot claimed by a `Game` that does not
   * exist and that nobody holds a reference to, so `destroy()` could never run
   * and *every later match start* threw out of `setActiveLanes`, blaming a
   * previous match rather than the failure that actually happened.
   *
   * `destroy()` already reasons about exactly this for teardown, and clears the
   * lanes before anything that can throw. This is the same rule for the other
   * end of a match's life.
   */
  static create(map: ActiveMap, plan?: MatchPlan): Game {
    try {
      return new Game(map, plan);
    } catch (error) {
      clearActiveLanes();
      throw error;
    }
  }

  constructor(map: ActiveMap, plan?: MatchPlan) {
    this.mapSize = map.size;
    this.activeMapId = map.id;
    // Read once, before anything that might construct a Champion or a Spell:
    // `matchRules` has to be in place the moment the player's own kit is
    // built further down, and the mode's tuning has to be merged before the
    // first `resolveEconomy` below. Validated/defaulted by `loadPregameConfig`
    // itself, so a corrupt or missing stored blob never reaches this
    // constructor as anything other than a playable config.
    const pregameConfig = loadPregameConfig();
    const kits = plan ?? planMatchKits(pregameConfig);
    // The plan's mode wins over storage: a net client's plan is the host's
    // room, and its own stored mode is somebody else's evening.
    const mode = matchModeFor(kits.mode ?? pregameConfig.mode);
    this.matchMode = mode.id;
    // The map's numbers with the mode's laid over them. Every reader resolves
    // `game.mapTuning` at the moment it needs it, so this one merge is the
    // whole of how a mode changes the economy, respawn or champion speed.
    this.mapTuning = mergeTuning(map.tuning, mode.tuning);
    this.sellRefund = resolveEconomy(this.mapTuning).sellRefund;
    // A "Mốc đã lưu" opened on the menu, parked for this boot — the seed is
    // taken here, before the jungle spawns further down, because seeded
    // content derives its rotation from it; the overlay waits until the
    // world stands (the bottom of this constructor). One-shot like the
    // template bag stash below, and skipped on a net client for the same
    // reason: its world belongs to the host.
    const momentBoot: MomentBoot | null = isNetClient() ? null : takeMomentBoot();
    if (momentBoot) this.matchSeed = momentBoot.matchSeed;
    this.minionMuster = minionMusterSlotsFrom(map.slots.minion, map.factions);
    this.neutralSlots = map.slots.neutral;
    // Before anything queues a wave or builds a blackboard: `MinionSpawner`,
    // `TeamBlackboard` and `LaneObjectives.ts` all read `lanes.ts`'s live
    // `LANES`/`LANE_WAYPOINTS` rather than a value handed to them, so this is
    // what makes those the *this* match's lanes. `undefined` is a map with no
    // `lanes[]` at all — spec §7's laneless case — which empties both and
    // leaves PUSH nothing to fall through from ROAM/FIGHT for.
    setActiveLanes(map.lanes);
    this.matchRules = toMatchRules(pregameConfig.rules);
    this.touchUi = touchControlsPreference();

    this.worldMouse = createVector(0, 0);
    this.camera = new Camera();
    this.camera.setShakeEnabled(screenShakePreference());
    // Before anything reads a world position from the screen. `width`/`height`
    // are valid here: `Game` is constructed from `GameScene.enter()`, after
    // `createCanvas`.
    this.camera.setZoomFactor(zoomFactorPreference(this.touchUi));
    this.camera.fitTo(width, height);
    // A match that boots and is never resized must not sit at the constructed
    // 0.5 default, and the opening lerp from it would now zoom a phone *out*.
    this.camera.snapToScale();
    this.objectManager = new ObjectManager(this);
    this.eventManager = new EventManager();
    this.announcer = new MatchAnnouncer(this.eventManager, () => this.matchTimeMs);
    this.recorder = new MatchRecorder({
      matchId: this.matchId,
      mapId: this.activeMapId,
      mode: this.matchMode,
      enabled: !isNetClient(),
      nowMs: () => this.matchTimeMs,
      clock: () => Date.now(),
      player: () => this.player ?? null,
      botCount: () => this.director?.bots().length ?? 0,
      onAnnounce: listener => this.announcer.onAnnounce(listener),
    });
    this.deathCamera = new DeathCamera<Champion>({
      isDead: () => this.player.isDead,
      deathPoint: () => this.player.position,
      allies: () => this.spectateCandidates(),
      nowMs: () => this.matchTimeMs,
      follow: target => this.followForDeathCamera(target),
    });
    this.announcer.bountyEnabled = mode.bounty === true;
    this.announcer.attach();
    this.terrainMap = new TerrainMap(this, map);
    // The map is static, so every unit's routing is derived from the wall layer
    // once here — about 7ms and 1.6MB for the whole game — rather than per unit
    // per frame. Built off the same Obstacle list the collision push-out uses,
    // so there is one source of truth for where the walls are.
    // `map.id` caches the grid: it is a pure function of the wall layer and
    // the map does not change, so a second match here — a rematch, a restart,
    // the same map twice in an evening — reuses it, and the pregame screen can
    // build it before anyone presses Bắt Đầu (`prewarmNavigation`).
    this.navigation = new NavigationSystem(
      this.terrainMap.wallPolygons(),
      this.mapSize,
      undefined,
      map.id
    );
    // And now literally one structure, not merely one source: the grid routes
    // are planned against is handed straight back to be the field they are
    // enforced against. Those used to be a clearance grid and a pile of SAT
    // polygons giving different answers to "where is the wall", which is what
    // NAV_MAX_ACCEPTED_OVERLAP exists to reconcile. Without this line
    // `TerrainMap` would build an identical second one and hold it twice.
    this.terrainMap.useNavGrid(this.navigation.grid);
    this.fogOfWar = new FogOfWar(this);
    if (mode.randomEvents && !isNetClient()) this.eventDirector = this.createEventDirector();
    this.minimap = new Minimap(this.minimapHost());
    this.inGameHUD = new InGameHUD(this);

    // Fountains first: each champion asks the matching team fountain for its
    // initial point, and randomSpawnPoint falls back safely for UUID/FFA teams.
    this.spawnFountains(map.slots.spawn, map.factions, map.tuning);

    // Blue by default and for every match before the team tab existed, but the
    // player is now a movable roster slot like any bot — so its side comes from
    // the config, which persists a team switch the same way it persists a bot's.
    // A net client's side was decided by the host and arrived in the
    // handshake (`net/clientBoot.ts`); everything else about the player's
    // construction is unchanged — its kit is already in `plan.player`.
    const playerTeam = netClientBoot()?.playerTeam ?? pregameConfig.playerTeam;
    this.player = attachRecall(
      new Champion({
        game: this,
        position: this.randomSpawnPoint(playerTeam),
        teamId: playerTeam,
        preset: presetFromPlan(kits.player),
      })
    );
    this.objectManager.addObject(this.player);
    this.spellInputController = new SpellInputController({
      keyBindings: SpellHotKeys,
      getSpell: slot => this.player.spells[slot],
      createContext: (_spell, slot, _heldMs, phase) => {
        const spell = this.player.spells[slot];
        if (!spell) return undefined;
        // A thumb aims by dragging; a mouse aims by being somewhere. One line
        // decides which, and every spell downstream sees an ordinary context.
        const aim = this.touchAim.get(slot) ?? this.worldMouse;
        // A net client forwards presses and releases to the host and then
        // lets the local seam run too — that is the prediction (the session
        // answers `false`; `true` is the "wire only" path). The phase is what
        // lets a charge cross as press *and* release instead of firing at
        // minimum charge, and keeps the per-frame hold stream off the wire.
        if (this.net?.interceptCast(slot, aim, phase)) return undefined;
        return this.createSpellContext(spell, this.player, aim);
      },
      // A cancelled charge must be called off on the host too, or it keeps
      // charging there and fires at max on its own.
      onCancel: slot => this.net?.interceptCastCancel(slot),
    });

    this.itemInputController = new SpellInputController({
      keyBindings: ItemHotKeys,
      getSpell: slot => this.player.items[slot]?.active ?? undefined,
      createContext: (_spell, slot, _heldMs, phase) => {
        const spell = this.player.items[slot]?.active;
        if (!spell) return undefined;
        // `itemTouchAim`, never `touchAim`: both rows index from 0, so the
        // kit's map would have item slot 2 aim at whatever the thumb last did
        // to the champion's W.
        const aim = this.itemTouchAim.get(slot) ?? this.worldMouse;
        // The bag is a second bar of castable things and needs the same wire
        // the kit has, tagged so the host indexes the right one — until this
        // existed a LAN client's item actives ran purely locally, which on a
        // client means they resolved into the gated funnel and did nothing.
        if (this.net?.interceptCast(slot, aim, phase, 'item')) return undefined;
        return this.createSpellContext(spell, this.player, aim);
      },
      onCancel: slot => this.net?.interceptCastCancel(slot, 'item'),
    });

    this.touchControls = new TouchControls(this.touchControlsHost(), this.touchUi);
    this.applyTouchUiClass();

    // Each bot's champion/kit comes from its own slot in ai.bots — 'random'
    // by default (today's behaviour, unchanged), or a specific loadout the
    // player configured for that bot. Behaviour flags come from the matching
    // slot in ai.botBehaviours — including how well it plays, which is the same
    // record's fourth field — and its persisted side comes from ai.botTeams.
    // Older configs migrate behaviours from their global flags and teams to a
    // stable Red/Blue alternation. Count is clamped by `loadPregameConfig`; all
    // three slot arrays always have AI_COUNT_MAX entries.
    // Which loadout each unit built above is carrying, kept until the director
    // exists to be told. `getChampionPresetFromLoadout` is one-way — a bot on
    // 'random' has already become one particular champion by the time it is
    // constructed — so this is the only moment the mapping is knowable, and the
    // practice panel's editor needs it to open on a unit's real kit rather than
    // on a default (see `MatchDirector.loadoutOf`).
    const loadoutsInPlay: { unit: Champion; loadout: ChampionLoadout }[] = [
      {
        unit: this.player,
        // A net client's champion came from the host's hello plan, so the
        // editor must open on *that* — the stored config is this device's
        // last local loadout, and on a two-tab machine it is literally the
        // host's (both tabs persist into one localStorage key). See
        // `loadoutFromPlan`.
        loadout: isNetClient() ? loadoutFromPlan(kits.player) : pregameConfig.player,
      },
    ];

    // A net client fields no bots of its own: the host's champions — bots
    // and other players alike — arrive as spawn events and are built by
    // `ClientSession` (LAN design spec §4). The loop below is the one place
    // bots are born at boot, which is what makes this a single gate.
    const localBotCount = isNetClient() ? 0 : pregameConfig.ai.count;
    for (let i = 0; i < localBotCount; i++) {
      const botLoadout = pregameConfig.ai.bots[i];
      const botBehaviour = pregameConfig.ai.botBehaviours[i];
      const botTeam = pregameConfig.ai.botTeams[i];
      const bot = attachRecall(
        new AIChampion({
          game: this,
          position: this.randomSpawnPoint(botTeam),
          teamId: botTeam,
          preset: presetFromPlan(kits.bots[i] ?? planLoadout(botLoadout)),
          // Re-resolving the same loadout on every respawn is what makes a
          // bot configured with a fixed champion keep that identity across
          // deaths, while a bot left on 'random' keeps re-rolling exactly as
          // it always has (getChampionPresetFromLoadout falls through to
          // getChampionPresetRandom for 'random').
          // Twins: the team's rolled champion, not a fresh roll, every life.
          presetFactory:
            mode.twins && kits.bots[i]
              ? () => presetFromPlan(kits.bots[i])
              : () => getChampionPresetFromLoadout(botLoadout),
          autoMove: botBehaviour.autoMove,
          autoAttack: botBehaviour.autoAttack,
          autoCast: botBehaviour.autoCast,
          difficulty: botBehaviour.difficulty,
        })
      );
      this.objectManager.addObject(bot);
      loadoutsInPlay.push({ unit: bot, loadout: botLoadout });
    }

    // A "Trận mẫu" applied on the menu parks its bags in the config module,
    // because the menu cannot reach units that do not exist yet — this is the
    // other end of `PregameConfigSource.applyTemplateSetup`. Taken once, so a
    // plain restart re-rolls an ordinary match instead of re-granting a stale
    // template's build; skipped on a net client, whose units belong to the
    // host. `loadoutsInPlay` is player-then-bots in slot order, the exact
    // alignment `TemplateItems` stores.
    const templateItems = takeTemplateItems();
    if (templateItems && !isNetClient()) {
      grantTemplateBag(this.player, templateItems.player);
      for (let i = 1; i < loadoutsInPlay.length; i++)
        grantTemplateBag(loadoutsInPlay[i].unit, templateItems.bots[i - 1] ?? []);
    }

    // anything reading `isAllied` needs this.player, so these come after it.
    // The jungle is spawned only if the config wants one — the director is told
    // below, and skipping the spawn is not the same as spawning and then
    // clearing: the camps would be flushed into the world by the first
    // `ObjectManager.update()` and only swept by the second, i.e. one frame of
    // camps a player who switched the jungle off never asked to see.
    // A pack's own slot objects (a map's rules, its art) are furniture, not
    // jungle: they stand whatever the switch says. Before this a jungle-off
    // lobby got a map with invisible walls — its art lived in a slot object —
    // until a hero of that pack happened to cast.
    this.spawnSlotObjects();
    if (pregameConfig.world.jungle) this.spawnJungle();
    this.spawnTurrets(map.slots.structure, map.factions, map.tuning);
    // the spawner reads teams off the fountains, so it comes after them
    this.minionSpawner = new MinionSpawner(this);

    // Last: it reads the roster, the spawner and the rules, so all three have
    // to exist.
    this.director = new MatchDirector(this);
    // The director keeps the panel's view of the rules as percentages, and it
    // starts at "nobody has retuned this match". `matchRules` above came from
    // `pregameConfig.rules`, so without this a match booted at 40% CDR would
    // open the panel showing 0% — and the player's first nudge of the slider
    // would silently reset the match to whatever the slider was showing.
    // Re-derives the same numbers line 114 already wrote, so this changes no
    // behaviour; it only tells the director what the match started with.
    this.director.seedRules(pregameConfig.rules);
    this.director.seedMode(this.matchMode);
    for (const { unit, loadout } of loadoutsInPlay) this.director.seedLoadout(unit, loadout);
    // And the world the config asked for. `seed*` rather than the public
    // setters throughout: those persist, and a match *booting* has nothing to
    // save — it is being told what it already is. The jungle flag has to be
    // said out loud even so, because it starts on and the camps above were
    // skipped: a director that disagreed with the match would show a ticked box
    // over an empty jungle, and then write that lie over the player's setting.
    this.director.seedWorld(pregameConfig.world);
    // And the cheats, which persist now (see `CheatConfig` in
    // PregameConfig.ts). Last of the three seeds because it is the only one
    // that lands on units: `seedCheats` reads the roster to apply per-slot
    // invulnerability, and every bot above is already queued by this point —
    // `MatchDirector.bots()` counts `_objectToBeAdd`, so it does not need the
    // first `ObjectManager.update()` to have run.
    this.director.seedCheats(pregameConfig.cheats);
    // What the *next* match boots onto if the player never touches the
    // picker — see `MatchDirector.seedMapChoice`'s own doc comment for why
    // this is not just `this.activeMapId`: the config's own `mapId` may have
    // named a map nothing installs any more, in which case `GameScene`
    // already fell back to a different one for *this* match, and the panel
    // must not quietly overwrite the player's stored choice with that
    // fallback the moment any other setting changes.
    this.director.seedMapChoice(pregameConfig.mapId);

    this.camera.target = this.player.position;
    this.camera.position = this.player.position.copy();

    // The opened moment's numbers, laid over the world the template path
    // just built — after the director, the spawner and every unit exist.
    if (momentBoot) applyMomentOverlay(this, momentBoot.overlay);
    // "Đầu trận": the anchor save, so rewind always has somewhere to go —
    // and after a reopened moment it IS that moment, which is what "thử lại
    // từ đầu" should mean there. Skipped on a net client, whose match cannot
    // be rewound at all.
    if (!isNetClient()) {
      this.checkpoints.push(captureCheckpoint(this, 'Đầu trận', true));
    }
  }

  /**
   * @param spawnSlots The active map's `slots.spawn` — one fountain per slot,
   *   on the slot's own `faction` rather than its position in the array. See
   *   `preset.ts`'s `fountainsFromSlots` for the faction -> `TeamId` bridge.
   * @param factions The active map's own `factions`, in declared order —
   *   `fountainsFromSlots`/`teamIdOfFaction` read position 0/1 as BLUE/RED.
   */
  private createEventDirector(): EventDirector {
    let points: Point[] | null = null;
    return new EventDirector({
      game: this,
      seed: this.matchSeed,
      now: () => this.matchTimeMs,
      champions: () => {
        const out: Champion[] = [];
        for (const object of this.objectManager.objects) {
          if (object instanceof Champion && !object.toRemove) out.push(object);
        }
        return out;
      },
      spawn: object => this.objectManager.addObject(object),
      reachable: () => (points ??= reachablePoints(this.navigation.grid, this.player.position)),
      center: () => ({ x: this.mapSize / 2, y: this.mapSize / 2 }),
      mapSize: () => this.mapSize,
      onDeath: listener => this.eventManager.on(EventType.ON_DIE, listener),
    });
  }

  spawnFountains(spawnSlots: SpawnSlot[], factions: ActiveMap['factions'], tuning?: MapTuning) {
    for (const preset of fountainsFromSlots(spawnSlots, factions, tuning)) {
      const fountain = new Fountain({ game: this, preset });
      this.fountains.push(fountain);
      this.objectManager.addObject(fountain);
    }
  }

  /**
   * The neutral slots a pack fills with its own object — map rules, map art.
   * Called once at boot, jungle on or off; `spawnJungle` skips these.
   */
  spawnSlotObjects() {
    for (const slot of this.neutralSlots) {
      const fill = neutralSlotFill(slot);
      if (!fill || fill.kind !== 'object') continue;
      const object = fill.build(slot, this);
      // `null` is a slot the pack looked at and declined, which is how it
      // conditions on the slot's own numbers without core learning them.
      if (object) this.objectManager.addObject(object);
    }
  }

  /**
   * Walks `this.neutralSlots` (the active map's `slots.neutral`) and, for
   * each one, resolves the installed monster that fills its `role` and
   * spawns one body per `member` of it — a camp is a composition
   * (`MonsterDef.members`), not a repeat count. A slot no installed pack
   * fills is left empty rather than throwing — spec §6, `preset.ts`'s
   * `monsterFillingSlot` doc comment.
   *
   * Every body for one slot is built from `monsterBodyPreset`, whose `camp`
   * is the slot object itself — every member of the same camp ends up
   * holding the exact same `camp` reference, which is what
   * `Monster.alertCamp` matches on. Each body's own spot — `slot.{x,y} +
   * member.offset` — arrives as `MonsterPresetData.home`, which is what the
   * body spawns on, walks back to, counts as arrived at and respawns on. The
   * *leash* is still measured from `camp`, because how far a camp will chase
   * is a property of the camp and not of one wolf.
   */
  spawnJungle() {
    const economy = resolveEconomy(this.mapTuning);
    for (const slot of this.neutralSlots) {
      // What stands here at all — a pack's own object, a camp, or nothing.
      // The ruling lives in `preset.ts` rather than in this loop because this
      // loop cannot be tested: nothing constructs a real `Game`.
      const fill = neutralSlotFill(slot);
      // Objects are `spawnSlotObjects`' — once per match, never by the jungle
      // switch, which would otherwise add a second copy on every flip back on.
      if (!fill || fill.kind === 'object') continue;

      const monster = fill.monster;
      for (const member of monster.members) {
        const preset = monsterBodyPreset(monster, member, slot, this.mapTuning);
        const body = new Monster({ game: this, preset });
        body.goldBounty = economy.monsterBounty;
        this.monsters.push(body);
        this.objectManager.addObject(body);
      }
    }
  }

  /**
   * @param structureSlots The active map's `slots.structure` — one turret per
   *   slot, on the slot's own `faction`. Every entry's `kind` is `'turret'`
   *   already (`preset.ts`'s `turretsFromSlots` doc comment explains why this
   *   does not check), which is also the only structure kind `Turret` knows
   *   how to be.
   * @param factions The active map's own `factions`, in declared order — see
   *   `spawnFountains`'s matching parameter.
   */
  spawnTurrets(
    structureSlots: StructureSlot[],
    factions: ActiveMap['factions'],
    tuning?: MapTuning
  ) {
    const economy = resolveEconomy(tuning);
    for (const { x, y, teamId, preset } of turretsFromSlots(structureSlots, factions, tuning)) {
      // The turret's kit, folded on at construction. `resolveTurretPreset`
      // answers with numbers only — core's, then the map's, then the slot's —
      // and the *code* half is a passive list, the same crossing
      // `monsterBodyPreset` makes for a camp's abilities.
      //
      // **A pack's list replaces core's; it does not add to it.** Core owns
      // the three (`structures/turretPassives.ts`) because a tower's behaviour
      // decides whether a dive is a play or a coin flip, and a map drawn in
      // core's own editor must not need a particular pack installed to get
      // that. A pack with a different idea of a tower declares its own list and
      // gets exactly that list — two half-towers stacked is not a third
      // opinion.
      const turret = new Turret({
        game: this,
        position: createVector(x, y),
        teamId,
        preset: { ...preset, passives: turretPassivesFor(contentRegistry().turretPassives()) },
      });
      // What a turret is *worth* is a statement about the economy, so it comes
      // from that group rather than from `TurretStats` beside its other
      // numbers — see `EconomyTuning`'s own doc comment.
      turret.goldBounty = economy.turretBounty;
      this.turrets.push(turret);
      this.objectManager.addObject(turret);
    }
  }

  pause() {
    // A LAN match stops for nobody: the host's sim is other people's match
    // and a client's "pause" only freezes its own view while the host plays
    // on — the desync the panel then mutates. So with a net session attached
    // the config panel (and `pauseForAway`) opens over the *running* match,
    // exactly the rule the shop has always had, and this refusal is the one
    // place that decides it rather than a check at every `pause()` caller.
    if (this.net) return;
    if (this.paused) return;
    this.paused = true;
    this.onPauseChanged?.(true);
  }

  unpause() {
    if (!this.paused) return;
    this.paused = false;
    this.onPauseChanged?.(false);
  }

  fixedUpdate() {
    // Before the camera lerps, so the tick a target changes is the tick the
    // journey there starts.
    this.deathCamera.tick();
    this.recorder.tick();
    // Puts the panel's cheats back on whoever can carry them now — a champion
    // who was dead when the switch was flipped, or who has died since. See
    // `MatchDirector.tick`.
    this.director?.tick();
    this.tickZone();
    this.camera.update();
    this.worldMouse = this.camera.screenToWorld(mouseX, mouseY);
    // before objectManager.update(), so a minion released this frame is added
    // to the world in the same pass as everything else spawned this frame
    this.minionSpawner.update();
    // also before it: a route asked for last frame is in hand before the unit
    // that asked takes its next step. The pass is budgeted, so this is a few
    // hundred microseconds whatever the board looks like.
    this.navigation.update();
    this.objectManager.update();
    this.eventDirector?.tick();
    this.terrainMap.update();

    // Not through the minimap: a right click on the overlay would otherwise
    // walk the champion to whatever the map happens to be covering.
    if (
      mouseIsPressed &&
      mouseButton === RIGHT &&
      !hitTest({ x: mouseX, y: mouseY }, this.minimap.rect)
    ) {
      // A net client's orders go to the host instead of the local unit —
      // the session throttles and serializes; the ground pulse still draws,
      // because the click *was* accepted, just remotely.
      if (this.net?.interceptPointer(this.worldMouse)) {
        this.moveMarker = { x: this.worldMouse.x, y: this.worldMouse.y, atMs: this.matchTimeMs };
      } else {
        const target = issuePointerOrder(this.player, this.objectManager, this.worldMouse);
        // A move gets the existing green ground pulse. An attack already has the
        // red target ring drawn by Champion.drawAttackOrder, so stacking both
        // signals on an enemy body would say two different things at once.
        if (!target) {
          this.moveMarker = { x: this.worldMouse.x, y: this.worldMouse.y, atMs: this.matchTimeMs };
        }
      }
    }

    // Before the spell input controller ticks: a charge held under a thumb must
    // have this frame's aim in hand before its `hold` runs, or the telegraph
    // trails the drag by a frame.
    this.touchControls.update();
    this.spellInputController.update(deltaTime);
    this.itemInputController.update(deltaTime);

    // Last, after every local system has moved: a host session reads the
    // settled tick to snapshot it, and a client session overwrites puppet
    // positions with interpolated truth so the draw that follows paints the
    // network's answer, not the local guess.
    this.net?.update();
  }

  private tickZone(): void {
    const zone = this.zone;
    if (!zone) return;
    const victims: Champion[] = [];
    const fighters: { teamId: string; isDead: boolean }[] = [];
    for (const object of this.objectManager.objects) {
      if (!(object instanceof Champion)) continue;
      victims.push(object);
      // Down with a life left is not out: only an eliminated champion counts.
      if (!(object instanceof Pet))
        fighters.push({ teamId: String(object.teamId), isDead: object.zoneEliminated });
    }
    zone.tick(1000 / this.fps, this.matchTimeMs, victims, fighters);
  }

  /**
   * Where bots of `_teamId` should be, or null (every mode but `zone`). The
   * next circle while the warning is up, otherwise the current one. Read by
   * `TeamBlackboard` once per snapshot; see `BlackboardHost.botGoalArea`.
   */
  /** Sự Kiện's hints for bots — hazards to step out of, coins, mood. See `TeamBlackboard.EventHints`. */
  botEventHints(): { hazards: readonly { x: number; y: number; r: number }[]; pickups: readonly { x: number; y: number }[]; mood: 'fight' | 'normal' } | null {
    const director = this.eventDirector;
    if (!director?.activeEvent) return null;
    return { hazards: director.hazards(), pickups: director.pickups(), mood: director.mood };
  }

  botGoalArea(teamId: unknown, nowMs: number): { x: number; y: number; r: number } | null {
    const zone = this.zone;
    // Not a zone match: Sự Kiện's objective events (springs, chest) borrow the hook.
    if (!zone) return this.eventDirector?.goalArea(teamId) ?? null;
    if (zone.result) return null;
    const state = zone.state(nowMs);
    return state.next ?? state.current;
  }

  /** Screen-space countdown / verdict of the `zone` mode. */
  private drawZoneBanner(): void {
    const zone = this.zone;
    if (!zone) return;
    const line = zoneBanner(zone.state(this.matchTimeMs), zone.result, String(this.player.teamId));
    if (zone.result) {
      this.zoneEndCard ??= new ZoneEndCard({
        rematch: () => this.onRestartRequested?.(),
        menu: () => this.onExitRequested?.(),
      });
      this.zoneEndCard.sync(
        zoneEndCardView(zone.result, String(this.player.teamId), isNetClient())
      );
    }
    if (this.zoneEndCard?.visible) return;
    const lives = zone.result ? '' : zoneLivesLabel(this.player);
    // The countdown, with the player's lives after it; lives alone between warnings.
    const shown = line ? line + lives : lives.replace(/^ · /, '');
    if (!shown) return;
    push();
    noStroke();
    fill(0, 0, 0, 150);
    textAlign(CENTER, CENTER);
    textSize(zone.result ? 44 : 20);
    text(shown, width / 2 + 2, (zone.result ? height * 0.3 : 96) + 2);
    fill(255);
    text(shown, width / 2, zone.result ? height * 0.3 : 96);
    pop();
  }

  /**
   * One simulation step, and exactly one step's worth of time.
   *
   * The step is this match's own, never the renderer's: `simulationClock.ts`
   * has the measurement, but the short version is that reading p5's
   * `deltaTime` here made the 30 FPS setting run the whole game at double
   * speed. The global is substituted for the duration of the tick so the
   * eighty-two places inside the simulation that already read it get the right
   * number without any of them being edited, and restored afterwards so
   * draw-time animation keeps the real frame delta.
   */
  update() {
    if (this.paused) return;
    const step = 1000 / this.fps;
    const startedAt = performance.now();
    withSimulationStep(step, () => {
      this.matchTimeMs += step;
      this.fixedUpdate();
    });
    // Optional: `simulationClock.test.ts` drives this off the prototype with a
    // stub that has no meter.
    this.fpsMeter?.sampleUpdate(performance.now() - startedAt);
  }

  /**
   * @param alpha How far into the current simulation step the renderer is,
   *   `[0, 1]` — `GameScene.draw` computes it from the clock the two loops keep
   *   apart. Defaults to `1` (the newest tick, no interpolation) so a bench that
   *   calls `draw()` bare is unchanged. Below 1 the camera and every object are
   *   drawn blended between the last two ticks; see `render/Interpolation.ts`.
   */
  draw(alpha = 1) {
    if (this.paused) return;
    const drawStartedAt = performance.now();
    // First, and unconditionally: the frame this is measuring is the one about
    // to be drawn with the answer. `deltaTime` here is p5's real render delta —
    // the simulation's substitution (`simulationClock.ts`) is already back off.
    this.stressState = nextStressState(
      this.stressState,
      this.fpsMeter.sample(deltaTime),
      this.renderFps,
      deltaTime
    );
    this.renderStressed = this.stressState.stressed;
    this.deeplyStressed = this.stressState.deeplyStressed;
    background(MAP_BACKGROUND_GREY);

    // Substitute the interpolated camera around the *whole* body: the minimap
    // (below, outside makeDraw) paints the camera box and has to move with the
    // smooth world too. Restored before returning, so the next fixedUpdate reads
    // the true camera through screenToWorld.
    //
    // Unconditionally, not only when `alpha < 1`: the shake offset rides the
    // same substitution (see `Camera.applyRenderOrigin`), and `blend(a, b, 1)`
    // is `b`, so a frame with nothing to interpolate pays six assignments.
    this.camera.advanceShake(deltaTime);
    this.camera.applyRenderOrigin(alpha);

    this.camera.makeDraw(() => {
      this.terrainMap.draw();
      this.player.spells.forEach(spell => {
        if (spell.willDrawPreview) spell.drawPreview?.();
      });
      this.objectManager.draw(alpha);
      // After the objects: a pack that paints its own floor does it with a
      // ground object (Tidelight's art at zIndex -5), which would cover it.
      const markerPose = moveMarkerPose(this.moveMarker, this.matchTimeMs);
      if (markerPose && this.moveMarker) drawMoveMarker(drawingContext, this.moveMarker, markerPose);
      if (this.zone) {
        drawZone(drawingContext, this.zone.state(this.matchTimeMs), this.camera.getBoundingBox());
      }
      // After the units, so the ring sits on top of the body it is marking, and
      // at game level rather than on the caster: see combat/ExecuteMarks.ts.
      drawExecuteMarks(this);
      drawNavDebug(this);
      // The rest of the debug layers (terrain, collision, vision, quadtree),
      // toggled in the Gian lận tab. Each checks its flag before iterating, so
      // this line costs a handful of property reads with everything off.
      drawDebugOverlay(this);
    });

    this.fogOfWar.draw();
    // After the fog, outside camera.makeDraw: both of these are screen space,
    // and an overlay you cannot see is not an overlay.
    this.minimap.draw();
    this.drawZoneBanner();
    this.eventDirector?.drawAmbience(
      stressTier(this.renderQuality, this.renderStressed, this.deeplyStressed)
    );
    this.eventDirector?.drawBanner();
    this.touchControls.draw();
    // Screen space for the same reason, and the last of the three: a fixed
    // HUD corner, not a world position the camera would pan or zoom under it.
    drawFpsOverlay(this, this.fpsMeter);

    // True camera back, for the next fixedUpdate's screenToWorld and the next
    // tick's lerp — which would otherwise start from a blended position.
    this.camera.restoreRenderOrigin();
    this.fpsMeter.sampleDraw(performance.now() - drawStartedAt);
  }

  destroy() {
    // First, not last: the seam that keeps `setActiveLanes`'s "one
    // process-wide slot" guard (`lanes.ts`) from ever tripping on a real
    // match sequence. `GameScene.stopGame()` calls this unconditionally
    // before dropping its `Game` reference, so the *next* match's
    // constructor never installs its lanes over an unstopped one's — but a
    // throw from any of the three `.destroy()` calls below used to skip this
    // entirely, latching the guard for the rest of the process and making
    // every later match start throw out of `setActiveLanes`. Clearing the
    // lanes before anything that can throw means one bad teardown loses at
    // most its own cleanup, not every match after it.
    clearActiveLanes();
    // Every object lets go of what it holds outside the canvas. Each in its
    // own try: one pack object that throws must not keep the rest (or the
    // fog, minimap and HUD below) from being torn down.
    this.zoneEndCard?.destroy();
    this.zoneEndCard = null;
    const manager = this.objectManager;
    for (const list of manager ? [manager.objects, manager._objectToBeAdd] : []) {
      for (const object of list) {
        try {
          object.onMatchTeardown();
        } catch (error) {
          console.error('[Game.destroy] onMatchTeardown threw', error);
        }
      }
    }
    // The last word on this match, before the announcer it listens to goes.
    this.recorder?.save();
    this.recorder?.detach();
    this.announcer?.detach();
    this.fogOfWar.destroy();
    this.minimap.destroy();
    this.inGameHUD.destroy();
  }

  /**
   * Spawn and respawn point (AttackableUnit.respawn() calls this too). A lane
   * team returns at its own fountain; UUID/FFA callers retain the old random
   * fountain fallback instead of being forced onto either side.
   */
  randomSpawnPoint(teamId?: string) {
    const teamFountain = teamId
      ? this.fountains.find(fountain => fountain.teamId === teamId)
      : undefined;
    if (teamFountain) return teamFountain.randomPointInside();

    if (this.fountains.length > 0) {
      const fountain = this.fountains[Math.floor(random(this.fountains.length))];
      return fountain.randomPointInside();
    }

    return createVector(
      this.mapSize / 2 + random(-1000, 1000),
      this.mapSize / 2 + random(-1000, 1000)
    );
  }

  resize(w: number, h: number) {
    // First: both of the others derive from the camera's view of the world.
    this.camera.fitTo(w, h);
    // A rotation or a split-screen change is exactly when the device furniture
    // moves, and it is also what got us here. See `render/safeArea.ts`.
    invalidateSafeArea();
    this.fogOfWar.resize(w, h);
    this.minimap.resize(w, h);
    this.touchControls.resize(w, h);
  }

  // ------------------------------------------------------------ touch input

  /**
   * The fingers currently on the glass, straight from p5's `touches`.
   *
   * Called from all three of GameScene's touch handlers with the same list;
   * TouchControls works out for itself which of them are new, moved or gone.
   */
  syncTouches(points: readonly TouchPoint[]): void {
    // The spell picker pauses the game and covers the screen. Touches belong to
    // it while it is open, and a gesture that was running when it opened has to
    // end without casting rather than sit there half-aimed behind a modal.
    if (this.paused) {
      this.touchControls.releaseEverything();
      this.seenTouches.clear();
      this.minimapTouches.clear();
      return;
    }

    // The minimap gets first refusal, and only on a finger's *first* frame.
    // Deciding per frame instead would let a spell gesture dragged over the
    // minimap be stolen mid-aim; deciding once and remembering the claim for
    // the finger's whole life is what keeps the two systems from ever seeing
    // the same finger. A claimed finger is filtered out of the list the
    // controls are reconciled against, so as far as they are concerned it
    // never happened.
    const live = new Set<number>();
    const forwarded: TouchPoint[] = [];
    for (const point of points) {
      live.add(point.id);
      if (!this.seenTouches.has(point.id)) {
        this.seenTouches.add(point.id);
        if (this.pressMinimap(point)) this.minimapTouches.add(point.id);
      }
      if (!this.minimapTouches.has(point.id)) forwarded.push(point);
    }
    for (const id of this.seenTouches) {
      if (!live.has(id)) {
        this.seenTouches.delete(id);
        this.minimapTouches.delete(id);
      }
    }

    this.touchControls.syncPointers(forwarded);
  }

  /**
   * Route one press through the minimap. Returns true when the minimap took it
   * — i.e. when nothing else may see it.
   *
   * A dismissing tap (`'collapse'`) is handled here but *not* claimed: it
   * closes the expanded map and still reaches whatever it landed on.
   */
  private pressMinimap(point: { x: number; y: number }): boolean {
    switch (this.minimap.route(point)) {
      case 'expand':
        this.minimap.expanded = true;
        return true;
      case 'teleport': {
        // Read the destination before collapsing — the transform is
        // parameterised by the rect, and collapsing changes it.
        const target = this.minimap.worldAt(point);
        // A net client asks the host to make the jump — teleporting only its
        // local body gets snapped straight back by reconciliation, which is
        // how "bấm minimap dịch chuyển" read as broken in a LAN match.
        if (this.net?.interceptTeleport(target)) {
          this.minimap.expanded = false;
          return true;
        }
        // `teleportTo` is the whole job: markDisplaced(), pathAgent.clear(),
        // and both position and destination. It does not check terrain and
        // does not need to — `TerrainMap.update()` pushes a body out of a wall
        // on the next tick.
        this.player.teleportTo(target.x, target.y);
        this.minimap.expanded = false;
        return true;
      }
      case 'collapse':
        this.minimap.expanded = false;
        return false;
      default:
        return false;
    }
  }

  /**
   * The mouse's half of the same routing. Left button only: the right button is
   * the move order, and `fixedUpdate` already refuses to issue one from inside
   * the minimap's rect.
   */
  mousePressed(): void {
    if (this.paused) return;
    if (mouseButton === RIGHT) return;
    this.pressMinimap({ x: mouseX, y: mouseY });
  }

  /** The on-screen toggle, and the handle Playwright drives. */
  setTouchControlsEnabled(enabled: boolean, remember = true): void {
    this.touchControls.setEnabled(enabled);
    this.touchUi = enabled;
    this.inGameHUD?.setTouchUi(enabled);
    if (remember) rememberTouchControlsPreference(enabled);
    this.applyTouchUiClass();
  }

  setRenderQuality(quality: RenderQuality): void {
    this.renderQuality = quality === 'low' || quality === 'high' ? quality : 'auto';
    setRenderQualityPreference(this.renderQuality);
  }

  setRenderFps(fps: RenderFps): void {
    this.renderFps = fps === 30 ? 30 : 60;
    frameRate(this.renderFps);
    setRenderFpsPreference(this.renderFps);
  }

  /** The camera-shake toggle — applied to the live camera and persisted. */
  get screenShake(): boolean {
    return this.camera.shakeEnabled;
  }

  setScreenShake(enabled: boolean): void {
    this.camera.setShakeEnabled(enabled);
    setScreenShakePreference(enabled);
  }

  /**
   * One class on <body> switches the whole HUD between the two layouts.
   *
   * A mode flag rather than a viewport breakpoint, because the thing that has
   * to change is not how much room there is — it is whether the player has a
   * hover, a keyboard and a pixel-accurate pointer. A narrow desktop window has
   * all three and wants the desktop HUD; a wide tablet has none of them and
   * wants the touch one. It also keeps the two verifiable from one machine:
   * the same toggle that gives Playwright the controls gives it the HUD.
   */
  private applyTouchUiClass(): void {
    document.body?.classList.toggle('touch-ui', this.touchControls.enabled);
  }

  /**
   * Drive the champion from a held stick direction, or stop it when the thumb
   * lifts.
   *
   * `moveTo` rather than `orderMove`/`navigateTo` on purpose. A stick is a
   * steering input, not a destination: routing it would queue an A* search
   * sixty times a second toward a point that moves with the champion, and the
   * route would be fighting the thumb the whole way. `moveTo` *clears*
   * `pathAgent` on every call, so the first frame of stick input drops whatever
   * route was running and no route can start while it is held — which is
   * exactly the takeover this needs, for free.
   *
   * Walking into a wall is then the player's own doing and gets the player's
   * own consequence: `TerrainMap.pushOutOfWalls` already runs over every
   * champion each frame, so the champion slides along the wall instead of
   * pathing around it.
   */
  private steerPlayer(direction: JoystickVector | null): void {
    if (!direction) {
      // The host hears the thumb lift too, or its copy walks on to the last
      // lookahead point and reconciliation drags this one after it.
      this.net?.interceptSteer(null);
      this.player.stopMovement();
      return;
    }
    // A stick is an order in its own right, and drops a standing attack order
    // the way a move order does — otherwise the attack controller would be
    // re-planting its chase destination against the thumb every frame.
    this.player.basicAttack?.clear();
    this.lastFacing = { x: direction.x, y: direction.y };

    const lookAhead = Math.max(
      JOYSTICK_LOOKAHEAD_MIN,
      Math.max(1, this.player.moveSpeed) * JOYSTICK_LOOKAHEAD_FRAMES
    );
    const target = {
      x: this.player.position.x + direction.x * lookAhead,
      y: this.player.position.y + direction.y * lookAhead,
    };
    // A net client forwards the push and still steers locally — the same
    // predict-then-reconcile shape right-clicks already get. Without this a
    // phone's stick moved nothing but its own screen.
    this.net?.interceptSteer(target);
    this.player.moveTo(target.x, target.y);
  }

  /** Unit vector the champion is pointed along; never (0,0). */
  private facing(): Vec2 {
    const dx = this.player.destination.x - this.player.position.x;
    const dy = this.player.destination.y - this.player.position.y;
    const length = Math.hypot(dx, dy);
    if (length > 0.01) return { x: dx / length, y: dy / length };
    return this.lastFacing;
  }

  private touchSpellView(slot: number): TouchSpellView | null {
    const spell = this.player.spells[slot];
    if (!spell?.image) return null;

    const hotKey = SpellHotKeys[slot];
    return this.touchViewOf(spell, hotKey ? String.fromCharCode(hotKey) : String(slot));
  }

  /**
   * An item active's button view, or null for a slot holding nothing — or
   * holding an item that grants only stats and a passive, which is most of
   * them. `TouchControls` draws exactly the slots this answers for, which is
   * what keeps the six fixed positions from rendering as six dead circles.
   */
  private touchItemView(slot: number): TouchSpellView | null {
    const item = this.player.items?.[slot];
    const active = item?.active;
    const hotKey = ItemHotKeys[slot];
    const label = hotKey ? String.fromCharCode(hotKey) : String(slot + 1);
    if (active?.image) return this.touchViewOf(active, label);

    // A passive-only item is not a button — except while its passive is
    // re-arming (`Buff.rearmMsLeft`): a Guardian Angel's wearer has to know
    // whether the revival is up, and on touch this grid is the only place an
    // item can say so. The disc appears when the passive is spent, counts
    // down the same wedge-and-seconds a cooldown draws, and vanishes when the
    // passive is armed again — never a castable button, so a tap on it does
    // nothing, which is also the truth.
    const passive = item?.passive;
    if (!passive?.image) return null;
    let msLeft = 0;
    let total = 0;
    for (const buff of this.player.buffs ?? []) {
      if (buff.toRemove || buff.rearmMsLeft <= 0 || buff.sourceSpell !== passive) continue;
      if (buff.rearmMsLeft > msLeft) {
        msLeft = buff.rearmMsLeft;
        total = buff.rearmTotalMs || buff.rearmMsLeft;
      }
    }
    if (msLeft <= 0) return null;

    const view = this.touchViewOf(passive, label);
    return {
      ...view,
      castable: false,
      onCooldown: true,
      cooldownRatio: Math.min(1, msLeft / total),
      remainingSeconds: Math.ceil(msLeft / 1000),
    };
  }

  /**
   * The recall button's view.
   *
   * Through `touchViewOf` rather than a shape of its own, so the one button
   * that is not a kit slot still reports cooldown, castability and its channel
   * the way every other button does — `Recall` is a `Spell`, it is only not in
   * `spells[]`. Null for a unit that has no recall at all, which is how the
   * touch layer decides whether to draw the button.
   */
  /**
   * The player's living and dead teammates, for the death camera. One walk of
   * the world, once per tick while dead and never while alive — `DeathCamera`
   * only asks after the linger. A net client's allies are the host's
   * replicated champions, which are `Champion` instances too.
   */
  private spectateCandidates(): SpectateCandidate<Champion>[] {
    const out: SpectateCandidate<Champion>[] = [];
    for (const object of this.objectManager.objects) {
      if (!(object instanceof Champion) || object === this.player || object.toRemove) continue;
      if (object.teamId !== this.player.teamId) continue;
      out.push({
        unit: object,
        x: object.position.x,
        y: object.position.y,
        alive: !object.isDead,
        lastCombatMs: object.lastCombatMs,
      });
    }
    return out;
  }

  /**
   * The death camera's one hand on the camera. Respects the free camera: a
   * `null` target is Space's "leave it where it is", and a player who asked
   * for that is not overruled by dying. `null` back means the player is alive
   * again — or nobody is left to watch — and the camera returns to them.
   */
  private followForDeathCamera(target: Champion | null): void {
    if (this.camera.target === null) return;
    this.camera.target = target ? target.position : this.player.position;
  }

  private touchRecallView(): TouchSpellView | null {
    const spell = this.player?.recall;
    // No button in a match without recall — the same absence `buildRecall`
    // gives the desktop HUD.
    if (!spell || !this.matchRules.recall) return null;
    return this.touchViewOf(spell, String.fromCharCode(HotKeys.B));
  }

  private touchViewOf(spell: Spell, label: string): TouchSpellView {
    const spec = spell.castSpec;
    // `Recall` carries no icon asset, and `renderable` is not asked for one.
    const icon = spell.image ? AssetManager.renderable(spell.image) : null;
    return {
      targeting: spec.targeting,
      activation: spec.activation,
      range: touchAimRange(spell),
      label,
      // `renderable` hands back a data-URI string while the real icon is still
      // loading; the button draws its letter rather than a string as an image.
      icon: typeof icon === 'object' && icon !== null ? icon : null,
      cooldownRatio:
        spell.effectiveCoolDownMs > 0
          ? Math.min(1, Math.max(0, spell.currentCooldown / spell.effectiveCoolDownMs))
          : 0,
      onCooldown: spell.currentCooldown > 0 && spell.cooldownLocksOut !== false,
      // Whole seconds left, the same rounding the corner HUD uses for its own
      // cooldown stamp — so the two never disagree if they are ever visible
      // at once (the toggle mid-transition, a screenshot).
      remainingSeconds: Math.ceil(spell.currentCooldown / 1000),
      // `effectiveManaCost`, not the raw field: under URF this is 0, and a
      // button that greys itself out against a cost the cast path does not
      // charge would be lying about why it cannot be pressed.
      manaCost: spell.effectiveManaCost,
      affordable: this.player.stats.mana.value >= spell.effectiveManaCost,
      // `castableWhileControlled` on purpose: a cleanse is pressable while its
      // owner is stunned, and a button greyed out then would be lying at the
      // one moment the item exists for.
      castable:
        (this.player.canCast || spell.castableWhileControlled) &&
        !this.player.isDead &&
        !spell.disabled,
      charging: spell.state === 'CHARGING',
      channeling: spell.state === 'CHANNELING',
      // `channelProgress` is `Recall`'s own; a spell without one is not
      // channelling anything a button would draw a clock for.
      channelProgress: (spell as Spell & { channelProgress?: number }).channelProgress ?? 0,
      sustaining: spell.isSustaining,
      toggle: spell.isToggle,
    };
  }

  /**
   * One dot per thing worth knowing about, rebuilt each frame.
   *
   * Visibility is read off `visibleToPlayerTeam`, never recomputed: `FogOfWar.
   * calculateSight()` already sets it every frame and `ObjectManager.draw`
   * already consumes it, so the minimap is a second reader of one answer. Like
   * both of those it is a *rendering* question — "what does the player see" —
   * which is why it may read this flag at all; see `AttackableUnit`.
   * Structures keep it true for good (turrets are `alwaysVisible`, and
   * a fountain is not an `AttackableUnit` at all, so the fog's per-frame reset
   * never touches either) — which is exactly the "static and always known"
   * the minimap wants, with no special case here.
   *
   * `director.revealMap` is the practice panel's cheat, and it is the only
   * thing here that can override the fog.
   */
  private wantedAtMs = -1;
  private wantedCache: AttackableUnit | null = null;

  /**
   * Truy Nã: the live champion on the longest run (>= 3), or null. Cached per
   * simulation tick because every champion's health bar asks.
   */
  wantedChampion(): AttackableUnit | null {
    if (!this.announcer?.bountyEnabled) return null;
    if (this.wantedAtMs !== this.matchTimeMs) {
      this.wantedAtMs = this.matchTimeMs;
      const all: AttackableUnit[] = [this.player, ...(this.director?.bots() ?? [])];
      this.wantedCache = wantedOf(all, unit => this.announcer.streakOf(unit));
    }
    return this.wantedCache;
  }

  /** Extra gold for killing `victim`; read from `AttackableUnit.die` before its run is reset. */
  bountyExtra(victim: AttackableUnit, killer: AttackableUnit): number {
    return bountyForKill(
      this.announcer?.bountyEnabled === true,
      victim,
      killer,
      this.announcer?.streakOf(victim) ?? 0
    );
  }

  private minimapBlips(): MinimapBlip[] {
    const blips: MinimapBlip[] = [];
    const reveal = this.director.revealMap;
    const wanted = this.wantedChampion();
    for (const object of this.objectManager.objects) {
      // The player is drawn separately, always, in its own colour.
      if (object === this.player) continue;
      const unit = object as AttackableUnit & { isDead?: boolean };
      const isStructure = object instanceof Turret || object instanceof Fountain;
      if (!isStructure && !(object instanceof AttackableUnit)) continue;
      if (unit.isDead) continue;
      if (!isStructure && !reveal && !unit.visibleToPlayerTeam) continue;
      blips.push({
        x: object.position.x,
        y: object.position.y,
        kind: isStructure
          ? 'structure'
          : object instanceof Champion || object instanceof AIChampion
            ? 'champion'
            : 'unit',
        color: object === wanted ? WANTED_BLIP_COLOR : teamBodyColor(String(object.teamId)),
      });
    }
    return blips;
  }

  private minimapHost(): MinimapHost {
    return {
      viewport: () => ({ width: windowWidth, height: windowHeight }),
      mapSize: () => this.mapSize,
      wallPolygons: () => this.terrainMap.wallPolygons(),
      blips: () => this.minimapBlips(),
      // `null` is the practice panel's reveal cheat — no veil at all — and
      // matches the one override `minimapBlips` above already honours.
      visionCircles: () => (this.director.revealMap ? null : this.fogOfWar.visionCircles()),
      playerPosition: () => this.player.position,
      zone: () => this.zone?.state(this.matchTimeMs) ?? null,
      cameraBox: () => this.camera.getBoundingBox(),
      // The moving layer is held longer on a machine that is missing frames.
      // A dot that steps instead of sliding is a cheap thing to trade for a
      // fight that does not stutter, and it is only traded on a machine that
      // is already dropping frames — see `MINIMAP_LIVE_INTERVAL_STRESSED_MS`.
      stressTier: () => stressTier(this.renderQuality, this.renderStressed, this.deeplyStressed),
      liveRepaintIntervalMs: () => {
        switch (stressTier(this.renderQuality, this.renderStressed, this.deeplyStressed)) {
          case 2:
            return MINIMAP_LIVE_INTERVAL_DROWNING_MS;
          case 1:
            return MINIMAP_LIVE_INTERVAL_STRESSED_MS;
          default:
            return MINIMAP_LIVE_INTERVAL_MS;
        }
      },
    };
  }

  private controllerFor(row: TouchRow | undefined): SpellInputController {
    return row === 'item' ? this.itemInputController : this.spellInputController;
  }

  private touchControlsHost(): TouchControlsHost {
    return {
      viewport: () => ({ width: windowWidth, height: windowHeight }),
      slotCount: () => this.player.spells.length,
      spellView: (slot, row) =>
        row === 'item' ? this.touchItemView(slot) : this.touchSpellView(slot),
      recallView: () => this.touchRecallView(),
      // Straight to the seam the `B` key already uses. On a phone there is no
      // keyboard at all, so this button is the *only* way home.
      recall: () => this.recall(),
      playerPosition: () => this.player.position,
      playerFacing: () => this.facing(),
      // The same acquisition the `A` key already uses, only measured from the
      // champion instead of the cursor — there is no cursor. It is hostile,
      // alive, targetable and *visible*: a tap cannot auto-target through fog,
      // the same refusal a right click into the fog gets.
      autoTargetWithin: (range, priority) =>
        findAttackTargetNearPoint(
          this.player,
          this.player.position,
          range,
          priority
        ) as AimCandidate | null,
      pickUnitNear: (point, radius, preferred) =>
        findAttackTargetAlongRay(
          this.player,
          point,
          radius,
          preferred as AttackableUnit | null
        ) as AimCandidate | null,
      steer: direction => this.steerPlayer(direction),
      setSlotAim: (slot, world, row) => {
        const aims = row === 'item' ? this.itemTouchAim : this.touchAim;
        if (world) aims.set(slot, world);
        else aims.delete(slot);
      },
      // One controller per row, chosen here and nowhere else — the touch layer
      // carries the row and never has to know there are two of these.
      beginSlot: (slot, row) => {
        this.controllerFor(row).pointerDown(slot);
      },
      commitSlot: (slot, row) => {
        this.controllerFor(row).pointerUp(slot);
      },
      cancelSlot: (slot, row) => {
        this.controllerFor(row).pointerCancel(slot);
      },
      withWorldTransform: draw => {
        this.camera.push();
        draw();
        this.camera.pop();
      },
    };
  }

  /**
   * Where the player is aiming this spell **right now**, mid-gesture.
   *
   * The opening press already gets this right: `createContext` above reads
   * `touchAim.get(slot) ?? worldMouse`, so a tap or a flick casts where the
   * thumb pointed. What had no answer was everything *after* the press — the
   * frames while a `HOLD_RELEASE` charge grows, and the release itself — which
   * `Spell.aimPoint` served from `worldMouse` alone.
   *
   * On a mouse that is correct and this method changes nothing: no slot has a
   * touch aim, so it answers `undefined` and the cursor stands. On a phone
   * `worldMouse` is where the finger is *pressing*, which for a spell being
   * charged is its own button — so every charged ability fired at the corner
   * of the screen. Reported as the ability pointing at the touch rather than
   * at the direction chosen on the controls.
   *
   * Answers only for the player's own spells: a bot's aim is its cast context,
   * and handing it the human's controls is the bug this shares a branch with.
   */
  liveAimFor(spell: Spell): Vec2 | undefined {
    if (!this.player || spell.owner !== this.player) return undefined;

    // Both rows index from 0, so the row has to be established by *identity*
    // rather than by slot number — the same trap `setSlotAim` carries a `row`
    // to avoid, where the kit's map would answer for item slot 2.
    const kitSlot = this.player.spells.indexOf(spell);
    if (kitSlot >= 0) return this.touchAim.get(kitSlot);

    const itemSlot = this.player.items.findIndex(item => item?.active === spell);
    return itemSlot >= 0 ? this.itemTouchAim.get(itemSlot) : undefined;
  }

  createSpellContext(
    spell: Spell,
    caster: { readonly teamId?: unknown; readonly position: Vec2 },
    cursorWorld: Vec2
  ): CastContext | undefined {
    const result = TargetResolver.resolve(spell.castSpec.targeting, {
      spellId: spell.id,
      activationId: uuidv4(),
      startedAtMs: Date.now(),
      caster,
      casterTeamId: caster.teamId,
      origin: caster.position,
      cursorWorld,
      queryCandidates: () => this.objectManager.objects,
      isTargetable: defaultIsTargetable,
      getTargetInfo: defaultTargetInfo,
      ...spell.targetingRequest,
    });
    return result.ok ? result.context : undefined;
  }

  /**
   * Escape, routed from `GameScene`. The HUD owns what it means — innermost
   * layer, then the practice panel — and this is the one line that gets the
   * key to it, since `GameScene` holds a `Game` and not a Vue app.
   */
  escape(): void {
    this.inGameHUD?.vueInstance?.hud.escape();
  }

  /**
   * The player stopped looking at the page — backgrounded the app, locked the
   * phone, switched tab, or let another window take focus. Routed from
   * `GameScene`, which owns the listeners.
   *
   * The match used to carry on without them: minions pushed, bots fought, and
   * the champion standing still died to whatever walked past. Coming back to a
   * match that moved on is the bug this closes.
   *
   * **It opens the panel rather than calling `pause()`.** The panel already
   * holds the match paused — `openSpellPicker` *is* `pause()` plus the screen
   * that says so and the button that undoes it — so a `pause()` here would be
   * a second, invisible paused state with no way out on screen. One entry
   * point, and it is the one the corner button and Escape already use.
   *
   * Refuses to do anything to a match that is already paused, for two reasons
   * that happen to want the same guard: re-opening would wipe
   * `editPlayerSlot`, closing a loadout the player had left open, and a match
   * paused for any other reason is not ours to touch.
   *
   * `pause()` is the fallback only for a match with no HUD mounted — a
   * headless bench — where stopping is still right and there is nothing to
   * show.
   */
  pauseForAway(): void {
    // Not in a LAN match: the match runs on without this player, so there is
    // no held state to make visible — only a panel popping open uninvited on
    // every blur. `GameScene._leavePage` already skips the runtime half.
    if (this.net) return;
    if (this.paused) return;
    const hud = this.inGameHUD?.vueInstance?.hud;
    if (hud) hud.openSpellPicker();
    else this.pause();
  }

  /**
   * B: channel home, or stop the channel that is already running.
   *
   * A method rather than four lines inside `keyPressed`, so a touch button has
   * a seam to call — the key is one way in, not the definition of the action.
   */
  recall(): void {
    const spell = this.player?.recall;
    if (!spell) return;
    // The brawl's rule. Checked here as well as in the spell so a net client
    // — whose press goes to the host below, not to its own spell — does not
    // send an order the host will only refuse.
    if (!this.matchRules.recall) return;

    // A net client asks the host to go home; the channel it watches is the
    // host's, via snapshots.
    if (this.net?.interceptRecall()) return;

    // Pressing it again is how the player calls the trip off; without this the
    // press would be refused as "already casting" and the only way to stop
    // going home would be to walk.
    if (spell.state === 'CHANNELING') {
      spell.cancel('PLAYER_CANCEL');
      return;
    }

    // SELF targeting, so the aim is the champion's own feet.
    const context = this.createSpellContext(spell, this.player, this.player.position);
    if (context) spell.press(context);
  }

  keyPressed(keyCode: number, repeated = false) {
    if (keyCode === 32 && !repeated) {
      this.camera.target = this.camera.target ? null! : this.player.position;
    }
    // N: toggle the nav debug overlay (src/game/nav/NavDebugOverlay.ts) --
    // the clearance field, active routes and every agent's state. Not one of
    // SpellHotKeys' letters, so it never steals a cast.
    if (keyCode === 78 && !repeated) {
      // Through the director, not `navigation.debugRoutes` directly: the debug
      // layers persist now, and the director is the only thing that writes the
      // config. Writing the field would leave the key and the panel's checkbox
      // agreeing about the match (they are one boolean — see
      // `createDebugFlags`) while disagreeing about what gets saved.
      this.director?.setDebugFlag('routes', !this.navigation.debugRoutes);
    }
    // B: go home. Not one of SpellHotKeys' letters, so it never steals a cast.
    if (keyCode === HotKeys.B && !repeated) this.recall();
    // P: the shop. Same reasoning as B and N — not a kit letter, not an item
    // digit, so it can never steal a cast. It toggles rather than only
    // opening, because unlike the config panel the shop does not pause and a
    // player mid-fight needs one key back out.
    if (keyCode === HotKeys.P && !repeated) this.inGameHUD?.vueInstance?.hud.toggleShop();
    // Held, not toggled: the board is up for exactly as long as the key is.
    if (keyCode === HotKeys.TAB) {
      if (!repeated) this.inGameHUD?.vueInstance?.hud.setScoreboard(true);
      return;
    }
    this.spellInputController.keyDown(keyCode, repeated);
    this.itemInputController.keyDown(keyCode, repeated);
  }

  keyReleased(keyCode: number) {
    if (keyCode === HotKeys.TAB) this.inGameHUD?.vueInstance?.hud.setScoreboard(false);
    this.spellInputController.keyUp(keyCode);
    this.itemInputController.keyUp(keyCode);
  }
}
