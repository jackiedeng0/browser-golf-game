import { GRID_STEP, gridSize, nearestIndex, waterRegions, type LevelData, type Point } from './levelData';
import { toMillimetre } from './levelFile';
import { surfaceId, type Surface } from './surfaces';

export interface Brush {
  /** Meters. */
  radius: number;
  /** 0-1: how hard each dab pulls the ground (or, for scatter, how densely it places objects). */
  strength: number;
  /** 0-1: the fraction of the radius over which the brush fades out (0 is a hard edge). */
  falloff: number;
}

export type StrokeTool =
  | { kind: 'raise' }
  | { kind: 'lower' }
  | { kind: 'smooth' }
  /** Pulls the ground to the height where the stroke started. */
  | { kind: 'flatten' }
  | { kind: 'set'; height: number }
  | { kind: 'surface'; surface: Surface }
  | { kind: 'wind'; zone: number }
  | { kind: 'scatter'; type: string };

/** A block of grid points, columns c0-c1 and rows r0-r1 inclusive. */
export interface GridRect {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}

/** How far a full-strength raise or lower dab moves the ground (m). */
const HEIGHT_STEP = 0.5;
/** Dabs are spaced this fraction of the radius apart along a stroke. */
const DAB_SPACING = 0.25;
/** Scatter keeps objects at least this far apart (m): from sparse at strength 0 to dense at 1. */
const SCATTER_SPACING_SPARSE = 16;
const SCATTER_SPACING_DENSE = 3.5;
/** Places scatter tries per dab. */
const SCATTER_TRIES = 12;
/** Undo snapshots the grids in square tiles of this many points a side. */
const UNDO_TILE = 32;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Brush strength at `d` meters from its center: 1 inside the falloff, easing to 0 at the radius. */
export function brushWeight(d: number, brush: Brush): number {
  if (d >= brush.radius) return 0;
  const inner = brush.radius * (1 - brush.falloff);
  if (d <= inner) return 1;
  const t = (d - inner) / (brush.radius - inner);
  return 1 - t * t * (3 - 2 * t);
}

/** Everything but the grids, which undo snapshots whole. */
type Meta = Omit<LevelData, 'grids'>;

interface TileSnapshot {
  height: Float32Array;
  surface: Uint8Array;
  wind: Uint8Array;
}

interface UndoStep {
  meta: Meta;
  tiles: Map<number, TileSnapshot>;
}

/**
 * A level being edited: brush strokes on the grids and changes to everything else, all
 * undoable. Edits change `data` in place.
 */
export class EditableLevel {
  readonly data: LevelData;
  readonly cols: number;
  readonly rows: number;
  /** Source of randomness for scatter; replaceable for tests. */
  random: () => number = Math.random;
  /** Bumped on every edit, undo and redo, so callers can tell when there are unsaved changes. */
  version = 0;

  private readonly undoSteps: UndoStep[] = [];
  private readonly redoSteps: UndoStep[] = [];
  /** The step being recorded by an open stroke or change. */
  private open: UndoStep | null = null;
  private stroke: { tool: StrokeTool; brush: Brush; target: number; last: Point | null } | null = null;

  /** Takes over `data`, rounding its heights to the millimetre. */
  constructor(data: LevelData) {
    this.data = data;
    ({ cols: this.cols, rows: this.rows } = gridSize(data.width, data.length));
    const height = data.grids.height;
    for (let i = 0; i < height.length; i++) height[i] = toMillimetre(height[i]);
  }

  /** A flat level of rough, with the tee near the bottom (+z) edge and the cup near the top. */
  static blank(width: number, length: number): EditableLevel {
    const { cols, rows } = gridSize(width, length);
    const end = Math.min(10, length / 4);
    return new EditableLevel({
      name: 'New level',
      par: 4,
      width,
      length,
      tee: { x: width / 2, z: length - end },
      cup: { x: width / 2, z: end },
      winds: [{ speed: 0, direction: 0 }],
      waterLevels: [],
      objects: [],
      grids: {
        height: new Float32Array(cols * rows),
        surface: new Uint8Array(cols * rows).fill(surfaceId('rough')),
        wind: new Uint8Array(cols * rows),
      },
    });
  }

  get canUndo(): boolean {
    return this.undoSteps.length > 0;
  }

  get canRedo(): boolean {
    return this.redoSteps.length > 0;
  }

