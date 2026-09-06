import {
  DEFAULT_CHAMPION_REVIVE_MS,
  resolveChampionRevive,
  resolveChampionScale,
  resolveEconomy,
  resolveFountainStats,
  resolveMinionTypes,
  resolveTerrainTuning,
  resolveVisionTuning,
  resolveTurretPreset,
} from '@/game/config/mapTuning';
import type { MapTuning } from '@/content/ContentPack';

/**
 * What a map's rules actually are, in words, for somebody choosing it.
 *
 * ## The gap this fills
 *
 * A map may retune seven whole systems — respawn, the economy, turrets, the
 * fountain, minions, the jungle, terrain speed — and a player picking one saw
 * its name, its size and a faction count. The only way to find out that a map
 * pays triple gold, or that its jungle never heals, or that water halves your
 * speed, was to open the map editor. The rules were shipped, enforced, and
 * invisible.
 *
 * ## Every line is a diff, and the diff is computed by the engine
 *
 * The temptation is a table: field name, label, default. That table is a
 * second copy of `config/mapTuning.ts` and would drift from it the first time
 * a default moved — the same failure the map-geometry rules were collapsed to
 * one implementation to end.
 *
 * So nothing here knows a single default. Every group is resolved **twice**,
 * through the engine's own resolver: once with the map's tuning and once with
 * `undefined`, which is by definition what core does. Where the two answers
 * differ, that is a rule worth reading; where they agree, there is nothing to
 * say. A retuned default therefore changes what this prints without anybody
 * editing this file, and a new field shows up the moment its resolver returns
 * it.
 *
 * ## Why it lives beside the panel and not beside the resolvers
 *
 * These are sentences a player reads, in Vietnamese, and the formatting rules
 * (a multiplier as `×1.5`, a duration as `12s`, a fraction as `12%`) are a
 * presentation decision. `mapTuning.ts` is arithmetic and is pinned to the
 * `pregame` chunk for a reason its own header explains; a Vietnamese string
 * table has no business in it.
 */

/** One line: what it is, what this map sets it to, and what core would have. */
export interface MapRuleLine {
  label: string;
  /** Formatted for reading — `×1.5`, `12s`, `40%`, `900px`. */
  value: string;
  /** The same field with no map tuning at all, formatted the same way. */
  standard: string;
}

export interface MapRuleGroup {
  title: string;
  lines: MapRuleLine[];
}

/* ------------------------------------------------------------- formatting */

/** At most two decimals, and no trailing zeroes — `1.5`, `12`, `0.06`. */
const n = (value: number): string => String(Math.round(value * 100) / 100);

const px = (value: number): string => `${n(value)}px`;
const times = (value: number): string => `×${n(value)}`;
const gold = (value: number): string => `${n(value)} vàng`;
/** ms as seconds, because nothing a player reads is usefully in milliseconds. */
const secs = (ms: number): string => `${n(ms / 1000)}s`;
const pct = (fraction: number): string => `${n(fraction * 100)}%`;

/**
 * Compare one field across the two resolutions, and keep it only if it moved.
 *
 * Comparison is on the **formatted** strings rather than the raw numbers, on
 * purpose: two values that print the same are the same as far as a reader is
 * concerned, and a float that differs in the fifteenth decimal is not a rule.
 */
const differing = <T>(
  mapValues: T,
  coreValues: T,
  fields: { key: keyof T; label: string; format: (value: never) => string }[]
): MapRuleLine[] => {
  const lines: MapRuleLine[] = [];
  for (const { key, label, format } of fields) {
    const value = format(mapValues[key] as never);
    const standard = format(coreValues[key] as never);
    if (value !== standard) lines.push({ label, value, standard });
  }
  return lines;
};

const group = (title: string, lines: MapRuleLine[]): MapRuleGroup[] =>
  lines.length ? [{ title, lines }] : [];

/* ------------------------------------------------------------------ groups */

const economyLines = (tuning: MapTuning | undefined): MapRuleGroup[] =>
  group(
    'Kinh tế',
    differing(resolveEconomy(tuning), resolveEconomy(undefined), [
      { key: 'startingGold', label: 'Vàng khởi điểm', format: gold },
      { key: 'passiveGoldPerSecond', label: 'Vàng mỗi giây', format: gold },
      { key: 'minionBounty', label: 'Tiền lính', format: gold },
      { key: 'monsterBounty', label: 'Tiền quái', format: gold },
      { key: 'championBounty', label: 'Tiền hạ tướng', format: gold },
      { key: 'turretBounty', label: 'Tiền phá trụ', format: gold },
      { key: 'sellRefund', label: 'Bán lại được', format: pct },
      { key: 'assistWindowMs', label: 'Cửa sổ hỗ trợ', format: secs },
      { key: 'assistGoldShare', label: 'Tiền hỗ trợ', format: pct },
    ])
  );

