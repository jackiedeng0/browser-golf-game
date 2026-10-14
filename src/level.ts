import * as THREE from 'three';
import { mulberry32, Noise2D } from './noise';

// World units are meters. The ball and cup are oversized (keeping the real
// ~2.5:1 cup-to-ball ratio) so they stay readable at course scale.
export const BALL_RADIUS = 0.12;
export const HOLE_RADIUS = 0.3;
export const CUP_DEPTH = 0.4;
export const PIN_RADIUS = 0.022;
export const PIN_HEIGHT = 3.0;
/** How far the flagstick is raised (m) while putting, lifting it clear of the ball. */
const PIN_LIFT = 1.6;
export const MAX_WIND = 9;
export const PAR = 10;

export type Surface = 'tee' | 'fairway' | 'green' | 'rough' | 'bunker' | 'water';

export interface SurfaceProps {
  /** Fraction of normal speed kept on a bounce. */
  restitution: number;
  /** Coulomb friction coefficient applied during impacts. */
  friction: number;
  /** Rolling resistance coefficient (deceleration = rolling * g). */
  rolling: number;
}

export const SURFACES: Record<Surface, SurfaceProps> = {
  tee: { restitution: 0.35, friction: 0.45, rolling: 0.1 },
  fairway: { restitution: 0.38, friction: 0.54, rolling: 0.12 },
  green: { restitution: 0.3, friction: 0.5, rolling: 0.08 },
  rough: { restitution: 0.22, friction: 1.56, rolling: 0.72 },
  // Soft sand: the ball barely bounces and stops quickly.
  bunker: { restitution: 0.08, friction: 1.2, rolling: 1.4 },
  // Lake and creek beds. A ball is out of play as soon as it reaches the water surface.
  water: { restitution: 0, friction: 1, rolling: 2 },
};

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
/** Terrain is built from square tiles that only cover the band around the fairway. */
const TILE_SIZE = 40;
const GRID_STEP = 0.8;
/** Banks rise this far (m) beyond their start before leveling off; play ends where they level off. */
const BANK_RUN = 35;
/** Terrain tiles extend this far (m) past where the banks level off. */
const TILE_MARGIN = 10;
/** Trees are placed on a jittered grid of this spacing (m), then thinned by density. */
const TREE_SPACING = 6;
/** Cell size (m) of the grid used to find trees near the ball. */
const TREE_CELL = 10;
/** Floats stored per tree in `trees`: x, z, ground y, trunk radius, trunk top y, canopy center y, canopy radius. */
export const TREE_STRIDE = 7;
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

/**
 * A randomly generated par-10 hole: a long winding fairway of varying width over terraced,
 * hilly ground, with bunkers and water. The heightfield is analytic and shared by rendering
 * and physics.
 */
export class Level {
  readonly seed: number;
  /** Ball start position (ball center). */
  readonly tee: THREE.Vector3;
  /** Cup center on the XZ plane (x, z). */
  readonly hole: THREE.Vector2;
  /** Height of the green at the cup rim. */
  readonly rimY: number;
  /** Length of the hole along the fairway centerline. */
  readonly distance: number;
  readonly par = PAR;
  /** Constant wind velocity for this hole (m/s, horizontal). */
  readonly wind: THREE.Vector3;
  readonly group = new THREE.Group();

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
  private readonly flag: THREE.Mesh;
  private readonly flagRest: Float32Array;
  private pin!: THREE.Mesh;
  /** True while the flagstick hovers above the cup; the ball can't hit it then. */
  pinLifted = false;
  private pinRaise = 0;
  private lastUpdate = 0;

  /** Centerline position (m along the path) of the last distToPath query, or -1 if none was in reach. */
  private lastS = -1;
  /** Which side of the centerline the last distToPath query was on: 1 or -1. */
  private lastSide = 1;
  private memoX = NaN;
  private memoZ = NaN;
  private memoD = 0;
  private memoS = -1;
  private memoSide = 1;

  /** Tree data, TREE_STRIDE floats per tree (see TREE_STRIDE). */
  trees = new Float32Array(0);
  private treeGrid = new Map<number, number[]>();
  private readonly treeQuery: number[] = [];

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
    this.rimY = this.greenBase;
    this.tee = new THREE.Vector3(0, this.teeBase + BALL_RADIUS, 0);

    this.placeWater(range, rand);
    this.placeBunkers(range);
    this.placeTrees(mulberry32(seed ^ 0x9e3779b9));

