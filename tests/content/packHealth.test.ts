/**
 * The notice a pack problem turns into.
 *
 * The failure this exists for was silent by construction: a republished pack
 * whose old chunk graph 404'd left a champion with an ability that did
 * nothing, and the game carried on as if that were the design. Three places
 * discover it and none of them owns a screen, so they all report here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPackProblem,
  hasPackProblems,
  notePackProblem,
  packHealthDismissed,
  packProblems,
  updatablePackProblems,
  resetPackHealthForTests,
} from '@/content/packHealth';

const RIOT = { id: 'riot', name: 'Riot', manifestUrl: 'https://h/riot/manifest.json' };

beforeEach(() => resetPackHealthForTests());

describe('notePackProblem', () => {
  it('records one', () => {
    notePackProblem({ ...RIOT, kind: 'update' });
    expect(packProblems.value).toEqual([{ ...RIOT, kind: 'update', missingSpells: undefined }]);
  });

  it('does not list the same pack twice', () => {
    notePackProblem({ ...RIOT, kind: 'update' });
    notePackProblem({ ...RIOT, kind: 'update' });
    expect(packProblems.value).toHaveLength(1);
  });

  it('keeps two different packs apart', () => {
    notePackProblem({ ...RIOT, kind: 'update' });
    notePackProblem({
      id: 'other',
      name: 'Other',
      manifestUrl: 'https://h/other/manifest.json',
      kind: 'broken',
    });
    expect(packProblems.value).toHaveLength(2);
  });

  /**
   * The ordering rule. "There is a newer build" and "this build cannot be
   * completed" can both be true of one pack, and the second is strictly worse
   * news — a later `update` report must not talk the notice back down.
   */
  it('lets broken replace update', () => {
    notePackProblem({ ...RIOT, kind: 'update' });
    notePackProblem({ ...RIOT, kind: 'broken', missingSpells: 3 });
    expect(packProblems.value[0].kind).toBe('broken');
  });

  it('does not let update replace broken', () => {
    notePackProblem({ ...RIOT, kind: 'broken', missingSpells: 3 });
    notePackProblem({ ...RIOT, kind: 'update' });
    expect(packProblems.value[0].kind).toBe('broken');
    expect(packProblems.value[0].missingSpells).toBe(3);
  });

  it('keeps a spell count a later report cannot supply', () => {
    notePackProblem({ ...RIOT, kind: 'broken', missingSpells: 3 });
    notePackProblem({ ...RIOT, kind: 'broken' });
    expect(packProblems.value[0].missingSpells).toBe(3);
  });

  /**
   * Dismissing "there is an update" is not dismissing "your pack is broken".
   * The player answered a different question.
   */
  it('un-dismisses, because a new problem is new news', () => {
    notePackProblem({ ...RIOT, kind: 'update' });
    packHealthDismissed.value = true;
    expect(hasPackProblems()).toBe(false);

    notePackProblem({ ...RIOT, kind: 'broken', missingSpells: 1 });
    expect(hasPackProblems()).toBe(true);
  });
});

describe('hasPackProblems', () => {
  it('is false with nothing recorded', () => {
    expect(hasPackProblems()).toBe(false);
  });

  it('is false once dismissed, without forgetting the problem', () => {
    notePackProblem({ ...RIOT, kind: 'update' });
    packHealthDismissed.value = true;
    expect(hasPackProblems()).toBe(false);
    expect(packProblems.value).toHaveLength(1);
  });
});

describe('clearPackProblem', () => {
  it('drops one pack and leaves the rest', () => {
    notePackProblem({ ...RIOT, kind: 'update' });
    notePackProblem({
      id: 'other',
      name: 'Other',
      manifestUrl: 'https://h/other/manifest.json',
      kind: 'update',
    });
    clearPackProblem(RIOT.manifestUrl);
    expect(packProblems.value.map(p => p.id)).toEqual(['other']);
  });
});

/**
 * **One press has to settle every pack that has an update waiting.**
 *
 * The menu read `packProblems[0]` and updated that one, then reloaded — so a
 * player with three stale packs answered the same notice three times, watched
 * the page reload between each, and only learned there was another one after
 * the reload. Nothing was wrong with this queue; the screen was reading one
 * entry out of it. `updatablePackProblems` is the list it should have read.
 */
describe('every pack a single press should settle', () => {
  beforeEach(() => resetPackHealthForTests());

  it('is every problem whose fix is fetching the newest build', () => {
    notePackProblem({ ...RIOT, kind: 'update' });
    notePackProblem({ id: 'dota', name: 'Dota', manifestUrl: 'https://d/m.json', kind: 'update' });
    notePackProblem({
      id: 'naruto',
      name: 'Naruto',
      manifestUrl: 'https://n/m.json',
      kind: 'broken',
    });

    expect(updatablePackProblems().map(problem => problem.id)).toEqual([
      RIOT.id,
      'dota',
      'naruto',
    ]);
  });

  /** A dev pack has no pin to replace: `updatePack` would put one back. */
  it('leaves a dev rebuild out — its fix is a reload, not a fetch', () => {
    notePackProblem({ ...RIOT, kind: 'update' });
    notePackProblem({
      id: 'mine',
      name: 'Mine',
      manifestUrl: 'http://localhost:5174/manifest.json',
      kind: 'dev-changed',
    });

    expect(updatablePackProblems().map(problem => problem.id)).toEqual([RIOT.id]);
  });

  /**
   * The caller `await`s its way down this list while every success calls
   * `clearPackProblem`, which rewrites `packProblems` underneath it.
   */
  it('hands back a copy, so clearing one entry cannot shorten a walk in progress', () => {
    notePackProblem({ ...RIOT, kind: 'update' });
    notePackProblem({ id: 'dota', name: 'Dota', manifestUrl: 'https://d/m.json', kind: 'update' });

    const targets = updatablePackProblems();
    clearPackProblem(RIOT.manifestUrl);

    expect(targets).toHaveLength(2);
    expect(packProblems.value).toHaveLength(1);
  });

  it('is empty when nothing is wrong', () => {
    expect(updatablePackProblems()).toEqual([]);
  });
});
