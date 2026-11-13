/**
 * The minimap: a fog-respecting map of the whole world, drawn on the canvas in
 * screen space beside the touch controls.
 *
 * **A tap on the expanded map teleports the player there.** That makes this a
 * practice tool, not a neutral HUD element — say so plainly, because a reader
 * who assumes "minimap" means "the LoL minimap" will expect a move order. A
 * move order from the minimap is a different gesture on the same surface and
 * can be added later without redesigning anything here.
 *
 * Geometry and hit-testing live at module level, free of p5 globals, so they
 * run in a plain node test with no canvas — the shape `TouchControls` already
 * uses. Only `draw()` and the buffer builder may touch p5.
 */
import { removeGraphics } from '@/utils/graphics.utils';
import AssetManager from '@/managers/AssetManager';
import { safeAreaInsets } from '@/game/render/safeArea';

export interface MinimapRect {
  x: number;
  y: number;
  size: number;
}

export interface Point {
  x: number;
  y: number;
}

/** One lit disc: a champion's sight, a minion's, a turret's, a ward's. */
export interface VisionCircle {
  x: number;
  y: number;
  r: number;
}

/**
 * The collapsed map's edge length in screen pixels: the size it reaches on a
 * screen with room for it, and the size everything else is measured against.
 */
export const MINIMAP_SIZE = 150;
export const MINIMAP_MARGIN = 12;

/**
 * …and the floor under it. Below about this the dots stop being separable
 * from each other, which is the only thing the collapsed map is for.
 */
export const MINIMAP_MIN_SIZE = 96;

/**
 * Collapsed edge length as a share of the viewport's shorter side, clamped
 * into the two constants above.
 *
 * A fixed 150 is a quarter of a phone's short side and a seventh of a laptop's:
 * the same rectangle reads as a HUD element on one and as a window covering
 * the corner of the fight on the other ("trên mobile minimap hơi to"). The
 * fraction is picked so a 720p laptop and anything larger still lands on the
 * full 150 — this shrinks the map on small screens and changes nothing on the
 * screens nobody complained about — and a phone lands on the floor.
 */
export const COLLAPSED_FRACTION = 0.21;

/** Expanded edge length, as a fraction of the viewport's shorter side. */
export const EXPANDED_FRACTION = 0.8;

/** What the collapsed map measures, for a viewport. Pure. */
export const collapsedMinimapSize = (viewport: MinimapViewport): number => {
  const shorter = Math.min(viewport.width, viewport.height);
  return Math.round(
    Math.max(MINIMAP_MIN_SIZE, Math.min(MINIMAP_SIZE, shorter * COLLAPSED_FRACTION))
  );
};

/**
 * One transform, parameterised by the rect: the expanded and collapsed maps
 * differ only in that rect, so the teleport tap and the dot placement cannot
 * disagree with each other.
 */
export const worldToMinimap = (world: Point, rect: MinimapRect, mapSize: number): Point => ({
  x: rect.x + (world.x / mapSize) * rect.size,
  y: rect.y + (world.y / mapSize) * rect.size,
});

export const minimapToWorld = (screen: Point, rect: MinimapRect, mapSize: number): Point => ({
  x: ((screen.x - rect.x) / rect.size) * mapSize,
  y: ((screen.y - rect.y) / rect.size) * mapSize,
});

export const hitTest = (point: Point, rect: MinimapRect): boolean =>
  point.x >= rect.x &&
  point.x <= rect.x + rect.size &&
  point.y >= rect.y &&
  point.y <= rect.y + rect.size;

/**
 * Where the map sits for a given state and viewport. Collapsed it is pinned to
 * the top-left corner — both bottom corners are where two thumbs sit for the
 * whole match. Expanded it is centred, at a fraction of the shorter side, so a
 * tall phone and a wide desktop both get a square that fits.
 */
export const minimapRect = (expanded: boolean, viewport: MinimapViewport): MinimapRect => {
  if (!expanded) {
    // The margin is clearance from the *viewport* edge; the insets are how much
    // of that edge the device has already spent on its own furniture. On an
    // iPad running this as a full-screen PWA the status bar sits over the top
    // of the canvas — `apple-mobile-web-app-status-bar-style` is
    // `black-translucent`, which is what puts the page under it on purpose —
    // so a map pinned at a flat 12px was pinned underneath the clock.
    //
    // Added rather than maxed: the margin is a gap the design wants and the
    // inset is ground that is not there, so the map wants both. Zero on every
    // device without furniture, which is what makes this free to add.
    return {
      x: MINIMAP_MARGIN + (viewport.safeLeft ?? 0),
      y: MINIMAP_MARGIN + (viewport.safeTop ?? 0),
      size: collapsedMinimapSize(viewport),
    };
  }
  const size = Math.min(viewport.width, viewport.height) * EXPANDED_FRACTION;
  return { x: (viewport.width - size) / 2, y: (viewport.height - size) / 2, size };
};

