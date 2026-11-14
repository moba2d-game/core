import { System } from '@/libs/detect-collisions';
import SpellObject from '@/game/gameObject/SpellObject';
import AttackableUnit from '@/game/gameObject/attackableUnits/AttackableUnit';
import CombatText from '@/game/gameObject/helpers/CombatText';
import { Circle, Quadtree, Rectangle } from '@/libs/quadtree';
import TrailSystem from '@/game/gameObject/helpers/TrailSystem';
import ParticleSystem from '@/game/gameObject/helpers/ParticleSystem';
import GameObject from '@/game/gameObject/GameObject';
import UnitCollisionSystem from './UnitCollisionSystem';
import { canSee, type Seeable as VisionObserver } from '@/game/combat/Vision';
import { blend, isContinuousStep } from '@/game/render/Interpolation';
import { stressTier } from '@/game/render/renderStress';
import {
  beginAttribution,
  endAttribution,
  type DamageAttributable,
} from '@/game/combat/DamageAttribution';

export type QueryArea = Circle | Rectangle;
export type RenderQuality = 'auto' | 'low' | 'high';
export type GameObjectConstructor<T extends GameObject = GameObject> = abstract new (
  ...args: never[]
) => T;
export type GameObjectFilter = (object: GameObject) => boolean;
export type GameObjectTypeGuard<T extends GameObject> = (object: GameObject) => object is T;
export interface ObjectManagerGameContext {
  readonly mapSize: number;
  readonly touchUi?: boolean;
  readonly renderQuality?: RenderQuality;
  /**
   * Whether the machine is missing its own frame target right now
   * (`render/renderStress.ts`). Read only under `auto`: choosing Cao or Thấp is
   * the player overriding the measurement, and a measurement must not override
   * them back.
   */
  readonly renderStressed?: boolean;
  /**
   * And whether it is missing it *badly* — the second rung of the same state
   * machine. Read under `auto` like the first, and additionally implied by an
   * explicit Thấp: a player who asks for low quality is asking for all of it.
   */
  readonly deeplyStressed?: boolean;
  camera: {
    getBoundingBox(): Rectangle;
    constantSize?(pixels: number): number;
    currentScale?: number;
  };
}

interface GameObjectRegion {
  data: GameObject;
}

type TargetableGameObject = GameObject & { targetable?: unknown };

const hasTargetableProperty = (object: GameObject): object is TargetableGameObject =>
  'targetable' in object;

/**
 * Draw layers, back to front — lower paints first (further back), higher
 * paints later (nearer the camera, on top of everything under it). One
 * ordered list rather than a scatter of magic numbers: about a dozen
 * ground-art spell files each used to hardcode `zIndex = 2` with their own
 * explanatory comment, and every one of them now names `GROUND_Z_INDEX`
 * instead. `Champion.displayZIndex`, `Minion.displayZIndex` and the instance
 * `zIndex` on `Monster`/`Turret`/`Fountain` reference these too, so a value
 * lives in exactly one place regardless of which of the two escape hatches
 * (see `classLayerOf`) a class needs.
 *
 * The rule the ordering follows: **more important paints later.** A floating
 * number reporting what just happened outranks the spell effect that caused
 * it, which outranks the champion it happened to, which outranks the minion
 * wave, which outranks the ground it is all standing on. The default used to
 * be the opposite of this — an unlisted class fell through to
 * `DEFAULT_Z_INDEX` (99), which outranked everything actually chosen on
 * purpose, so the single most important object in a fight (a champion) was
 * on top only by the accident of nobody having given it a more specific slot
 * yet. `Champion` and `Minion` already had their own escape hatch and were
 * fine; `AIChampion`, `Pet`, `DummyChampion` and every ordinary spell-effect
 * class (a missile, a hit-spark, a buff aura — anything that is not ground
 * art) did not, which is exactly the two bugs this ordering fixes: a bot's
 * champion (`AIChampion`) painting above or below another champion by
 * whichever order the quadtree happened to return them in rather than by
 * anything either object's zIndex said, and `CombatText` (5, deliberately
 * above the old `AttackableUnit` slot of 3) sitting *under* every champion
 * that fell through to 99.
 */
