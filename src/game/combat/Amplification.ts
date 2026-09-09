import { DEFAULT_DAMAGE_TYPE, type DamageType } from '@/game/combat/Mitigation';
import {
  BASE_ATTRIBUTE,
  BASE_HIGH_ATTRIBUTE,
  FLAT_NONE_ATTRIBUTE,
  printFigure,
} from '@/game/combat/DamageText';

/**
 * What a build does to an ability, and the only place that question is
 * answered.
 *
 * ## The problem this exists for
 *
 * Items made basic attacks better and abilities exactly as good as they were
 * on the first frame of the match. Measured on the two installed packs the
 * gap was not subtle: a full attack build multiplies a champion's damage per
 * swing by about 5.7 and its rate by about 1.5, and not one of the 308
 * abilities across those packs read a single stat of its caster, so the same
 * gold bought them a multiplier of exactly 1.00. Players reported it the
 * obvious way — spamming a whole kit did less than holding right-click.
 *
 * ## Why it is a multiplier and not points
 *
 * The expressive fix is flat ability power with a ratio per ability, and it
 * was not available: a flat number means nothing until each ability declares
 * what share of it to take, which is 308 files across two repositories that
 * ship independently of this one. A multiplier is the only form that can be
 * applied *once*, at the funnel every hit already passes through, and have all
 * of them scale without a single edit. `Stats.abilityPower`'s own comment
 * covers the rest, including why an ability that wants a scaling of its own is
 * not shut out by this.
 *
 * ## The mirror of `Mitigation.ts`, on purpose
 *
 * Amplification belongs to the unit *dealing* the damage and mitigation to the
 * unit taking it, so `takeDamage` runs this first and that second: a hit is
 * made bigger at its source and then smaller by the body it lands on, which is
 * exactly the order a basic attack already goes through — `attackDamage` is
 * summed into the swing before `armor` ever sees it. Both modules take a
 * structural type rather than `AttackableUnit`, so both stay arithmetic a test
 * can drive without constructing a match.
 *
 * **What it deliberately does not touch:** whether the damage *is* an ability.
 * That is not knowable from a number and an attacker — see
 * `combat/DamageAttribution.ts`'s `abilityPowerScales`, which is what
 * `takeDamage` asks before calling in here.
 */

/** Anything with enough of a stat block to amplify. See `MitigationTarget`. */
export interface AmplificationSource {
  stats?: {
    abilityPower?: { value: number };
    /** `baseValue` as well as `value`, because only the *bonus* half scales an ability. */
    attackDamage?: { value: number; baseValue: number };
  };
  /**
   * Whose build this unit's *ability* damage reads, when it is not its own.
   *
   * Only a summon sets it (`Pet`), and the reason is the bug it fixes. A jester
   * box shoots for a flat 7 and its tooltip promises `7 (+n)`, because the
   * tooltip is rescaled by the champion who owns the ability while the bolt is
   * dealt by the box — a body with an empty inventory, no ability power, and
   * therefore a multiplier of exactly 1. Two hundred percent ability power
   * bought the caster nothing at all on that ability, silently, with the
   * tooltip still promising it.
   *
   * **Not solved by handing `takeDamage` the summoner as the attacker.** The
   * attacker is also who the victim remembers: a turret's ally-protection
   * aggro, `lastCombatMs`, the assist ledger, whose penetration applies. A
   * champion hiding two screens away whose trap shot a minion would be "in a
   * fight" and answered by a tower nobody walked up to. Who *dealt* the hit and
   * whose *build* it reads are two questions, so this is a second field rather
   * than a substitution.
   */
  abilityDamageOwner?: AmplificationSource | null;
}

/**
 * How deep a summoner chain is followed before it is judged a cycle.
 *
 * Nothing in the game builds one — the boxes a decoy clone leaves behind name
 * the champion, not the clone — but a pet summoning a pet is a pack's to write
 * and a cycle here is an infinite loop inside the damage funnel.
 */
const MAX_OWNER_DEPTH = 4;

/**
 * The unit whose stats an ability read off, following `abilityDamageOwner`.
 *
 * Applied inside both multipliers rather than at the call sites so that all
 * three amplification funnels — `takeDamage`, `AttackableUnit.takeHeal` and
 * `buffs/Shield` — get it without knowing it exists.
 */
const buildOf = (source: AmplificationSource | undefined): AmplificationSource | undefined => {
  let unit = source;
  for (let depth = 0; depth < MAX_OWNER_DEPTH; depth++) {
    const owner = unit?.abilityDamageOwner;
    if (!owner || owner === unit) return unit;
    unit = owner;
  }
  return unit;
};