export interface MinimapViewport {
  width: number;
  height: number;
  /**
   * The device furniture at the top-left corner, in canvas pixels.
   *
   * Optional and defaulted to zero at the one place that reads them, so every
   * existing caller — and every test that hands this two numbers — keeps
   * meaning exactly what it meant. Passed in rather than read here, because
   * `minimapRect` is pure and `TouchLayout.test.ts` drives it as pure.
   */
  safeTop?: number;
  safeLeft?: number;
}

/**
 * Everything the minimap reads from the match. An interface rather than a
 * `Game` reference for the same reason `TouchControlsHost` is one: it is the
 * whole coupling, and a plain object satisfies it in a node test.
 */
export interface MinimapHost {
  viewport(): MinimapViewport;
  mapSize(): number;
  /** World-space wall polygons; read once per buffer build, never per frame. */
  wallPolygons(): Point[][];
  /** Everything worth a dot this frame, fog already applied. See `MinimapBlip`. */
  blips(): readonly MinimapBlip[];
  /**
   * What the player's team lights up, in world space and over the WHOLE map —
   * not the camera's share of it. `null` means "no fog on this map", which is
   * the practice panel's reveal cheat and nothing else. See `MinimapVision`.
   */
  visionCircles(): readonly VisionCircle[] | null;
  /** The poison zone's circles, world space; absent or null outside the zone mode. */
  zone?(): { current: Point & { r: number }; next: (Point & { r: number }) | null } | null;
  /** Where the player is, always drawn — you can always see yourself. */
  playerPosition(): Point;
  /** `Camera.getBoundingBox()`: the one element that answers "where am I looking". */
  cameraBox(): { x: number; y: number; w: number; h: number };
  /**
   * How long the moving layer may be held before it is repainted, in ms.
   *
   * Asked of the host rather than read off a game, because this object has no
   * game — `MinimapHost` is the whole of what it knows, and that is what makes
   * it testable without one. Optional: a host that does not answer gets
   * `MINIMAP_LIVE_INTERVAL_MS`, which is every host that existed before the
   * quality tiers did.
   */
  liveRepaintIntervalMs?(): number;
}

/** What a press on the screen means to the minimap. See `Minimap.route`. */
export type MinimapAction = 'expand' | 'collapse' | 'teleport' | 'pass';

/** What a dot is, which decides its shape and size — never its world size. */
export type BlipKind = 'champion' | 'unit' | 'structure';

/**
 * One dot. The host resolves the colour because the host is the one that knows
 * the game's team palette (`teamBodyColor` in `Minion.ts`); the minimap only
 * knows where to put it.
 */
export interface MinimapBlip {
  x: number;
  y: number;
  kind: BlipKind;
  color: readonly number[];
}

/** Ground under the walls, and the walls themselves. */
const GROUND_COLOR = [16, 20, 28, 242] as const;
const WALL_COLOR = [72, 82, 100, 255] as const;
const BORDER_COLOR = [190, 205, 230, 200] as const;
/** The player, in a colour no team can be. */
export const PLAYER_COLOR = [255, 236, 140] as const;
const CAMERA_BOX_COLOR = [235, 240, 250, 190] as const;

/**
 * The veil over everything the team cannot currently see.
 *
 * The minimap showed terrain and dots and nothing about *vision*, so a player
 * reading it could not tell a quiet lane from one nobody is looking at —
 * which is most of what a minimap is for. The dots were already fog-correct
 * (`Game.minimapBlips` consults `visibleToPlayerTeam`); what was missing was
 * the ground under them, so an empty jungle read as an empty jungle rather
 * than as an unwatched one.
 *
 * Dark and translucent rather than opaque: League's minimap keeps the terrain
 * legible under its fog, and so does this — you always know the *shape* of the
 * map, only never who is standing on it.
 */
const FOG_COLOR = [8, 10, 16, 168] as const;