  /** Bytes of grid kept for undo and redo. */
  undoBytes(): number {
    let bytes = 0;
    for (const step of [...this.undoSteps, ...this.redoSteps]) {
      for (const t of step.tiles.values()) bytes += t.height.byteLength + t.surface.byteLength + t.wind.byteLength;
    }
    return bytes;
  }

  // --- Strokes -----------------------------------------------------------------

  /** Starts a brush stroke at (x, z); dab along it, then end it. The whole stroke undoes as one step. */
  beginStroke(tool: StrokeTool, brush: Brush, x: number, z: number): void {
    this.beginStep();
    this.stroke = { tool, brush, target: this.data.grids.height[this.index(x, z)], last: null };
  }

  /**
   * Applies the brush at (x, z) and along the way from the previous dab. Returns the grid
   * points it changed, or null if it changed none (scatter changes objects, not the grid).
   */
  dab(x: number, z: number): GridRect | null {
    const s = this.stroke;
    if (!s) return null;
    const last = s.last ?? { x, z };
    s.last = { x, z };
    const spacing = Math.max(GRID_STEP / 2, s.brush.radius * DAB_SPACING);
    const steps = Math.max(1, Math.ceil(Math.hypot(x - last.x, z - last.z) / spacing));
    let dirty: GridRect | null = null;
    // The first dab of a stroke has nothing to come from; later ones skip the point already dabbed.
    for (let k = last.x === x && last.z === z ? steps : 1; k <= steps; k++) {
      const t = k / steps;
      dirty = union(dirty, this.dabAt(lerp(last.x, x, t), lerp(last.z, z, t)));
    }
    return dirty;
  }

  endStroke(): void {
    this.stroke = null;
    this.endStep();
  }

  private dabAt(x: number, z: number): GridRect | null {
    const { tool, brush, target } = this.stroke!;
    if (tool.kind === 'scatter') {
      this.scatter(tool.type, x, z, brush);
      return null;
    }
    const rect = this.rectAround(x, z, brush.radius);
    if (!rect) return null;
    this.snapshotTiles(rect);
    const { height, surface, wind } = this.data.grids;
    const cols = this.cols;
    // Smoothing averages neighbors as they were before this dab.
    const before = tool.kind === 'smooth' ? this.copyHeights(rect) : null;
    const zone = tool.kind === 'wind' ? tool.zone : 0;
    const paint = tool.kind === 'surface' ? surfaceId(tool.surface) : 0;
    for (let row = rect.r0; row <= rect.r1; row++) {
      for (let col = rect.c0; col <= rect.c1; col++) {
        const d = Math.hypot(col * GRID_STEP - x, row * GRID_STEP - z);
        if (d >= brush.radius) continue;
        const i = row * cols + col;
        if (tool.kind === 'surface') surface[i] = paint;
        else if (tool.kind === 'wind') wind[i] = zone;
        else {
          const w = brushWeight(d, brush) * brush.strength;
          let next = height[i];
          if (tool.kind === 'raise') next += HEIGHT_STEP * w;
          else if (tool.kind === 'lower') next -= HEIGHT_STEP * w;
          else if (tool.kind === 'flatten') next = lerp(next, target, w);
          else if (tool.kind === 'set') next = lerp(next, tool.height, w);
          else next = lerp(next, before!.average(col, row), w);
          height[i] = toMillimetre(next);
        }
      }
    }
    return rect;
  }

  /**
   * A copy of the heights under `rect` plus one point around it, with the mean height of a
   * point and its eight neighbors (those on the map) read from the copy.
   */
  private copyHeights(rect: GridRect): { average: (col: number, row: number) => number } {
    const c0 = Math.max(0, rect.c0 - 1);
    const r0 = Math.max(0, rect.r0 - 1);
    const c1 = Math.min(this.cols - 1, rect.c1 + 1);
    const r1 = Math.min(this.rows - 1, rect.r1 + 1);
    const w = c1 - c0 + 1;
    const copy = new Float32Array(w * (r1 - r0 + 1));
    for (let row = r0; row <= r1; row++) {
      copy.set(this.data.grids.height.subarray(row * this.cols + c0, row * this.cols + c1 + 1), (row - r0) * w);
    }
    return {
      average: (col, row) => {
        let sum = 0;
        let n = 0;
        for (let r = Math.max(r0, row - 1); r <= Math.min(r1, row + 1); r++) {
          for (let c = Math.max(c0, col - 1); c <= Math.min(c1, col + 1); c++) {
            sum += copy[(r - r0) * w + (c - c0)];
            n++;
          }
        }
        return sum / n;
      },
    };
  }