/**
 * What one point of bonus attack damage adds to a physical ability, and the
 * only number in this engine that prices the two offensive stats against each
 * other.
 *
 * It exists because the two are not comparable and cannot be made so by
 * arithmetic. `abilityPower` is a **fraction** — an item granting `1.4` is
 * +140% ability damage — while `attackDamage` is **points**, and a champion's
 * base is 10 to 17 of them. There is no derivation from one to the other;
 * there is only a decision about what a point of attack damage is worth to an
 * ability, and this is it, in one place, named, so it can be argued with.
 *
 * 0.05 is chosen against the installed pack's own shelf. Its AP items sell
 * about +100% ability damage for 1400 gold; its AD items sell 8 to 18 points
 * for the same, so at this rate a 1400-gold AD item buys roughly +70% on a
 * physical ability. Deliberately less than the AP item buys, because the AD
 * item has already paid out once on every basic attack the holder throws and
 * the AP item has not.
 */
export const ABILITY_SCALING_PER_ATTACK_DAMAGE = 0.05;

/**
 * What this unit's abilities hit for, as a multiplier. `0.35` of ability power
 * is `1.35`, and a unit that has none is exactly `1` — which is every unit in
 * the game until an item or a buff grants some.
 *
 * Floored at zero. `Stats.abilityPower` already floors its own value at -1, but
 * this function is reachable with a hand-built stat block from a pack's tests,
 * and a negative multiplier is the failure `Mitigation.ts` documents at length:
 * an ability suppression strong enough to make casting on the victim *heal*
 * them. A missing or non-finite stat is no amplification, never `NaN`.
 */
export function abilityPowerMultiplier(source: AmplificationSource | undefined): number {
  const value = buildOf(source)?.stats?.abilityPower?.value;
  if (!Number.isFinite(value)) return 1;
  const multiplier = 1 + (value as number);
  return multiplier > 0 ? multiplier : 0;
}

/**
 * The same question for a physical ability, answered by the stat a player
 * buying physical damage actually buys.
 *
 * **Bonus attack damage only.** A champion's base is what it starts the match
 * with and is a property of the champion rather than of anything bought, so
 * counting it would mean an assassin's abilities hit for 75% more than a
 * marksman's on the first frame for no reason either player chose. The bonus
 * is the build, which is the whole thing this module is about.
 *
 * Floored at zero for the reason `abilityPowerMultiplier` documents: an attack
 * damage shred deep enough would otherwise make casting on the victim heal them.
 */
export function physicalPowerMultiplier(source: AmplificationSource | undefined): number {
  const stat = buildOf(source)?.stats?.attackDamage;
  if (!stat || !Number.isFinite(stat.value) || !Number.isFinite(stat.baseValue)) return 1;
  const bonus = stat.value - stat.baseValue;
  const multiplier = 1 + bonus * ABILITY_SCALING_PER_ATTACK_DAMAGE;
  return multiplier > 0 ? multiplier : 0;
}

/**
 * Which build multiplies which kind of damage — the question this module was
 * missing, and the bug it shipped with.
 *
 * Ability power amplified *every* ability regardless of what it dealt, so an
 * item selling magic power made a physical ability hit exactly as much harder
 * as it made a magic one. That was invisible while nothing in either installed
 * pack declared a type, and became a real defect the day all 241 of one pack's
 * damage sites did.
 *
 * **`TRUE` takes the better of the two, and that is a decision rather than an
 * oversight.** True damage carries no resistance to read a stat off, and where
 * this genre's conventions come from it is not a school at all — it is a
 * property attached to abilities that scale on whatever their champion is
 * built around, an executing ultimate on attack damage and a flat threshold on
 * nothing. Picking one stat for all of them would silently zero out a whole
 * class of ultimates for half a roster; taking whichever the caster actually
 * bought never does, and is the only rule here correct without a per-ability
 * table this engine deliberately does not have.
 */
export function abilityMultiplier(
  type: DamageType,
  source: AmplificationSource | undefined
): number {
  if (type === 'PHYSICAL') return physicalPowerMultiplier(source);
  if (type === 'MAGIC') return abilityPowerMultiplier(source);
  return Math.max(abilityPowerMultiplier(source), physicalPowerMultiplier(source));
}

/**
 * The whole question, in one call: what this ability is worth out of this unit.
 *
 * The type defaults to `MAGIC` — `DEFAULT_DAMAGE_TYPE`, the same default
 * `takeDamage` applies — which is also the honest answer for the two callers
 * that pass no type at all. A heal and a shield have no damage type to have,
 * and `abilityPower` is the stat that means "this unit's abilities are more
 * effective"; there is nothing for a restored number to read off attack damage.
 */