/**
 * The smallest lit disc, in minimap pixels.
 *
 * A revealer with a small radius scales down to nothing on a 96px map, and a
 * lit area you cannot see is the same as no vision at all — the dot would be
 * standing in its own fog.
 */
const FOG_MIN_LIT_PX = 4;

/**
 * Dot diameters in minimap pixels at the collapsed size, by kind.
 *
 * Deliberately not derived from `stats.size`: a dot is an icon, not a scale
 * model, and a 165-unit fully-stacked champion must not become a blob covering four other
 * units. The expanded map multiplies these by its rect ratio only so the same
 * icons stay the same *apparent* size — that ratio is a property of the rect,
 * never of the unit.
 */
const BLIP_DIAMETER: Record<BlipKind | 'player', number> = {
  player: 7,
  champion: 6,
  unit: 3.5,
  structure: 5,
};
/** Past this the expanded map's icons would be blobs of their own. */
const BLIP_SCALE_MAX = 2.2;
/**
 * …and the floor, which the collapsed map needs now that it shrinks. Scaling
 * the icons all the way down with a 96px map would take a unit dot to 2.2px:
 * the map would be smaller *and* less readable, which is not the trade the
 * smaller map was for.
 */
const BLIP_SCALE_MIN = 0.85;

/**
 * How often the moving layer — dots, camera box, player — is repainted.
 *
 * It used to be repainted onto the main canvas every frame, which measured at
 * 0.80ms of a 4.36ms frame on a throttled machine: the single most expensive
 * thing on screen after the fog, for a picture whose dots move a fraction of
 * one minimap pixel per frame. The cost is not the dots themselves — building
 * the blip list was 0.20ms of it — it is issuing the p5 calls sixty times a
 * second.
 *
 * 50ms is a considered number rather than a round one: it is under the ~100ms
 * at which a moving dot starts to read as stepping rather than sliding, and it
 * is slower than one simulation step so a dot never repaints twice for the same
 * position. The layer is held in a buffer between repaints, so the map is drawn
 * every frame either way — a skipped *repaint* is invisible, a skipped *draw*
 * would flicker, because `Game.draw` clears the whole canvas first.
 */
export const MINIMAP_LIVE_INTERVAL_MS = 50;

/**
 * And the same number for a machine that is missing its frame target, then for
 * one missing it badly (`render/renderStress.ts`).
 *
 * 100ms is the threshold the note above names as where a moving dot starts to
 * read as stepping rather than sliding — so this is deliberately spending the
 * exact thing 50ms was chosen to protect, and only on a machine that is already
 * dropping half its frames. A dot that steps is a small price against a fight
 * that stutters; at 150ms it is visibly stepping, which is why that tier is
 * reserved for the machine at fifteen frames a second, where the *whole
 * picture* is stepping anyway.
 */
export const MINIMAP_LIVE_INTERVAL_STRESSED_MS = 100;
export const MINIMAP_LIVE_INTERVAL_DROWNING_MS = 150;

/**
 * Whether the moving layer is due a repaint. Pure, and deliberately written so
 * that a first frame (`paintedAtMs` of `-Infinity`) and a clock that has gone
 * backwards both repaint rather than freeze.
 */
export const liveLayerIsStale = (
  nowMs: number,
  paintedAtMs: number,
  intervalMs: number = MINIMAP_LIVE_INTERVAL_MS
): boolean => !(nowMs - paintedAtMs >= 0 && nowMs - paintedAtMs < intervalMs);

/**
 * Pixel density of the moving layer's buffer.
 *
 * The wall layer under it is pinned to 1 — it is a static trace nobody can see
 * the resolution of. The dots are different: a 3.5px "unit" dot rendered at
 * density 1 and scaled up on a 3x phone would lose the thing that makes it
 * readable. 2 keeps it crisp on the ordinary case and costs a quarter of the
 * fill area a full-density buffer would, at a fifth of the repaints the main
 * canvas was doing.
 */
const LIVE_BUFFER_DENSITY = 2;

export class Minimap {
  /** Collapsed until tapped. */
  expanded = false;

  private viewportWidth: number;
  private viewportHeight: number;

