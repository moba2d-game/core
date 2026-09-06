/**
 * Where a frame goes on a machine that is struggling.
 *
 * Builds a crowded board out of the live spawner, throttles the CPU the way a
 * cheap laptop is throttled, and then *measures* — per subsystem and per object
 * class — how many milliseconds each frame actually spends. Nothing here is a
 * guess: every row is a wrapped function timing itself.
 *
 * ## Self time, not total
 *
 * The first version of this used an outermost-wins depth guard, which is the
 * obvious way to stop a `super()` call being counted twice — and it made every
 * nested row *vanish*: `fog.draw` swallowed `calculateSight` whole, and every
 * per-object draw disappeared inside `objectManager.draw`. So each wrapper
 * keeps a stack frame and subtracts the time its children claimed. `selfMs` is
 * what that row itself cost; `totalMs` is what it cost with everything it
 * called. Sort on the first, read the second to see where it went.
 *
 * ## What it found
 *
 * At 10x throttle with 200 minions, an 8.0ms frame: fog 4.3ms of it (half
 * painting the sight polygons, half recomputing them), the minimap 0.8ms
 * redrawing every dot every frame, and two Fountains 0.43ms retracing eight
 * `arc()` paths each. Those three are what `FOG_SIGHT_TICK_INTERVAL`,
 * `MINIMAP_LIVE_INTERVAL_MS` and `Fountain.bakeArt` were written for.
 *
 *   node tests/e2e/measure-frame-cost.mjs
 *   MOBA2D_CPU_THROTTLE=6 MOBA2D_TARGET_MINIONS=150 node tests/e2e/measure-frame-cost.mjs
 */
import { CFG_KEY, PHONE_VIEWPORT, startHarness, startMatch } from './harness.mjs';

const THROTTLE = Number(process.env.MOBA2D_CPU_THROTTLE ?? 10);
const TARGET_MINIONS = Number(process.env.MOBA2D_TARGET_MINIONS ?? 200);
const WINDOW_MS = Number(process.env.MOBA2D_WINDOW_MS ?? 6_000);
/**
 * Bots to field, and the difference between the two loads this script can
 * measure.
 *
 * Zero — the default — leaves the roster alone and measures the *crowd*: two
 * hundred minions walking lanes, which is what found the fog, the minimap and
 * the fountains. Any other number seeds the pregame config with that many bots
 * set to move, attack and cast for free, drags every champion on the map into
 * one pile, and measures a **teamfight** instead: ten champions inside one
 * screen, casting on cooldown, with the spell objects, the floating numbers and
 * the buff art that come with that. They are different profiles and they find
 * different things — a minion is a body, a champion is a body plus a kit.
 *
 *   MOBA2D_BOTS=9 node tests/e2e/measure-frame-cost.mjs
 */
const BOTS = Number(process.env.MOBA2D_BOTS ?? 0);

/**
 * Measure the phone's frame, not the desktop's.
 *
 * `MOBA2D_MOBILE=1` runs a phone viewport with the touch controls and
 * `deviceScaleFactor: 3` — which is the whole point, because a phone rasterises
 * roughly **nine times the pixels** of the same layout at 1x. Every run this
 * script had ever done was desktop at 1x, so the one cost it could not see was
 * the one that scales with pixels rather than with calls: translucent fills,
 * the fog's composites, anything painted over a large area. A row's `usPerCall`
 * barely moves for those and the frame doubles anyway.
 *
 * It is not a phone's GPU — it is this machine's, drawing a phone's pixel
 * count. That makes it a *ratio* instrument: run it against the desktop number
 * and read the multiplier, never the absolute ms.
 *
 *   MOBA2D_MOBILE=1 MOBA2D_BOTS=6 node tests/e2e/measure-frame-cost.mjs
 */
const MOBILE = process.env.MOBA2D_MOBILE === '1';