export function amplifiedAbilityDamage(
  damage: number,
  source: AmplificationSource | undefined,
  type: DamageType = DEFAULT_DAMAGE_TYPE
): number {
  return damage * abilityMultiplier(type, source);
}

/**
 * A number inside a spell's own description that this caster's build
 * multiplies, as a pack writes it: `<span class="damage">15 sát thương</span>`
 * or `<span class="heal">40 máu</span>`. Non-greedy, so two of them on one
 * line stay two.
 *
 * **Two classes, one claim.** They differ only in the colour the stylesheet
 * paints — a heal printed in the damage red is a heal a player reads as a
 * hit — and both mean exactly "a flat number the engine amplifies". `buff`
 * and `time` make no such claim and are never touched: a 30% slow is 30%
 * however much power you buy, and so is a four-second duration.
 *
 * **The optional second class names the damage type**, and it is a
 * presentation modifier rather than a second claim: `damage physical` is the
 * same promise as `damage`, painted in the colour `DAMAGE_TEXT_COLOR` already
 * gives that type on the floating numbers, so a tooltip and the figure it
 * predicts are the same colour. The three names are spelled out rather than
 * matched with `[a-z]+` on purpose — this regex decides what gets amplified,
 * and a wildcard there would silently enrol whatever class a pack invents next.
 *
 * Widening it was not optional once packs began labelling types: the pattern
 * required the attribute to be exactly `class="damage"`, so the first span
 * written as `class="damage physical"` would have stopped matching and quietly
 * printed its first-frame number for the rest of the match — the precise
 * failure the rest of this comment exists about, reintroduced by a stylesheet.
 *
 * `heal` arrived with the engine half of the same fact. Heals and shields
 * were not amplified at all until `takeHeal` and `buffs/Shield` were wired to
 * the same gate damage goes through, so until then a pack wanting to promise
 * the bonus on a heal had only `damage` to tag it with — which printed the
 * number in red and, worse, promised a scaling that did not happen.
 */
const SCALING_SPAN =
  /(<span class="(?:damage|heal)(?: (physical|magic|true))?">)([\s\S]*?)(<\/span>)/g;

/** The span's own class, back to the type it names. */
const SPAN_TYPE: Record<string, DamageType> = {
  physical: 'PHYSICAL',
  magic: 'MAGIC',
  true: 'TRUE',
};

/**
 * One flat figure: digits that are not a percentage and not the head of a
 * longer number.
 *
 * A percentage is refused outright: `100%` of something is still `100%` of it
 * however much power you buy, and a description that reads "from 40% to 100%
 * of 30 damage" has three numbers in damage spans of which exactly one is a
 * flat figure. The lookahead is the only unit test core can run without
 * knowing what language a pack writes in — everything past the number is a
 * word core has no business reading. Which numbers are damage at all is the
 * pack's to say, by tagging them; see this function's own doc comment.
 *
 * `(?![\d.])` is load-bearing and not a tidy-up. Without it the engine
 * answers a refused `40%` by backtracking `\d+` down to `4`, whose next
 * character is `0` rather than `%` — so the guard passes, and the span that
 * was supposed to be left alone reads `120%`. Pinning the number's own end
 * before testing what follows it is what makes the refusal mean anything.
 */
const FIGURE = String.raw`(\d+(?:\.\d+)?)(?![\d.])(?!\s*%)`;

/**
 * The figure at the front of such a span — **or the range at the front of it**,
 * which is the same claim made about an ability whose damage is not one number.
 *
 * ## The half this used to miss
 *
 * A charged ability writes its two ends: `18–48`, `45–75`, `15 - 30`. Only the
 * leading figure moved, so Rasengan under a finished hat printed
 * `18 (+33.8)–48` — a sentence in which the number a player is actually reading
 * for, the top of the range, is the one still showing its first-frame tuning.
 * The floor was honest and the ceiling was off by the whole build: reported as
 * "description ghi damage 18 (+33.8) - 48 ... nhưng đối phương ăn hơn 100
 * damage", which was the ability working correctly and the tooltip under-
 * reporting it by 90.
 *
 * ## Why a range and not simply every number in the span
 *
 * Because the other numbers in there are not damage. `4 sát thương phép mỗi
 * 0.5 giây` is one flat figure and a period, and a blanket scaler would have
 * amplified the period. A range is recognisable without reading a word of the
 * pack's language: two flat figures with nothing between them but a dash. The
 * second end is held to every rule the first is — a `5 - 10%` is still two
 * percentages, so the optional half simply does not match and the span falls
 * back to its leading figure alone.
 */