  /**
   * The wall layer, pre-rendered once per size. Two buffers rather than one
   * scaled to the other: scaling a 150px trace up to 600px is what makes a
   * minimap look muddy.
   *
   * Built lazily, on the first `draw()`, so that constructing a `Minimap` — and
   * with it every geometry method below — needs no canvas.
   */
  private collapsedBuffer: any = null;
  private collapsedBufferSize = 0;
  private expandedBuffer: any = null;
  private expandedBufferSize = 0;
  /** The restore generation these buffers were painted under — see `bufferFor`. */
  private bufferEpoch = AssetManager.purgeEpoch;

  /**
   * The moving layer, held between repaints. See `MINIMAP_LIVE_INTERVAL_MS`:
   * this is painted at 20Hz and blitted at whatever the frame rate is.
   */
  private liveBuffer: any = null;
  private liveBufferSize = 0;
  private liveDrawnAtMs = -Infinity;
  /**
   * Its own epoch, not `bufferEpoch`. `bufferFor` runs first in `draw()` and
   * clears that field as it repaints the wall layer, so sharing it would mean
   * the moving layer never heard about a purge at all — it would blit a blank
   * canvas for the rest of the match.
   */
  private liveBufferEpoch = AssetManager.purgeEpoch;

  constructor(private readonly host: MinimapHost) {
    const viewport = host.viewport();
    this.viewportWidth = viewport.width;
    this.viewportHeight = viewport.height;
  }

  /** Pure: the current rect for the current state. No p5, no canvas. */
  get rect(): MinimapRect {
    const safe = safeAreaInsets();
    return minimapRect(this.expanded, {
      width: this.viewportWidth,
      height: this.viewportHeight,
      safeTop: safe.top,
      safeLeft: safe.left,
    });
  }

  /**
   * What a press at this screen point means, given the current state. The whole
   * decision, and it needs no canvas — which is what lets the ordering that
   * `Game.syncTouches` depends on be checked in a plain node test.
   *
   * `'collapse'` deliberately does *not* claim the press: a tap outside the
   * expanded map dismisses it **and** still reaches the controls underneath,
   * so an accidental expand costs nothing. `'pass'` is "not mine at all".
   */
  route(point: Point): MinimapAction {
    if (!this.expanded) return hitTest(point, this.rect) ? 'expand' : 'pass';
    return hitTest(point, this.rect) ? 'teleport' : 'collapse';
  }

  /**
   * The world point a press lands on. Read *before* collapsing: the rect is
   * what the transform is parameterised by, and collapsing changes it.
   */
  worldAt(point: Point): Point {
    return minimapToWorld(point, this.rect, this.host.mapSize());
  }

  resize(width: number, height: number): void {
    if (width === this.viewportWidth && height === this.viewportHeight) return;
    this.viewportWidth = width;
    this.viewportHeight = height;
    // Both wall layers are sized off the viewport now — the collapsed one too,
    // since `collapsedMinimapSize` reads it — so both are the wrong pixel size.
    // Dropped rather than resized: rebuilding is one trace of a static layer,
    // and it happens on the next frame that needs it.
    removeGraphics(this.expandedBuffer);
    this.expandedBuffer = null;
    removeGraphics(this.collapsedBuffer);
    this.collapsedBuffer = null;
    removeGraphics(this.liveBuffer);
    this.liveBuffer = null;
  }

  // -------------------------------------------------------------------- draw

  /**
   * Screen space. Called from `Game.draw()` after `fogOfWar.draw()` and outside
   * `camera.makeDraw` — an overlay you cannot see is not an overlay.
   */
  draw(): void {
    const bounds = this.rect;
    const buffer = this.bufferFor(bounds.size);
    const live = this.liveLayerFor(bounds);

    push();
    imageMode(CORNER);
    rectMode(CORNER);
    image(buffer, bounds.x, bounds.y, bounds.size, bounds.size);
    image(live, bounds.x, bounds.y, bounds.size, bounds.size);
    noFill();
    stroke(BORDER_COLOR[0], BORDER_COLOR[1], BORDER_COLOR[2], BORDER_COLOR[3]);
    strokeWeight(2);
    rect(bounds.x, bounds.y, bounds.size, bounds.size);
    pop();
  }