const { url, page, report, check, guard } = await startHarness(
  MOBILE
    ? { viewport: PHONE_VIEWPORT, hasTouch: true, touch: true, deviceScaleFactor: 3 }
    : {}
);

await guard(async () => {
  if (BOTS > 0) {
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(
      ([key, config]) => localStorage.setItem(key, JSON.stringify(config)),
      [
        CFG_KEY,
        {
          ai: {
            count: BOTS,
            autoMove: true,
            autoAttack: true,
            autoCast: true,
            // `autoBuy` is **on by default in a real match** (`PregameConfig`'s
            // `DEFAULT_BOT_BEHAVIOUR`) and this script never set it, so every
            // teamfight it has ever measured was fought by naked champions.
            // A built champion is a different load: six item passives each with
            // their own buff, art and periodic area query, times the roster.
            // Set `MOBA2D_BOT_BUY=0` to measure the old naked fight.
            autoBuy: process.env.MOBA2D_BOT_BUY !== '0',
            bots: [],
          },
          rules: { manaFree: true },
        },
      ]
    );
  }
  await page.goto(url, { waitUntil: 'load' });
  await startMatch(page);
  await page.waitForFunction(() => window.__moba2d?.scene?.oScene?.game?.objectManager, null, {
    timeout: 30_000,
  });
  // At least one real wave out of each fountain, so there is a (team, lane)
  // pair to spawn the rest of the crowd on.
  await page.waitForFunction(
    () => window.__moba2d.scene.oScene.game.minionSpawner.minions.length >= 6,
    null,
    { timeout: 20_000 }
  );

  const cdp = await page.context().newCDPSession(page);
  if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

  const result = await page.evaluate(
    async ({ targetMinions, windowMs, bots }) => {
      const game = window.__moba2d.scene.oScene.game;
      const manager = game.objectManager;
      const spawner = game.minionSpawner;
      const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

      // ------------------------------------------------------------ the board
      const pairs = [];
      const seen = new Set();
      for (const minion of spawner.minions) {
        const key = minion.teamId + '|' + minion.lane;
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push({ teamId: minion.teamId, lane: minion.lane });
        }
      }
      let attempts = 0;
      while (spawner.minions.length < targetMinions && attempts < targetMinions * 3) {
        const pair = pairs[attempts % pairs.length];
        spawner.spawn({
          teamId: pair.teamId,
          lane: pair.lane,
          kind: attempts % 3 === 0 ? 'caster' : 'melee',
        });
        attempts++;
      }
      // Health pinned so the crowd cannot thin out mid-window and make two
      // runs incomparable for a reason that has nothing to do with the code.
      for (const minion of spawner.minions) {
        minion.stats.maxHealth.baseValue = 1e9;
        minion.stats.health.baseValue = 1e9;
      }

      // Every champion on the map, in one pile around the player, with health
      // they cannot burn through — so the window measures a fight that is still
      // going at the end of it rather than a field of corpses. The pile is
      // loose (a ring, not a point) because `UnitCollisionSystem` would spend
      // the whole window pushing a stack of co-located bodies apart, and that
      // is a measurement of the setup rather than of the game.
      if (bots > 0) {
        const champions = manager.objects.filter(o => o.killCredit === 'champion');
        const anchor = game.player?.position ?? champions[0]?.position;
        champions.forEach((champion, i) => {
          const angle = (i / champions.length) * Math.PI * 2;
          champion.position.x = anchor.x + Math.cos(angle) * 160;
          champion.position.y = anchor.y + Math.sin(angle) * 160;
          champion.stats.maxHealth.baseValue = 1e9;
          champion.stats.health.baseValue = 1e9;
        });
        // Long enough for the kits to be *running* before anything is wrapped:
        // a spell object that does not exist yet has no prototype to time, and
        // the classes this load exists to measure — the missiles, the floating
        // numbers, the buff art — all arrive on a cast.
        await settle(2_500);
      }

      // ----------------------------------------------------------- the timers
      const buckets = new Map();
      const bucketFor = name => {
        let bucket = buckets.get(name);
        if (!bucket) {
          bucket = { calls: 0, total: 0, self: 0 };
          buckets.set(name, bucket);
        }
        return bucket;
      };
      const restores = [];
      const stack = [];
      const enter = () => {
        const frame = { child: 0 };
        stack.push(frame);
        return frame;
      };
      const leave = (frame, startedAt, name) => {
        const elapsed = performance.now() - startedAt;
        stack.pop();
        if (stack.length) stack[stack.length - 1].child += elapsed;
        const bucket = bucketFor(name);
        bucket.calls++;
        bucket.total += elapsed;
        bucket.self += elapsed - frame.child;
      };

      /**
       * Wrap `owner[key]`, charging it to `name` or to the receiver's class.
       *
       * The call is not guarded, the same choice `ObjectManager.draw` makes and
       * for a stronger reason here: a throw out of a wrapped frame has already
       * invalidated the measurement, and the harness fails the run on the page
       * error either way. `tests/scripts/e2eHarness.test.ts` also refuses a
       * hand-rolled guard block anywhere in a driver, because that is the shape
       * that used to let a script exit 0 after running a prefix of its checks.
       */
      const wrap = (owner, key, name) => {
        const real = owner?.[key];
        if (typeof real !== 'function' || real.__profiled) return;
        const wrapped = function (...args) {
          const frame = enter();
          const startedAt = performance.now();
          const out = real.apply(this, args);
          leave(frame, startedAt, name ?? this?.constructor?.name ?? 'unknown');
          return out;
        };
        wrapped.__profiled = true;
        owner[key] = wrapped;
        restores.push(() => {
          owner[key] = real;
        });
      };

      // The whole frame and the whole tick, above the stack so nothing inside
      // them is subtracted from these two.
      let frames = 0;
      let ticks = 0;
      let drawMs = 0;
      let updateMs = 0;
      /**
       * Every frame's wall-clock gap, because **an average cannot see a hitch**
       * and a hitch is what a player reports.
       *
       * This script computed `frames * 1000 / wall` and nothing else, so a run
       * that held 60 on average while dropping to 15 four times a second read
       * as perfectly healthy — which is exactly the shape of the complaint it
       * was first pointed at. `worstFps` and `p95Fps` below are the numbers to
       * argue with; the average is the one that was always fine.
       */
      const gaps = [];
      let lastFrameAt = 0;
      const gameProto = Object.getPrototypeOf(game);
      const realDraw = gameProto.draw;
      const realTick = gameProto.fixedUpdate;
      gameProto.draw = function (...args) {
        const startedAt = performance.now();
        const out = realDraw.apply(this, args);
        frames++;
        drawMs += performance.now() - startedAt;
        // The gap between presented frames, not the cost of this one: a stall
        // in anything else sharing the thread is invisible to `drawMs` and is
        // felt.
        if (lastFrameAt > 0) gaps.push(startedAt - lastFrameAt);
        lastFrameAt = startedAt;
        return out;
      };
      gameProto.fixedUpdate = function (...args) {
        const startedAt = performance.now();
        const out = realTick.apply(this, args);
        ticks++;
        updateMs += performance.now() - startedAt;
        return out;
      };
      restores.push(() => {
        gameProto.draw = realDraw;
        gameProto.fixedUpdate = realTick;
      });

      const proto = value => Object.getPrototypeOf(value);
      wrap(proto(manager), 'draw', 'draw/objectManager');
      wrap(proto(manager), 'update', 'update/objectManager');
      wrap(proto(manager), 'queryObjects', 'om/queryObjects');
      wrap(proto(game.terrainMap), 'draw', 'draw/terrain');
      wrap(proto(game.terrainMap), 'update', 'update/terrain');
      wrap(proto(game.terrainMap), 'getObstaclesInArea', 'terrain/getObstaclesInArea');
      wrap(proto(game.fogOfWar), 'draw', 'draw/fog');
      wrap(proto(game.fogOfWar), 'calculateSight', 'fog/calculateSight');
      wrap(proto(game.fogOfWar), 'drawVisions', 'fog/drawVisions');
      wrap(proto(game.fogOfWar), 'getSightPoly', 'fog/getSightPoly');
      wrap(proto(game.fogOfWar), 'computeSightPoly', 'fog/computeSightPoly');
      wrap(proto(game.minimap), 'draw', 'draw/minimap');
      wrap(proto(game.minimap), 'paintLiveLayer', 'minimap/paintLiveLayer');
      wrap(proto(game), 'minimapBlips', 'minimap/blips');
      wrap(proto(game.navigation), 'update', 'update/navigation');
      wrap(proto(spawner), 'update', 'update/minionSpawner');
      wrap(proto(manager.unitCollision), 'resolve', 'update/unitCollision');
      if (game.inGameHUD) wrap(proto(game.inGameHUD), 'update', 'hud/computeState');

      // Both quadtrees, split by which one was asked.
      const treeProto = proto(manager._objectsTree);
      const realRetrieve = treeProto.retrieve;
      treeProto.retrieve = function (...args) {
        const name =
          this === manager._objectsTree
            ? 'qt/objectsTree'
            : this === manager._decorTree
              ? 'qt/decorTree'
              : 'qt/other';
        const frame = enter();
        const startedAt = performance.now();
        const out = realRetrieve.apply(this, args);
        leave(frame, startedAt, name);
        return out;
      };
      restores.push(() => {
        treeProto.retrieve = realRetrieve;
      });

      // Per-class draw/update, resolved off the live objects. One wrap per
      // distinct function, bucketed by the receiver — so an inherited
      // `AttackableUnit.draw` still reports Minion and Champion separately.
      const wrapped = new Set();
      const wrapMember = (object, key, prefix) => {
        let owner = Object.getPrototypeOf(object);
        while (owner && !Object.prototype.hasOwnProperty.call(owner, key)) {
          owner = Object.getPrototypeOf(owner);
        }
        const real = owner?.[key];
        if (typeof real !== 'function' || wrapped.has(real) || real.__profiled) return;
        wrapped.add(real);
        const fn = function (...args) {
          const frame = enter();
          const startedAt = performance.now();
          const out = real.apply(this, args);
          leave(frame, startedAt, prefix + (this?.constructor?.name ?? '?'));
          return out;
        };
        fn.__profiled = true;
        owner[key] = fn;
        restores.push(() => {
          owner[key] = real;
        });
      };
      for (const object of [...manager.objects]) {
        wrapMember(object, 'draw', 'obj.draw/');
        wrapMember(object, 'update', 'obj.update/');
      }

      /**
       * Inside a body's own draw, bucketed by *method* rather than by class.
       *
       * `obj.draw/AIChampion` is the biggest row a teamfight produces and it is
       * five different jobs — the portrait, the facing line, the buff art, the
       * bar, the numbers over the bar — so on its own it says only that bodies
       * are expensive. One bucket per job says which one, across every class
       * that has bodies, which is the question. Subclasses override some of
       * these (`Minion` and `Monster` both paint their own `drawBody`), so this
       * walks the chain per object the way `wrapMember` does and pours every
       * override into the one bucket.
       */
      const wrapNamed = (object, key, name) => {
        let owner = Object.getPrototypeOf(object);
        while (owner && !Object.prototype.hasOwnProperty.call(owner, key)) {
          owner = Object.getPrototypeOf(owner);
        }
        const real = owner?.[key];
        if (typeof real !== 'function' || wrapped.has(real) || real.__profiled) return;
        wrapped.add(real);
        const fn = function (...args) {
          const frame = enter();
          const startedAt = performance.now();
          const out = real.apply(this, args);
          // Bucketed by the receiver's class as well as the job, because most
          // of these are overridden: a lean bar and a bar carrying a name, a
          // level and six buff icons are the same method name and nothing
          // alike, and one bucket for both says only that bars are expensive.
          leave(frame, startedAt, name + '/' + (this?.constructor?.name ?? '?'));
          return out;
        };
        fn.__profiled = true;
        owner[key] = fn;
        restores.push(() => {
          owner[key] = real;
        });
      };
      // Every buff class that is currently drawing on anybody, by class. A
      // buff's world art is per-instance and per-frame, and a fight puts the
      // same buff on every body in a wave at once — so "buffs are expensive"
      // needs to name one before it can be acted on.
      for (const object of [...manager.objects]) {
        if (!Array.isArray(object.buffs)) continue;
        for (const buff of object.buffs) wrapNamed(buff, 'draw', 'buff.draw');
      }

      for (const object of [...manager.objects]) {
        if (typeof object.drawHealthBar !== 'function') continue;
        wrapNamed(object, 'drawAvatar', 'unit/drawAvatar');
        wrapNamed(object, 'drawBody', 'unit/drawBody');
        wrapNamed(object, 'drawDir', 'unit/drawDir');
        wrapNamed(object, 'drawBuffs', 'unit/drawBuffs');
        wrapNamed(object, 'drawHealthBar', 'unit/drawHealthBar');
      }

      // ---------------------------------------------------------- the window
      await settle(500);
      frames = 0;
      ticks = 0;
      drawMs = 0;
      updateMs = 0;
      gaps.length = 0;
      lastFrameAt = 0;
      for (const bucket of buckets.values()) {
        bucket.calls = 0;
        bucket.total = 0;
        bucket.self = 0;
      }
      stack.length = 0;

      const startedAt = performance.now();
      await settle(windowMs);
      const wall = performance.now() - startedAt;

      for (const restore of restores.reverse()) restore();

      const census = {};
      for (const object of manager.objects) {
        const name = object.constructor?.name ?? '?';
        census[name] = (census[name] ?? 0) + 1;
      }

      // What is actually riding the bodies, and how much of it *paints*.
      // `Buff.prototype.draw` is empty, so a buff with no art of its own costs
      // one call and nothing else — the difference between "minions carry
      // buffs" and "minions carry buffs that draw" is the whole question, and
      // a class name in the row above cannot answer it.
      const buffCensus = {};
      const emptyDraw = Object.getPrototypeOf(Object.getPrototypeOf({})) && null;
      for (const object of manager.objects) {
        if (!Array.isArray(object.buffs) || object.buffs.length === 0) continue;
        const host = object.constructor?.name ?? '?';
        for (const buff of object.buffs) {
          const drawFn = buff.draw;
          // A `draw` inherited straight from the base is the empty one.
          const paints =
            typeof drawFn === 'function' && drawFn.length + drawFn.toString().length > 24;
          const key = `${host}<-${buff.constructor?.name ?? '?'}${paints ? '' : ' (no art)'}`;
          buffCensus[key] = (buffCensus[key] ?? 0) + 1;
        }
      }
      void emptyDraw;

      const rows = [...buckets.entries()]
        .filter(([, bucket]) => bucket.calls > 0)
        .map(([name, bucket]) => ({
          name,
          selfMs: Number(bucket.self.toFixed(1)),
          totalMs: Number(bucket.total.toFixed(1)),
          calls: bucket.calls,
          selfPerFrame: Number((bucket.self / Math.max(1, frames)).toFixed(3)),
          pctCpu: Number(((bucket.self / wall) * 100).toFixed(1)),
          // What one call of this costs. The column that finds a *pathological*
          // object rather than a numerous one: a body drawn forty times a frame
          // and a single effect drawn once can carry the same share of the
          // profile, and only one of them is a bug.
          usPerCall: Number(((bucket.self / bucket.calls) * 1000).toFixed(1)),
        }))
        .sort((a, b) => b.selfMs - a.selfMs);

      const sortedGaps = [...gaps].sort((a, b) => a - b);
      const gapAt = share =>
        sortedGaps.length === 0
          ? 0
          : sortedGaps[Math.min(sortedGaps.length - 1, Math.floor(sortedGaps.length * share))];
      const asFps = gap => (gap > 0 ? Number((1000 / gap).toFixed(1)) : 0);

      return {
        windowMs: Number(wall.toFixed(0)),
        fps: Number(((frames * 1000) / wall).toFixed(1)),
        // The three a player actually feels. `worstFps` is one frame and is
        // noisy on its own; `p95Fps` is the one to hold a line on.
        p95Fps: asFps(gapAt(0.95)),
        p99Fps: asFps(gapAt(0.99)),
        worstFps: asFps(sortedGaps[sortedGaps.length - 1] ?? 0),
        longFrames: gaps.filter(gap => gap > 33).length,
        tickRate: Number(((ticks * 1000) / wall).toFixed(1)),
        drawMsPerFrame: Number((drawMs / Math.max(1, frames)).toFixed(2)),
        updateMsPerTick: Number((updateMs / Math.max(1, ticks)).toFixed(2)),
        objects: manager.objects.length,
        frames,
        census,
        buffCensus,
        rows: rows.slice(0, 40),
      };
    },
    { targetMinions: TARGET_MINIONS, windowMs: WINDOW_MS, bots: BOTS }
  );

  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  console.log(`\n=== frame profile (CPU throttle ${THROTTLE}x) ===`);
  console.log(
    `fps ${result.fps}  tick ${result.tickRate}  draw ${result.drawMsPerFrame}ms/frame  ` +
      `update ${result.updateMsPerTick}ms/tick  objects ${result.objects}`
  );
  console.log(
    `p95 ${result.p95Fps}fps  p99 ${result.p99Fps}fps  worst ${result.worstFps}fps  ` +
      `frames over 33ms: ${result.longFrames}/${result.frames}`
  );
  console.log(
    '\n' +
      'name'.padEnd(34) +
      'selfMs'.padStart(9) +
      'totalMs'.padStart(9) +
      'calls'.padStart(9) +
      'self/frame'.padStart(12) +
      '%cpu'.padStart(7)
  );
  for (const row of result.rows) {
    console.log(
      row.name.padEnd(34) +
        String(row.selfMs).padStart(9) +
        String(row.totalMs).padStart(9) +
        String(row.calls).padStart(9) +
        String(row.selfPerFrame).padStart(12) +
        String(row.pctCpu).padStart(7)
    );
  }
  // Sorted by what one call costs, not by the total. `calls >= frames / 4`
  // keeps out the row that ran twice and happened to land on a slow frame.
  const perCall = [...result.rows]
    .filter(row => row.calls >= Math.max(4, result.frames / 4))
    .sort((a, b) => b.usPerCall - a.usPerCall)
    .slice(0, 12);
  console.log('\n--- most expensive per call (the outliers, not the crowds) ---');
  console.log('name'.padEnd(34) + 'us/call'.padStart(9) + 'calls'.padStart(9) + '%cpu'.padStart(7));
  for (const row of perCall) {
    console.log(
      row.name.padEnd(34) +
        String(row.usPerCall).padStart(9) +
        String(row.calls).padStart(9) +
        String(row.pctCpu).padStart(7)
    );
  }

  console.log('\ncensus: ' + JSON.stringify(result.census));
  console.log('buffs:  ' + JSON.stringify(result.buffCensus));

  Object.assign(report, { throttle: THROTTLE, ...result });
  // The board has to be crowded or the profile is of an empty map, and the
  // simulation has to still be keeping real time or the rows are of a
  // different game than the one anyone plays.
  check('the board was actually crowded', result.objects > 100, `${result.objects} objects`);
  check(
    'the simulation held its own clock under load',
    result.tickRate > 55,
    `${result.tickRate} ticks/sec`
  );
});