const LEADING_NUMBER = new RegExp(`^(\\s*)${FIGURE}(?:(\\s*[–—-]\\s*)${FIGURE})?`);

/** At most one decimal, and no trailing `.0` — `45`, not `45.0`. */
const printable = (value: number): string => (Math.round(value * 10) / 10).toString();

/**
 * `15 (+30)` — the pack's own number, then what this build adds to it.
 *
 * A bare total would answer "what does this hit for" and lose the question a
 * player is usually asking while shopping, which is "what is this item doing
 * for me". Both numbers together answer both, and the base staying visible is
 * also what makes the sentence recognisable as the one the pack wrote.
 *
 * A suppression (a multiplier under 1) prints `15 (-5)` rather than `(+-5)`.
 */
const withBonus = (base: number, multiplier: number): string => {
  const bonus = base * multiplier - base;
  const sign = bonus < 0 ? '-' : '+';
  return `${printable(base)} (${sign}${printable(Math.abs(bonus))})`;
};

/**
 * The same amplification, applied to the number a player *reads* instead of
 * the one they take.
 *
 * A description is authored text with its damage baked in, so the HUD showed
 * a spell's first-frame tuning for the whole match: buy 200% ability power
 * and the bar still promised 15. The arithmetic was right and the only place
 * a player could check it was wrong, which is the worse half — an item that
 * silently works is indistinguishable from an item that silently does not.
 *
 * Printed as `15 (+30)`, not as `45`. The total alone would answer what the
 * spell hits for and lose what the build is contributing, which is the
 * question being asked at the moment somebody is reading item text at all.
 *
 * Only the leading figure of a `damage` span moves — or both ends of the range
 * it leads, for an ability that charges — and only when it is a flat one: a
 * percentage, or a span whose text does not open with a number at all, is left
 * exactly as written rather than guessed at.
 *
 * **`class="damage"` and `class="heal"` are a claim, and it is the pack's to
 * make**: each means "a flat number the engine will multiply by this caster's
 * ability power", and they differ only in what colour it is painted. That is
 * now true of all three funnels — `takeDamage`, `AttackableUnit.takeHeal` and
 * `buffs/Shield` all ask `abilityPowerScales()` and call in here — where for
 * a long time it was true only of the first, and a pack tagging a heal as
 * damage was asking this to lie for it in two ways at once. A duration and a
 * percentage are still not amplified by anything, so `buff` and `time` are
 * still outside this and a number tagged with either is printed as written.
 *
 * **Whose text may be passed in is the caller's question, not this
 * function's.** It rescales whatever it is handed, so the gate belongs where
 * the owner is known: `Spell.effectiveDescription` asks its own
 * `damageScalesWithAbilityPower` first. The population that answers *no* is
 * not hypothetical — `economy/ItemShop` sets it false on every item passive
 * and active, since those already read `attackDamage`. An item description
 * therefore goes to the HUD and the shop card exactly as the pack wrote it,
 * and it did not for one commit: Vĩnh Sương's flat 30 was printed as
 * `30 (+60)`, which is this module's own failure mode aimed the other way.
 *
 * Returns the input unchanged at a multiplier of 1, which is every unit in
 * the game until an item or a buff grants some.
 */
/**
 * A span written by `DamageText`'s helpers: the classes, then the attributes
 * that say what the figure *is* instead of leaving it to be guessed at.
 *
 * `data-flat="none"` is matched here rather than skipped by a separate pass so
 * that a `tint` span is recognised as *deliberately* unscaled — the parser
 * then leaves it alone knowing it was told to, which is a different fact from
 * "I tried and could not", and the difference is the whole subject of
 * `DamageText`'s header.
 */
const AUTHORED_SPAN =
  /(<span class="(?:damage|heal)(?: (physical|magic|true))?"([^>]*)>)([\s\S]*?)(<\/span>)/g;

/**
 * One attribute out of a captured tag.
 *
 * The attributes are read by name rather than matched in a fixed order in the
 * pattern above, and that is not tidiness. A pattern spelling them out in
 * sequence silently stops matching the day one is added or reordered — and
 * "silently stops matching" means the span falls through to the prose parser
 * below, which is the exact failure this whole module was rewritten to end.
 * Twice already a copy of a span pattern anchored to the markup of the day
 * went blind: once here when packs began naming damage types, once in
 * `ai/BotShopper.ts` when they began writing `data-base`.
 */
const attributeOf = (tag: string, name: string): string | undefined =>
  new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];

