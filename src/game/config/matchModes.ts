import type { MapTuning } from '@/content/ContentPack';
import type { MatchRulesConfig, PregameConfig, WorldConfig } from './PregameConfig';
import { MatchTeam, type MatchTeamId } from './MatchTeams';

/**
 * Match modes: a name for a bundle of knobs the panel already has.
 *
 * ## What a mode is not
 *
 * Not a win condition, not a queue, not a map. This game is a practice room —
 * the match ends when the player leaves it — so a "mode" here is the answer
 * to "how do I want tonight's room set up", stated once instead of dragged
 * across four controls and two tabs. URF is CDR at 80% with mana off; the
 * brawl is every kit random with no way home; the duel is one bot. Every one
 * of those was already possible; none of them had a name.
 *
 * ## Macro, then overlay
 *
 * Picking a mode does two different kinds of thing, and the split is the
 * design:
 *
 * - **Knobs the panel owns are written through the panel.** `rules`, `world`
 *   and `bots` are copied into `PregameConfig` by `applyMode` (outside a
 *   match) or seeded into the live match by `MatchDirector.setMode` (inside
 *   one). Afterwards the fields are the truth and the mode id is a label —
 *   see `modeDrift`, which is how the label admits it has been edited.
 * - **Numbers no knob holds ride on the id.** `tuning` is laid over the map's
 *   own `MapTuning` when the match boots (`mergeTuning`, in `Game`'s
 *   constructor), and `allRandom` is read by `planMatchKits`. Both take effect
 *   on the next match, like the map choice does, and for the same reason: a
 *   running match cannot change its economy or re-roll its roster.
 *
 * `MapTuning` is the right vehicle for the second half because it already
 * has the levers a mode wants — starting gold, income, respawn, champion
 * speed — and every reader resolves `game.mapTuning` at the moment it needs
 * it, so a merged object reaches all of them without a single new seam.
 *
 * ## Pure data
 *
 * Imports types only. `PregameConfig.ts` imports `isMatchModeId` from here as
 * a value, so a value import in the other direction would be a cycle
 * evaluated at module load — which is why `classic.bots` is a literal rather
 * than `DEFAULT_PREGAME_CONFIG.ai.count` (`matchModes.test.ts` pins them
 * equal). Safe to import from the menu chunk for the same reason
 * `PregameConfig.ts` is.
 */

export type MatchModeId =
  | 'classic' | 'blitz' | 'urf' | 'brawl' | 'duel' | 'war'
  | 'twins' | 'bounty' | 'zone' | 'events';

export interface MatchMode {
  readonly id: MatchModeId;
  /** Vietnamese, two words at most: it is a chip on a phone. */
  readonly name: string;
  /** One sentence under the chips saying what the room feels like. */
  readonly blurb: string;
  /**
   * Written whole, never patched: a mode is a known state, and "URF but with
   * whatever recall setting the last mode left" is not one.
   */
  readonly rules: Readonly<MatchRulesConfig>;
  readonly world: Readonly<WorldConfig>;
  /** How many bots the room fields. Absent leaves the roster alone. */
  readonly bots?: number;
  /** Every kit — the player's too — is rolled at random, ignoring picks. */
  readonly allRandom?: boolean;
  /** Each team rolls one champion and every member plays it. Read by `planMatchKits`. */
  readonly twins?: boolean;
  /** The longest kill run (>= 3) is wanted: extra gold to its killer. See `combat/Bounty.ts`. */
  readonly bounty?: boolean;
  /** Laid over the map's own numbers at boot. See `mergeTuning`. */
  readonly tuning?: MapTuning;
  /** A shrinking poison zone, no revives, last team standing wins. See `game/zone/`. */
  readonly zone?: boolean;
  /** Random world events fire on a schedule (`game/events/`). */
  readonly randomEvents?: boolean;
}

export const DEFAULT_MATCH_MODE_ID: MatchModeId = 'classic';

const CLASSIC_RULES: Readonly<MatchRulesConfig> = Object.freeze({
  cooldownReductionPercent: 0,
  manaFree: false,
  recall: true,
});

const CLASSIC_WORLD: Readonly<WorldConfig> = Object.freeze({ jungle: true, minions: true });

/**
 * The table, in the order the panel shows it. Classic first because it is the
 * answer to "put it back".
 */