  /** Tries a few random spots in the brush, keeping those far enough from every other object. */
  private scatter(type: string, x: number, z: number, brush: Brush): void {
    const spacing = lerp(SCATTER_SPACING_SPARSE, SCATTER_SPACING_DENSE, brush.strength);
    const objects = this.data.objects;
    for (let k = 0; k < SCATTER_TRIES; k++) {
      const r = brush.radius * Math.sqrt(this.random());
      const a = this.random() * Math.PI * 2;
      const ox = x + Math.cos(a) * r;
      const oz = z + Math.sin(a) * r;
      if (ox < 0 || oz < 0 || ox > this.data.width || oz > this.data.length) continue;
      if (objects.some((o) => Math.hypot(o.x - ox, o.z - oz) < spacing)) continue;
      objects.push({ type, x: ox, z: oz, rotation: Math.round(this.random() * 360), scale: 0.75 + this.random() * 0.5 });
    }
  }

  // --- Changes to everything else ----------------------------------------------

  /** Makes one undoable change to anything but the grids. */
  change(apply: (data: LevelData) => void): void {
    this.beginChange();
    apply(this.data);
    this.endChange();
  }

  /** Starts an undoable change made directly to `data` over time, such as dragging an object. */
  beginChange(): void {
    this.beginStep();
  }

  endChange(): void {
    this.endStep();
  }

  /** Sets the level of the water region at (x, z); returns false if there's no water there. */
  setWaterLevel(x: number, z: number, level: number): boolean {
    const { region } = waterRegions(this.data);
    const id = region[this.index(x, z)];
    if (id < 0) return false;
    this.change((d) => {
      d.waterLevels = d.waterLevels.filter((w) => region[this.index(w.x, w.z)] !== id);
      d.waterLevels.push({ x, z, level });
    });
    return true;
  }

  /** Removes the last wind zone, giving its ground the default wind. Zone 0, the default, stays. */
  removeWindZone(): void {
    const last = this.data.winds.length - 1;
    if (last < 1) return;
    this.beginStep();
    const wind = this.data.grids.wind;
    let rect: GridRect | null = null;
    for (let i = 0; i < wind.length; i++) {
      if (wind[i] !== last) continue;
      const col = i % this.cols;
      const row = (i - col) / this.cols;
      rect = union(rect, { c0: col, r0: row, c1: col, r1: row });
    }
    if (rect) this.snapshotTiles(rect);
    for (let i = 0; i < wind.length; i++) if (wind[i] === last) wind[i] = 0;
    this.data.winds.pop();
    this.endStep();
  }

  // --- Undo --------------------------------------------------------------------

  /** Undoes the last step; does nothing while a stroke or change is still open. */
  undo(): boolean {
    return !this.open && this.swap(this.undoSteps, this.redoSteps);
  }

  redo(): boolean {
    return !this.open && this.swap(this.redoSteps, this.undoSteps);
  }

  /** Restores the last step in `from`, recording the state it replaces in `to`. */
  private swap(from: UndoStep[], to: UndoStep[]): boolean {
    const step = from.pop();
    if (!step) return false;
    const current: UndoStep = { meta: this.copyMeta(), tiles: new Map() };
    for (const [tile, snapshot] of step.tiles) {
      current.tiles.set(tile, this.readTile(tile));
      this.writeTile(tile, snapshot);
    }
    Object.assign(this.data, structuredClone(step.meta));
    if (!step.meta.lineOfPlay) delete this.data.lineOfPlay;
    to.push(current);
    this.version++;
    return true;
  }

  private beginStep(): void {
    if (this.open) this.endStep();
    this.open = { meta: this.copyMeta(), tiles: new Map() };
  }

  /** Keeps the open step if it changed anything. */
  private endStep(): void {
    const step = this.open;
    this.open = null;
    if (!step) return;
    if (step.tiles.size === 0 && JSON.stringify(step.meta) === JSON.stringify(this.copyMeta())) return;
    this.undoSteps.push(step);
    this.redoSteps.length = 0;
    this.version++;
  }

  private copyMeta(): Meta {
    const { grids: _grids, ...meta } = this.data;
    return structuredClone(meta);
  }

