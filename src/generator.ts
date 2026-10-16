import * as THREE from 'three';
import { TILE_SIZE } from './level';
import { GRID_STEP, gridSize, type LevelData, type LevelObject, type Point, type WaterLevel, type Wind } from './levelData';
import { mulberry32, Noise2D } from './noise';
import { surfaceId, type Surface } from './surfaces';

const MAX_WIND = 9;
const PAR = 10;

/** Range of hole lengths along the fairway (m); each hole picks one at random. */
const HOLE_LENGTH_MIN = 1100;
const HOLE_LENGTH_MAX = 1400;
/** The green ends up to this far above or below the tee (m). */
const MAX_CLIMB = 200;
/** Height of each terrace step (m); bigger climbs get more steps. */
const TERRACE_HEIGHT = 45;
/** Length range of the straight-ish legs between the fairway's bends (m). */
const LEG_LENGTH_MIN = 110;
const LEG_LENGTH_MAX = 220;
/** Spacing of the resampled fairway centerline (m). */
const SEGMENT_LENGTH = 4;
/** Cell size of the grid that buckets nearby centerline segments for fast distance queries (m). */
const LOOKUP_CELL = 40;
/** The line of play keeps the centerline's bends to within this many meters. */
const LINE_OF_PLAY_TOLERANCE = 2;
/** Banks rise this far (m) beyond their start before leveling off; play ends where they level off. */
const BANK_RUN = 35;
/** Terrain tiles extend this far (m) past where the banks level off. */
const TILE_MARGIN = 10;
/** Trees are placed on a jittered grid of this spacing (m), then thinned by density. */
const TREE_SPACING = 6;
/**
 * Ground steeper than this (rise per meter) is left as rough rather than fairway: fairway only
 * holds a resting ball up to about 0.17, while rough holds the ball on hillsides.
 */
const FAIRWAY_MAX_SLOPE = 0.18;
/** Fairway half-width wanders around the mean by up to ± the spread, clamped to min/max (m). */
const MEAN_HALF_WIDTH = 14;
const HALF_WIDTH_SPREAD = 26;
const MIN_HALF_WIDTH = 6;
const MAX_HALF_WIDTH = 26;
/** The rasterized map extends this far (m) past the fairway centerline's bounding box: past the widest out-of-bounds line plus the trees beyond it. */
const MAP_MARGIN = MAX_HALF_WIDTH * 1.8 + BANK_RUN + TILE_MARGIN + 8;
/** Ground beside water is cut down to the water at this slope (rise per meter from the shore). */
const SHORE_SLOPE = 0.5;
/** How far from a water edge (m) its banks can be cut. */
const SHORE_REACH = 50;
/** Water sits this far below the shape's edge; the banks reach the surface just outside it. */
const SHORE_DROP = 0.15;
/** Distance outside a water shape's edge where the visible shoreline is. */
const SHORE_OFFSET = SHORE_DROP / SHORE_SLOPE;

/** An irregular blob: a rotated ellipse with angular harmonics bulging and pinching its outline. */
interface Blob {
  x: number;
  z: number;
  cos: number;
  sin: number;
  /** Semi-axes of the base ellipse. */
  a: number;
  b: number;
  /** Mean radius, used to turn normalized distances into meters. */
  size: number;
  lobes: { k: number; amp: number; phase: number }[];
  /** Radius that fully contains the blob, for quick rejection. */
  bound: number;
}

interface Bunker {
  blob: Blob;
  depth: number;
}

type WaterShape =
  | { kind: 'lake'; blob: Blob }
  /** A ring `mid` m outside the green's edge, `half` m half-width, open across a gap. */
  | { kind: 'moat'; mid: number; half: number; gapAngle: number; gapHalf: number }
  /** A band across the whole fairway corridor, centered `s0` m along the hole. */
  | { kind: 'creek'; s0: number; half: number };