export const FOUNTAIN_Z_INDEX = -1;
export const TRAIL_Z_INDEX = 0;
export const PARTICLE_Z_INDEX = 1;
/** Ground art: a decal, a pool, a trail on the floor. Paints under the feet standing on it. */
export const GROUND_Z_INDEX = 2;
/** `AttackableUnit`'s own registered floor — nothing concrete resolves here directly today (every real subclass has a more specific slot below), but it is what `classLayerOf` lands a *hypothetical* undecorated unit on. */
export const UNIT_Z_INDEX = 3;
export const MINION_Z_INDEX = 3.2;
/** Monster camps and turrets: above plain units and minions, below champions. */
export const OBJECTIVE_Z_INDEX = 3.5;
export const CHAMPION_Z_INDEX = 4;
/**
 * The ordinary case for a spell effect: a missile in flight, a hit-spark, a
 * beam, a buff aura — anything that is not ground art, which explicitly
 * overrides down to `GROUND_Z_INDEX` instead. This is the corrected,
 * intentional version of what `DEFAULT_Z_INDEX` used to provide by accident:
 * `ground-decal-zindex.test.ts`'s own comment used to call the *old*
 * accidental 99 "the right default for a missile or a blast", which is the
 * same judgement this constant now states on purpose.
 */
export const SPELL_EFFECT_Z_INDEX = 6;
/**
 * `CombatText` is an overlay, not a thing in the scene — it already draws at
 * constant screen size regardless of zoom (`Camera.constantSize`). Above
 * every unit and above ordinary spell effects, so a number is never the
 * thing a flashy cast or a dying champion happens to cover.
 */
export const COMBAT_TEXT_Z_INDEX = 8;

const Z_INDEX_MAP = new Map<Function, number>([
  [TrailSystem, TRAIL_Z_INDEX],
  [ParticleSystem, PARTICLE_Z_INDEX],
  [SpellObject, SPELL_EFFECT_Z_INDEX],
  [AttackableUnit, UNIT_Z_INDEX],
  [CombatText, COMBAT_TEXT_Z_INDEX],
]);
/**
 * What an unregistered, un-overridden class falls back to. Deliberately no
 * longer 99: the whole point of this file is that "unlisted" must not mean
 * "wins every layer someone deliberately chose." In practice nothing real
 * should ever reach this — `AttackableUnit`, `SpellObject`, `TrailSystem`,
 * `ParticleSystem` and `Fountain` are the only direct `GameObject` subclasses
 * in the game, and `classLayerOf` below finds one of the first four for every
 * concrete class by walking up to it; `Fountain` always sets its own
 * instance `zIndex` and so never reaches class resolution at all.
 */
const DEFAULT_Z_INDEX = UNIT_Z_INDEX;
export const MOBILE_PARTICLE_DRAW_BUDGET = 800;
export const MOBILE_CROWDED_PARTICLE_DRAW_BUDGET = 400;
/**
 * And what is left for a machine that is drowning rather than merely late —
 * see `STRESS_DEEP_ENTER_SHARE`. Half the crowded ration again: at fifteen
 * frames a second the choice is not between a pretty fight and a plain one, it
 * is between a plain fight and a slideshow.
 */
export const MOBILE_DROWNING_PARTICLE_DRAW_BUDGET = 200;
export const MOBILE_CROWDED_DRAWABLE_COUNT = 40;
export const MOBILE_COMPACT_UNIT_COUNT = 8;
export const MOBILE_COMPACT_UNIT_SCALE = 0.45;
const ATTACKABLE_DRAW_MARGIN_PX = 100;

/**
 * Resolves a class's layer by walking from `constructor` up the *class*
 * hierarchy (`Object.getPrototypeOf` on the constructor function itself —
 * the `extends` chain, not an instance's `instanceof` chain) until it finds
 * either a static `displayZIndex` own property or a `Z_INDEX_MAP` entry.
 * Both escape hatches are checked at every step, so `Champion.displayZIndex`
 * is what `AIChampion`, `Pet` and `DummyChampion` resolve to as well even
 * though none of them declare their own — before this walk they fell
 * straight through to `DEFAULT_Z_INDEX` the instant they were not an *exact*
 * match for anything, which was the root of both z-index bugs. Likewise a
 * `MissileSpellObject` subclass with no zIndex of its own climbs to
 * `SpellObject`'s `SPELL_EFFECT_Z_INDEX` instead of the old 99 — a different
 * number that happens to still mean "above the units", which is why no
 * spell-effect visual moved.
 *
 * `Object.hasOwn` (not a plain property read) matters: a subclass never
 * *has* an inherited static as its own property, only sees it through the
 * constructor's own prototype chain when read directly — checking `hasOwn`
 * at each step is what makes this walk equivalent to that natural JS
 * inheritance instead of silently finding the same value one hop early via
 * `current.displayZIndex` and never actually consulting `Z_INDEX_MAP` for
 * classes in between.
 */
function classLayerOf(constructor: Function): number {
  let current: Function | null = constructor;
  while (current && current !== Function.prototype && current !== Object.prototype) {
    const own = (current as { displayZIndex?: unknown }).displayZIndex;
    if (Object.hasOwn(current, 'displayZIndex') && typeof own === 'number') {
      return own;
    }
    const mapped = Z_INDEX_MAP.get(current);
    if (mapped !== undefined) return mapped;
    current = Object.getPrototypeOf(current) as Function | null;
  }
  return DEFAULT_Z_INDEX;
}

