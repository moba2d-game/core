/**
 * The four `PredefinedFilters` that take a list.
 *
 * A filter runs once per candidate per query, and these four used to answer
 * through `list.some(closure)` — a closure built per candidate, called through
 * the `Array.prototype` patch `main.ts` installs. They are plain loops now, and
 * this holds them to the answers the `some` form gave, written out here from
 * the definition rather than by calling the thing under test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PredefinedFilters } from '../../../src/game/managers/ObjectManager';

class Alpha {
  constructor(public teamId: string | undefined) {}
}
class AlphaChild extends Alpha {}
class Beta {
  constructor(public teamId: string | undefined) {}
}

const bodies = [
  new Alpha('blue'),
  new AlphaChild('red'),
  new Beta('blue'),
  new Beta('neutral'),
  new Alpha(undefined),
];
const teamLists = [[], ['blue'], ['red', 'neutral'], ['blue', 'red', 'neutral'], ['nobody']];
const typeLists = [[], [Alpha], [AlphaChild], [Beta], [AlphaChild, Beta], [Alpha, Beta]];

const inTeams = (body: { teamId?: string }, teams: string[]) => {
  let found = false;
  for (const team of teams) if (body.teamId === team) found = true;
  return found;
};
const ofTypes = (body: object, types: (new (...args: never[]) => object)[]) => {
  let found = false;
  for (const type of types) if (body instanceof type) found = true;
  return found;
};

afterEach(() => vi.restoreAllMocks());

describe('list filters', () => {
  it('includeTeamIds / excludeTeamIds answer for every list, the empty one included', () => {
    for (const teams of teamLists) {
      const include = PredefinedFilters.includeTeamIds(teams);
      const exclude = PredefinedFilters.excludeTeamIds(teams);
      for (const body of bodies) {
        expect(include(body as never), `include ${teams} ${body.teamId}`).toBe(
          inTeams(body, teams)
        );
        expect(exclude(body as never), `exclude ${teams} ${body.teamId}`).toBe(
          !inTeams(body, teams)
        );
      }
    }
  });

  it('includeTypes / excludeTypes answer for every list, subclasses included', () => {
    for (const types of typeLists) {
      const include = PredefinedFilters.includeTypes(types as never);
      const exclude = PredefinedFilters.excludeTypes(types as never);
      for (const body of bodies) {
        expect(include(body as never)).toBe(ofTypes(body, types as never));
        expect(exclude(body as never)).toBe(!ofTypes(body, types as never));
      }
    }
  });

  it('read the list as it is when asked, not as it was when built', () => {
    const teams: string[] = [];
    const include = PredefinedFilters.includeTeamIds(teams);
    expect(include(bodies[0] as never)).toBe(false);
    teams.push('blue');
    expect(include(bodies[0] as never)).toBe(true);
  });

  it('do not go through Array.prototype.some to do it', () => {
    const some = vi.spyOn(Array.prototype, 'some');
    const filters = [
      PredefinedFilters.includeTeamIds(['red', 'blue']),
      PredefinedFilters.excludeTeamIds(['red', 'blue']),
      PredefinedFilters.includeTypes([Alpha, Beta] as never),
      PredefinedFilters.excludeTypes([Alpha, Beta] as never),
    ];
    for (const filter of filters) for (const body of bodies) filter(body as never);
    const calls = some.mock.calls.length;
    some.mockRestore();
    expect(calls).toBe(0);
  });
});
