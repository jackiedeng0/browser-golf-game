import { GRID_STEP, gridSize, type LevelData } from './levelData';
import { surfaceId, type Surface } from './surfaces';

/** A small level whose grid is filled from functions of the grid point's world position. */
export function makeData(
  opts: Partial<Omit<LevelData, 'grids'>> & {
    height?: (x: number, z: number) => number;
    surface?: (x: number, z: number) => Surface;
    wind?: (x: number, z: number) => number;
  } = {},
): LevelData {
  const width = opts.width ?? 16;
  const length = opts.length ?? 40;
  const { cols, rows } = gridSize(width, length);
  const height = new Float32Array(cols * rows);
  const surface = new Uint8Array(cols * rows);
  const wind = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * GRID_STEP;
      const z = row * GRID_STEP;
      height[row * cols + col] = opts.height?.(x, z) ?? 0;
      surface[row * cols + col] = surfaceId(opts.surface?.(x, z) ?? 'fairway');
      wind[row * cols + col] = opts.wind?.(x, z) ?? 0;
    }
  }
  return {
    name: 'Test',
    par: 3,
    width,
    length,
    tee: opts.tee ?? { x: 8, z: 36 },
    cup: opts.cup ?? { x: 8, z: 4 },
    lineOfPlay: opts.lineOfPlay,
    winds: opts.winds ?? [{ speed: 0, direction: 0 }],
    waterLevels: opts.waterLevels ?? [],
    objects: opts.objects ?? [],
    grids: { height, surface, wind },
  };
}