function zIndexOf(o: GameObject): number {
  return o.zIndex ?? classLayerOf(o.constructor as Function);
}

/**
 * Objects that exist only to be looked at, and so are indexed separately from
 * everything a gameplay query can ask about — see `ObjectManager._decorTree`.
 *
 * Deliberately a closed list rather than a `decorative = true` flag on
 * `GameObject`: a flag invites a spell object to set it because "it's only
 * VFX", and a spell object is exactly the thing that must stay queryable. Add
 * to this list only for something that deals no damage, holds no target and
 * blocks nothing.
 *
 * `CombatText` used to be kept out on the theory that a query narrowing by
 * `SpellObject` (the class it extends) would quietly stop seeing it. Audited
 * against every call site instead of trusting that: nothing in the codebase
 * filters on bare `instanceof SpellObject`. The one filter that comes close,
 * `PredefinedFilters.missileSpellObject`, also requires `isMissile`, which
 * `CombatText` never sets. It deals no damage, holds no target and blocks
 * nothing — the criterion above, exactly — and a teamfight is precisely the
 * moment `_objectsTree` is both biggest and most queried: measured at up to
 * ~46% of the tree's live entries during a burst of damage/heal events
 * (`tests/e2e/measure-combattext-perf.mjs`), every one of them dead weight to
 * every vision check, target scan and AOE query that had to walk past it.
 */
function isDecoration(o: GameObject): boolean {
  return o instanceof ParticleSystem || o instanceof TrailSystem || o instanceof CombatText;
}

export interface QueryOptions {
  area?: QueryArea;
  filters?: readonly GameObjectFilter[];
  queryByDisplayBoundingBox?: boolean;
}

type GuardedGameObject<TFilter> =
  TFilter extends GameObjectTypeGuard<infer TObject> ? TObject : never;
type IntersectGuardedGameObjects<TFilter> = (
  GuardedGameObject<TFilter> extends infer TObject
    ? TObject extends GameObject
      ? (object: TObject) => void
      : never
    : never
) extends (object: infer TIntersection) => void
  ? TIntersection
  : never;
type QueryResult<TFilters extends readonly GameObjectFilter[]> = [
  GuardedGameObject<TFilters[number]>,
] extends [never]
  ? GameObject
  : IntersectGuardedGameObjects<TFilters[number]>;