export const MATCH_MODES: readonly MatchMode[] = Object.freeze([
  {
    id: 'classic',
    name: 'Cổ điển',
    blurb: 'Luật gốc của bản đồ, ba bot.',
    rules: CLASSIC_RULES,
    world: CLASSIC_WORLD,
    // `DEFAULT_PREGAME_CONFIG.ai.count`, by hand — see the file comment.
    bots: 3,
  },
  {
    id: 'blitz',
    name: 'Siêu tốc',
    blurb: 'Vàng dồi dào, hồi sinh nhanh: lên đồ rồi đánh.',
    rules: CLASSIC_RULES,
    world: CLASSIC_WORLD,
    tuning: {
      economy: { startingGold: 2000, passiveGoldPerSecond: 6 },
      champions: { reviveTime: 3000 },
    },
  },
  {
    id: 'urf',
    name: 'URF',
    blurb: 'Hồi chiêu 80%, không tốn mana, chạy nhanh hơn.',
    rules: { cooldownReductionPercent: 80, manaFree: true, recall: true },
    world: CLASSIC_WORLD,
    tuning: {
      champions: { speedMult: 1.15 },
      economy: { passiveGoldPerSecond: 4 },
    },
  },
  {
    id: 'brawl',
    name: 'Loạn đấu',
    blurb: 'Tướng ngẫu nhiên, không hồi thành, không rừng.',
    rules: { cooldownReductionPercent: 0, manaFree: false, recall: false },
    world: { jungle: false, minions: true },
    allRandom: true,
    tuning: {
      economy: { startingGold: 1400, passiveGoldPerSecond: 5 },
      champions: { reviveTime: 8000 },
    },
  },
  {
    id: 'duel',
    name: 'Tay đôi',
    blurb: 'Một chọi một với một bot.',
    rules: CLASSIC_RULES,
    world: CLASSIC_WORLD,
    bots: 1,
  },
  {
    id: 'war',
    name: 'Đại chiến',
    blurb: 'Năm chọi năm, đủ hai đội.',
    rules: CLASSIC_RULES,
    world: CLASSIC_WORLD,
    // Nine, not ten: the player is the tenth. `initialBotTeam` alternates
    // Red first, so nine bots beside a Blue player is five Red and five Blue.
    bots: 9,
  },
  {
    id: 'twins',
    name: 'Sinh Đôi',
    blurb: 'Mỗi đội cùng một tướng ngẫu nhiên, ba chọi ba.',
    rules: CLASSIC_RULES,
    world: CLASSIC_WORLD,
    // Five bots beside a Blue player: three Red, two Blue, the player the third.
    bots: 5,
    twins: true,
  },
  {
    id: 'bounty',
    name: 'Truy Nã',
    blurb: 'Chuỗi hạ gục từ 3 bị treo thưởng: hạ hắn để nhận thêm vàng.',
    rules: CLASSIC_RULES,
    world: CLASSIC_WORLD,
    bots: 7,
    bounty: true,
  },
  {
    id: 'zone',
    name: 'Vùng Độc',
    blurb: 'Vòng độc thu hẹp, mỗi người 3 mạng: đội cuối cùng còn trụ lại thắng.',
    rules: { cooldownReductionPercent: 0, manaFree: false, recall: false },
    world: { jungle: false, minions: false },
    bots: 5,
    zone: true,
    tuning: { economy: { startingGold: 1400, passiveGoldPerSecond: 5 } },
  },
  {
    id: 'events',
    name: 'Sự Kiện',
    blurb: 'Mỗi 15 giây một sự kiện ngẫu nhiên: mưa vàng, thiên thạch, gió lốc...',
    rules: CLASSIC_RULES,
    world: CLASSIC_WORLD,
    bots: 3,
    randomEvents: true,
  },
]);

const MODE_IDS = new Set<string>(MATCH_MODES.map(mode => mode.id));

export const isMatchModeId = (value: unknown): value is MatchModeId =>
  typeof value === 'string' && MODE_IDS.has(value);

/** The table row, or classic for an id nothing knows. */
export function matchModeFor(id: MatchModeId | string | undefined): MatchMode {
  return MATCH_MODES.find(mode => mode.id === id) ?? MATCH_MODES[0];
}

const otherSide = (team: MatchTeamId): MatchTeamId =>
  team === MatchTeam.BLUE ? MatchTeam.RED : MatchTeam.BLUE;

/**
 * The first `count` bot slots dealt so the two sides come out even *with the
 * player counted*: the first bot goes opposite the player, then they
 * alternate. Nine bots beside a Blue player is five Red and four Blue — 5v5;
 * one bot is the opponent, not a teammate. Slots past `count` are kept as
 * they were, the way every per-slot array in the config keeps what a lower
 * count does not reach.
 *
 * This is what makes "Đại chiến" mean 5v5 rather than "nine bots on whatever
 * sides the last few evenings left in storage" — the shape a mode promises
 * is the mode's to deal, and a stale slot 7 is not a choice anyone made.
 */
export function balancedBotTeams(
  playerTeam: MatchTeamId,
  count: number,
  current: readonly MatchTeamId[]
): MatchTeamId[] {
  const teams = [...current];
  for (let i = 0; i < count && i < teams.length; i++) {
    teams[i] = i % 2 === 0 ? otherSide(playerTeam) : playerTeam;
  }
  return teams;
}

/**
 * The knobs a mode owns, written into a config. Pure: a new object, the
 * input untouched. This is the whole of what picking a mode does outside a
 * match; `MatchDirector.setMode` does the same three things to a live one.
 */