  /**
   * The moving layer's buffer, repainted only when it is due.
   *
   * Same lazy/epoch shape as `bufferFor`, and the same reason for it: a
   * background purge blanks every canvas the page holds, and this one is not
   * something `AssetManager` ever saw.
   */
  private liveLayerFor(bounds: MinimapRect): any {
    const pixels = Math.max(1, Math.round(bounds.size));
    if (this.liveBufferEpochStale() || !this.liveBuffer || this.liveBufferSize !== pixels) {
      removeGraphics(this.liveBuffer);
      const graphics: any = createGraphics(pixels, pixels);
      graphics.pixelDensity(LIVE_BUFFER_DENSITY);
      this.liveBuffer = graphics;
      this.liveBufferSize = pixels;
      this.liveDrawnAtMs = -Infinity;
    }
    const now = performance.now();
    if (liveLayerIsStale(now, this.liveDrawnAtMs, this.host.liveRepaintIntervalMs?.())) {
      this.liveDrawnAtMs = now;
      this.paintLiveLayer(this.liveBuffer, bounds.size);
    }
    return this.liveBuffer;
  }

  /** The same check `bufferFor` makes, against this layer's own generation. */
  private liveBufferEpochStale(): boolean {
    if (this.liveBufferEpoch === AssetManager.purgeEpoch) return false;
    this.liveBufferEpoch = AssetManager.purgeEpoch;
    return true;
  }