export const PredefinedFilters = {
  id:
    (id: string): GameObjectFilter =>
    object =>
      object.id === id,
  type:
    <T extends GameObject>(type: GameObjectConstructor<T>): GameObjectTypeGuard<T> =>
    (object): object is T =>
      object instanceof type,
  excludeType:
    (type: GameObjectConstructor): GameObjectFilter =>
    object =>
      !(object instanceof type),
  teamId:
    (teamId: string): GameObjectFilter =>
    object =>
      object.teamId === teamId,
  excludeTeamId:
    (teamId: string): GameObjectFilter =>
    object =>
      object.teamId !== teamId,
  // The four list filters below are plain loops rather than `list.some(...)`:
  // a filter runs once per candidate per query, and `some` built a closure for
  // each of those runs before calling through the `Array.prototype` patch in
  // `main.ts`. Same answers, including for an empty list.
  includeTeamIds:
    (teamIds: string[]): GameObjectFilter =>
    object => {
      for (let i = 0; i < teamIds.length; i++) if (object.teamId === teamIds[i]) return true;
      return false;
    },
  excludeTeamIds:
    (teamIds: string[]): GameObjectFilter =>
    object => {
      for (let i = 0; i < teamIds.length; i++) if (object.teamId === teamIds[i]) return false;
      return true;
    },
  includeTypes:
    (types: GameObjectConstructor[]): GameObjectFilter =>
    object => {
      for (let i = 0; i < types.length; i++) if (object instanceof types[i]) return true;
      return false;
    },
  excludeTypes:
    (types: GameObjectConstructor[]): GameObjectFilter =>
    object => {
      for (let i = 0; i < types.length; i++) if (object instanceof types[i]) return false;
      return true;
    },
  excludeObjects:
    (
      objects: (GameObject | undefined | null)[] | Set<GameObject | undefined | null>
    ): GameObjectFilter =>
    object =>
      objects instanceof Set
        ? !objects.has(object)
        : !objects.some(excluded => excluded === object),
  includeDead: (object: GameObject): object is AttackableUnit =>
    object instanceof AttackableUnit && object.isDead,
  excludeDead: (object: GameObject): boolean =>
    object instanceof AttackableUnit ? !object.isDead : Boolean(object),
  includeUntargetable: (object: GameObject): boolean =>
    !hasTargetableProperty(object) || !Boolean(object.targetable),
  excludeUntargetable: (object: GameObject): boolean =>
    hasTargetableProperty(object) && Boolean(object.targetable),
  /**
   * Units within `radius` of a *point*. Not the home of the size-aware reach
   * rule, and not a substitute for it: this filter is handed a bare position,
   * so it can widen for the target's body but has no way to know whose body the
   * measurement started from. Caster-centred ranges go through
   * `combat/Reach.ts`, which needs both ends.
   */
  attackableUnitInRange:
    (
      position: p5.Vector,
      radius: number,
      includeSize = false
    ): GameObjectTypeGuard<AttackableUnit> =>
    (object): object is AttackableUnit =>
      object instanceof AttackableUnit &&
      p5.Vector.dist(object.position, position) <=
        radius + (includeSize ? object.animatedValues.size / 2 : 0),
  collideWith:
    (area?: QueryArea): GameObjectFilter =>
    object => {
      if (!area) return false;
      if (typeof object.getCollideBoundingBox !== 'function') return false;
      return object.getCollideBoundingBox().intersect(area);
    },
  missileSpellObject: (object: GameObject): object is SpellObject =>
    object instanceof SpellObject && object.isMissile,
  canTakeDamage: (object: GameObject): object is AttackableUnit =>
    object instanceof AttackableUnit && object.targetable && !object.isDead,
  canTakeDamageFromTeam:
    (teamId: string): GameObjectTypeGuard<AttackableUnit> =>
    (object): object is AttackableUnit =>
      object instanceof AttackableUnit &&
      object.targetable &&
      !object.isDead &&
      object.teamId !== teamId,
  /**
   * Drops units hidden by an active stealth spell.
   *
   * Applied to every scan that acquires a target on its own — the wave, the
   * camps, the turrets and the bots. Before this, `ActionState.STEALTHED` was
   * read in exactly one place in the engine (`BasicAttackController`, so a
   * player could not *order* an attack on a stealthed unit), which meant
   * stealth dimmed the sprite and changed nothing else: everything on the map
   * kept chasing and hitting a champion nobody could see.
   *
   * Unlike `visibleTo` below this *is* applied to `AIChampion`. Bush cover is
   * terrain and leaving the bots blind to it would be a difficulty change;
   * stealth is an ability with a cast and a cooldown behind it, and a bot that
   * ignores it makes that ability worthless against the only real opponents in
   * the match.
   *
   * No observer side: a reveal is `TrueSight`, which strips the flag from the
   * hidden unit, so a revealed champion is simply no longer stealthed.
   */
  excludeStealthed: (object: GameObject): boolean =>
    !(object instanceof AttackableUnit) || !object.isStealthed,
  /**
   * Drops what `observer`'s team cannot see — the gate every scan that *picks*
   * a target needs, and the one `combat/Vision.ts` defines.
   *
   * It started as the bush rule alone, because bushes were cosmetic (the only
   * thing that ever read `isInsideBush` was the sprite's alpha) and a player
   * standing in one was picked up by every minion and camp scan that came
   * within aggro range. Terrain was the other half and was missing entirely:
   * nothing that acquired a target had ever asked whether it could *see* it, so
   * a wall-piercing leap found a jungle camp through a jungle wall on a screen
   * showing nothing but fog. `canSee` answers walls, bushes, sight range and friendly
   * wards in one place, matching what `FogOfWar` paints.
   *
   * Only `AttackableUnit`s are gated: a query that also returns spell objects
   * or terrain is not asking about vision, and every caller's own filters have
   * already narrowed the units to the ones it may hit.
   *
   * `AIChampion` does not route its target scan through this filter, and asks
   * the same question one step later instead: `BotBrain.canPerceive` calls
   * `canSee` itself, because the blackboard path (`pickTarget` walking
   * `view.enemies`) has no quadtree query to hang a filter on and both paths
   * have to answer alike. It is the same rule at every tier — there was once a
   * `seesThroughTerrain` knob that switched it off for `normal` and `hard`, and
   * it is gone. Every other caller here is unchanged.
   */
  visibleTo:
    (observer: VisionObserver): GameObjectFilter =>
    object =>
      !(object instanceof AttackableUnit) || canSee(observer, object),
};

declare global {
  var objectManager: ObjectManager | undefined;
}