/**
 * The half of this that needs no guessing.
 *
 * The base arrived as a number and the text in front of it was generated from
 * that same number by `printFigure`, so the prefix to replace is known
 * exactly rather than matched — no lookahead for a `%`, no pinning the end of
 * a number to stop `40%` backtracking into `120%`, and no way for a `+` in
 * front of the digits to make the whole thing quietly do nothing.
 *
 * Returns `null` when the span does not begin with the figure it declared,
 * which is a pack and an engine disagreeing about `printFigure` — reported by
 * `testing/spellRules.ts` rather than silently rendered, because a silent
 * version of this is exactly what the old parser was.
 */
function rescaleAuthored(
  inner: string,
  base: number,
  high: number | undefined,
  multiplier: number
): string | null {
  const lowText = printFigure(base);
  if (!inner.startsWith(lowText)) return null;
  let rest = inner.slice(lowText.length);
  let out = withBonus(base, multiplier);

  if (high !== undefined) {
    // The separator is the pack's own punctuation and is whatever sits
    // between the two printed ends — read, not assumed, so a pack that writes
    // a plain hyphen keeps its hyphen.
    const highText = printFigure(high);
    const at = rest.indexOf(highText);
    if (at === -1) return null;
    out += rest.slice(0, at) + withBonus(high, multiplier);
    rest = rest.slice(at + highText.length);
  }
  return out + rest;
}

export function amplifiedDamageText(
  description: string,
  source: AmplificationSource | undefined
): string {
  // Nothing bought, nothing to say — and both stats have to be asked now,
  // not just ability power, or an attack-damage build reads its own
  // physical abilities at their first-frame numbers for the whole match.
  if (abilityPowerMultiplier(source) === 1 && physicalPowerMultiplier(source) === 1) {
    return description;
  }

  // Each span is scaled by the build that answers *its own* type, so one
  // sentence can print two different bonuses — the correct answer for a
  // hybrid, and impossible before the packs began labelling their spans. An
  // unlabelled span is the engine's default, exactly as a `takeDamage` that
  // names no type is.
  // Spans the helpers wrote, which is every span in a pack built against this
  // core. `data-base` is authoritative and the legacy pass below never sees
  // them, because this one has already consumed them.
  const authored = description.replace(
    AUTHORED_SPAN,
    (whole, open, span, tag, inner, close) => {
      const base = attributeOf(tag, BASE_ATTRIBUTE);
      const high = attributeOf(tag, BASE_HIGH_ATTRIBUTE);
      // `tint`/`pct` say so with `data-flat`; a span with neither attribute is
      // a hand-typed one the legacy pass below still owns. Either way there is
      // nothing to rescale from here.
      if (base === undefined) return whole;
      const multiplier = abilityMultiplier(span ? SPAN_TYPE[span] : DEFAULT_DAMAGE_TYPE, source);
      if (multiplier === 1) return whole;
      const scaled = rescaleAuthored(
        inner,
        Number(base),
        high === undefined ? undefined : Number(high),
        multiplier
      );
      // Rebuilt from the captured tag, never `whole.replace(inner, …)`: a span
      // with no tail has an `inner` of `26` and an attribute reading
      // `data-base="26"`, and a string replace would rewrite the attribute.
      return scaled === null ? whole : open + scaled + close;
    }
  );

  // Everything else: a pack built against a core older than `DamageText`, or a
  // third-party pack that types its spans by hand. The prose-guessing parser
  // is kept for them alone and is not reachable from the packs shipped here —
  // `describeSpellDescriptions` is what holds those to the helpers.
  return authored.replace(SCALING_SPAN, (whole, open, span, inner, close) => {
    if (whole.includes(BASE_ATTRIBUTE) || whole.includes(FLAT_NONE_ATTRIBUTE)) return whole;
    if (!LEADING_NUMBER.test(inner)) return whole;
    const multiplier = abilityMultiplier(span ? SPAN_TYPE[span] : DEFAULT_DAMAGE_TYPE, source);
    if (multiplier === 1) return whole;
    // Both ends of a range carry their own bonus — `18 (+33.8)–48 (+90)`,
    // rather than one parenthetical after the pair. `(+33.8–90)` reads as a
    // subtraction the moment a pack writes its range with a plain hyphen, and
    // the number a player is checking is whichever end they are about to hit
    // for, so each one says what it is worth where it stands.
    const scaled = inner.replace(
      LEADING_NUMBER,
      (_match: string, space: string, low: string, dash: string | undefined, high: string) =>
        space +
        withBonus(Number(low), multiplier) +
        (dash === undefined ? '' : dash + withBonus(Number(high), multiplier))
    );
    return open + scaled + close;
  });
}
