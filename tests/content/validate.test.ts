import { describe, expect, it } from 'vitest';
import { validatePack } from '../../src/content/validate';

/**
 * Validation is the only thing standing at the boundary.
 *
 * A pack is authored in TypeScript, but types are erased at compile time, so
 * by the time core holds a pack object nothing has checked it. Stage 2 makes
 * that acute — the object will come from a URL — but it is already true of a
 * pack built from a different core version.
 *
 * The failure mode this exists to prevent is the silent one. `TerrainMap`
 * drops an unknown terrain layer without a word, and `MinionSpawner` returns
 * null for a team with fewer than two turrets and lets the whole wave fall
 * back into the fountain; both surface as a broken match minutes later
 * instead of a named error at load.
 */
const goodManifest = { id: 'ref', version: '1.0.0', coreRange: '^1' };

describe('validatePack', () => {
  it('accepts a minimal pack that declares only a manifest', () => {
    const result = validatePack({ manifest: goodManifest });
    expect(result.ok).toBe(true);
  });

  it('rejects a pack with no manifest', () => {
    const result = validatePack({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/manifest/);
  });

  it('rejects a pack id that is not a bare identifier', () => {
    // Ids are namespaced as `<packId>:<localId>`, so a colon in the pack id
    // makes the qualified id ambiguous.
    const result = validatePack({ manifest: { ...goodManifest, id: 'ref:extra' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/id/);
  });

  it('names the champion whose spell id does not exist in the pack', () => {
    const result = validatePack({
      manifest: goodManifest,
      spells: { Alpha_Q: class {} },
      champions: [{ id: 'alpha', name: 'Alpha', image: null, spells: ['Alpha_Q', 'Alpha_W'] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/Alpha_W/);
  });

  it('names the champion whose recall id does not exist in the pack', () => {
    const result = validatePack({
      manifest: goodManifest,
      spells: { Alpha_Q: class {} },
      champions: [
        {
          id: 'alpha',
          name: 'Alpha',
          image: null,
          spells: ['Alpha_Q'],
          recall: 'Alpha_Recall',
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/Alpha_Recall/);
  });

  it('accepts a champion whose recall names a spell the pack declares', () => {
    const result = validatePack({
      manifest: goodManifest,
      spells: { Alpha_Q: class {}, Alpha_Recall: class {} },
      champions: [
        {
          id: 'alpha',
          name: 'Alpha',
          image: null,
          playable: false,
          spells: ['Alpha_Q'],
          recall: 'Alpha_Recall',
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a map whose lane names a faction it never declared', () => {
    const result = validatePack({
      manifest: goodManifest,
      maps: [
        {
          id: 'arena',
          name: 'Arena',
          size: 4000,
          factions: [{ id: 'blue' }],
          geometry: {
            terrain: { wall: [], bush: [], water: [] },
            slots: { spawn: [], minion: [], structure: [], neutral: [] },
            lanes: [{ id: 'MID', from: 'blue', to: 'red', waypoints: [] }],
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/red/);
  });

  it('rejects a lane whose faction has no declared muster point', () => {
    // `MinionSpawner.musterPointFor` used to answer this with `null` and drop
    // the whole wave into the fountain, silently, until the first wave walked
    // back out of it (see this file's own header). Task 6 pushes that failure
    // here instead — a lane's faction with nowhere to muster cannot install.
    const result = validatePack({
      manifest: goodManifest,
      maps: [
        {
          id: 'arena',
          name: 'Arena',
          size: 4000,
          factions: [{ id: 'blue' }, { id: 'red' }],
          geometry: {
            terrain: { wall: [], bush: [], water: [] },
            slots: {
              spawn: [],
              // blue musters here; red, which also walks MID, has nothing.
              minion: [{ faction: 'blue', lane: 'MID', x: 0, y: 0 }],
              structure: [],
              neutral: [],
            },
            lanes: [{ id: 'MID', from: 'blue', to: 'red', waypoints: [] }],
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/no muster point.*red.*MID/);
  });

  it('accepts a lane whose two factions both declare a muster point', () => {
    const result = validatePack({
      manifest: goodManifest,
      maps: [
        {
          id: 'arena',
          name: 'Arena',
          size: 4000,
          factions: [{ id: 'blue' }, { id: 'red' }],
          geometry: {
            terrain: { wall: [], bush: [], water: [] },
            slots: {
              spawn: [],
              minion: [
                { faction: 'blue', lane: 'MID', x: 0, y: 0 },
                { faction: 'red', lane: 'MID', x: 10, y: 10 },
              ],
              structure: [],
              neutral: [],
            },
            lanes: [{ id: 'MID', from: 'blue', to: 'red', waypoints: [] }],
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a structure slot whose kind is not core vocabulary', () => {
    // `role` on a neutral slot is a free string the packs agree on between
    // themselves; `kind` on a structure is core's own vocabulary, because
    // Turret and Fountain are core classes.
    const result = validatePack({
      manifest: goodManifest,
      maps: [
        {
          id: 'arena',
          name: 'Arena',
          size: 4000,
          factions: [{ id: 'blue' }],
          geometry: {
            terrain: { wall: [], bush: [], water: [] },
            slots: {
              spawn: [],
              minion: [],
              structure: [{ faction: 'blue', kind: 'obelisk', x: 0, y: 0 }],
              neutral: [],
            },
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/obelisk/);
  });

  it('accepts a map with no lanes at all', () => {
    // A battle-royale map has none, and that must be a shape rather than an
    // error: no lanes means no minion waves, and BotBrain's PUSH posture —
    // the only one that needs a lane — falls through to ROAM.
    const result = validatePack({
      manifest: goodManifest,
      maps: [
        {
          id: 'forest',
          name: 'Forest',
          size: 4000,
          factions: [{ id: 'solo' }],
          geometry: {
            terrain: { wall: [], bush: [], water: [] },
            slots: { spawn: [], minion: [], structure: [], neutral: [] },
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a terrain layer core does not know', () => {
    // TerrainMap only knows wall/bush/water and used to drop anything else in
    // silence — see this file's own header. A pack that declares `lava` must
    // be told, not ignored.
    const result = validatePack({
      manifest: goodManifest,
      maps: [
        {
          id: 'arena',
          name: 'Arena',
          size: 4000,
          factions: [{ id: 'solo' }],
          geometry: {
            terrain: { wall: [], bush: [], water: [], lava: [] },
            slots: { spawn: [], minion: [], structure: [], neutral: [] },
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.errors.join('\n')).toMatch(/lava/);
  });

  // ── terrain zones ────────────────────────────────────────────────────────
  //
  // A zone is a tagged region that is deliberately *not* one of the three
  // layers: it never reaches the nav grid, blocks no sight, and conceals
  // nobody. So it is checked here rather than folded into the layer loop
  // above — the layer loop's whole job is to refuse a fourth layer, and a
  // zone must not become one.

  const zoneMap = (zones: unknown) => ({
    manifest: goodManifest,
    maps: [
      {
        id: 'arena',
        name: 'Arena',
        size: 4000,
        factions: [{ id: 'solo' }],
        geometry: {
          terrain: { wall: [], bush: [], water: [] },
          zones,
          slots: { spawn: [], minion: [], structure: [], neutral: [] },
        },
      },
    ],
  });

  const sandZone = (extra: Record<string, unknown> = {}) => ({
    id: 'sand',
    name: 'Cát',
    speedMultiplier: 0.8,
    render: { fill: '#d9c08a' },
    polygons: [
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
    ],
    ...extra,
  });

  it('accepts a map that declares no zones at all', () => {
    expect(validatePack(zoneMap(undefined)).ok).toBe(true);
  });

  it('accepts a well-formed zone', () => {
    expect(validatePack(zoneMap([sandZone()])).ok).toBe(true);
  });

  it('accepts a zone that states no speed multiplier', () => {
    const zone = sandZone();
    delete (zone as Record<string, unknown>).speedMultiplier;
    expect(validatePack(zoneMap([zone])).ok).toBe(true);
  });

  it('refuses two zones sharing an id', () => {
    // `zoneIdsAt` answers with ids, and a spell asking "am I on sand" gets a
    // yes from whichever polygon happens to be found first. Two zones named
    // `sand` with different speeds is a map that means two things at once.
    const result = validatePack(zoneMap([sandZone(), sandZone({ name: 'Cát 2' })]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toMatch(/sand/);
  });

  it('refuses a zone with no render fill', () => {
    // Core has no palette to fall back on: a zone's colour is the pack's own
    // vocabulary, and an unpainted zone is an invisible speed change.
    const zone = sandZone();
    delete (zone as Record<string, unknown>).render;
    const result = validatePack(zoneMap([zone]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toMatch(/render/);
  });

  it('refuses a negative speed multiplier', () => {
    const result = validatePack(zoneMap([sandZone({ speedMultiplier: -1 })]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toMatch(/negative|speedMultiplier/);
  });

  it('refuses a polygon that is not a polygon', () => {
    // Two points is a line. `CollideUtils.pointPolygon` returns false for
    // every point against it, so the zone would exist, cost a query, and
    // never contain anybody.
    const result = validatePack(
      zoneMap([
        sandZone({
          polygons: [
            [
              { x: 0, y: 0 },
              { x: 100, y: 0 },
            ],
          ],
        }),
      ])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toMatch(/polygon/i);
  });

  it('refuses zones that are not an array', () => {
    const result = validatePack(zoneMap({ sand: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toMatch(/zones/);
  });

  it('accepts a map whose geometry is a lazy loader, unvalidated until it resolves', () => {
    // Exactly like `SpellSource`: a loader's own body cannot be inspected
    // synchronously, so validation checks that it is a function and stops —
    // the same discipline `checkSpells` already applies to a spell loader.
    const result = validatePack({
      manifest: goodManifest,
      maps: [
        {
          id: 'arena',
          name: 'Arena',
          size: 4000,
          factions: [{ id: 'solo' }],
          geometry: () =>
            Promise.resolve({
              terrain: { wall: [], bush: [], water: [] },
              slots: { spawn: [], minion: [], structure: [], neutral: [] },
            }),
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a map with no name', () => {
    const result = validatePack({
      manifest: goodManifest,
      maps: [
        {
          id: 'arena',
          size: 4000,
          factions: [{ id: 'solo' }],
          geometry: {
            terrain: { wall: [], bush: [], water: [] },
            slots: { spawn: [], minion: [], structure: [], neutral: [] },
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/name/);
  });

  it('names the monster whose fills is not an array of strings', () => {
    // PackRegistry.install() iterates pack.monsters, and monstersFilling(role)
    // calls monster.fills.includes(role) — a fills that is a string rather
    // than an array turns into a runtime TypeError one layer downstream.
    const result = validatePack({
      manifest: goodManifest,
      monsters: { wolf: { id: 'wolf', name: 'Wolf', fills: 'jungle', health: 20 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/fills/);
  });

  it('rejects a monster with no members', () => {
    // A camp used to carry position and tuning in one flat MonsterPresetData
    // entry; splitting position out to a NeutralSlot, and composition out to
    // MonsterBody, still leaves a monster with nothing to spawn if its own
    // members array is empty or missing — Game.spawnJungle() loops it
    // unconditionally, so an empty camp here is a silent one there.
    const result = validatePack({
      manifest: goodManifest,
      monsters: { wolves: { id: 'wolves', name: 'Wolves', fills: ['wolves'], members: [] } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/members/);
  });

  it('names a monster body missing the tuning fields Game.spawnJungle needs to build one', () => {
    const result = validatePack({
      manifest: goodManifest,
      monsters: {
        wolves: {
          id: 'wolves',
          name: 'Wolves',
          fills: ['wolves'],
          members: [{ name: 'Wolf', health: 100 }],
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/avatar/);
      expect(result.errors.join(' ')).toMatch(/speed/);
      expect(result.errors.join(' ')).toMatch(/size/);
      expect(result.errors.join(' ')).toMatch(/attackRange/);
      expect(result.errors.join(' ')).toMatch(/reviveTime/);
      expect(result.errors.join(' ')).toMatch(/offset/);
    }
  });

  it('rejects a monster body avatar that is not a string', () => {
    const result = validatePack({
      manifest: goodManifest,
      monsters: {
        wolves: {
          id: 'wolves',
          name: 'Wolves',
          fills: ['wolves'],
          members: [
            {
              name: 'Wolf',
              avatar: 42,
              speed: 2,
              size: 40,
              attackRange: 50,
              reviveTime: 3000,
              health: 100,
              offset: { x: 0, y: 0 },
            },
          ],
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/avatar/);
  });

  it('rejects a monster body offset that is not {x, y}', () => {
    const result = validatePack({
      manifest: goodManifest,
      monsters: {
        wolves: {
          id: 'wolves',
          name: 'Wolves',
          fills: ['wolves'],
          members: [
            {
              name: 'Wolf',
              avatar: 'reference:wolf',
              speed: 2,
              size: 40,
              attackRange: 50,
              reviveTime: 3000,
              health: 100,
              offset: 'centre',
            },
          ],
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/offset/);
  });

  it('accepts a fully specified monster, a pack of several members included', () => {
    const member = (health: number, offset: { x: number; y: number }) => ({
      name: 'Wolf',
      avatar: 'reference:wolf',
      speed: 2,
      size: 40,
      attackRange: 50,
      reviveTime: 3000,
      health,
      offset,
    });
    const result = validatePack({
      manifest: goodManifest,
      monsters: {
        wolves: {
          id: 'wolves',
          name: 'Wolves',
          fills: ['wolves'],
          members: [
            member(300, { x: 0, y: 0 }),
            member(100, { x: -83, y: -51 }),
            member(100, { x: 40, y: 97 }),
          ],
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  // ---------------------------------------------------------- behaviour fields
  //
  // `temperament`, `roam` and `ephemeral` are the three optional fields on a
  // `MonsterBody` whose failure mode is *silence*. A published pack is JSON by
  // the time it reaches here, so the union types are gone: a misspelled
  // temperament reads as "not aggressive" at every comparison in `Monster` and
  // the camp installs fine, then stands there while you kill it. An
  // unrecognised `roam.kind` is worse — it falls through to the camp circle,
  // which *works*, so a river crab quietly becomes an ordinary one.

  const behaviouralWolves = (body: Record<string, unknown>) => ({
    manifest: goodManifest,
    monsters: {
      wolves: {
        id: 'wolves',
        name: 'Wolves',
        fills: ['wolves'],
        members: [
          {
            name: 'Wolf',
            avatar: 'monster_wolf',
            speed: 2,
            size: 40,
            attackRange: 50,
            reviveTime: 3000,
            health: 100,
            offset: { x: 0, y: 0 },
            ...body,
          },
        ],
      },
    },
  });

  it('accepts the three behaviour fields when they are spelled right', () => {
    const result = validatePack(
      behaviouralWolves({
        temperament: 'skittish',
        roam: { kind: 'terrain', layer: 'water' },
        ephemeral: true,
      })
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a body that declares none of them — they are all optional', () => {
    expect(validatePack(behaviouralWolves({})).ok).toBe(true);
  });

  it('accepts a declared attack style and its colour', () => {
    const result = validatePack(
      behaviouralWolves({ attackStyle: 'breath', attackColor: [255, 138, 58] })
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a misspelled attack style rather than falling through to ranged', () => {
    const result = validatePack(behaviouralWolves({ attackStyle: 'meele' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/attackStyle/);
      expect(result.errors.join(' ')).toMatch(/breath/);
    }
  });

  it('accepts a creature rig, legs and a body drawn from code', () => {
    const result = validatePack(
      behaviouralWolves({
        rig: {
          body: { kind: 'orb', color: [140, 90, 255], glow: 0.6 },
          legs: { count: 6, reach: 1.6, bend: 'up' },
        },
      })
    );
    expect(result.ok).toBe(true);
  });

  /**
   * Numbers are clamped, not refused — and this is a bug report, not a
   * preference.
   *
   * Typing 7 into the editor's leg count made the whole map vanish: the slot
   * validated false, `localMaps.keepValid` dropped the map with a
   * `console.warn` nobody sees, it left the picker, and the playtest the player
   * had just started fell back to the menu. From their seat the game stopped
   * working because they typed an odd number into a cosmetic field.
   *
   * `resolveRig` already clamps every one of these, so refusing was a second
   * and far harsher answer to a question already answered. The line now: a
   * **number** out of range has one obvious repair, so take it; a **word** or a
   * shape core does not know has none, so refuse it.
   */
  it('clamps an odd leg count instead of dropping the map that holds it', () => {
    expect(validatePack(behaviouralWolves({ rig: { legs: { count: 7 } } })).ok).toBe(true);
  });

  it('clamps a leg count far past what a body can carry', () => {
    expect(validatePack(behaviouralWolves({ rig: { legs: { count: 40 } } })).ok).toBe(true);
    expect(validatePack(behaviouralWolves({ rig: { legs: { count: 0 } } })).ok).toBe(true);
  });

  it('clamps a nonsense reach rather than refusing the pack', () => {
    expect(validatePack(behaviouralWolves({ rig: { legs: { count: 6, reach: -1 } } })).ok).toBe(
      true
    );
  });

  /** A number is still a number: a string cannot be clamped into one. */
  it('still rejects a leg count that is not a number at all', () => {
    const result = validatePack(behaviouralWolves({ rig: { legs: { count: 'six' } } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/rig\.legs\.count/);
  });

  it('rejects a bend core does not know rather than silently using the other one', () => {
    const result = validatePack(
      behaviouralWolves({ rig: { legs: { count: 4, bend: 'sideways' } } })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/rig\.legs\.bend/);
      expect(result.errors.join(' ')).toMatch(/up, down/);
    }
  });

  /**
   * A body with no colour named takes core's default, the way an undeclared
   * `attackColor` does. What is refused is a colour that is not one — two
   * entries reach `fill(r, g, b, a)` as a greyscale call.
   */
  it('accepts a procedural body with no colour, and rejects a malformed one', () => {
    expect(validatePack(behaviouralWolves({ rig: { body: { kind: 'orb' } } })).ok).toBe(true);

    const bad = validatePack(
      behaviouralWolves({ rig: { body: { kind: 'orb', color: [140, 90] } } })
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(' ')).toMatch(/rig\.body\.color/);
  });

  it('accepts a segmented body and the joints its legs hang off', () => {
    const result = validatePack(
      behaviouralWolves({
        rig: {
          body: { kind: 'chain', widths: [0.9, 1, 0.8, 0.6, 0.4], spacing: 0.9, bend: 0.45 },
          legs: { count: 4, on: [1, 3] },
        },
      })
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a body kind core cannot draw', () => {
    const result = validatePack(behaviouralWolves({ rig: { body: { kind: 'blob' } } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/rig\.body/);
  });

  /**
   * The widths array is the shape of the creature, so a pack that means to
   * declare one and gets the type wrong should hear about it. The *length* is
   * clamped, like every other number here — a spine trimmed to one vertebra
   * falls back to a plain body rather than dropping the pack.
   */
  it('rejects widths that are not a list of numbers, and clamps a short one', () => {
    const bad = validatePack(behaviouralWolves({ rig: { body: { kind: 'chain', widths: 5 } } }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(' ')).toMatch(/rig\.body\.widths/);

    expect(
      validatePack(behaviouralWolves({ rig: { body: { kind: 'chain', widths: [1] } } })).ok
    ).toBe(true);
  });

  it('rejects an attack colour that is not three numbers', () => {
    // A two-entry array reaches `fill(r, g, b, a)` as `fill(255, 138,
    // undefined, alpha)`, which p5 reads as a greyscale call — the camp's art
    // silently turns grey instead of failing.
    const result = validatePack(behaviouralWolves({ attackColor: [255, 138] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/attackColor/);
  });

  it('rejects a misspelled temperament rather than reading it as not-aggressive', () => {
    const result = validatePack(behaviouralWolves({ temperament: 'agressive' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/temperament/);
      // Names what core does provide, so the fix is in the message.
      expect(result.errors.join(' ')).toMatch(/skittish/);
    }
  });

  it('rejects an unknown roam kind rather than falling through to the camp circle', () => {
    const result = validatePack(behaviouralWolves({ roam: { kind: 'river' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/roam\.kind/);
  });

  it('rejects a terrain roam naming a layer that is not a region', () => {
    // `wall` is a layer, but not one anything can stand in.
    const result = validatePack(behaviouralWolves({ roam: { kind: 'terrain', layer: 'wall' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/roam\.layer/);
  });

  it('accepts an explicit camp roam', () => {
    expect(validatePack(behaviouralWolves({ roam: { kind: 'camp' } })).ok).toBe(true);
  });

  it('rejects a non-boolean ephemeral', () => {
    const result = validatePack(behaviouralWolves({ ephemeral: 'yes' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/ephemeral/);
  });

  // ------------------------------------------------------------ map tuning
  //
  // Every group is optional and absent means core's own numbers, so the only
  // thing worth checking is that what a map *did* say is sayable. Unknown
  // keys are the point: the engine's failure for a misspelled one is to keep
  // its own value in silence, which leaves an author with a turret that
  // ignored them and no way to find out why.

  const mapWith = (extra: Record<string, unknown>) => ({
    manifest: goodManifest,
    maps: [
      {
        id: 'm',
        name: 'M',
        size: 1_000,
        factions: [{ id: 'blue' }, { id: 'red' }],
        geometry: {
          terrain: { wall: [], bush: [], water: [] },
          slots: { spawn: [], minion: [], structure: [], neutral: [] },
        },
        ...extra,
      },
    ],
  });

  it('accepts a map that states no tuning at all', () => {
    expect(validatePack(mapWith({})).ok).toBe(true);
  });

  it('accepts a fully populated tuning block', () => {
    const result = validatePack(
      mapWith({
        tuning: {
          champions: { reviveCurve: { base: 8_000, perMinute: 2_500, max: 60_000 } },
          turrets: { damage: 40, attackRange: 900 },
          fountain: { name: 'Suối', healPercent: 0.3 },
          monsters: { healthMult: 2, chaseMargin: 800 },
          terrain: { water: { speedMultiplier: 0.5 }, bush: { speedMultiplier: 1.2 } },
        },
      })
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a misspelled stat instead of silently keeping core's", () => {
    const result = validatePack(mapWith({ tuning: { turrets: { attackRnage: 900 } } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/attackRnage/);
  });

  it('rejects an unknown tuning group', () => {
    const result = validatePack(mapWith({ tuning: { weather: {} } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/weather/);
  });

  it('names every real group in that message', () => {
    // The list is a runtime constant because the type is erased, so a group
    // added to `MapTuning` and forgotten here reads to an author as a typo.
    const result = validatePack(mapWith({ tuning: { weather: {} } }));
    if (!result.ok) {
      for (const group of ['champions', 'turrets', 'fountain', 'minions', 'monsters', 'terrain']) {
        expect(result.errors.join(' ')).toContain(group);
      }
    }
  });

  it('rejects a negative duration', () => {
    const result = validatePack(mapWith({ tuning: { turrets: { rebuildTime: -1 } } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/negative/);
  });

  it('rejects a half-written revive curve', () => {
    const result = validatePack(
      mapWith({ tuning: { champions: { reviveCurve: { base: 8_000 } } } })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/perMinute/);
  });

  it('rejects a terrain layer nothing can stand in', () => {
    const result = validatePack(
      mapWith({ tuning: { terrain: { wall: { speedMultiplier: 0.5 } } } })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/wall/);
  });

  it('checks the tuning of a map whose geometry is a lazy loader', () => {
    // The ordering trap: `checkMap` returns early for a loader, and every big
    // map is a loader. Tuning is checked before that point, so this must fail.
    const result = validatePack({
      manifest: goodManifest,
      maps: [
        {
          id: 'm',
          name: 'M',
          size: 1_000,
          factions: [{ id: 'blue' }, { id: 'red' }],
          tuning: { turrets: { attackRnage: 900 } },
          geometry: () => Promise.resolve({}),
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/attackRnage/);
  });

  it('accepts a declared minion roster and its formation', () => {
    const result = validatePack(
      mapWith({
        tuning: {
          minions: {
            types: {
              siege: {
                name: 'Siege',
                style: 'cannon',
                speed: 2,
                size: 44,
                health: 500,
                damage: 20,
                attackInterval: 2_000,
                attackRange: 400,
                aggroRange: 420,
              },
            },
            waves: { composition: ['siege'], intervalMs: 10_000 },
          },
        },
      })
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a minion type missing a field it has no default for', () => {
    // Unlike every override elsewhere in `MapTuning`, a declared type is
    // all-or-nothing: there is no core body called `siege` to fall back to,
    // so a missing `health` is a minion with none.
    const result = validatePack(
      mapWith({
        tuning: {
          minions: { types: { siege: { name: 'Siege', speed: 2, size: 44, damage: 20 } } },
        },
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/health/);
  });

  it('accepts a minion type that brings its own body, and refuses one that is not a function', () => {
    const siege = {
      name: 'Siege',
      speed: 2,
      size: 44,
      health: 100,
      damage: 20,
      attackInterval: 1_000,
      attackRange: 40,
      aggroRange: 300,
    };
    const withDraw = (draw: unknown) =>
      validatePack(
        mapWith({
          tuning: {
            minions: { types: { siege: { ...siege, draw } }, waves: { composition: ['siege'] } },
          },
        })
      );

    const drawn = withDraw(() => {});
    expect(drawn.ok ? [] : drawn.errors).toEqual([]);

    const broken = withDraw('crab.png');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.errors.join(' ')).toMatch(/siege\.draw: must be a function/);
  });

  it('rejects a style core cannot fight or draw as', () => {
    const result = validatePack(
      mapWith({ tuning: { minions: { types: { siege: { name: 'S', style: 'flying' } } } } })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/style/);
  });

  it('rejects a formation naming a type nothing supplies', () => {
    // The map replaced core's roster, so `melee` no longer exists on it and
    // this wave would spawn nothing at all, silently, for the whole match.
    const result = validatePack(
      mapWith({
        tuning: {
          minions: {
            types: {
              grunt: {
                name: 'Grunt',
                speed: 3,
                size: 30,
                health: 200,
                damage: 7,
                attackInterval: 1_000,
                attackRange: 40,
                aggroRange: 300,
              },
            },
            waves: { composition: ['grunt', 'melee'] },
          },
        },
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/melee/);
  });

  it('accepts core ids in a formation when the map declares no roster', () => {
    const result = validatePack(
      mapWith({ tuning: { minions: { waves: { composition: ['melee', 'cannon'] } } } })
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a stage with no time on it', () => {
    const result = validatePack(
      mapWith({ tuning: { minions: { waves: { stages: [{ composition: ['melee'] }] } } } })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/atMs/);
  });

  /* ------------------------------- a muster point's own formation ------- */

  const grunt = {
    name: 'Grunt',
    speed: 3,
    size: 30,
    health: 200,
    damage: 7,
    attackInterval: 1_000,
    attackRange: 40,
    aggroRange: 300,
  };

  /** A map declaring `types` and a muster point, with whatever else is passed. */
  const musterMap = (types: Record<string, unknown>, musterStats: unknown, waves?: unknown) =>
    mapWith({
      tuning: { minions: { types, ...(waves === undefined ? {} : { waves }) } },
      geometry: {
        terrain: { wall: [], bush: [], water: [] },
        slots: {
          spawn: [],
          minion: [{ faction: 'blue', lane: 'MID', x: 1, y: 1, stats: musterStats }],
          structure: [],
          neutral: [],
        },
      },
    });

  it('rejects a muster formation naming a type nothing supplies', () => {
    // The same rule the map-wide formation follows, and the same silence if it
    // is missed: `MinionSpawner` drops the id, so this point fields a smaller
    // wave — or none — for the whole match, with nothing saying why.
    const result = validatePack(musterMap({ grunt }, { composition: ['grunt', 'melee'] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/melee/);
  });

  /**
   * The regression that moving the never-fielded rule out of `checkMinionTuning`
   * exists to prevent.
   *
   * A type fielded **only** by a muster point is the whole point of the
   * feature — "bot lane trickles grunts, nowhere else does" — and the old rule,
   * which could see the tuning and not the slots, would have called it
   * "declared but never fielded" and refused the map.
   */
  it('accepts a type that only a muster point fields', () => {
    const result = validatePack(musterMap({ grunt }, { composition: ['grunt'] }));
    expect(result.ok).toBe(true);
  });

  it('still refuses a type no formation fields at all', () => {
    const result = validatePack(musterMap({ grunt }, { composition: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/never fielded/);
  });

  it('rejects a key core does not read on a muster point', () => {
    // A misspelled key is a formation the engine keeps its own value for, in
    // silence — the reason every other `stats` block here is checked too.
    const result = validatePack(musterMap({ grunt }, { compositon: ['grunt'] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/compositon/);
  });

  it('checks a per-slot stats block too', () => {
    const result = validatePack(
      mapWith({
        geometry: {
          terrain: { wall: [], bush: [], water: [] },
          slots: {
            spawn: [],
            minion: [],
            structure: [
              { faction: 'blue', kind: 'turret', x: 1, y: 1, stats: { attackRnage: 900 } },
            ],
            neutral: [],
          },
        },
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/attackRnage/);
  });

  it('accepts a neutral slot naming a temperament and rejects a misspelled one', () => {
    const geometryWith = (stats: Record<string, unknown>) => ({
      terrain: { wall: [], bush: [], water: [] },
      slots: {
        spawn: [],
        minion: [],
        structure: [],
        neutral: [{ role: 'crab', x: 1, y: 1, r: 10, stats }],
      },
    });
    expect(validatePack(mapWith({ geometry: geometryWith({ temperament: 'skittish' }) })).ok).toBe(
      true
    );
    const bad = validatePack(mapWith({ geometry: geometryWith({ temperament: 'skitish' }) }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(' ')).toMatch(/temperament/);
  });

  it('accepts a neutral slot naming an attack style and rejects a misspelled one', () => {
    const geometryWith = (stats: Record<string, unknown>) => ({
      terrain: { wall: [], bush: [], water: [] },
      slots: {
        spawn: [],
        minion: [],
        structure: [],
        neutral: [{ role: 'dragon', x: 1, y: 1, r: 10, stats }],
      },
    });
    expect(validatePack(mapWith({ geometry: geometryWith({ attackStyle: 'breath' }) })).ok).toBe(
      true
    );
    // Without the destructure in `checkMonsterSlotStats` this reads as an
    // unknown *number* key, so the message would name the wrong problem.
    const bad = validatePack(mapWith({ geometry: geometryWith({ attackStyle: 'breth' }) }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(' ')).toMatch(/attackStyle/);
  });

  it('accepts a neutral slot overriding the rig, and rejects a broken one', () => {
    const geometryWith = (stats: Record<string, unknown>) => ({
      terrain: { wall: [], bush: [], water: [] },
      slots: {
        spawn: [],
        minion: [],
        structure: [],
        neutral: [{ role: 'dragon', x: 1, y: 1, r: 10, stats }],
      },
    });

    expect(
      validatePack(mapWith({ geometry: geometryWith({ rig: { legs: { count: 8 } } }) })).ok
    ).toBe(true);

    // The reported bug, at the level it was reported: a map slot with an odd
    // count must still install. It is the editor that produces these, and a
    // number typed into a cosmetic field cannot be allowed to delete a map.
    expect(
      validatePack(mapWith({ geometry: geometryWith({ rig: { legs: { count: 5 } } }) })).ok
    ).toBe(true);

    // As with `attackStyle`: without `rig` pulled out of the destructure this
    // reads as an unknown *number* key and the message names the wrong problem.
    const bad = validatePack(
      mapWith({ geometry: geometryWith({ rig: { legs: { bend: 'sideways' } } }) })
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(' ')).toMatch(/rig\.legs\.bend/);
  });

  it('rejects a spells entry that is not a class', () => {
    // The success cast claims spells: Record<string, SpellClass>. A string
    // sitting where a constructor belongs must be named at load, not `new`-ed
    // by whatever eventually instantiates it.
    const result = validatePack({
      manifest: goodManifest,
      spells: { Alpha_Q: 'not-a-class' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/Alpha_Q/);
  });

  it('accepts a lazy spell source', () => {
    const result = validatePack({
      manifest: goodManifest,
      spells: { Late: () => Promise.resolve(class {}) },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a champion whose name is not a string', () => {
    const result = validatePack({
      manifest: goodManifest,
      champions: [{ id: 'alpha', name: 42, image: null, spells: [] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/name/);
  });

  it('rejects a champion whose image is neither a string nor null', () => {
    const result = validatePack({
      manifest: goodManifest,
      champions: [{ id: 'alpha', name: 'Alpha', image: 42, spells: [] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/image/);
  });

  it('reports every defect in a single map, not just the first', () => {
    // Regression for the early-return bug: a map missing `slots` used to
    // `return` immediately, so the lane below — naming a faction nobody
    // declared — was never reached or reported in the same pass.
    const result = validatePack({
      manifest: goodManifest,
      maps: [
        {
          id: 'arena',
          name: 'Arena',
          size: 4000,
          factions: [{ id: 'blue' }],
          geometry: {
            terrain: { wall: [], bush: [], water: [] },
            lanes: [{ id: 'MID', from: 'blue', to: 'red', waypoints: [] }],
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const joined = result.errors.join(' ');
      expect(joined).toMatch(/slots/);
      expect(joined).toMatch(/red/);
    }
  });

  it('rejects a spellDisplay entry with no matching spell', () => {
    const result = validatePack({
      manifest: { id: 'p', version: '1.0.0', coreRange: '^1' },
      spells: { A: class {} },
      spellDisplay: {
        B: {
          name: 'B',
          description: '',
          iconKey: null,
          coolDownMs: 0,
          manaCost: 0,
          specCoolDownMs: 0,
        },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.errors.join('\n')).toMatch(/spellDisplay.*B/);
  });

  it('rejects a champion with no playable flag', () => {
    const result = validatePack({
      manifest: { id: 'p', version: '1.0.0', coreRange: '^1' },
      spells: { A: class {} },
      champions: [{ id: 'c', name: 'C', image: null, spells: ['A'] }],
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.errors.join('\n')).toMatch(/playable/);
  });

  it('rejects a playable champion with no portrait', () => {
    const result = validatePack({
      manifest: { id: 'p', version: '1.0.0', coreRange: '^1' },
      spells: { A: class {}, B: class {}, C: class {}, D: class {} },
      champions: [
        { id: 'c', name: 'C', image: null, playable: true, spells: ['A', 'B', 'C', 'D'] },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.errors.join('\n')).toMatch(/portrait|image/);
  });

  it('rejects a playable champion without four abilities', () => {
    const result = validatePack({
      manifest: { id: 'p', version: '1.0.0', coreRange: '^1' },
      spells: { A: class {} },
      champions: [{ id: 'c', name: 'C', image: 'art', playable: true, spells: ['A'] }],
    });
    expect(result.ok).toBe(false);
    // Named, like its three siblings: `ok === false` alone would still pass if
    // an unrelated validator regression rejected this fixture for some other
    // reason, and the rule under test would have stopped being tested.
    if (result.ok === false) expect(result.errors.join('\n')).toMatch(/four abilities/);
  });
});
