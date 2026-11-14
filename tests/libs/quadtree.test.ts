import { describe, expect, it } from 'vitest';
import { Circle, Quadtree, Rectangle } from '../../src/libs/quadtree';

// Quadtree.retrieve used to dedupe with
// `returnObjects.filter((item, i) => returnObjects.indexOf(item) >= i)`,
// an O(n^2) scan. It was rewritten to use a Set, but must keep returning the
// same set (each object once) in the same first-occurrence order.
describe('Quadtree.retrieve', () => {
  it('returns an object spanning multiple quadrants exactly once', () => {
    const tree = new Quadtree({ x: 0, y: 0, w: 100, h: 100, maxObjects: 1, maxLevels: 4 });

    // Two objects in the same corner push the root past maxObjects so it
    // splits into 4 child nodes before the shared object is inserted.
    tree.insert(new Rectangle({ x: 1, y: 1, w: 1, h: 1, data: 'a' }));
    tree.insert(new Rectangle({ x: 2, y: 2, w: 1, h: 1, data: 'b' }));

    // Straddles the root's center (50, 50), so qtIndex matches all 4
    // quadrants and the object is inserted into every child node.
    const shared = new Rectangle({ x: 45, y: 45, w: 10, h: 10, data: 'shared' });
    tree.insert(shared);

    const query = new Rectangle({ x: 0, y: 0, w: 100, h: 100 });
    const results = tree.retrieve(query);

    expect(results.filter(r => r.data === 'shared')).toHaveLength(1);
  });

  it('still filters out objects that do not actually intersect the query area', () => {
    const tree = new Quadtree({ x: 0, y: 0, w: 100, h: 100, maxObjects: 10, maxLevels: 4 });
    tree.insert(new Rectangle({ x: 0, y: 0, w: 5, h: 5, data: 'near' }));
    tree.insert(new Rectangle({ x: 90, y: 90, w: 5, h: 5, data: 'far' }));

    const query = new Rectangle({ x: 0, y: 0, w: 10, h: 10 });
    const results = tree.retrieve(query);

    expect(results.map(r => r.data)).toEqual(['near']);
  });

  it('keeps first-occurrence order for objects retrieved from a single leaf', () => {
    const tree = new Quadtree({ x: 0, y: 0, w: 100, h: 100, maxObjects: 10, maxLevels: 4 });
    tree.insert(new Rectangle({ x: 1, y: 1, w: 1, h: 1, data: 'first' }));
    tree.insert(new Rectangle({ x: 2, y: 2, w: 1, h: 1, data: 'second' }));
    tree.insert(new Rectangle({ x: 3, y: 3, w: 1, h: 1, data: 'third' }));

    const query = new Rectangle({ x: 0, y: 0, w: 10, h: 10 });
    const results = tree.retrieve(query);

    expect(results.map(r => r.data)).toEqual(['first', 'second', 'third']);
  });

  /**
   * `qtIndex` returns a bitmask whose bit `i` means "child node `i`", and
   * `split()` decides what child `i` actually covers. Nothing else pins those
   * two together: scramble either and inserts still land somewhere, queries
   * still descend somewhere, and the tree simply stops finding things. Both
   * sides use the same mask, so a *consistently* wrong mapping is invisible —
   * only checking each quadrant against real geometry catches it.
   */
  it('stores each quadrant where a query of that quadrant looks for it', () => {
    const corners = [
      { data: 'top-right', x: 80, y: 10 },
      { data: 'top-left', x: 10, y: 10 },
      { data: 'bottom-left', x: 10, y: 80 },
      { data: 'bottom-right', x: 80, y: 80 },
    ];

    // maxObjects: 1 forces the root to split, so the children are what answer.
    const tree = new Quadtree({ x: 0, y: 0, w: 100, h: 100, maxObjects: 1, maxLevels: 4 });
    for (const corner of corners) {
      tree.insert(new Rectangle({ x: corner.x, y: corner.y, w: 5, h: 5, data: corner.data }));
    }

    for (const corner of corners) {
      const probe = new Rectangle({ x: corner.x + 1, y: corner.y + 1, w: 1, h: 1 });
      expect(tree.retrieve(probe).map(r => r.data)).toEqual([corner.data]);
    }
  });

  /**
   * Dedupe is a stamp written onto the stored object, not a per-query Set. A
   * stamp that failed to advance between calls would make every object look
   * already-seen the second time round, so the first query would work and
   * every later one would come back empty.
   */
  it('returns the same objects when the identical query runs twice', () => {
    const tree = new Quadtree({ x: 0, y: 0, w: 100, h: 100, maxObjects: 1, maxLevels: 4 });
    tree.insert(new Rectangle({ x: 10, y: 10, w: 5, h: 5, data: 'a' }));
    tree.insert(new Rectangle({ x: 12, y: 12, w: 5, h: 5, data: 'b' }));
    tree.insert(new Rectangle({ x: 80, y: 80, w: 5, h: 5, data: 'c' }));

    const query = new Rectangle({ x: 0, y: 0, w: 30, h: 30 });
    const first = tree.retrieve(query).map(r => r.data);
    const second = tree.retrieve(query).map(r => r.data);

    expect(first).toEqual(['a', 'b']);
    expect(second).toEqual(first);
  });
});