export default class ObjectManager {
  system = new System();
  objects: GameObject[] = [];
  _objectToBeAdd: GameObject[] = [];
  _objectsTree!: Quadtree;
  /**
   * Spatial index for decoration — particle systems and trails.
   *
   * They are `GameObject`s so the update/draw loop carries them for free, but
   * nothing in the game ever asks a spatial question *about* them: they deal no
   * damage, hold no target and block nothing. Kept in the main index they were
   * still inserted every tick and then retrieved, stamped and intersect-tested
   * by every one of the ~150 `queryObjects` call sites, only to be thrown away
   * by each caller's own type filter — and a fight is where there are most of
   * them and least budget to spare.
   *
   * Splitting them out shrinks the gameplay tree as well as skipping the work,
   * so the queries that remain go shallower. `draw` reads both; `queryObjects`
   * reads only the gameplay one, which is the whole point.
   */
  _decorTree!: Quadtree;
  _objectsTreeIsUpdating = false;
  _deadBuffer: number[] = [];
  revision = 0;
  unitCollision = new UnitCollisionSystem();
  game: ObjectManagerGameContext;

  constructor(game: ObjectManagerGameContext) {
    this.game = game;

    const mapSize = this.game.mapSize;
    this._objectsTree = new Quadtree({
      x: 0,
      y: 0,
      w: mapSize,
      h: mapSize,
      // maxObjects: 2 forced deep splits and multi-leaf inserts (an object
      // that spans multiple quadrants near a boundary gets inserted into
      // each one) on every rebuild, every tick. 12 keeps leaves shallow
      // without turning every query into a near-linear scan of one big leaf.
      maxObjects: 12,
      maxLevels: 4,
    });
    this._decorTree = new Quadtree({
      x: 0,
      y: 0,
      w: mapSize,
      h: mapSize,
      maxObjects: 12,
      maxLevels: 4,
    });

    globalThis.objectManager = this;
  }

  /**
   * Runs one of an object's lifecycle callbacks under the cast it belongs to.
   *
   * Whatever this object belongs to owns the damage it deals without naming a
   * source — a missile's `onHit` runs frames after the cast that built it.
   * Save/restore rather than assign: a child object built during the call
   * inherits the attribution, and a reflect re-enters `takeDamage` from inside
   * it. See `combat/DamageAttribution.ts`.
   *
   * **All three callbacks, not just `update`.** For a long time this bracket
   * was written inline around `o.update?.()` and nowhere else, which quietly
   * made the other two lifecycle hooks a different kind of place to stand:
   *
   *   - `onRemoved` is where a **missile that reached its range** does its
   *     work. Three abilities in the installed packs end that way — a Rasengan
   *     thrown down an empty lane still bursts — and each builds its blast
   *     object there. Built outside the bracket, that object's own
   *     `attributedTo` is stamped `null` (`SpellObject`'s field initialiser
   *     reads the ambient), so the blast it later deals is not ability damage
   *     to `abilityPowerScales()` and `Stats.abilityPower` is dropped on the
   *     floor. A throw that *hit* somebody was amplified and the identical
   *     throw that landed on the ground was not.
   *   - `onAdded` is where an effect that acts on arrival acts. Damage dealt
   *     from there lost the same multiplier, in the same silence: a pack
   *     moving a bite from its update clock to its arrival — a legitimate
   *     change, and the fix for a 180ms gap between a burst and its number —
   *     took a champion from 449 damage to 31 with the tooltip still promising
   *     the 449.
   *
   * Neither had anything to do with what the pack wrote. The rule is a
   * property of *where core calls in*, so it belongs on every door core opens,
   * and having exactly one helper is what stops the next door from missing it.
   *
   * Phrasing note: `BaseObjectTypes.test.ts` scans this whole file for
   * TypeScript's three-letter escape hatch and does not strip comments, so
   * prose here cannot spell it either.
   */
  private attributed(object: unknown, run: () => void): void {
    const previous = beginAttribution(
      (object as { attributedTo?: DamageAttributable }).attributedTo
    );
    try {
      run();
    } finally {
      endAttribution(previous);
    }
  }