const turretLines = (tuning: MapTuning | undefined): MapRuleGroup[] =>
  group(
    'Trụ',
    differing(resolveTurretPreset(tuning), resolveTurretPreset(undefined), [
      { key: 'health', label: 'Máu', format: n },
      { key: 'damage', label: 'Sát thương', format: n },
      { key: 'attackRange', label: 'Tầm bắn', format: px },
      { key: 'attackInterval', label: 'Nhịp bắn', format: secs },
      { key: 'size', label: 'Kích thước', format: px },
      { key: 'rebuildTime', label: 'Xây lại', format: secs },
      { key: 'repairDelay', label: 'Chờ tự sửa', format: secs },
      { key: 'repairRate', label: 'Tốc tự sửa', format: n },
    ])
  );

const fountainLines = (tuning: MapTuning | undefined): MapRuleGroup[] => {
  const mapStats = resolveFountainStats(tuning);
  const coreStats = resolveFountainStats(undefined);
  const lines = differing(mapStats, coreStats, [
    { key: 'tickInterval', label: 'Nhịp hồi', format: secs },
    { key: 'healPercent', label: 'Hồi máu mỗi nhịp', format: pct },
    { key: 'manaPercent', label: 'Hồi mana mỗi nhịp', format: pct },
  ]);

  // `shopRange` is the one field whose default is a sentinel rather than a
  // number — 0 means "the platform itself" — so `differing` would print a
  // meaningless `0px`. Said in words instead, and only when it is set.
  if (mapStats.shopRange > 0) {
    lines.push({
      label: 'Tầm mua đồ',
      value: `${px(mapStats.shopRange)} quanh bệ đá`,
      standard: 'phải đứng trong bệ đá',
    });
  }
  return group('Bệ đá', lines);
};

/**
 * How much a brush is worth on this map.
 *
 * Said in words rather than through `differing` for `attackRevealMs: 0`,
 * because "0s" is a number that reads as a rounding error when it is in fact
 * the single most map-defining thing on this list: brush stops being cover you
 * can be found in and becomes stealth you can fight out of.
 */
const visionLines = (tuning: MapTuning | undefined): MapRuleGroup[] => {
  const map = resolveVisionTuning(tuning);
  const core = resolveVisionTuning(undefined);
  const lines: MapRuleLine[] = [];

  if (map.attackRevealMs !== core.attackRevealMs) {
    lines.push({
      label: 'Đánh trong bụi bị lộ',
      value: map.attackRevealMs > 0 ? secs(map.attackRevealMs) : 'không bao giờ lộ',
      standard: secs(core.attackRevealMs),
    });
  }
  // Only when it can matter: a reveal that never happens has no radius worth
  // printing, and a line about one would be a rule the map does not have.
  if (map.attackRevealMs > 0 && map.attackRevealRadius !== core.attackRevealRadius) {
    lines.push({
      label: 'Vùng bị lộ',
      value: px(map.attackRevealRadius),
      standard: px(core.attackRevealRadius),
    });
  }
  return group('Tầm nhìn', lines);
};

const terrainLines = (tuning: MapTuning | undefined): MapRuleGroup[] =>
  group(
    'Địa hình',
    differing(resolveTerrainTuning(tuning), resolveTerrainTuning(undefined), [
      { key: 'bush', label: 'Tốc chạy trong bụi', format: times },
      { key: 'water', label: 'Tốc chạy dưới nước', format: times },
    ])
  );

const championLines = (tuning: MapTuning | undefined): MapRuleGroup[] => {
  const lines: MapRuleLine[] = differing(
    resolveChampionScale(tuning),
    resolveChampionScale(undefined),
    [
      { key: 'healthMult', label: 'Máu tướng', format: times },
      { key: 'damageMult', label: 'Sát thương đánh thường', format: times },
      { key: 'speedMult', label: 'Tốc chạy', format: times },
    ]
  );
  const curve = tuning?.champions?.reviveCurve;
  if (curve) {
    // A curve has no single number to diff against, so it is stated whole. It
    // is also the only rule here that *changes as the match runs*, which is
    // exactly why a player wants to know before picking the map.
    lines.push({
      label: 'Hồi sinh',
      value: `${secs(curve.base)} + ${secs(curve.perMinute)}/phút, tối đa ${secs(curve.max)}`,
      standard: secs(DEFAULT_CHAMPION_REVIVE_MS),
    });
  } else {
    const atStart = resolveChampionRevive(tuning, 0);
    if (atStart !== DEFAULT_CHAMPION_REVIVE_MS) {
      lines.push({
        label: 'Hồi sinh',
        value: secs(atStart),
        standard: secs(DEFAULT_CHAMPION_REVIVE_MS),
      });
    }
  }
  return group('Tướng', lines);
};

