/**
 * What is wrong with an installed pack, kept where every screen can read it.
 *
 * The bug this exists for had no voice at all. A player installed a pack, the
 * pack was republished under new content hashes, and the chunk the installed
 * build named 404'd — so one champion's Q silently became a basic attack. The
 * game did not stop, did not warn, and did not look broken; it looked like a
 * champion whose ability does nothing. The only evidence was a red line in a
 * console a player has no reason to open, and even then only a developer could
 * read what it meant.
 *
 * Three different places discover this and none of them owns a screen:
 * `runtimePacks.ts` (the update check, and a prefetch that 404s),
 * `GameScene.startGame` (a kit that would not load). They all report here, and
 * the menu renders it.
 *
 * A plain `.ts` module rather than component state, for the same reason
 * `pwa/updates.ts` and `packBanner.ts` are: `MenuScene` mounts on every entry
 * and unmounts on every exit, so anything held in its `<script setup>` is
 * rebuilt each time the player comes back from the pregame screen — including
 * a dismissal, which would make the notice reappear, and including the notice
 * itself, which nothing would ever set a second time.
 *
 * Dependency-free apart from `vue`. `MenuScene`'s chunk may not statically
 * reach the match chunk (`scripts/check-chunks.mjs`) and both ends import
 * this.
 */
import { ref } from 'vue';

/** Why a pack needs the player's attention. */
export type PackProblemKind =
  /**
   * The host is serving a different build than the one installed. Noticed by
   * comparing `buildId`, and by itself only means "there is something newer" —
   * the installed copy is pinned and still works.
   */
  | 'update'
  /**
   * A pack served from the author's own machine has been rebuilt since this
   * page loaded. Not a fault and not an offer to update — there is no pin to
   * replace (see `devPack.ts`), only a page holding the previous build. The
   * action is a reload, and `devPackWatch.ts` is what notices.
   */
  | 'dev-changed'
  /**
   * The installed build is *gone from the host* and this copy is incomplete,
   * so the missing part can never be fetched. Proven, not guessed: either a
   * file the manifest listed came back 404, or a spell this match needed
   * failed to load. This is the one that is actually broken.
   */
  | 'broken';

export interface PackProblem {
  readonly id: string;
  readonly name: string;
  readonly manifestUrl: string;
  readonly kind: PackProblemKind;
  /** How many spells could not be loaded, when that is how it was found. */
  readonly missingSpells?: number;
}

/**
 * The problems worth showing. Read directly in templates, the way
 * `packBanner.ts`'s and `pwa/updates.ts`'s refs are.
 */
export const packProblems = ref<PackProblem[]>([]);

/** Set once the player has actively dismissed the notice. Never set by a timer. */
export const packHealthDismissed = ref(false);

/**
 * Records one problem, or upgrades an existing one.
 *
 * **`broken` outranks `update`, and never the other way round.** A pack can be
 * found stale by the update check (there is a newer build; this one still
 * plays) and *also* found broken by a 404 (this one cannot be completed). The
 * second is strictly worse news about the same pack, and a second `update`
 * report arriving afterwards must not talk the notice back down to it.
 */
export function notePackProblem(problem: PackProblem): void {
  const next: PackProblem[] = [];
  let merged = false;
  for (const existing of packProblems.value) {
    if (existing.manifestUrl !== problem.manifestUrl) {
      next.push(existing);
      continue;
    }
    merged = true;
    if (existing.kind === 'broken' && problem.kind !== 'broken') {
      next.push(existing);
    } else {
      next.push({
        ...problem,
        // Keep whichever count we have. A `broken` found by the update check's
        // 404 carries no spell count; one found by a kit load does, and losing
        // it would make the notice vaguer than it needs to be.
        missingSpells: problem.missingSpells ?? existing.missingSpells,
      });
    }
  }
  if (!merged) next.push(problem);
  packProblems.value = next;

  // A new problem is new news. A player who dismissed the "there is an update"
  // notice has not thereby dismissed "your pack is broken".
  packHealthDismissed.value = false;
}

/** Whether anything is worth putting in front of the player right now. */
export const hasPackProblems = (): boolean =>
  packProblems.value.length > 0 && !packHealthDismissed.value;

/**
 * Every problem whose fix is **fetching the newest build**, which is the list
 * one press of Cập nhật should settle.
 *
 * The menu used to read `packProblems[0]` and update that one pack, then
 * reload — so a player with three stale packs answered the same notice three
 * times, watching the page reload between each, and only found out there was
 * another one after the reload. Reported exactly that way. Nothing was wrong
 * with the queue; the screen was reading one entry out of it.
 *
 * `dev-changed` is excluded and that is the whole reason this is a function
 * rather than a length: a dev pack has no pin to replace (`devPack.ts`), and
 * `updatePack` would put back the very pin boot refused to write. Its fix is a
 * reload, which the menu still offers on its own.
 *
 * A plain loop rather than `.filter`, per CLAUDE.md, and it hands back a copy:
 * the caller is about to `await` its way down the list while `clearPackProblem`
 * rewrites `packProblems` under it after every success.
 */
export const updatablePackProblems = (): PackProblem[] => {
  const out: PackProblem[] = [];
  for (const problem of packProblems.value) {
    if (problem.kind !== 'dev-changed') out.push(problem);
  }
  return out;
};

/** Test seam, and what a completed update calls once the pack is replaced. */
export function clearPackProblem(manifestUrl: string): void {
  const next: PackProblem[] = [];
  for (const existing of packProblems.value) {
    if (existing.manifestUrl !== manifestUrl) next.push(existing);
  }
  packProblems.value = next;
}

/** Test seam: forget everything, so a case can observe a report from empty. */
export function resetPackHealthForTests(): void {
  packProblems.value = [];
  packHealthDismissed.value = false;
}