  update(): void {
    // update
    for (const o of this.objects) {
      // Remember where the object began this tick, before its own update moves
      // it, so `draw` can blend between the two endpoints. Riding the existing
      // walk keeps this a field write, not a second pass over the list.
      o.renderOriginX = o.position.x;
      o.renderOriginY = o.position.y;
      // `attributed`, written out — the one bracket of the three that runs per
      // object per tick, so it is the one that should not allocate a closure.
      const previous = beginAttribution((o as { attributedTo?: DamageAttributable }).attributedTo);
      try {
        o.update?.();
      } finally {
        endAttribution(previous);
      }
    }

    // two-pass remove: collect dead, then filter once (avoids O(n²) splice)
    for (let i = 0, l = this.objects.length; i < l; i++) {
      if (this.objects[i].toRemove) this._deadBuffer.push(i);
    }
    if (this._deadBuffer.length > 0) {
      for (let i = this._deadBuffer.length - 1; i >= 0; i--) {
        const idx = this._deadBuffer[i];
        const dying = this.objects[idx];
        this.attributed(dying, () => dying.onRemoved?.());
        this.objects.splice(idx, 1);
      }
      this._deadBuffer.length = 0;
    }

    // check add
    if (this._objectToBeAdd.length > 0) {
      for (const o of this._objectToBeAdd) {
        this.objects.push(o);
        this.attributed(o, () => o.onAdded?.());
      }
      // Truncate rather than rebind. `onAdded` may itself call `addObject`,
      // and a for..of re-reads `length` each step, so anything queued during
      // the loop is drained by this same pass either way — but keeping the
      // array identity stops one throwaway allocation per tick.
      this._objectToBeAdd.length = 0;
    }

    // Bodies push each other apart once everything has moved, and before the
    // tree is rebuilt so the tree already reflects the settled positions.
    // Deliberately upstream of TerrainMap.update(), which Game runs next: terrain
    // gets the last word, so a unit shoved into a wall by a neighbour is back out
    // of it inside the same frame. The cost is that a wall push-out can leave two
    // bodies overlapping for one frame near a wall, which the next frame clears.
    this.unitCollision.resolve(this.objects);

    // update quadtree
    this._objectsTreeIsUpdating = true;
    this._objectsTree.clear();
    this._decorTree.clear();
    for (const o of this.objects) {
      // Decoration is indexed apart from everything gameplay can ask about —
      // see `_decorTree`.
      const tree = isDecoration(o) ? this._decorTree : this._objectsTree;
      tree.insert(o.getDisplayBoundingBox());
    }
    this._objectsTreeIsUpdating = false;
    this.revision++;
  }

