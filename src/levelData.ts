import { surfaceId } from './surfaces';

/**
 * A hole as plain data: everything a Level is built from. World units are meters. The map is
 * the rectangle x ∈ [0, width], z ∈ [0, length], sampled by a grid of points GRID_STEP apart
 * that are also the terrain mesh's vertices.
 */
export interface LevelData {
  name: string;
  par: number;
  width: number;
  length: number;
  tee: Point;
  cup: Point;
  /** Points the hole bends through between the tee and the cup (both excluded). */
  lineOfPlay?: Point[];
  /** Entry 0 is the default wind; wind-zone grid values index into this list. */
  winds: Wind[];
  /** One point inside each water region, giving that region's surface height. */
  waterLevels: WaterLevel[];
  objects: LevelObject[];
  /** Row-major (index = row * cols + col), one value per grid point; see gridSize. */
  grids: {
    height: Float32Array;
    /** Surface ids (see SURFACE_LIST). */
    surface: Uint8Array;
    /** Indices into `winds`. */
    wind: Uint8Array;
  };
}

export interface Point {
  x: number;
  z: number;
}

export interface Wind {
  /** m/s */
  speed: number;
  /** Heading the wind blows toward, in degrees from +x toward +z. */
  direction: number;
}

export interface WaterLevel extends Point {
  level: number;
}

export interface LevelObject {
  /** Kind and variant, e.g. 'tree-pine'; see OBJECT_TYPES. */
  type: string;
  x: number;
  z: number;
  /** Height above the ground (m); 0 when omitted. */
  y?: number;
  /** Degrees about the vertical axis. */
  rotation: number;
  scale: number;
}

export const GRID_STEP = 0.8;

/** Grid points across (cols) and along (rows) a map, including both edges. */
export function gridSize(width: number, length: number): { cols: number; rows: number } {
  return { cols: Math.round(width / GRID_STEP) + 1, rows: Math.round(length / GRID_STEP) + 1 };
}

/** Index of the grid point nearest (x, z), clamped to the map. */
export function nearestIndex(cols: number, rows: number, x: number, z: number): number {
  const col = Math.min(cols - 1, Math.max(0, Math.round(x / GRID_STEP)));
  const row = Math.min(rows - 1, Math.max(0, Math.round(z / GRID_STEP)));
  return row * cols + col;
}

/** Water with no level given fills to this far (m) below the lowest ground around it. */
const WATER_BELOW_SHORE = 0.1;

/**
 * Labels each connected (4-neighbor) patch of water, as a region id per grid point (-1 where
 * there's no water), and gives each region the level of the first `waterLevels` point inside
 * it, or else fills it to just below the lowest ground around it.
 */
export function waterRegions(data: LevelData): { region: Int32Array; levels: number[] } {
  const { cols, rows } = gridSize(data.width, data.length);
  const { height, surface } = data.grids;
  const water = surfaceId('water');
  const region = new Int32Array(cols * rows).fill(-1);
  const levels: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < region.length; start++) {
    if (surface[start] !== water || region[start] >= 0) continue;
    const id = levels.length;
    let shore = Infinity;
    region[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop()!;
      const col = i % cols;
      const row = (i - col) / cols;
      for (const [ok, j] of [
        [col > 0, i - 1],
        [col < cols - 1, i + 1],
        [row > 0, i - cols],
        [row < rows - 1, i + cols],
      ] as const) {
        if (!ok) continue;
        if (surface[j] !== water) shore = Math.min(shore, height[j]);
        else if (region[j] < 0) {
          region[j] = id;
          stack.push(j);
        }
      }
    }
    levels.push(Number.isFinite(shore) ? shore - WATER_BELOW_SHORE : height[start]);
  }
  const seeded = new Set<number>();
  for (const s of data.waterLevels) {
    const id = region[nearestIndex(cols, rows, s.x, s.z)];
    if (id < 0) console.warn(`Water level at (${s.x}, ${s.z}) isn't on water, ignored`);
    else if (!seeded.has(id)) {
      levels[id] = s.level;
      seeded.add(id);
    }
  }
  return { region, levels };
}
