import {
  ZONE_DAMAGE_LABEL,
  ZONE_PULSE_MS,
  isOutsideZone,
  zoneAt,
  zoneCircles,
  zoneDps,
  zoneResult,
  type Fighter,
  type ZoneCircle,
  type ZoneResult,
  type ZoneState,
} from './zoneRules';

/** What the zone needs of a unit: where it is and how to hurt it. */
export interface ZoneVictim {
  position: { x: number; y: number };
  isDead: boolean;
  takeDamage: (amount: number, owner: undefined, type: 'TRUE', label: string) => void;
}

/**
 * The zone of one match: owns the schedule, the damage pulse and the verdict.
 * Held by `Game` only in the `zone` mode; the engine is not consulted here, so
 * it unit-tests under plain Vitest.
 */
export default class ZoneController {
  readonly circles: ZoneCircle[];
  result: ZoneResult = null;
  private pulseMs = 0;

  constructor(mapSize: number, seed: number) {
    this.circles = zoneCircles(mapSize, seed);
  }

  state(timeMs: number): ZoneState {
    return zoneAt(this.circles, timeMs);
  }

  /**
   * One simulation step. `victims` are everything the zone hurts; `champions`
   * decide the winner. Nothing happens once the match has a result.
   */
  tick(
    stepMs: number,
    timeMs: number,
    victims: Iterable<ZoneVictim>,
    champions: readonly Fighter[]
  ): void {
    if (this.result) return;
    this.pulseMs += stepMs;
    if (this.pulseMs >= ZONE_PULSE_MS) {
      this.pulseMs -= ZONE_PULSE_MS;
      const { current, stage } = this.state(timeMs);
      const amount = (zoneDps(stage) * ZONE_PULSE_MS) / 1000;
      for (const unit of victims) {
        if (unit.isDead || !isOutsideZone(unit.position, current)) continue;
        unit.takeDamage(amount, undefined, 'TRUE', ZONE_DAMAGE_LABEL);
      }
    }
    this.result = zoneResult(champions);
  }
}
