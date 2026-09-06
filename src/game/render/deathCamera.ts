/**
 * Where the camera goes while the player is dead.
 *
 * ## The problem
 *
 * Champion respawn is five seconds on a map that says nothing and up to a
 * minute on one with a revive curve, and for all of it the camera used to sit
 * on the corpse: `Game` set `camera.target = player.position` once at boot
 * and nothing ever moved it. The dead player watched an empty patch of lane
 * with a countdown on it — the one stretch of a match with nothing to do,
 * spent looking at the one place where nothing is happening.
 *
 * ## The answer
 *
 * After a short linger — long enough for the death shake and the recap to
 * land, so the cut does not eat the moment of dying — the camera goes to a
 * living ally: the one in a fight if any is, else the nearest. It stays on
 * them until they die too, or the player asks for the next one (the HUD's
 * spectate pill, `HudInteractions.spectateNext`), and it comes back the tick
 * the player is alive again. The world under it is desaturated by the HUD
 * (`#game-scene.dead-view`), so a grey screen and a coloured pill say
 * "watching" without a word.
 *
 * ## Pure, and why
 *
 * This file knows nothing of `Game`, `Camera` or `Champion`: it is a small
 * state machine over a context of five functions, generic in what an "ally"
 * is. `Game` wires it (`Game.deathCamera`) and the tests drive it with plain
 * objects — the same shape `combat/Announcer.ts` takes, and for the same
 * reason: there is no headless `Game` to construct in a unit test.
 *
 * The free camera is respected. Space toggles `camera.target` to null and a
 * player who did that before dying asked for the camera to stay put; the
 * `follow` callback `Game` supplies checks for it, and this class never
 * knows.
 */

/** How long the corpse stays on screen before the camera leaves it. */
export const DEATH_CAMERA_LINGER_MS = 1500;

/** How recently an ally must have hit or been hit to count as "in a fight". */
export const SPECTATE_COMBAT_WINDOW_MS = 4000;

export interface SpectateCandidate<T> {
  readonly unit: T;
  readonly x: number;
  readonly y: number;
  readonly alive: boolean;
  /** Match time of the unit's last exchange of damage, `-Infinity` for never. */
  readonly lastCombatMs: number;
}

export interface DeathCameraContext<T> {
  /** Whether the player is dead this tick. */
  isDead(): boolean;
  /** Where the player died — the point "nearest" is measured from. */
  deathPoint(): { x: number; y: number };
  /** Every allied champion, in roster order, dead ones included. */
  allies(): readonly SpectateCandidate<T>[];
  nowMs(): number;
  /** Point the camera at `target`, or at the player again for `null`. */
  follow(target: T | null): void;
}

/**
 * Who to watch: a living ally in a fight — the most recent fight wins — or,
 * with nobody fighting, the living ally nearest the death. Null when every
 * ally is dead or there are none, which is the solo player's whole match.
 */
export function pickSpectateTarget<T>(
  candidates: readonly SpectateCandidate<T>[],
  from: { x: number; y: number },
  nowMs: number
): T | null {
  let fighting: SpectateCandidate<T> | null = null;
  let nearest: SpectateCandidate<T> | null = null;
  let nearestD2 = Infinity;
  for (const candidate of candidates) {
    if (!candidate.alive) continue;
    if (nowMs - candidate.lastCombatMs <= SPECTATE_COMBAT_WINDOW_MS) {
      if (!fighting || candidate.lastCombatMs > fighting.lastCombatMs) fighting = candidate;
    }
    const dx = candidate.x - from.x;
    const dy = candidate.y - from.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < nearestD2) {
      nearestD2 = d2;
      nearest = candidate;
    }
  }
  return (fighting ?? nearest)?.unit ?? null;
}

/**
 * The living ally after `current` in roster order, wrapping; the first living
 * one when `current` is not among them. Roster order rather than distance so
 * repeated presses visit everyone once instead of bouncing between the two
 * nearest.
 */
export function nextSpectateTarget<T>(
  candidates: readonly SpectateCandidate<T>[],
  current: T | null
): T | null {
  const living = candidates.filter(candidate => candidate.alive);
  if (living.length === 0) return null;
  const at = living.findIndex(candidate => candidate.unit === current);
  return living[(at + 1) % living.length].unit;
}

export class DeathCamera<T> {
  /** The ally on screen, or null while on the corpse / alive. */
  watching: T | null = null;
  private deathAtMs: number | null = null;

  constructor(private readonly context: DeathCameraContext<T>) {}

  /** Once per simulation tick, before the camera lerps. */
  tick(): void {
    const now = this.context.nowMs();
    if (!this.context.isDead()) {
      if (this.deathAtMs !== null) this.release();
      return;
    }
    if (this.deathAtMs === null) this.deathAtMs = now;
    // A rewound match can pull `now` behind the stamp, and a stamp from the
    // erased future would hold the camera on the corpse for the whole gap.
    if (this.deathAtMs > now) this.deathAtMs = now;
    if (now - this.deathAtMs < DEATH_CAMERA_LINGER_MS) return;

    const allies = this.context.allies();
    if (this.watching !== null && allies.some(a => a.unit === this.watching && a.alive)) return;
    this.aim(pickSpectateTarget(allies, this.context.deathPoint(), now));
  }

  /**
   * The player's own press: the next living ally. A no-op while alive, and
   * during the linger — pressing it early is asking to skip the linger,
   * which is granted by aiming straight away.
   */
  next(): void {
    if (!this.context.isDead()) return;
    if (this.deathAtMs === null) this.deathAtMs = this.context.nowMs() - DEATH_CAMERA_LINGER_MS;
    this.aim(nextSpectateTarget(this.context.allies(), this.watching));
  }

  private aim(target: T | null): void {
    // Nobody left to watch and nobody being watched: leave the corpse on
    // screen rather than "follow null", which would be a pointless snap.
    if (target === null && this.watching === null) return;
    this.watching = target;
    this.context.follow(target);
  }

  private release(): void {
    this.deathAtMs = null;
    if (this.watching === null) return;
    this.watching = null;
    this.context.follow(null);
  }
}