type Water = WaterShape & {
  /** Height of the water surface. */
  level: number;
  depth: number;
  /** Bounding box of the water shape itself. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/** Approximate signed distance (meters) to a blob's outline; negative inside. */
function blobEdge(g: Blob, x: number, z: number): number {
  const dx = x - g.x;
  const dz = z - g.z;
  const u = (dx * g.cos + dz * g.sin) / g.a;
  const v = (-dx * g.sin + dz * g.cos) / g.b;
  const theta = Math.atan2(v, u);
  let edge = 1;
  for (const l of g.lobes) edge += l.amp * Math.cos(l.k * theta + l.phase);
  return (Math.hypot(u, v) - edge) * g.size;
}

/** Generates a random hole and samples it into level data. */
export function generateLevel(seed: number): LevelData {
  return new Generator(seed).toData();
}

/**
 * A randomly generated par-10 hole: a long winding fairway of varying width over terraced,
 * hilly ground, with bunkers, water and trees. The heightfield is analytic while generating;
 * `toData` samples it onto a level grid.
 */
class Generator {
  private readonly seed: number;
  /** Cup center on the XZ plane (x, z). */
  private readonly hole: THREE.Vector2;
  /** Length of the hole along the fairway centerline. */
  private readonly distance: number;
  private readonly wind: Wind;

  private readonly hills: Noise2D;
  private readonly bumps: Noise2D;
  private readonly detail: Noise2D;
  private readonly green: Blob;
  /** Fairway centerline as flattened (x, z) pairs, SEGMENT_LENGTH apart. */
  private readonly path: Float32Array;
  /** Distance along the centerline at each path point. */
  private readonly pathS: Float32Array;
  /** Fairway half-width at each path point. */
  private readonly halfWidths: Float32Array;
  /** Distance from the centerline beyond which nothing is built or played (covers every terrain tile). */
  private readonly reach = MAX_HALF_WIDTH * 1.8 + BANK_RUN + TILE_MARGIN + TILE_SIZE * Math.SQRT1_2 + 2;
  /** Segment lookup grid: cell (i, j) lists segments within `reach` of it. */
  private readonly lookup: { x0: number; z0: number; cols: number; rows: number; start: Int32Array; segs: Int32Array };
  /** Total rise from tee to green, reached in terraces. */
  private readonly climb: number;
  private readonly terraces: number;
  private readonly swell: { amp: number; waves: number; phase: number };
  private readonly teeBase: number;
  private readonly greenBase: number;
  private readonly bunkers: Bunker[] = [];
  private readonly waters: Water[] = [];
  private readonly trees: LevelObject[] = [];

  /** Centerline position (m along the path) of the last distToPath query, or -1 if none was in reach. */
  private lastS = -1;
  /** Which side of the centerline the last distToPath query was on: 1 or -1. */
  private lastSide = 1;
  private memoX = NaN;
  private memoZ = NaN;
  private memoD = 0;
  private memoS = -1;
  private memoSide = 1;

  constructor(seed: number) {
    this.seed = seed;
    const rand = mulberry32(seed);
    const range = (a: number, b: number) => a + (b - a) * rand();
    this.hills = new Noise2D(rand);
    this.bumps = new Noise2D(rand);
    this.detail = new Noise2D(rand);

    this.path = this.makePath(range, range(HOLE_LENGTH_MIN, HOLE_LENGTH_MAX));
    const n = this.path.length / 2;
    this.pathS = new Float32Array(n);
    this.halfWidths = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      if (k > 0) {
        this.pathS[k] =
          this.pathS[k - 1] +
          Math.hypot(this.path[k * 2] - this.path[k * 2 - 2], this.path[k * 2 + 1] - this.path[k * 2 - 1]);
      }
      // Fairway width wanders along the hole: some stretches narrow, some much wider.
      const wobble = this.detail.fbm(this.pathS[k] * 0.0045 + 3.7, 91.7, 2);
      this.halfWidths[k] = clamp(MEAN_HALF_WIDTH + HALF_WIDTH_SPREAD * wobble, MIN_HALF_WIDTH, MAX_HALF_WIDTH);
    }
    this.distance = this.pathS[n - 1];
    this.hole = new THREE.Vector2(this.path[n * 2 - 2], this.path[n * 2 - 1]);
    this.lookup = this.buildLookup();

    // Climb or drop, taken in terraces.
    this.climb = range(-MAX_CLIMB, MAX_CLIMB);
    this.terraces = Math.max(1, Math.round(Math.abs(this.climb) / TERRACE_HEIGHT));
    this.swell = { amp: range(0, 12), waves: Math.floor(range(1, 4)), phase: range(0, Math.PI * 2) };

    this.green = this.makeGreen(range);
    this.teeBase = this.rawHeight(0, 0);
    this.greenBase = this.rawHeight(this.hole.x, this.hole.y);

    this.placeWater(range, rand);
    this.placeBunkers(range);
    this.placeTrees(mulberry32(seed ^ 0x9e3779b9));

    // Wind direction is uniform; speed is skewed toward lighter breezes.
    const windAngle = range(0, 360);
    const windSpeed = MAX_WIND * Math.pow(rand(), 1.5);
    this.wind = { speed: windSpeed, direction: windAngle };
  }

  /**
   * Samples the hole onto a grid covering the fairway out past the trees beyond its
   * out-of-bounds lines, shifted so the map starts at the origin.
   */
  toData(): LevelData {
    const p = this.path;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      minX = Math.min(minX, p[i]);
      maxX = Math.max(maxX, p[i]);
      minZ = Math.min(minZ, p[i + 1]);
      maxZ = Math.max(maxZ, p[i + 1]);
    }
    const x0 = minX - MAP_MARGIN;
    const z0 = minZ - MAP_MARGIN;
    const width = Math.ceil((maxX + MAP_MARGIN - x0) / GRID_STEP) * GRID_STEP;
    const length = Math.ceil((maxZ + MAP_MARGIN - z0) / GRID_STEP) * GRID_STEP;
    const { cols, rows } = gridSize(width, length);

    const height = new Float32Array(cols * rows);
    const surface = new Uint8Array(cols * rows);
    const oob = surfaceId('oob');
    for (let row = 0; row < rows; row++) {
      const z = z0 + row * GRID_STEP;
      for (let col = 0; col < cols; col++) {
        const x = x0 + col * GRID_STEP;
        const i = row * cols + col;
        height[i] = this.heightAt(x, z);
        surface[i] = this.isOutOfBounds(x, z) ? oob : surfaceId(this.surfaceAt(x, z));
      }
    }

    // Seed each water body at a grid point inside it.
    const water = surfaceId('water');
    const waterLevels: WaterLevel[] = [];
    for (const w of this.waters) {
      const c0 = clamp(Math.ceil((w.minX - x0) / GRID_STEP), 0, cols - 1);
      const c1 = clamp(Math.floor((w.maxX - x0) / GRID_STEP), 0, cols - 1);
      const r0 = clamp(Math.ceil((w.minZ - z0) / GRID_STEP), 0, rows - 1);
      const r1 = clamp(Math.floor((w.maxZ - z0) / GRID_STEP), 0, rows - 1);
      search: for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          if (surface[row * cols + col] !== water) continue;
          if (this.waterEdge(w, x0 + col * GRID_STEP, z0 + row * GRID_STEP) >= SHORE_OFFSET) continue;
          waterLevels.push({ x: col * GRID_STEP, z: row * GRID_STEP, level: w.level });
          break search;
        }
      }
    }

    const local = (x: number, z: number): Point => ({ x: x - x0, z: z - z0 });
    return {
      name: `Random ${this.seed}`,
      par: PAR,
      width,
      length,
      tee: local(0, 0),
      cup: local(this.hole.x, this.hole.y),
      lineOfPlay: this.lineOfPlay().map((q) => local(q.x, q.z)),
      winds: [this.wind],
      waterLevels,
      objects: this.trees.map((t) => ({ ...t, ...local(t.x, t.z) })),
      grids: { height, surface, wind: new Uint8Array(cols * rows) },
    };
  }

  /**
   * The centerline's bends, between (and excluding) the tee and the cup: a simplification
   * of it that never strays more than LINE_OF_PLAY_TOLERANCE from it.
   */
  private lineOfPlay(): Point[] {
    const p = this.path;
    const n = p.length / 2;
    const keep = new Uint8Array(n);
    const spans: [number, number][] = [[0, n - 1]];
    while (spans.length > 0) {
      const [a, b] = spans.pop()!;
      const ax = p[a * 2];
      const az = p[a * 2 + 1];
      const abx = p[b * 2] - ax;
      const abz = p[b * 2 + 1] - az;
      let worst = -1;
      let far = LINE_OF_PLAY_TOLERANCE;
      for (let k = a + 1; k < b; k++) {
        const t = clamp(((p[k * 2] - ax) * abx + (p[k * 2 + 1] - az) * abz) / (abx * abx + abz * abz), 0, 1);
        const d = Math.hypot(p[k * 2] - ax - abx * t, p[k * 2 + 1] - az - abz * t);
        if (d > far) {
          far = d;
          worst = k;
        }
      }
      if (worst < 0) continue;
      keep[worst] = 1;
      spans.push([a, worst], [worst, b]);
    }
    const out: Point[] = [];
    for (let k = 1; k < n - 1; k++) if (keep[k]) out.push({ x: p[k * 2], z: p[k * 2 + 1] });
    return out;
  }

  private heightAt(x: number, z: number): number {
    return this.carveWater(x, z, this.landHeight(x, z));
  }

  private surfaceAt(x: number, z: number): Surface {
    if (!Number.isNaN(this.waterLevelAt(x, z))) return 'water';
    const outside = this.distanceOutsideGreen(x, z);
    if (outside < 0) return 'green';
    for (const b of this.bunkers) if (this.inBlobBound(b.blob, x, z) && blobEdge(b.blob, x, z) < 0) return 'bunker';
    // The fringe around the green is cut to fairway length.
    if (this.isFringe(x, z, outside)) return 'fairway';
    if (Math.hypot(x, z) < 2.5) return 'tee';
    const d = this.distToPath(x, z);
    if (this.lastS < 0) return 'rough';
    const edge = Math.max(4, this.halfWidthAt(this.lastS) + this.bumps.sample(x * 0.03 + 50, z * 0.03) * 3);
    return d < edge && this.steepness(x, z) < FAIRWAY_MAX_SLOPE ? 'fairway' : 'rough';
  }

  /** Height of the water surface if (x, z) is in water, otherwise NaN. */
  private waterLevelAt(x: number, z: number): number {
    for (const w of this.waters) {
      if (x < w.minX - 1 || x > w.maxX + 1 || z < w.minZ - 1 || z > w.maxZ + 1) continue;
      if (this.waterEdge(w, x, z) < SHORE_OFFSET) return w.level;
    }
    return NaN;
  }

  /** Out of bounds once the ball reaches the top of the banks. */
  private isOutOfBounds(x: number, z: number): boolean {
    const d = this.distToPath(x, z);
    return this.lastS < 0 || d > this.halfWidthAt(this.lastS) * 1.8 + BANK_RUN - 1;
  }

  // --- Ground --------------------------------------------------------------

  /** Terrain before water is cut into it. */
  private landHeight(x: number, z: number): number {
    let h = this.rawHeight(x, z);

    const tb = smoothstep(7, 3, Math.hypot(x, z));
    if (tb > 0) h = lerp(h, this.teeBase, tb);

    const dHole = Math.hypot(x - this.hole.x, z - this.hole.y);
    const gb = smoothstep(10, -0.3 * this.green.size, blobEdge(this.green, x, z));
    if (gb > 0) {
      // Gentle green undulation that fades out so the cup sits on level ground.
      const undulation = this.detail.fbm(x * 0.06, z * 0.06, 2) * 0.6 * smoothstep(1, 5, dHole);
      h = lerp(h, this.greenBase + undulation, gb);
    }

    // Bunkers are sunk below their surroundings, deepening from the lip.
    for (const b of this.bunkers) {
      if (!this.inBlobBound(b.blob, x, z)) continue;
      const e = blobEdge(b.blob, x, z);
      if (e < 0) h -= b.depth * smoothstep(0, 1.6, -e);
    }
    return h;
  }

  /** Terrain before the tee box, green and bunkers are shaped into it. */
  private rawHeight(x: number, z: number): number {
    let h = this.landform(x, z) + this.bumps.fbm(x * 0.07, z * 0.07, 2) * 0.35;
    const d = this.distToPath(x, z);
    // Banks rise away from the fairway along ridged stretches; wooded stretches stay flat.
    if (this.lastS >= 0) {
      const bank = Math.min(BANK_RUN, Math.max(0, d - this.halfWidthAt(this.lastS) * 1.8));
      h += bank * bank * 0.012 * this.ridged(this.lastS, this.lastSide);
    }
    return h;
  }

  /**
   * How ridged one side of the hole is at `s` m along it: 1 for rising banks, 0 for flat
   * ground lined with trees. Each side changes independently every few hundred meters.
   */
  private ridged(s: number, side: number): number {
    return smoothstep(-0.15, 0.15, this.detail.sample(s * 0.004 + side * 37.1, 55.5));
  }

  /** Large-scale shape of the ground: terraces along the hole plus rolling hills. */
  private landform(x: number, z: number): number {
    return this.elevation(z) + this.hills.fbm(x * 0.014, z * 0.014, 4) * 7;
  }

  /** Gradient magnitude of the large-scale landform (ignores banks, greens and bunkers). */
  private steepness(x: number, z: number): number {
    const e = 1;
    const gx = this.landform(x + e, z) - this.landform(x - e, z);
    const gz = this.landform(x, z + e) - this.landform(x, z - e);
    return Math.hypot(gx, gz) / (2 * e);
  }

  /**
   * Large-scale height along the hole. The hole runs toward -z without doubling back, so
   * height is a function of z: terraces (flat, then a slope, then flat) climbing or
   * dropping `climb` meters in total, plus a gentle swell that vanishes at both ends.
   */
  private elevation(z: number): number {
    const t = clamp(z / this.hole.y, 0, 1);
    const k = this.terraces;
    const step = Math.min(Math.floor(t * k), k - 1);
    const terraced = (step + smoothstep(0.2, 0.8, t * k - step)) / k;
    const s = this.swell;
    return this.climb * terraced + s.amp * Math.sin(Math.PI * t) * Math.sin(Math.PI * t * s.waves + s.phase);
  }

  /** Lowers the ground into each water body: a bed below the surface and banks cut down to it. */
  private carveWater(x: number, z: number, h: number): number {
    for (const w of this.waters) {
      if (x < w.minX - SHORE_REACH || x > w.maxX + SHORE_REACH || z < w.minZ - SHORE_REACH || z > w.maxZ + SHORE_REACH) {
        continue;
      }
      const e = this.waterEdge(w, x, z);
      if (e > SHORE_REACH) continue;
      const surface = w.level - SHORE_DROP;
      const cut = e >= 0 ? surface + e * SHORE_SLOPE : surface - w.depth * smoothstep(0, 4, -e);
      if (cut < h) h = cut;
    }
    return h;
  }

  /** Signed distance (m) to a water shape's edge; negative inside. */
  private waterEdge(w: Water, x: number, z: number): number {
    switch (w.kind) {
      case 'lake':
        return blobEdge(w.blob, x, z);
      case 'moat': {
        const g = this.green;
        const ring = Math.abs(blobEdge(g, x, z) - w.mid) - w.half;
        const gap = w.gapHalf - Math.abs(angleDiff(Math.atan2(z - g.z, x - g.x), w.gapAngle));
        return Math.max(ring, gap * (g.size + w.mid));
      }
      case 'creek': {
        this.distToPath(x, z);
        if (this.lastS < 0) return SHORE_REACH + 1;
        return Math.abs(this.lastS - w.s0) - w.half - this.bumps.sample(x * 0.05 + 13, z * 0.05) * 2.5;
      }
    }
  }

  private inBlobBound(g: Blob, x: number, z: number): boolean {
    return Math.abs(x - g.x) < g.bound && Math.abs(z - g.z) < g.bound;
  }

  // --- Fairway centerline ----------------------------------------------------

  /**
   * A winding centerline: legs of LEG_LENGTH_MIN-LEG_LENGTH_MAX m whose heading wanders but stays within about
   * 57° of straight ahead, so the hole never doubles back on itself. The legs are smoothed
   * with a Catmull-Rom spline and resampled every SEGMENT_LENGTH meters, ending at `length`.
   */
  private makePath(range: (a: number, b: number) => number, length: number): Float32Array {
    const pts: [number, number][] = [[0, 0]];
    let heading = range(-0.2, 0.2);
    let x = 0;
    let z = 0;
    let total = 0;
    while (total < length + 150) {
      const leg = range(LEG_LENGTH_MIN, LEG_LENGTH_MAX);
      x += Math.sin(heading) * leg;
      z -= Math.cos(heading) * leg;
      total += leg;
      pts.push([x, z]);
      heading = clamp(heading + range(-0.7, 0.7), -1, 1);
    }

    // Densely sample the spline, then walk it to place evenly spaced points.
    const dense: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      for (let k = 0; k < 64; k++) {
        const t = k / 64;
        const t2 = t * t;
        const t3 = t2 * t;
        for (let c = 0; c < 2; c++) {
          dense.push(
            0.5 *
              (2 * p1[c] +
                (-p0[c] + p2[c]) * t +
                (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 +
                (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3),
          );
        }
      }
    }

    const out: number[] = [0, 0];
    let travelled = 0;
    let next = SEGMENT_LENGTH;
    for (let i = 2; i < dense.length && travelled < length; i += 2) {
      const ax = dense[i - 2];
      const az = dense[i - 1];
      const seg = Math.hypot(dense[i] - ax, dense[i + 1] - az);
      while (travelled + seg >= Math.min(next, length) && out.length / 2 <= length / SEGMENT_LENGTH + 1) {
        const target = Math.min(next, length);
        const t = (target - travelled) / seg;
        out.push(ax + (dense[i] - ax) * t, az + (dense[i + 1] - az) * t);
        if (target >= length) break;
        next += SEGMENT_LENGTH;
      }
      travelled += seg;
    }
    // Avoid a degenerate final segment when the length lands just past a sample point.
    const m = out.length;
    if (m >= 6 && Math.hypot(out[m - 2] - out[m - 4], out[m - 1] - out[m - 3]) < 0.5) out.splice(m - 4, 2);
    return Float32Array.from(out);
  }

  /** Position and unit direction `s` meters along the centerline. */
  private pathAt(s: number): { x: number; z: number; dx: number; dz: number } {
    const p = this.path;
    const k = clamp(Math.floor(s / SEGMENT_LENGTH), 0, this.pathS.length - 2);
    const len = this.pathS[k + 1] - this.pathS[k];
    const t = clamp((s - this.pathS[k]) / len, 0, 1);
    const dx = (p[k * 2 + 2] - p[k * 2]) / len;
    const dz = (p[k * 2 + 3] - p[k * 2 + 1]) / len;
    return { x: p[k * 2] + dx * len * t, z: p[k * 2 + 1] + dz * len * t, dx, dz };
  }

  private halfWidthAt(s: number): number {
    const k = clamp(Math.floor(s / SEGMENT_LENGTH), 0, this.halfWidths.length - 2);
    const t = clamp((s - this.pathS[k]) / (this.pathS[k + 1] - this.pathS[k]), 0, 1);
    return lerp(this.halfWidths[k], this.halfWidths[k + 1], t);
  }

  /** Buckets centerline segments into grid cells so distance queries only check nearby ones. */
  private buildLookup(): Generator['lookup'] {
    const p = this.path;
    const r = this.reach;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      minX = Math.min(minX, p[i]);
      maxX = Math.max(maxX, p[i]);
      minZ = Math.min(minZ, p[i + 1]);
      maxZ = Math.max(maxZ, p[i + 1]);
    }
    const x0 = minX - r - LOOKUP_CELL;
    const z0 = minZ - r - LOOKUP_CELL;
    const cols = Math.ceil((maxX + r + LOOKUP_CELL - x0) / LOOKUP_CELL);
    const rows = Math.ceil((maxZ + r + LOOKUP_CELL - z0) / LOOKUP_CELL);
    const cells: number[][] = Array.from({ length: cols * rows }, () => []);
    for (let i = 0; i + 3 < p.length; i += 2) {
      const c0 = Math.floor((Math.min(p[i], p[i + 2]) - r - x0) / LOOKUP_CELL);
      const c1 = Math.floor((Math.max(p[i], p[i + 2]) + r - x0) / LOOKUP_CELL);
      const r0 = Math.floor((Math.min(p[i + 1], p[i + 3]) - r - z0) / LOOKUP_CELL);
      const r1 = Math.floor((Math.max(p[i + 1], p[i + 3]) + r - z0) / LOOKUP_CELL);
      for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) cells[row * cols + col].push(i);
    }
    const start = new Int32Array(cells.length + 1);
    for (let c = 0; c < cells.length; c++) start[c + 1] = start[c] + cells[c].length;
    return { x0, z0, cols, rows, start, segs: Int32Array.from(cells.flat()) };
  }

  /**
   * Distance to the fairway centerline, capped at `reach` (beyond which nothing depends on it).
   * Also records the nearest centerline position in `lastS`. Repeated queries for the same
   * point (common within one height lookup) are answered from a one-entry cache.
   */
  private distToPath(x: number, z: number): number {
    if (x === this.memoX && z === this.memoZ) {
      this.lastS = this.memoS;
      this.lastSide = this.memoSide;
      return this.memoD;
    }
    const L = this.lookup;
    const col = Math.floor((x - L.x0) / LOOKUP_CELL);
    const row = Math.floor((z - L.z0) / LOOKUP_CELL);
    let best = this.reach * this.reach;
    let bestS = -1;
    let bestSide = 1;
    if (col >= 0 && row >= 0 && col < L.cols && row < L.rows) {
      const cell = row * L.cols + col;
      const p = this.path;
      for (let k = L.start[cell]; k < L.start[cell + 1]; k++) {
        const i = L.segs[k];
        const ax = p[i];
        const az = p[i + 1];
        const abx = p[i + 2] - ax;
        const abz = p[i + 3] - az;
        const t = clamp(((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz), 0, 1);
        const dx = x - (ax + abx * t);
        const dz = z - (az + abz * t);
        const d = dx * dx + dz * dz;
        if (d < best) {
          best = d;
          const seg = i / 2;
          bestS = this.pathS[seg] + (this.pathS[seg + 1] - this.pathS[seg]) * t;
          bestSide = abx * (z - az) - abz * (x - ax) >= 0 ? 1 : -1;
        }
      }
    }
    this.memoX = x;
    this.memoZ = z;
    this.memoD = Math.sqrt(best);
    this.memoS = bestS;
    this.memoSide = bestSide;
    this.lastS = bestS;
    this.lastSide = bestSide;
    return this.memoD;
  }

  // --- Green -----------------------------------------------------------------

  /**
   * A rotated ellipse with random lobes, placed so the cup lies well inside it
   * (at most 25% of the way to the edge) and the ground around the cup stays level.
   */
  private makeGreen(range: (a: number, b: number) => number): Blob {
    const size = range(11, 16);
    const aspect = range(1, 1.4);
    const a = size * aspect;
    const b = size / aspect;
    const angle = range(0, Math.PI);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const lobes = [
      { k: 3, amp: range(0, 0.12), phase: range(0, Math.PI * 2) },
      { k: 4, amp: range(0, 0.08), phase: range(0, Math.PI * 2) },
      { k: 5, amp: range(0, 0.05), phase: range(0, Math.PI * 2) },
    ];
    // Cup offset from the green's center, in the ellipse's normalized coordinates.
    const r = 0.25 * Math.sqrt(range(0, 1));
    const phi = range(0, Math.PI * 2);
    const u = Math.cos(phi) * r * a;
    const v = Math.sin(phi) * r * b;
    return {
      x: this.hole.x - (u * cos - v * sin),
      z: this.hole.y - (u * sin + v * cos),
      cos,
      sin,
      a,
      b,
      size,
      lobes,
      bound: a * 1.3,
    };
  }

  /** Signed distance (meters) to the green's actual edge, including its small wobble; negative on the green. */
  private distanceOutsideGreen(x: number, z: number): number {
    return blobEdge(this.green, x, z) - this.detail.sample(x * 0.15, z * 0.15) * 0.6;
  }

  /** Width of the fringe around the green, varying between 0.5 and 2 m along the edge. */
  private fringeWidth(x: number, z: number): number {
    return clamp(1.25 + this.bumps.sample(x * 0.12 + 31, z * 0.12 - 17) * 1.1, 0.5, 2);
  }

  private isFringe(x: number, z: number, outside = this.distanceOutsideGreen(x, z)): boolean {
    if (outside < 0 || outside > 6) return false;
    // distanceOutsideGreen is only approximately metric; divide by its gradient for true meters.
    const e = 0.05;
    const gx = this.distanceOutsideGreen(x + e, z) - this.distanceOutsideGreen(x - e, z);
    const gz = this.distanceOutsideGreen(x, z + e) - this.distanceOutsideGreen(x, z - e);
    const grad = Math.hypot(gx, gz) / (2 * e);
    return outside / Math.max(grad, 0.2) < this.fringeWidth(x, z);
  }

  // --- Hazards ---------------------------------------------------------------

  private makeBlob(range: (a: number, b: number) => number, x: number, z: number, size: number, maxAspect: number): Blob {
    const aspect = range(1, maxAspect);
    const a = size * aspect;
    const b = size / aspect;
    const angle = range(0, Math.PI);
    const lobes = [
      { k: 2, amp: range(0, 0.15), phase: range(0, Math.PI * 2) },
      { k: 3, amp: range(0, 0.18), phase: range(0, Math.PI * 2) },
      { k: 5, amp: range(0, 0.08), phase: range(0, Math.PI * 2) },
    ];
    return { x, z, cos: Math.cos(angle), sin: Math.sin(angle), a, b, size, lobes, bound: a * 1.45 + 1 };
  }

  /** Lakes beside the fairway, sometimes a moat around the green, sometimes creeks across the hole. */
  private placeWater(range: (a: number, b: number) => number, rand: () => number): void {
    const L = this.distance;

    const lakes = Math.floor(range(1, 4));
    for (let i = 0, tries = 0; i < lakes && tries < 40; tries++) {
      const s = range(140, L - 140);
      const p = this.pathAt(s);
      const side = rand() < 0.5 ? -1 : 1;
      const size = range(10, 28);
      const offset = this.halfWidthAt(s) + range(-4, 22) + size * 0.6;
      const x = p.x - p.dz * offset * side;
      const z = p.z + p.dx * offset * side;
      const blob = this.makeBlob(range, x, z, size, 1.8);
      if (Math.hypot(x, z) < blob.bound + 25 || blobEdge(this.green, x, z) < blob.bound + 15) continue;
      if (this.waters.some((w) => w.kind === 'lake' && Math.hypot(w.blob.x - x, w.blob.z - z) < w.blob.bound + blob.bound)) continue;
      const lake: Water = {
        kind: 'lake',
        blob,
        level: 0,
        depth: range(1.5, 3),
        minX: x - blob.bound,
        maxX: x + blob.bound,
        minZ: z - blob.bound,
        maxZ: z + blob.bound,
      };
      lake.level = this.lowestShore(lake) - 0.1;
      this.waters.push(lake);
      i++;
    }

    if (rand() < 0.4) {
      // A moat ringing most of the green, its water just below the putting surface.
      const mid = range(6.5, 9);
      const half = range(2, 3.5);
      const g = this.green;
      const outer: number[] = [];
      for (let k = 0; k < 48; k++) {
        const theta = (k / 48) * Math.PI * 2;
        let r = g.size * 0.5;
        while (blobEdge(g, g.x + Math.cos(theta) * r, g.z + Math.sin(theta) * r) < mid + half && r < 80) r += 0.5;
        outer.push(this.landHeight(g.x + Math.cos(theta) * r, g.z + Math.sin(theta) * r));
      }
      const lowest = Math.min(...outer);
      // Skip it where the ground falls away too far below the green to hold a moat.
      if (lowest > this.greenBase - 3) {
        const extent = g.bound + mid + half + 2;
        const moat: Water = {
          kind: 'moat',
          mid,
          half,
          gapAngle: range(0, Math.PI * 2),
          gapHalf: range(0.5, 1.2),
          level: 0,
          depth: range(1, 1.5),
          minX: g.x - extent,
          maxX: g.x + extent,
          minZ: g.z - extent,
          maxZ: g.z + extent,
        };
        moat.level = Math.min(this.greenBase - 0.6, this.lowestShore(moat) - 0.1);
        this.waters.push(moat);
      }
    }

    const r = rand();
    const creeks = r < 0.3 ? 0 : r < 0.8 ? 1 : 2;
    const placed: number[] = [];
    for (let i = 0, tries = 0; i < creeks && tries < 40; tries++) {
      const s0 = range(200, L - 180);
      if (placed.some((s) => Math.abs(s - s0) < 200)) continue;
      // Prefer terrace flats, where a creek can cross without a deep cut.
      const a = this.pathAt(s0 - 15);
      const b = this.pathAt(s0 + 15);
      if (Math.abs(this.elevation(a.z) - this.elevation(b.z)) > 4 && tries < 30) continue;
      const half = range(5, 11);
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const s of [s0 - half - 3, s0 - half / 2, s0, s0 + half / 2, s0 + half + 3]) {
        const p = this.pathAt(s);
        const across = this.halfWidthAt(s) * 1.8 + BANK_RUN + 3;
        for (let l = -across; l <= across; l += 3) {
          const x = p.x - p.dz * l;
          const z = p.z + p.dx * l;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minZ = Math.min(minZ, z);
          maxZ = Math.max(maxZ, z);
        }
      }
      const creek: Water = { kind: 'creek', s0, half, level: 0, depth: range(1, 2), minX, maxX, minZ, maxZ };
      creek.level = this.lowestShore(creek) - 0.1;
      this.waters.push(creek);
      placed.push(s0);
      i++;
    }
  }

  /**
   * Lowest ground in the band just outside a water shape. Setting the water below it keeps
   * the surface from showing dry dips below the waterline.
   */
  private lowestShore(w: Water): number {
    let lowest = Infinity;
    for (let z = w.minZ - 4; z <= w.maxZ + 4; z += 1.5) {
      for (let x = w.minX - 4; x <= w.maxX + 4; x += 1.5) {
        const e = this.waterEdge(w, x, z);
        if (e >= 0 && e <= 3) lowest = Math.min(lowest, this.landHeight(x, z));
      }
    }
    return lowest;
  }

  /** Bunkers along the fairway edges and around the green, clear of water. */
  private placeBunkers(range: (a: number, b: number) => number): void {
    const clearOfWater = (blob: Blob) =>
      this.waters.every((w) => this.waterEdge(w, blob.x, blob.z) > blob.bound + 3);

    const fairway = Math.round(this.distance / 110);
    for (let i = 0, tries = 0; i < fairway && tries < fairway * 6; tries++) {
      const s = range(110, this.distance - 60);
      const p = this.pathAt(s);
      const side = range(0, 1) < 0.5 ? -1 : 1;
      const size = range(3.5, 9);
      const offset = this.halfWidthAt(s) + range(-3, 4);
      const x = p.x - p.dz * offset * side;
      const z = p.z + p.dx * offset * side;
      const blob = this.makeBlob(range, x, z, size, 2);
      if (blobEdge(this.green, x, z) < blob.bound + 3 || !clearOfWater(blob)) continue;
      this.bunkers.push({ blob, depth: range(0.5, 0.9) });
      i++;
    }

    const greenside = Math.floor(range(1, 4));
    const g = this.green;
    for (let i = 0, tries = 0; i < greenside && tries < 20; tries++) {
      const theta = range(0, Math.PI * 2);
      const size = range(3, 6);
      const gap = size * 1.45 + range(2.5, 4);
      let r = g.size * 0.5;
      while (blobEdge(g, g.x + Math.cos(theta) * r, g.z + Math.sin(theta) * r) < gap && r < 80) r += 0.25;
      const blob = this.makeBlob(range, g.x + Math.cos(theta) * r, g.z + Math.sin(theta) * r, size, 1.8);
      if (!clearOfWater(blob)) continue;
      if (this.bunkers.some((b) => Math.hypot(b.blob.x - blob.x, b.blob.z - blob.z) < b.blob.bound + blob.bound)) continue;
      this.bunkers.push({ blob, depth: range(0.6, 1) });
      i++;
    }
  }

  /**
   * Trees in the rough on wooded stretches: scattered near the fairway, thickening into forest
   * toward the out-of-bounds line (which also hides where the terrain ends). Ridged stretches
   * get only the odd tree. Uses its own random stream so it doesn't reshape the rest of the hole.
   */
  private placeTrees(rand: () => number): void {
    const L = this.lookup;
    for (let z = L.z0; z < L.z0 + L.rows * LOOKUP_CELL; z += TREE_SPACING) {
      for (let x = L.x0; x < L.x0 + L.cols * LOOKUP_CELL; x += TREE_SPACING) {
        const tx = x + rand() * TREE_SPACING;
        const tz = z + rand() * TREE_SPACING;
        const roll = rand();
        const kind = rand();
        const size = rand();
        const rotation = rand() * 360;
        const d = this.distToPath(tx, tz);
        if (this.lastS < 0) continue;
        const s = this.lastS;
        const hw = this.halfWidthAt(s);
        const outOfBounds = hw * 1.8 + BANK_RUN;
        if (d < hw + 4 || d > outOfBounds + TILE_MARGIN - 4) continue;
        const wooded = 1 - this.ridged(s, this.lastSide);
        const density = (0.06 + 0.7 * smoothstep(outOfBounds - 30, outOfBounds - 5, d)) * (0.1 + 0.9 * wooded);
        if (roll > density) continue;
        if (Math.hypot(tx, tz) < 20 || blobEdge(this.green, tx, tz) < 12) continue;
        if (this.surfaceAt(tx, tz) !== 'rough') continue;
        this.trees.push({ type: kind < 0.55 ? 'tree-pine' : 'tree-oak', x: tx, z: tz, rotation, scale: 0.75 + size * 0.5 });
      }
    }
  }
}
