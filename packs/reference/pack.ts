import type { ContentApi } from '@moba2d/core/content/ContentApi';
import type {
  ContentPackCode,
  ContentPackData,
  MonsterDef,
} from '@moba2d/core/content/ContentPack';
import { referenceMap } from './map';
import makeScenery, { SCENERY_ROLE } from './art/scenery';
import makeVeraQ, { VERA_Q_COOLDOWN_MS, VERA_Q_DAMAGE, VERA_Q_MANA } from './spells/Vera_Q';
import makeVeraW, {
  VERA_W_COOLDOWN_MS,
  VERA_W_DURATION_MS,
  VERA_W_MANA,
  VERA_W_SHIELD,
} from './spells/Vera_W';
import makeVeraE, { VERA_E_COOLDOWN_MS, VERA_E_MANA } from './spells/Vera_E';
import makeVeraR, { VERA_R_COOLDOWN_MS, VERA_R_DAMAGE, VERA_R_MANA } from './spells/Vera_R';

/**
 * The pack core ships with — proof the content-pack seam works, not yet a
 * playable game. Nothing in `src/` imports `src/content/install.ts` today, so
 * shipping this pack does not make this champion selectable; wiring the
 * registry into the boot path is batch 2's first step.
 *
 * It is three things at once and each one matters: the smoke test that the
 * seam works end to end, the living documentation an author reads to learn
 * `ContentApi`, and the second consumer that keeps the API from being shaped
 * around the Riot pack alone.
 *
 * Every id here is local. `PackRegistry` prefixes them with `reference:`.
 *
 * Split into a data half and a code half, batch 3's own change: `data` is
 * reachable — a roster, a set of tooltips — without ever building a
 * `ContentApi`, because none of `./spells/Vera_*.ts` imports the engine
 * either; each takes `api` as a parameter of its exported factory and
 * nothing more. The default export stays the code half, still a factory,
 * because a pack's spells are still real engine classes and still need it.
 *
 * `monsters` and `maps` are Task 9's own addition: a second map (`./map.ts`)
 * that is core's own rather than a pack's, and a camp declared here rather
 * than by whatever pack a player has installed — proof that a monster
 * "filling a role" (Task 7's split) is a real cross-pack match, not just
 * something the bundled pack does to its own slots. See `warden` below for
 * what happened to the slot it used to fill.
 */
export const data: ContentPackData = {
  manifest: { id: 'reference', version: '1.0.0', coreRange: '^1' },
  // Every number interpolated below is imported from the spell file it
  // describes, never restated by hand, so a description can never disagree
  // with the spell it describes. `specCoolDownMs` equals `coolDownMs` for
  // all four: none of these spells overrides `castSpec`, so the runtime's
  // countdown runs off `legacyCastSpec(this.coolDown)` — the same number.
  spellDisplay: {
    Vera_Q: {
      name: 'Tia Lam (Vera_Q)',
      description: `Bắn một tia năng lượng thẳng, gây <span class="damage">${VERA_Q_DAMAGE} sát thương</span> cho kẻ địch đầu tiên trúng.`,
      iconKey: 'reference_vera_q',
      coolDownMs: VERA_Q_COOLDOWN_MS,
      manaCost: VERA_Q_MANA,
      specCoolDownMs: VERA_Q_COOLDOWN_MS,
    },
    Vera_W: {
      name: 'Vỏ Sáng (Vera_W)',
      description: `Tự khoác một <span class="buff">Lá Chắn ${VERA_W_SHIELD}</span> trong <span class="time">${VERA_W_DURATION_MS / 1000} giây</span>.`,
      iconKey: 'reference_vera_w',
      coolDownMs: VERA_W_COOLDOWN_MS,
      manaCost: VERA_W_MANA,
      specCoolDownMs: VERA_W_COOLDOWN_MS,
    },
    Vera_E: {
      name: 'Bước Chớp (Vera_E)',
      description: 'Lướt nhanh một đoạn ngắn theo hướng chỉ định.',
      iconKey: 'reference_vera_e',
      coolDownMs: VERA_E_COOLDOWN_MS,
      manaCost: VERA_E_MANA,
      specCoolDownMs: VERA_E_COOLDOWN_MS,
    },
    Vera_R: {
      name: 'Vòng Tận (Vera_R)',
      description: `Gọi một vòng sáng tại vị trí chỉ định, gây <span class="damage">${VERA_R_DAMAGE} sát thương</span> cho mọi kẻ địch bên trong.`,
      iconKey: 'reference_vera_r',
      coolDownMs: VERA_R_COOLDOWN_MS,
      manaCost: VERA_R_MANA,
      specCoolDownMs: VERA_R_COOLDOWN_MS,
    },
  },
  champions: [
    {
      id: 'vera',
      name: 'Vera',
      image: 'reference_champ_vera',
      playable: true,
      attack: { damage: 14, attacksPerSecond: 1.1, range: 300 },
      // A short cloak, so the bundled pack demonstrates `ChampionEntry.trail`
      // the way it demonstrates everything else core can do. Five vertebrae
      // tapering to nothing, in the same blue the portrait is drawn in.
      trail: { widths: [0.5, 0.62, 0.5, 0.34, 0.16], spacing: 0.5, color: [92, 122, 190] },
      spells: ['Vera_Q', 'Vera_W', 'Vera_E', 'Vera_R'],
    },
  ],
  // A camp of one body, `offset: {0, 0}` — see `MonsterBody`'s own doc comment
  // for why a multi-body camp needs more.
  //
  // **No map here places it.** It filled the one neutral slot of the map this
  // pack shipped before ARAM, whose two neutral points are `relic` (core's own
  // furniture) and `dragon` (nobody's here — the pit is empty until a content
  // pack answers that role). It stays because it is the second half of what
  // this pack is *for*: `fills` is a cross-pack match, and a monster declared
  // by one pack and placed by another map's slot is the case that keeps the
  // seam honest. A pack that declares a camp no bundled map draws costs
  // nothing until a map names its role — the same shape the health relic had
  // before it became core's.
  monsters: {
    warden: {
      id: 'warden',
      name: 'Vệ Binh Đá',
      fills: ['warden'],
      members: [
        {
          name: 'Vệ Binh Đá',
          avatar: 'reference_monster_warden',
          speed: 1.5,
          size: 90,
          attackRange: 60,
          reviveTime: 3000,
          health: 250,
          damage: 18,
          attackInterval: 1500,
          aggroRange: 200,
          offset: { x: 0, y: 0 },
        },
      ],
    } satisfies MonsterDef,
  },
  maps: [referenceMap],
};

const code = (api: ContentApi): ContentPackCode => ({
  spells: {
    Vera_Q: makeVeraQ(api),
    Vera_W: makeVeraW(api),
    Vera_E: makeVeraE(api),
    Vera_R: makeVeraR(api),
  },
  // The painted ground of this pack's map: the map's geometry carries one
  // neutral `kind: 'object'` slot with this role, and this is what stands on it.
  slotObjects: {
    [SCENERY_ROLE]: makeScenery(api),
  },
});

export default code;