    this.group.add(this.buildTerrain());
    for (const w of this.waters) this.group.add(this.buildWater(w));
    this.group.add(this.buildTrees());
    this.group.add(this.buildCup());
    this.group.add(this.buildTeeMarkers());
    // Wind direction is uniform; speed is skewed toward lighter breezes.
    const windAngle = range(0, Math.PI * 2);
    const windSpeed = MAX_WIND * Math.pow(rand(), 1.5);
    this.wind = new THREE.Vector3(Math.cos(windAngle) * windSpeed, 0, Math.sin(windAngle) * windSpeed);
    this.flag = this.buildFlag();
    this.flagRest = Float32Array.from(this.flag.geometry.getAttribute('position').array);
  }

  heightAt(x: number, z: number): number {
    return this.carveWater(x, z, this.landHeight(x, z));
  }

  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = 0.05;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return out.set(-dx, 1, -dz).normalize();
  }

  surfaceAt(x: number, z: number): Surface {
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
  waterLevelAt(x: number, z: number): number {
    for (const w of this.waters) {
      if (x < w.minX - 1 || x > w.maxX + 1 || z < w.minZ - 1 || z > w.maxZ + 1) continue;
      if (this.waterEdge(w, x, z) < SHORE_OFFSET) return w.level;
    }
    return NaN;
  }

  /** Out of bounds once the ball reaches the top of the banks. */
  isOutOfBounds(x: number, z: number): boolean {
    const d = this.distToPath(x, z);
    return this.lastS < 0 || d > this.halfWidthAt(this.lastS) * 1.8 + BANK_RUN - 1;
  }

  /** Distance left to play: along the fairway, or straight at the pin once that's longer (e.g. near the green). */
  remainingDistance(x: number, z: number): number {
    const straight = Math.hypot(x - this.hole.x, z - this.hole.y);
    this.distToPath(x, z);
    return this.lastS < 0 ? straight : Math.max(straight, this.distance - this.lastS);
  }

  /**
   * The point `ahead` meters further along the fairway from (x, z), or the pin if that's
   * closer. Used to face the camera down the fairway rather than at a far-off pin.
   */
  targetAhead(x: number, z: number, ahead: number, out: THREE.Vector2): THREE.Vector2 {
    this.distToPath(x, z);
    if (this.lastS < 0 || this.distance - this.lastS <= ahead) return out.copy(this.hole);
    const p = this.pathAt(this.lastS + ahead);
    return out.set(p.x, p.z);
  }

  /** Raises the flagstick out of the cup (for putting) or puts it back. */
  liftPin(lifted: boolean): void {
    this.pinLifted = lifted;
  }

  /** Animates the flag in the wind (stronger wind flaps it faster and harder) and eases the pin up or down. */
  update(time: number): void {
    const dt = Math.min(0.1, time - this.lastUpdate);
    this.lastUpdate = time;
    const goal = this.pinLifted ? PIN_LIFT : 0;
    this.pinRaise += (goal - this.pinRaise) * (1 - Math.exp(-dt * 5));
    this.pin.position.y = -CUP_DEPTH + PIN_HEIGHT / 2 + this.pinRaise;
    this.flag.position.y = this.rimY - CUP_DEPTH + PIN_HEIGHT - 0.36 + this.pinRaise;

    const pos = this.flag.geometry.getAttribute('position') as THREE.BufferAttribute;
    const rest = this.flagRest;
    const strength = Math.min(1, this.wind.length() / 6);
    const amp = 0.03 + 0.08 * strength;
    const t = time * (3 + 5 * strength);
    for (let i = 0; i < pos.count; i++) {
      const x = rest[i * 3];
      const wave = Math.sin(x * 5 - t) * amp * x + Math.sin(x * 9 - t * 1.5) * amp * 0.25 * x;
      pos.setZ(i, rest[i * 3 + 2] + wave);
    }
    pos.needsUpdate = true;
    this.flag.geometry.computeVertexNormals();
  }

  dispose(): void {
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m.dispose();
      }
    });
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
  private buildLookup(): Level['lookup'] {
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

  /** Uncapped nearest point on the centerline; only used while building the level. */
  private exactNearest(x: number, z: number): { d: number; s: number } {
    const p = this.path;
    let best = Infinity;
    let s = 0;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i];
      const az = p[i + 1];
      const abx = p[i + 2] - ax;
      const abz = p[i + 3] - az;
      const t = clamp(((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz), 0, 1);
      const d = (x - ax - abx * t) ** 2 + (z - az - abz * t) ** 2;
      if (d < best) {
        best = d;
        s = this.pathS[i / 2] + (this.pathS[i / 2 + 1] - this.pathS[i / 2]) * t;
      }
    }
    return { d: Math.sqrt(best), s };
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
    const data: number[] = [];
    const L = this.lookup;
    for (let z = L.z0; z < L.z0 + L.rows * LOOKUP_CELL; z += TREE_SPACING) {
      for (let x = L.x0; x < L.x0 + L.cols * LOOKUP_CELL; x += TREE_SPACING) {
        const tx = x + rand() * TREE_SPACING;
        const tz = z + rand() * TREE_SPACING;
        const roll = rand();
        const kind = rand();
        const r1 = rand();
        const r2 = rand();
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
        const ground = this.heightAt(tx, tz);
        const trunkR = 0.25 + r1 * 0.2;
        if (kind < 0.55) {
          // Pine: short trunk under a tall cone; its physics canopy is the cone's lower bulk.
          const trunkTop = ground + 1.8 + r2 * 1.5;
          const coneR = 2 + r1 * 1.3;
          const coneH = 6 + r2 * 4;
          data.push(tx, tz, ground, trunkR, trunkTop, trunkTop + coneH * 0.3, coneR, 0, coneH);
        } else {
          // Broadleaf: taller trunk under a round crown.
          const trunkTop = ground + 2.5 + r2 * 1.5;
          const crownR = 2.2 + r1 * 1.6;
          data.push(tx, tz, ground, trunkR, trunkTop, trunkTop + crownR * 0.6, crownR, 1, 0);
        }
      }
    }
    // Physics data keeps TREE_STRIDE floats per tree; the last two (kind, cone height) are only for meshes.
    const count = data.length / 9;
    this.trees = new Float32Array(count * TREE_STRIDE);
    this.treeShapes = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < TREE_STRIDE; k++) this.trees[i * TREE_STRIDE + k] = data[i * 9 + k];
      this.treeShapes[i * 2] = data[i * 9 + 7];
      this.treeShapes[i * 2 + 1] = data[i * 9 + 8];
      const key = this.treeKey(Math.floor(data[i * 9] / TREE_CELL), Math.floor(data[i * 9 + 1] / TREE_CELL));
      const list = this.treeGrid.get(key);
      if (list) list.push(i);
      else this.treeGrid.set(key, [i]);
    }
  }

  private treeShapes = new Float32Array(0);

  private treeKey(col: number, row: number): number {
    return (col + 32768) * 65536 + (row + 32768);
  }

  /** Indices of trees whose cell neighbors (x, z). The returned array is reused between calls. */
  treesNear(x: number, z: number): readonly number[] {
    const out = this.treeQuery;
    out.length = 0;
    const col = Math.floor(x / TREE_CELL);
    const row = Math.floor(z / TREE_CELL);
    for (let r = row - 1; r <= row + 1; r++) {
      for (let c = col - 1; c <= col + 1; c++) {
        const list = this.treeGrid.get(this.treeKey(c, r));
        if (list) for (const i of list) out.push(i);
      }
    }
    return out;
  }

  // --- Meshes ----------------------------------------------------------------

  /** All trees as three instanced meshes: trunks, pine cones and round crowns. */
  private buildTrees(): THREE.Group {
    const group = new THREE.Group();
    const count = this.trees.length / TREE_STRIDE;
    const pines = Array.from({ length: count }, (_, i) => i).filter((i) => this.treeShapes[i * 2] === 0);
    const rounds = Array.from({ length: count }, (_, i) => i).filter((i) => this.treeShapes[i * 2] === 1);

    const trunks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1, 1, 6).translate(0, 0.5, 0),
      new THREE.MeshStandardMaterial({ color: 0x5b4030, roughness: 0.9 }),
      Math.max(1, count),
    );
    const cones = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 1, 8).translate(0, 0.5, 0),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, flatShading: true }),
      Math.max(1, pines.length),
    );
    const crowns = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, flatShading: true }),
      Math.max(1, rounds.length),
    );
    trunks.count = count;
    cones.count = pines.length;
    crowns.count = rounds.length;

    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    const t = this.trees;
    for (let i = 0; i < count; i++) {
      const o = i * TREE_STRIDE;
      const trunkH = t[o + 4] - t[o + 2] + 0.6;
      m.makeScale(t[o + 3], trunkH, t[o + 3]).setPosition(t[o], t[o + 2] - 0.3, t[o + 1]);
      trunks.setMatrixAt(i, m);
    }
    pines.forEach((i, n) => {
      const o = i * TREE_STRIDE;
      m.makeScale(t[o + 6], this.treeShapes[i * 2 + 1], t[o + 6]).setPosition(t[o], t[o + 4] - 0.6, t[o + 1]);
      cones.setMatrixAt(n, m);
      cones.setColorAt(n, c.setHSL(0.33 + (t[o + 3] - 0.35) * 0.2, 0.45, 0.2 + (t[o + 6] - 2.6) * 0.03));
    });
    rounds.forEach((i, n) => {
      const o = i * TREE_STRIDE;
      m.makeScale(t[o + 6], t[o + 6] * 0.85, t[o + 6]).setPosition(t[o], t[o + 5], t[o + 1]);
      crowns.setMatrixAt(n, m);
      crowns.setColorAt(n, c.setHSL(0.25 + (t[o + 3] - 0.35) * 0.3, 0.5, 0.27 + (t[o + 6] - 3) * 0.03));
    });

    for (const mesh of [trunks, cones, crowns]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
    return group;
  }

  /** Terrain as square tiles covering only the band around the fairway (out to just past the bank tops). */
  private buildTerrain(): THREE.Group {
    const terrain = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    // Cut the cup out of the terrain surface.
    const hole = new THREE.Vector3(this.hole.x, this.hole.y, HOLE_RADIUS);
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uHole = { value: hole };
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'varying vec3 vGolfWorld;\nvoid main() {')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGolfWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader.replace(
        'void main() {',
        'uniform vec3 uHole;\nvarying vec3 vGolfWorld;\nvoid main() {\n  if (distance(vGolfWorld.xz, uHole.xy) < uHole.z) discard;',
      );
    };

    const L = this.lookup;
    const tx0 = Math.floor(L.x0 / TILE_SIZE);
    const tz0 = Math.floor(L.z0 / TILE_SIZE);
    const tx1 = Math.ceil((L.x0 + L.cols * LOOKUP_CELL) / TILE_SIZE);
    const tz1 = Math.ceil((L.z0 + L.rows * LOOKUP_CELL) / TILE_SIZE);
    for (let tz = tz0; tz < tz1; tz++) {
      for (let tx = tx0; tx < tx1; tx++) {
        const x0 = tx * TILE_SIZE;
        const z0 = tz * TILE_SIZE;
        const near = this.exactNearest(x0 + TILE_SIZE / 2, z0 + TILE_SIZE / 2);
        const keep = this.halfWidthAt(near.s) * 1.8 + BANK_RUN + TILE_MARGIN;
        if (near.d > keep) continue;
        const mesh = new THREE.Mesh(this.buildTile(x0, z0), material);
        mesh.receiveShadow = true;
        terrain.add(mesh);
      }
    }
    return terrain;
  }

  private buildTile(x0: number, z0: number): THREE.BufferGeometry {
    const n = Math.round(TILE_SIZE / GRID_STEP) + 1;
    // Heights with a one-vertex border so normals match across tile seams.
    const w = n + 2;
    const heights = new Float32Array(w * w);
    for (let j = 0; j < w; j++) {
      for (let i = 0; i < w; i++) heights[j * w + i] = this.heightAt(x0 + (i - 1) * GRID_STEP, z0 + (j - 1) * GRID_STEP);
    }

    const positions = new Float32Array(n * n * 3);
    const normals = new Float32Array(n * n * 3);
    const colors = new Float32Array(n * n * 3);
    const palette: Record<Surface, THREE.Color> = {
      tee: new THREE.Color(0x5cae3e),
      fairway: new THREE.Color(0x4f9e34),
      green: new THREE.Color(0x63c24a),
      rough: new THREE.Color(0x2f6b25),
      bunker: new THREE.Color(0xdcc690),
      water: new THREE.Color(0x3a4f36),
    };
    const c = new THREE.Color();
    const nrm = new THREE.Vector3();

    for (let j = 0; j < n; j++) {
      const z = z0 + j * GRID_STEP;
      for (let i = 0; i < n; i++) {
        const x = x0 + i * GRID_STEP;
        const v = (j * n + i) * 3;
        const h = (j + 1) * w + (i + 1);
        positions[v] = x;
        positions[v + 1] = heights[h];
        positions[v + 2] = z;
        nrm
          .set(-(heights[h + 1] - heights[h - 1]) / (2 * GRID_STEP), 1, -(heights[h + w] - heights[h - w]) / (2 * GRID_STEP))
          .normalize();
        normals[v] = nrm.x;
        normals[v + 1] = nrm.y;
        normals[v + 2] = nrm.z;

        const surface = this.surfaceAt(x, z);
        c.copy(palette[surface]);
        // Fringe is left unstriped so it reads as a collar around the green.
        if (surface === 'fairway' && !this.isFringe(x, z)) c.multiplyScalar(Math.floor(z / 4) & 1 ? 1.07 : 0.95);
        else if (surface === 'green') c.multiplyScalar(Math.floor((x + z) / 2.5) & 1 ? 1.05 : 0.96);
        c.multiplyScalar(1 + this.bumps.sample(x * 0.2, z * 0.2) * (surface === 'bunker' ? 0.04 : 0.08));
        colors[v] = c.r;
        colors[v + 1] = c.g;
        colors[v + 2] = c.b;
      }
    }

    const indices = new Uint16Array((n - 1) * (n - 1) * 6);
    let k = 0;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        const b = a + 1;
        const d = a + n;
        const e = d + 1;
        indices.set([a, d, b, b, d, e], k);
        k += 6;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    return geometry;
  }

  /** A flat water surface covering the shape out to the visible shoreline. */
  private buildWater(w: Water): THREE.Mesh {
    const step = 1;
    const x0 = w.minX - 2;
    const z0 = w.minZ - 2;
    const nx = Math.ceil((w.maxX + 2 - x0) / step) + 1;
    const nz = Math.ceil((w.maxZ + 2 - z0) / step) + 1;
    const inside = new Uint8Array(nx * nz);
    const positions = new Float32Array(nx * nz * 3);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = x0 + i * step;
        const z = z0 + j * step;
        const v = j * nx + i;
        positions.set([x, w.level, z], v * 3);
        // Slightly past the shoreline; the banks rise through the surface and hide the edge.
        inside[v] = this.waterEdge(w, x, z) < SHORE_OFFSET + 0.6 ? 1 : 0;
      }
    }
    const indices: number[] = [];
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const d = a + nx;
        const e = d + 1;
        if (inside[a] && inside[d] && inside[b]) indices.push(a, d, b);
        if (inside[b] && inside[d] && inside[e]) indices.push(b, d, e);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0x2f6fa8, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.85 }),
    );
    mesh.receiveShadow = true;
    return mesh;
  }

  private buildCup(): THREE.Group {
    const cup = new THREE.Group();
    cup.position.set(this.hole.x, this.rimY, this.hole.y);

    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(HOLE_RADIUS, HOLE_RADIUS, CUP_DEPTH, 40, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x4a4640, roughness: 0.9, side: THREE.BackSide }),
    );
    wall.position.y = -CUP_DEPTH / 2;
    wall.receiveShadow = true;

    const bottom = new THREE.Mesh(
      new THREE.CircleGeometry(HOLE_RADIUS, 40).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x2b2118, roughness: 1 }),
    );
    bottom.position.y = -CUP_DEPTH + 0.001;
    bottom.receiveShadow = true;

    const pin = new THREE.Mesh(
      new THREE.CylinderGeometry(PIN_RADIUS, PIN_RADIUS, PIN_HEIGHT, 10),
      new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.4 }),
    );
    pin.position.y = -CUP_DEPTH + PIN_HEIGHT / 2;
    pin.castShadow = true;
    this.pin = pin;

    cup.add(wall, bottom, pin);
    return cup;
  }

  private buildFlag(): THREE.Mesh {
    const geometry = new THREE.PlaneGeometry(1.0, 0.65, 16, 4).translate(0.5, 0, 0);
    const flag = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0xe0262b, roughness: 0.7, side: THREE.DoubleSide }),
    );
    flag.position.set(this.hole.x, this.rimY - CUP_DEPTH + PIN_HEIGHT - 0.36, this.hole.y);
    // Point the flag downwind; in light air it droops toward the pole.
    const droop = (1 - Math.min(1, this.wind.length() / 5)) * 1.1;
    flag.rotation.set(0, Math.atan2(-this.wind.z, this.wind.x), -droop);
    flag.castShadow = true;
    this.group.add(flag);
    return flag;
  }

  private buildTeeMarkers(): THREE.Group {
    const markers = new THREE.Group();
    const dirX = this.path[2];
    const dirZ = this.path[3];
    const len = Math.hypot(dirX, dirZ);
    const geometry = new THREE.SphereGeometry(0.14, 16, 12);
    const material = new THREE.MeshStandardMaterial({ color: 0x2b6fd6, roughness: 0.4 });
    for (const side of [-1, 1]) {
      const x = (-dirZ / len) * 1.8 * side;
      const z = (dirX / len) * 1.8 * side;
      const marker = new THREE.Mesh(geometry, side < 0 ? material : material.clone());
      marker.position.set(x, this.heightAt(x, z) + 0.1, z);
      marker.castShadow = true;
      markers.add(marker);
    }
    return markers;
  }
}