  /**
   * Everything that moves: the camera's view, the dots, and the player.
   *
   * Painted in the buffer's own coordinates — a rect at the origin — rather
   * than at the map's screen position, so the same picture is correct wherever
   * the map is blitted and an expand/collapse needs no repaint of its own.
   */
  private paintLiveLayer(graphics: any, size: number): void {
    const local: MinimapRect = { x: 0, y: 0, size };
    const mapSize = this.host.mapSize();
    const dotScale = Math.min(BLIP_SCALE_MAX, Math.max(BLIP_SCALE_MIN, size / MINIMAP_SIZE));

    graphics.clear();
    graphics.rectMode(graphics.CORNER);

    // Under everything: what the team cannot see. Painted into this layer
    // rather than the wall layer under it because vision moves and walls do
    // not — the veil is repainted on the moving layer's own 20Hz beat, and the
    // static trace it sits over is still built once per size.
    this.paintFog(graphics, local, mapSize, size);

    // One veil path (even-odd hole) and one ring, then the warning ring.
    const zone = this.host.zone?.();
    if (zone) {
      const k = size / mapSize;
      const c = zone.current;
      const ctx = graphics.drawingContext as CanvasRenderingContext2D;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, size, size);
      ctx.moveTo((c.x + c.r) * k, c.y * k);
      ctx.arc(c.x * k, c.y * k, c.r * k, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(120, 40, 160, 0.4)';
      ctx.fill('evenodd');
      ctx.beginPath();
      ctx.arc(c.x * k, c.y * k, c.r * k, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(190, 90, 255, 1)';
      ctx.stroke();
      if (zone.next) {
        ctx.beginPath();
        ctx.arc(zone.next.x * k, zone.next.y * k, zone.next.r * k, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.stroke();
      }
      ctx.restore();
    }

    // The view rectangle first, so no dot is hidden under its outline.
    const box = this.host.cameraBox();
    const topLeft = worldToMinimap({ x: box.x, y: box.y }, local, mapSize);
    const span = { w: (box.w / mapSize) * size, h: (box.h / mapSize) * size };
    graphics.noFill();
    graphics.stroke(
      CAMERA_BOX_COLOR[0],
      CAMERA_BOX_COLOR[1],
      CAMERA_BOX_COLOR[2],
      CAMERA_BOX_COLOR[3]
    );
    graphics.strokeWeight(1);
    graphics.rect(topLeft.x, topLeft.y, span.w, span.h);

    graphics.noStroke();
    for (const blip of this.host.blips()) {
      const at = worldToMinimap(blip, local, mapSize);
      const diameter = BLIP_DIAMETER[blip.kind] * dotScale;
      graphics.fill(blip.color[0], blip.color[1], blip.color[2]);
      if (blip.kind === 'structure') {
        graphics.rect(at.x - diameter / 2, at.y - diameter / 2, diameter, diameter);
      } else {
        graphics.circle(at.x, at.y, diameter);
      }
    }

    // Last, and outlined: the player is the one dot that must never be lost
    // under another, and is drawn whatever the fog says.
    const player = worldToMinimap(this.host.playerPosition(), local, mapSize);
    const playerDiameter = BLIP_DIAMETER.player * dotScale;
    graphics.stroke(20, 24, 32, 220);
    graphics.strokeWeight(1.5);
    graphics.fill(PLAYER_COLOR[0], PLAYER_COLOR[1], PLAYER_COLOR[2]);
    graphics.circle(player.x, player.y, playerDiameter);
  }

  /**
   * The fog: one veil over the whole map, with a hole punched for every lit
   * disc.
   *
   * **Circles, not the fog's own polygons.** `FogOfWar` casts wall-aware
   * visibility polygons, and they are the right picture on a 1280-pixel canvas
   * and the wrong one here twice over: they are only cast for revealers *near
   * the camera* (so an ally holding vision across the map would light nothing
   * on a map whose whole point is showing the other side of the map), and a
   * wall's shadow is well under one pixel wide at this scale. A disc per
   * revealer is what the polygons look like from here.
   *
   * `erase` rather than a second buffer and a mask blit: p5 gives the same
   * destination-out composite the fog overlay itself uses, on a buffer that is
   * repainted five times a second at most.
   */
  private paintFog(graphics: any, local: MinimapRect, mapSize: number, size: number): void {
    const circles = this.host.visionCircles();
    // `null` is the reveal cheat: no veil at all, not a veil with no holes.
    if (circles === null) return;

    graphics.noStroke();
    graphics.fill(FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2], FOG_COLOR[3]);
    graphics.rect(0, 0, size, size);
    if (circles.length === 0) return;

    const scale = size / mapSize;
    graphics.erase();
    for (const lit of circles) {
      const at = worldToMinimap(lit, local, mapSize);
      graphics.circle(at.x, at.y, Math.max(FOG_MIN_LIT_PX, lit.r * 2 * scale));
    }
    graphics.noErase();
  }

  private bufferFor(size: number): any {
    // A background purge blanks these pre-rendered layers along with every
    // image (`AssetManager`'s probe note): the manager repaints what it
    // loaded, but it never saw this picture, so the epoch is how this file
    // hears "your canvases are gone, paint again".
    if (this.bufferEpoch !== AssetManager.purgeEpoch) {
      this.bufferEpoch = AssetManager.purgeEpoch;
      removeGraphics(this.collapsedBuffer);
      removeGraphics(this.expandedBuffer);
      this.collapsedBuffer = null;
      this.expandedBuffer = null;
    }

    const pixels = Math.max(1, Math.round(size));
    if (!this.expanded) {
      if (!this.collapsedBuffer || this.collapsedBufferSize !== pixels) {
        removeGraphics(this.collapsedBuffer);
        this.collapsedBuffer = this.buildBuffer(pixels);
        this.collapsedBufferSize = pixels;
      }
      return this.collapsedBuffer;
    }
    if (!this.expandedBuffer || this.expandedBufferSize !== pixels) {
      removeGraphics(this.expandedBuffer);
      this.expandedBuffer = this.buildBuffer(pixels);
      this.expandedBufferSize = pixels;
    }
    return this.expandedBuffer;
  }

  /** The one place besides `draw()` that may touch p5. */
  private buildBuffer(size: number): any {
    // `any`, as FogOfWar's overlay is: p5's Graphics type omits most of the
    // drawing surface it actually has.
    const graphics: any = createGraphics(size, size);
    // Pinned for the same reason FogOfWar pins its overlay: p5.Graphics
    // inherits the sketch's density, and a 3x buffer of a static layer is
    // nine times the memory for a picture nobody can see the resolution of.
    graphics.pixelDensity(1);
    graphics.clear();
    graphics.noStroke();
    graphics.fill(GROUND_COLOR[0], GROUND_COLOR[1], GROUND_COLOR[2], GROUND_COLOR[3]);
    graphics.rect(0, 0, size, size);

    const mapSize = this.host.mapSize();
    const scale = size / mapSize;
    graphics.fill(WALL_COLOR[0], WALL_COLOR[1], WALL_COLOR[2], WALL_COLOR[3]);
    for (const polygon of this.host.wallPolygons()) {
      graphics.beginShape();
      for (const vertex of polygon) graphics.vertex(vertex.x * scale, vertex.y * scale);
      graphics.endShape(graphics.CLOSE);
    }
    return graphics;
  }

  destroy(): void {
    removeGraphics(this.collapsedBuffer);
    removeGraphics(this.expandedBuffer);
    removeGraphics(this.liveBuffer);
    this.collapsedBuffer = null;
    this.expandedBuffer = null;
    this.liveBuffer = null;
  }
}

export default Minimap;