  /**
   * @param alpha How far into the current simulation step the renderer is,
   *   `[0, 1]`. Defaults to `1` — the newest tick, a byte-for-byte no-op — so
   *   every existing caller and test keeps working untouched. Below 1 each
   *   object is drawn blended between its tick origin and its current position;
   *   `GameScene.draw` is the one caller that passes a real value. See
   *   `render/Interpolation.ts`.
   */
  draw(alpha = 1): void {
    const camBound = this.game.camera.getBoundingBox();
    const margin =
      this.game.camera.constantSize?.(ATTACKABLE_DRAW_MARGIN_PX) ?? ATTACKABLE_DRAW_MARGIN_PX;
    const visualBound = new Rectangle({
      x: camBound.x - margin,
      y: camBound.y - margin,
      w: camBound.w + margin * 2,
      h: camBound.h + margin * 2,
    });

    // Single pass over the quadtree hit-list: unwrap the region, filter to
    // what will actually draw, and tag it with a z-index together, instead of
    // the three full-length arrays (map region->object, map in z-index,
    // filter to drawables) this used to rebuild from scratch every frame for
    // the same object set — real GC churn at 60 draws/sec.
    const drawables: { o: GameObject; z: number; dead: boolean }[] = [];
    let particleCount = 0;
    let attackableCount = 0;
    // Both indexes: decoration lives in its own tree so gameplay queries never
    // page it in (see `_decorTree`), but it still has to be painted, so the
    // draw pass is the one caller that reads both. An object is in exactly one
    // of them, so the two walks cannot hand back the same thing twice.
    for (const tree of [this._objectsTree, this._decorTree]) {
      for (const region of tree.retrieve(camBound) as GameObjectRegion[]) {
        const o = region.data;
        let dead = false;
        if (o instanceof AttackableUnit) {
          // The fog's answer for the player's own eyes — rendering only. What a
          // unit may *target* is `combat/Vision.ts`, asked per observer.
          if (!o.visibleToPlayerTeam) continue;
          if (!o.getCollideBoundingBox().intersect(visualBound)) continue;
          attackableCount++;
          dead = o.isDead;
        } else {
          // The same fog, for the things that ride a body. A cloak, a shell,
          // an eye or a burning victim drew straight through a wall before
          // this, because the check above is an `instanceof` and a spell
          // object is not one. One property read, only for drawables that are
          // not units, and `null` for everything that is not glued to anybody
          // — so a projectile, a decal and a burst all cost the same as they
          // did. See `GameObject.visionAnchor`.
          const anchor = o.visionAnchor;
          if (anchor && !anchor.visibleToPlayerTeam) continue;
          if (o instanceof ParticleSystem) particleCount += o.particles.length;
        }
        // zIndexOf does a Map lookup + Object.hasOwn — computed once here
        // rather than repeatedly by the sort comparator below.
        drawables.push({ o, z: zIndexOf(o), dead });
      }
    }
    // A per-object tiebreak, not a layer: a dead champion has no more claim
    // to paint over a living one than the order the quadtree happened to
    // return them in, which is what it was accidentally deciding by before
    // this — a corpse added to the tree after a survivor painted over them
    // whenever both fell on the same layer, which every champion (before
    // `classLayerOf`'s walk) and every pair of same-tier structures still
    // do. Belongs beside `zIndexOf`'s number rather than inside it: "is this
    // particular instance dead right now" is not a property of the class.
    drawables.sort((a, b) => (a.z !== b.z ? a.z - b.z : Number(b.dead) - Number(a.dead)));

    const quality = this.game.renderQuality ?? 'auto';
    // Two ways in, and they say different things. `automaticCompact` is "this
    // is a phone, zoomed out, in a crowd" — a guess from the shape of the
    // situation. `renderStressed` is the machine reporting that it is actually
    // missing frames, whatever kind of machine it is; before it existed, a
    // struggling laptop got the full-quality path forever because the only
    // question `auto` asked was whether it had a touchscreen.
    // What the frame may give up, player's choice and measurement together —
    // see `render/renderStress.ts`. `compactUnits` below is deliberately NOT
    // derived from it.
    const tier = stressTier(quality, this.game.renderStressed, this.game.deeplyStressed);
    const stressed = tier >= 1;
    const deeplyStressed = tier >= 2;
    const automaticCompact = Boolean(
      this.game.touchUi &&
      (this.game.camera.currentScale ?? Infinity) <= MOBILE_COMPACT_UNIT_SCALE &&
      attackableCount >= MOBILE_COMPACT_UNIT_COUNT
    );
    // **Neither stress nor Thấp compacts a unit.** Both used to, and both were
    // the wrong thing to give up: the compact frame drops the score, the tick
    // marks and the status text, which is information a player decides from —
    // stress doing it was reported as "the bar shrank and I could no longer
    // read my health or my buffs", and Thấp doing it was reported again as a
    // champion bar that is one bare strip on a desktop that merely asked for
    // the cheap picture. Compact art answers exactly one question: is this
    // body about twelve screen pixels wide, on a phone, in a crowd — a
    // *layout* answer for a frame the full bar physically does not fit. A late
    // frame is not that question, and neither is a quality setting; since the
    // frame paints through the native context (~65us for a full side of
    // champions) there is no budget argument left either. What Thấp and
    // stress give up instead: particles, trails, thin minion bodies — see
    // `stressTier`, which Thấp turns to the deep rung.
    const compactUnits = (quality === 'low' || quality === 'auto') && automaticCompact;
    const crowded = drawables.length > MOBILE_CROWDED_DRAWABLE_COUNT;
    const particleBudget =
      quality === 'high'
        ? Infinity
        : deeplyStressed && crowded
          ? MOBILE_DROWNING_PARTICLE_DRAW_BUDGET
          : quality === 'low' || ((compactUnits || stressed) && crowded)
            ? MOBILE_CROWDED_PARTICLE_DRAW_BUDGET
            : MOBILE_PARTICLE_DRAW_BUDGET;
    const limitParticles =
      quality === 'low' || stressed || deeplyStressed || (quality === 'auto' && this.game.touchUi);
    const particleScale =
      limitParticles && particleCount > particleBudget ? particleBudget / particleCount : 1;

    // When the frame sits between two ticks, draw each body at the fraction of
    // its step that has elapsed. Substitute the blended position onto the live
    // vector, draw, then put the true numbers back — no `draw()` body has to
    // know it happened, and no draw site is edited. Culling above stayed on the
    // true position on purpose (the difference is sub-pixel and the margin
    // covers it); this only moves where the object is *painted*.
    const interpolate = alpha < 1;
    for (const { o } of drawables) {
      let trueX = 0;
      let trueY = 0;
      let swapped = false;
      // A jump past the snap distance (a blink, a respawn) is not a journey to
      // blend across — `isContinuousStep` refuses it and it is drawn where the
      // simulation actually put it.
      if (
        interpolate &&
        isContinuousStep(o.renderOriginX, o.renderOriginY, o.position.x, o.position.y)
      ) {
        trueX = o.position.x;
        trueY = o.position.y;
        o.position.x = blend(o.renderOriginX, trueX, alpha);
        o.position.y = blend(o.renderOriginY, trueY, alpha);
        swapped = true;
      }

      if (o instanceof ParticleSystem) {
        o.draw(Math.floor(o.particles.length * particleScale));
      } else if (o instanceof TrailSystem) {
        // The second thing stress rations, after particles: a trail collapses
        // to one segment. Its shape is decoration; where it points is not.
        o.draw(compactUnits || stressed);
      } else if (o instanceof AttackableUnit) {
        // `thinCrowd` is deliberately **not** `compactUnits`. Compact art
        // answers "is this body twelve screen pixels wide, on a phone, in a
        // crowd", and it takes away health numbers, buff icons and status text
        // — information a player decides from, and taking it away was reported
        // as a bug the last time stress did it. `thinCrowd` asks a different
        // question: "may the anonymous bodies in this fight be drawn with
        // fewer strokes". A minion has no information to lose. See
        // `renderStress.test.ts`, which pins that stress alone never compacts.
        // No `plainFrames` any more: the champion frame paints through the
        // native context and is cheap at full detail, so stress no longer
        // changes what a health bar looks like mid-fight (that flicker was
        // reported as making health unreadable in combat).
        o.draw({ compactUnits, thinCrowd: deeplyStressed });
      } else {
        o.draw?.();
      }
      // o.drawBoundingBox?.(true);

      // No try/finally: a throw inside a draw already breaks the frame, and the
      // state being restored is about to be discarded — a guard per object at
      // 60fps buys nothing.
      if (swapped) {
        o.position.x = trueX;
        o.position.y = trueY;
      }
    }

    // draw camera bound
    // push();
    // fill(200, 50);
    // stroke(255);
    // rect(camBound.x, camBound.y, camBound.w, camBound.h);
    // pop();
  }