  /** Records the tiles under `rect` as they are before the open step first changes them. */
  private snapshotTiles(rect: GridRect): void {
    const step = this.open;
    if (!step) return;
    const across = Math.ceil(this.cols / UNDO_TILE);
    for (let tr = Math.floor(rect.r0 / UNDO_TILE); tr <= Math.floor(rect.r1 / UNDO_TILE); tr++) {
      for (let tc = Math.floor(rect.c0 / UNDO_TILE); tc <= Math.floor(rect.c1 / UNDO_TILE); tc++) {
        const tile = tr * across + tc;
        if (!step.tiles.has(tile)) step.tiles.set(tile, this.readTile(tile));
      }
    }
  }

  /** The grid rows and columns a tile covers. */
  private tileRect(tile: number): GridRect {
    const across = Math.ceil(this.cols / UNDO_TILE);
    const c0 = (tile % across) * UNDO_TILE;
    const r0 = Math.floor(tile / across) * UNDO_TILE;
    return { c0, r0, c1: Math.min(c0 + UNDO_TILE, this.cols) - 1, r1: Math.min(r0 + UNDO_TILE, this.rows) - 1 };
  }

  private readTile(tile: number): TileSnapshot {
    const { c0, r0, c1, r1 } = this.tileRect(tile);
    const w = c1 - c0 + 1;
    const n = w * (r1 - r0 + 1);
    const out = { height: new Float32Array(n), surface: new Uint8Array(n), wind: new Uint8Array(n) };
    const g = this.data.grids;
    for (let row = r0; row <= r1; row++) {
      const from = row * this.cols + c0;
      const to = (row - r0) * w;
      out.height.set(g.height.subarray(from, from + w), to);
      out.surface.set(g.surface.subarray(from, from + w), to);
      out.wind.set(g.wind.subarray(from, from + w), to);
    }
    return out;
  }

  private writeTile(tile: number, snapshot: TileSnapshot): void {
    const { c0, r0, c1, r1 } = this.tileRect(tile);
    const w = c1 - c0 + 1;
    const g = this.data.grids;
    for (let row = r0; row <= r1; row++) {
      const from = (row - r0) * w;
      const to = row * this.cols + c0;
      g.height.set(snapshot.height.subarray(from, from + w), to);
      g.surface.set(snapshot.surface.subarray(from, from + w), to);
      g.wind.set(snapshot.wind.subarray(from, from + w), to);
    }
  }

  // --- Grid helpers --------------------------------------------------------------

  private index(x: number, z: number): number {
    return nearestIndex(this.cols, this.rows, x, z);
  }

  /** Grid points within `radius` of (x, z), or null if none are on the map. */
  private rectAround(x: number, z: number, radius: number): GridRect | null {
    const c0 = Math.max(0, Math.ceil((x - radius) / GRID_STEP));
    const c1 = Math.min(this.cols - 1, Math.floor((x + radius) / GRID_STEP));
    const r0 = Math.max(0, Math.ceil((z - radius) / GRID_STEP));
    const r1 = Math.min(this.rows - 1, Math.floor((z + radius) / GRID_STEP));
    return c0 > c1 || r0 > r1 ? null : { c0, r0, c1, r1 };
  }
}

function union(a: GridRect | null, b: GridRect | null): GridRect | null {
  if (!a || !b) return a ?? b;
  return { c0: Math.min(a.c0, b.c0), r0: Math.min(a.r0, b.r0), c1: Math.max(a.c1, b.c1), r1: Math.max(a.r1, b.r1) };
}

/** Inserts a line-of-play point where it lengthens the route (tee → points → cup) least. */
export function insertLinePoint(data: LevelData, p: Point): void {
  const line = data.lineOfPlay ?? [];
  const route = [data.tee, ...line, data.cup];
  const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);
  let best = 0;
  let bestAdded = Infinity;
  for (let k = 0; k < route.length - 1; k++) {
    const added = dist(route[k], p) + dist(p, route[k + 1]) - dist(route[k], route[k + 1]);
    if (added < bestAdded) {
      bestAdded = added;
      best = k;
    }
  }
  data.lineOfPlay = [...line.slice(0, best), { x: p.x, z: p.z }, ...line.slice(best)];
}

/** Index of the line-of-play point nearest (x, z) within `within` meters, or -1. */
export function nearestLinePoint(data: LevelData, x: number, z: number, within: number): number {
  return nearest(data.lineOfPlay ?? [], x, z, within);
}

/** Index of the object nearest (x, z) within `within` meters, or -1. */
export function nearestObject(data: LevelData, x: number, z: number, within: number): number {
  return nearest(data.objects, x, z, within);
}

function nearest(points: Point[], x: number, z: number, within: number): number {
  let best = -1;
  let bestD = within;
  points.forEach((p, i) => {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}
