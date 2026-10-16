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