  addObject(object: GameObject): void {
    this._objectToBeAdd.push(object);
  }

  removeObject(object: GameObject): void {
    object.toRemove = true;
  }

  queryObjects<const TFilters extends readonly GameObjectFilter[]>(
    options: Omit<QueryOptions, 'filters'> & { filters: TFilters }
  ): QueryResult<TFilters>[];
  queryObjects(options: QueryOptions): GameObject[];
  queryObjects({ area, filters, queryByDisplayBoundingBox = false }: QueryOptions): GameObject[] {
    if (this._objectsTreeIsUpdating) {
      console.warn('Quadtree is updating, this may cause unexpected result.');
    }

    const hasFilters = !!filters && filters.length > 0;
    // Matches PredefinedFilters.collideWith, including its "no area means
    // nothing matches" answer — and, as there, only when a filter list was
    // given at all. The collide test stays last of the three, because the cheap
    // type/team filters should reject before a bounding-box intersect runs.
    const needsCollideCheck = hasFilters && !queryByDisplayBoundingBox;

    // Hand-rolled instead of `[...filters]` + `.filter(o => resolved.every(f => f(o)))`:
    // that spread built an array, `collideWith(area)` built a closure and the
    // two callbacks built two more — per query, and there are many queries per
    // frame.
    //
    // **One walk of the hit-list, not two.** The area case used to unwrap every
    // region into an intermediate array and then walk *that* to filter it: two
    // passes and one throwaway array per query, and a teamfight makes ~37
    // queries a tick. Fused, the region loop is the filter loop.
    //
    // Worth **~9%** of this function on the shape the bots actually issue (an
    // area plus one team filter, 8.4 → 7.6us a call, measured in a tight loop
    // on a 168-object board) — real, and small. It is here because it costs
    // nothing and allocates one array per query less; do not expect a fight to
    // feel different for it.
    //
    // The four cases below are the four the old shape had, kept apart on
    // purpose because they do genuinely different things — an area with no
    // filters skips the collide test, and no area with filters is the answer
    // above.
    if (area) {
      const regions = this._objectsTree.retrieve(area) as GameObjectRegion[];
      const result: GameObject[] = [];
      for (let i = 0; i < regions.length; i++) {
        const object = regions[i]?.data;
        if (!object || object.toRemove) continue;
        if (hasFilters) {
          let passed = true;
          for (let f = 0; f < filters!.length; f++) {
            if (!filters![f](object)) {
              passed = false;
              break;
            }
          }
          if (!passed) continue;
          if (needsCollideCheck) {
            if (typeof object.getCollideBoundingBox !== 'function') continue;
            if (!object.getCollideBoundingBox().intersect(area)) continue;
          }
        }
        result.push(object);
      }
      return result;
    }

    const objects = this.objects;
    if (!hasFilters) {
      const clean: GameObject[] = [];
      for (let i = 0; i < objects.length; i++) {
        const o = objects[i];
        if (o && !o.toRemove) clean.push(o);
      }
      return clean;
    }
    // Filters but no area, and the collide test still owed: every candidate
    // fails it, so the answer is empty without running a predicate. Stated
    // rather than reached by filtering the whole list and discarding it.
    if (needsCollideCheck) return [];

    const result: GameObject[] = [];
    for (let i = 0; i < objects.length; i++) {
      const object = objects[i];
      if (!object || object.toRemove) continue;
      let passed = true;
      for (let f = 0; f < filters!.length; f++) {
        if (!filters![f](object)) {
          passed = false;
          break;
        }
      }
      if (passed) result.push(object);
    }
    return result;
  }
}