export function applyMode(config: PregameConfig, mode: MatchMode): PregameConfig {
  return {
    ...config,
    mode: mode.id,
    rules: { ...mode.rules },
    world: { ...mode.world },
    ai:
      mode.bots === undefined
        ? config.ai
        : {
            ...config.ai,
            count: mode.bots,
            botTeams: balancedBotTeams(config.playerTeam, mode.bots, config.ai.botTeams),
          },
  };
}

/** What the panel is showing now, for `modeDrift`. */
export interface ModeKnobs {
  rules: Readonly<MatchRulesConfig>;
  world: Readonly<WorldConfig>;
  botCount: number;
}

/**
 * Whether the knobs have been moved since the mode was picked.
 *
 * The chip stays on the mode the player chose — the id is a stored fact, and
 * un-choosing it because CDR moved would make the slider a way to lose the
 * label. This is how the label stays honest instead: true, and the panel
 * appends "đã chỉnh". Only knobs the mode *declares* count; a mode that says
 * nothing about bots has no opinion on how many there are.
 */
export function modeDrift(mode: MatchMode, knobs: ModeKnobs): boolean {
  if (mode.rules.cooldownReductionPercent !== knobs.rules.cooldownReductionPercent) return true;
  if (mode.rules.manaFree !== knobs.rules.manaFree) return true;
  if (mode.rules.recall !== (knobs.rules.recall !== false)) return true;
  if (mode.world.jungle !== knobs.world.jungle) return true;
  if (mode.world.minions !== knobs.world.minions) return true;
  if (mode.bots !== undefined && mode.bots !== knobs.botCount) return true;
  return false;
}

/**
 * The mode's knobs as short Vietnamese lines, defaults omitted — under the
 * chips, so a player knows what "Loạn đấu" will do before pressing it. The
 * tuning half is *not* described here: `hud/config/mapRuleLines.ts` already
 * turns a `MapTuning` into lines and lives beside the panel; this module is
 * data and must not import the HUD.
 */
export function describeMode(mode: MatchMode): string[] {
  const lines: string[] = [];
  if (mode.allRandom) lines.push('Tướng ngẫu nhiên cho tất cả');
  if (mode.twins) lines.push('Mỗi đội cùng một tướng');
  if (mode.bounty) lines.push('Truy nã chuỗi hạ gục từ 3');
  if (mode.rules.cooldownReductionPercent > 0) {
    lines.push(`Giảm hồi chiêu ${mode.rules.cooldownReductionPercent}%`);
  }
  if (mode.rules.manaFree) lines.push('Không tốn mana');
  if (!mode.rules.recall) lines.push('Không hồi thành');
  if (!mode.world.jungle) lines.push('Không quái rừng');
  if (!mode.world.minions) lines.push('Không lính');
  if (mode.zone) lines.push('Vùng độc thu hẹp, 3 mạng');
  if (mode.bots !== undefined) lines.push(`${mode.bots} bot`);
  if (mode.randomEvents) lines.push('Sự kiện ngẫu nhiên mỗi 15 giây');
  return lines;
}

// ------------------------------------------------------------------ tuning

type Bag = Record<string, unknown>;

const isBag = (value: unknown): value is Bag =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Paths whose overlay **replaces** the base outright instead of merging into
 * it. `minions.types` is all-or-nothing by `MinionTuning`'s own contract — a
 * map declaring a roster declares the whole roster — and a mode declaring
 * one means the same thing.
 */
const REPLACE_WHOLE = new Set(['minions.types']);

function mergeBags(base: Bag, overlay: Bag, path: string): Bag {
  const out: Bag = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    const here = path ? `${path}.${key}` : key;
    const under = base[key];
    out[key] =
      isBag(value) && isBag(under) && !REPLACE_WHOLE.has(here)
        ? mergeBags(under, value, here)
        : value;
  }
  return out;
}

/**
 * The map's numbers with the mode's laid over them, field by field.
 *
 * A field the overlay names wins; one it does not keeps the map's value, or
 * stays absent so the reader's own default still applies — `resolve*` in
 * `config/mapTuning.ts` treat absence as "what core did before", and this
 * must not turn an absence into a number. Arrays (`waves.composition`,
 * `waves.stages`) and the paths in `REPLACE_WHOLE` are replaced, not spliced.
 *
 * Returns `undefined` when both sides are, so a classic match on a map that
 * states nothing still has `game.mapTuning === undefined`, exactly as before
 * modes existed. Neither input is mutated.
 */
export function mergeTuning(
  base: MapTuning | undefined,
  overlay: MapTuning | undefined
): MapTuning | undefined {
  if (!overlay) return base;
  if (!base) return mergeBags({}, overlay as Bag, '') as MapTuning;
  return mergeBags(base as Bag, overlay as Bag, '') as MapTuning;
}