const monsterLines = (tuning: MapTuning | undefined): MapRuleGroup[] => {
  // The only group not resolved twice: `resolveMonsterPreset` needs a body from
  // whichever pack fills the slot, and there is no map-independent one to
  // compare against. The map's own multipliers *are* the diff — a multiplier's
  // "core value" is 1 by construction.
  const monsters = tuning?.monsters;
  if (!monsters) return [];
  const lines: MapRuleLine[] = [];
  const scale: { key: keyof typeof monsters; label: string }[] = [
    { key: 'healthMult', label: 'Máu quái' },
    { key: 'damageMult', label: 'Sát thương quái' },
    { key: 'speedMult', label: 'Tốc chạy quái' },
    { key: 'attackIntervalMult', label: 'Nhịp đánh quái' },
    { key: 'aggroRangeMult', label: 'Tầm phát hiện' },
    { key: 'reviveTimeMult', label: 'Thời gian hồi sinh quái' },
  ];
  for (const { key, label } of scale) {
    const value = monsters[key];
    if (typeof value === 'number' && value !== 1) {
      lines.push({ label, value: times(value), standard: times(1) });
    }
  }
  if (typeof monsters.chaseMargin === 'number') {
    lines.push({ label: 'Đuổi xa thêm', value: px(monsters.chaseMargin), standard: '350px' });
  }
  if (typeof monsters.regenDelayMs === 'number') {
    lines.push({
      label: 'Chờ trước khi hồi máu',
      value: secs(monsters.regenDelayMs),
      standard: '4s',
    });
  }
  return group('Quái rừng', lines);
};

const minionLines = (tuning: MapTuning | undefined): MapRuleGroup[] => {
  const lines: MapRuleLine[] = [];

  // A roster is replaced whole or not at all (`MinionTuning.types`), so the
  // interesting statement is which bodies this map fields, not a per-number
  // diff nobody could hold in their head.
  const own = tuning?.minions?.types;
  if (own && Object.keys(own).length) {
    const core = Object.keys(resolveMinionTypes(undefined));
    lines.push({
      label: 'Loại lính',
      value: Object.values(own)
        .map(type => type.name)
        .join(', '),
      standard: `${core.length} loại của core`,
    });
  }

  const waves = tuning?.minions?.waves;
  if (waves) {
    if (typeof waves.intervalMs === 'number') {
      lines.push({ label: 'Nhịp ra lính', value: secs(waves.intervalMs), standard: '30s' });
    }
    if (typeof waves.firstDelayMs === 'number') {
      lines.push({ label: 'Wave đầu tiên', value: secs(waves.firstDelayMs), standard: '30s' });
    }
    if (typeof waves.liveCap === 'number') {
      lines.push({ label: 'Giới hạn lính sống', value: n(waves.liveCap), standard: 'không giới hạn' });
    }
    if (waves.composition?.length) {
      lines.push({
        label: 'Đội hình wave',
        value: waves.composition.join(' · '),
        standard: 'đội hình của core',
      });
    }
    if (waves.stages?.length) {
      lines.push({
        label: 'Wave đổi theo thời gian',
        value: `${waves.stages.length} mốc`,
        standard: 'không đổi',
      });
    }
  }
  return group('Lính', lines);
};

/**
 * Every way this map differs from a map that declares nothing.
 *
 * Empty means exactly that — the map plays by core's rules — which the panel
 * should say in one sentence rather than drawing an empty box.
 */
export function mapRuleGroups(tuning: MapTuning | undefined): MapRuleGroup[] {
  return [
    ...championLines(tuning),
    ...economyLines(tuning),
    ...turretLines(tuning),
    ...fountainLines(tuning),
    ...minionLines(tuning),
    ...monsterLines(tuning),
    ...terrainLines(tuning),
    ...visionLines(tuning),
  ];
}

/** How many rules a map bends — for a badge beside its name in the list. */
export const mapRuleCount = (tuning: MapTuning | undefined): number =>
  mapRuleGroups(tuning).reduce((total, section) => total + section.lines.length, 0);