// `ObjectManager` clears and refills its trees every tick. `clear()` parks a
// node's children and `split()` takes them back instead of building four new
// ones — which is only allowed to be invisible: same hits, same order, same
// node layout as a tree built from nothing.
describe('Quadtree.clear reuses its nodes', () => {
  const CONFIG = { x: 0, y: 0, w: 3200, h: 3200, maxObjects: 4, maxLevels: 4 };

  /** Deterministic, so a failure names a round that can be re-run. */
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const layout = (node: Quadtree, out: string[] = []): string[] => {
    const { x, y, w, h } = node.bounds;
    out.push(`${node.level}:${x},${y},${w},${h}:${node.objects.map(o => o.data).join('.')}`);
    for (const child of node.nodes) layout(child, out);
    return out;
  };

  const fill = (tree: Quadtree, board: { x: number; y: number; s: number; id: number }[]) => {
    for (const b of board) {
      tree.insert(new Rectangle({ x: b.x - b.s / 2, y: b.y - b.s / 2, w: b.s, h: b.s, data: b.id }));
    }
  };

  it('answers every query like a freshly built tree, in the same order', () => {
    const random = rng(7);
    const reused = new Quadtree(CONFIG);
    for (let round = 0; round < 120; round++) {
      // The board swings between crowded-in-one-corner and nearly empty, so
      // nodes split, stop splitting and split again somewhere else.
      const count = round % 9 === 0 ? 2 : 10 + Math.floor(random() * 70);
      const spread = round % 4 === 0 ? 300 : 3200;
      const ox = random() * (3200 - spread);
      const oy = random() * (3200 - spread);
      const board = Array.from({ length: count }, (_, id) => ({
        x: ox + random() * spread,
        y: oy + random() * spread,
        s: 20 + random() * 160,
        id,
      }));

      reused.clear();
      fill(reused, board);
      const fresh = new Quadtree(CONFIG);
      fill(fresh, board);

      expect(layout(reused), `layout, round ${round}`).toEqual(layout(fresh));
      for (let q = 0; q < 12; q++) {
        const x = random() * 3200;
        const y = random() * 3200;
        const area =
          q % 2 === 0
            ? new Circle({ x, y, r: 50 + random() * 900 })
            : new Rectangle({ x, y, w: 50 + random() * 900, h: 50 + random() * 900 });
        expect(
          reused.retrieve(area).map(r => r.data),
          `round ${round}, query ${q}`
        ).toEqual(fresh.retrieve(area).map(r => r.data));
      }
    }
  });

  it('hands a split node the children it had before the clear', () => {
    const tree = new Quadtree({ x: 0, y: 0, w: 100, h: 100, maxObjects: 1, maxLevels: 2 });
    const crowd = () => {
      tree.insert(new Rectangle({ x: 1, y: 1, w: 1, h: 1, data: 'a' }));
      tree.insert(new Rectangle({ x: 80, y: 80, w: 1, h: 1, data: 'b' }));
    };
    crowd();
    const before = [...tree.nodes];
    expect(before).toHaveLength(4);

    tree.clear();
    // Unsplit is still "no nodes": the debug overlay and `insert` both read it.
    expect(tree.nodes).toHaveLength(0);
    expect(tree.objects).toHaveLength(0);

    crowd();
    expect(tree.nodes).toHaveLength(4);
    tree.nodes.forEach((node, i) => expect(node).toBe(before[i]));
  });

  it('re-seats reused children from the bounds the parent has now', () => {
    const tree = new Quadtree({ x: 0, y: 0, w: 100, h: 100, maxObjects: 1, maxLevels: 2 });
    tree.insert(new Rectangle({ x: 1, y: 1, w: 1, h: 1 }));
    tree.insert(new Rectangle({ x: 80, y: 80, w: 1, h: 1 }));
    tree.clear();

    tree.bounds = { x: 1000, y: 2000, w: 400, h: 200 };
    tree.insert(new Rectangle({ x: 1001, y: 2001, w: 1, h: 1 }));
    tree.insert(new Rectangle({ x: 1390, y: 2190, w: 1, h: 1 }));

    expect(tree.nodes.map(n => n.bounds)).toEqual([
      { x: 1200, y: 2000, w: 200, h: 100 },
      { x: 1000, y: 2000, w: 200, h: 100 },
      { x: 1000, y: 2100, w: 200, h: 100 },
      { x: 1200, y: 2100, w: 200, h: 100 },
    ]);
  });
});
