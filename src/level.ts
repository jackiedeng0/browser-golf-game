import * as THREE from 'three';
import { GRID_STEP, gridSize, type LevelData } from './levelData';
import { mulberry32, Noise2D } from './noise';
import { OBJECT_TYPES, type ObjectDef } from './objects';
import { SURFACE_LIST, SURFACES, surfaceId, type Surface } from './surfaces';

// World units are meters. The ball and cup are oversized (keeping the real
// ~2.5:1 cup-to-ball ratio) so they stay readable at course scale.
export const BALL_RADIUS = 0.12;
export const HOLE_RADIUS = 0.3;
export const CUP_DEPTH = 0.4;
export const PIN_RADIUS = 0.022;
export const PIN_HEIGHT = 3.0;
/** How far the flagstick is raised (m) while putting, lifting it clear of the ball. */
const PIN_LIFT = 1.6;
/** Terrain is drawn in square tiles of this many grid cells a side. */
const TILE_CELLS = 50;
/** Side of a terrain tile (m). */
export const TILE_SIZE = TILE_CELLS * GRID_STEP;
/** Cell size (m) of the grid used to find trees near the ball. */
const TREE_CELL = 10;
/** Floats stored per tree in `trees`: x, z, ground y, trunk radius, trunk top y, canopy center y, canopy radius. */
export const TREE_STRIDE = 7;
/** Water with no level given fills to this far (m) below the lowest ground around it. */
const WATER_BELOW_SHORE = 0.1;
/** Out-of-bounds terrain is drawn this far (m) past playable ground, then left out. */
const OOB_DRAW_MARGIN = 16;
/** Wind changes from one zone's to the next's over about this distance (m) across their border. */
const WIND_BLEND = 10;

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

interface TreeMesh {
  def: ObjectDef;
  scale: number;
  rotation: number;
}

/**
 * A hole built from level data: a heightfield and painted surfaces on a grid, plus the tee,
 * cup, line of play, water, wind and objects. Rendering and physics read the same grid, so
 * what you see is what the ball plays on.
 */
export class Level {
  readonly name: string;
  readonly par: number;
  readonly width: number;
  readonly length: number;
  /** Ball start position (ball center). */
  readonly tee: THREE.Vector3;
  /** Cup center on the XZ plane (x, z). */
  readonly hole: THREE.Vector2;
  /** Height of the green at the cup rim. */
  readonly rimY: number;
  /** Length of the hole along the line of play. */
  readonly distance: number;
  readonly group = new THREE.Group();

  private readonly cols: number;
  private readonly rows: number;
  private readonly heights: Float32Array;
  private readonly surfaces: Uint8Array;
  /** Water region of each grid point, or -1 where there's no water. */
  private readonly waterRegion: Int32Array;
  /** Surface height of each water region. */
  private readonly regionLevels: number[] = [];
  /** Tee, line of play, cup as flattened (x, z) pairs. */
  private readonly route: Float32Array;
  /** Distance along the route at each of its points. */
  private readonly routeS: Float32Array;
  /** Wind (m/s) where no zone is painted. */
  private readonly defaultWind: THREE.Vector3;
  /** Wind at each grid point as (x, z) pairs, blended across zone borders; null when no zones are painted. */
  private readonly windField: Float32Array | null;
  /** Wind at the cup, which the flag shows. */
  private readonly flagWind = new THREE.Vector3();
  /** Without a line of play, the camera aims straight at the pin. */
  private readonly hasLineOfPlay: boolean;
  private readonly flag: THREE.Mesh;
  private readonly flagRest: Float32Array;
  private pin!: THREE.Mesh;
  /** True while the flagstick hovers above the cup; the ball can't hit it then. */
  pinLifted = false;
  private pinRaise = 0;
  private lastUpdate = 0;

  /** Tree data, TREE_STRIDE floats per tree (see TREE_STRIDE). */
  readonly trees: Float32Array;
  private readonly treeMeshes: TreeMesh[] = [];
  private readonly treeGrid = new Map<number, number[]>();
  private readonly treeQuery: number[] = [];

  constructor(data: LevelData) {
    this.name = data.name;
    this.par = data.par;
    this.width = data.width;
    this.length = data.length;
    ({ cols: this.cols, rows: this.rows } = gridSize(data.width, data.length));
    const g = data.grids;
    const n = this.cols * this.rows;
    if (g.height.length !== n || g.surface.length !== n || g.wind.length !== n) {
      throw new Error(`Level grids don't match a ${data.width} × ${data.length} m map`);
    }
    this.heights = g.height;
    this.surfaces = g.surface;

    this.tee = new THREE.Vector3(data.tee.x, this.heightAt(data.tee.x, data.tee.z) + BALL_RADIUS, data.tee.z);
    this.hole = new THREE.Vector2(data.cup.x, data.cup.z);
    this.rimY = this.heightAt(data.cup.x, data.cup.z);

    this.hasLineOfPlay = (data.lineOfPlay ?? []).length > 0;
    const points = [data.tee, ...(data.lineOfPlay ?? []), data.cup];
    this.route = Float32Array.from(points.flatMap((p) => [p.x, p.z]));
    this.routeS = new Float32Array(points.length);
    for (let k = 1; k < points.length; k++) {
      this.routeS[k] = this.routeS[k - 1] + Math.hypot(points[k].x - points[k - 1].x, points[k].z - points[k - 1].z);
    }
    this.distance = this.routeS[points.length - 1];

    const winds = data.winds.map((w) => {
      const angle = (w.direction * Math.PI) / 180;
      return new THREE.Vector3(Math.cos(angle) * w.speed, 0, Math.sin(angle) * w.speed);
    });
    this.defaultWind = winds[0] ?? new THREE.Vector3();
    this.windField = this.blendWindZones(g.wind, winds);
    this.windAt(this.hole.x, this.hole.y, this.flagWind);

    this.waterRegion = this.findWaterRegions(data.waterLevels);
    this.trees = this.placeObjects(data);

    this.group.add(this.buildTerrain());
    this.group.add(this.buildWater());
    this.group.add(this.buildTrees());
    this.group.add(this.buildCup());
    this.group.add(this.buildTeeMarkers());
    this.flag = this.buildFlag();
    this.flagRest = Float32Array.from(this.flag.geometry.getAttribute('position').array);
  }

  /**
   * Ground height, interpolated across the same triangles the terrain is drawn with. Each
   * grid cell is split along the diagonal from its (+x, -z) corner to its (-x, +z) corner.
   * Off the map, the edge is extended outward.
   */
  heightAt(x: number, z: number): number {
    const { i, fx, fz } = this.cell(x, z);
    const h = this.heights;
    const a = h[i];
    const b = h[i + 1];
    const d = h[i + this.cols];
    if (fx + fz <= 1) return a + (b - a) * fx + (d - a) * fz;
    const e = h[i + this.cols + 1];
    return e + (d - e) * (1 - fx) + (b - e) * (1 - fz);
  }

  /** Upward normal of the triangle under (x, z). */
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const { i, fx, fz } = this.cell(x, z);
    const h = this.heights;
    const lower = fx + fz <= 1;
    let gx = lower ? h[i + 1] - h[i] : h[i + this.cols + 1] - h[i + this.cols];
    let gz = lower ? h[i + this.cols] - h[i] : h[i + this.cols + 1] - h[i + 1];
    // Off the map the edge is extended flat.
    if (x < 0 || x > this.width) gx = 0;
    if (z < 0 || z > this.length) gz = 0;
    return out.set(-gx / GRID_STEP, 1, -gz / GRID_STEP).normalize();
  }

  /** Surface painted at the nearest grid point. */
  surfaceAt(x: number, z: number): Surface {
    return SURFACE_LIST[this.surfaces[this.nearest(x, z)]];
  }

  /** Wind velocity (m/s, horizontal) at (x, z), interpolated between grid points. */
  windAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const f = this.windField;
    if (!f) return out.copy(this.defaultWind);
    const { i, fx, fz } = this.cell(x, z);
    const j = i + this.cols;
    const lerp2 = (k: number) =>
      (f[i * 2 + k] * (1 - fx) + f[i * 2 + 2 + k] * fx) * (1 - fz) + (f[j * 2 + k] * (1 - fx) + f[j * 2 + 2 + k] * fx) * fz;
    return out.set(lerp2(0), 0, lerp2(1));
  }

  /** Height of the water surface if (x, z) is in water, otherwise NaN. */
  waterLevelAt(x: number, z: number): number {
    const region = this.waterRegion[this.nearest(x, z)];
    return region < 0 ? NaN : this.regionLevels[region];
  }

  /** True outside the map's rectangle, x ∈ [0, width] and z ∈ [0, length]. A ball there is out even while moving. */
  isOffMap(x: number, z: number): boolean {
    return x < 0 || z < 0 || x > this.width || z > this.length;
  }

  /** Whether a ball at rest at (x, z) is out: on painted out-of-bounds ground or off the map. */
  isOutOfBounds(x: number, z: number): boolean {
    return this.isOffMap(x, z) || this.surfaceAt(x, z) === 'oob';
  }

  /** Distance left to play: along the line of play, or straight at the pin once that's longer (e.g. near the green). */
  remainingDistance(x: number, z: number): number {
    const straight = Math.hypot(x - this.hole.x, z - this.hole.y);
    return Math.max(straight, this.distance - this.projectOnRoute(x, z));
  }

  /**
   * The point `ahead` meters further along the line of play from (x, z), or the pin if that's
   * closer or there's no line of play. Used to face the camera down the fairway rather than at
   * a far-off pin.
   */
  targetAhead(x: number, z: number, ahead: number, out: THREE.Vector2): THREE.Vector2 {
    if (!this.hasLineOfPlay) return out.copy(this.hole);
    const s = this.projectOnRoute(x, z) + ahead;
    if (s >= this.distance) return out.copy(this.hole);
    const r = this.route;
    let k = 0;
    while (k < this.routeS.length - 2 && this.routeS[k + 1] < s) k++;
    const t = (s - this.routeS[k]) / (this.routeS[k + 1] - this.routeS[k]);
    return out.set(r[k * 2] + (r[k * 2 + 2] - r[k * 2]) * t, r[k * 2 + 1] + (r[k * 2 + 3] - r[k * 2 + 1]) * t);
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
    const strength = Math.min(1, this.flagWind.length() / 6);
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

  // --- Grid ------------------------------------------------------------------

  /** The grid cell holding (x, z), clamped to the map: index of its (-x, -z) corner and the position within it (0-1). */
  private cell(x: number, z: number): { i: number; fx: number; fz: number } {
    const gx = clamp(x / GRID_STEP, 0, this.cols - 1);
    const gz = clamp(z / GRID_STEP, 0, this.rows - 1);
    const col = Math.min(Math.floor(gx), this.cols - 2);
    const row = Math.min(Math.floor(gz), this.rows - 2);
    return { i: row * this.cols + col, fx: gx - col, fz: gz - row };
  }

  /** Index of the grid point nearest (x, z), clamped to the map. */
  private nearest(x: number, z: number): number {
    const col = clamp(Math.round(x / GRID_STEP), 0, this.cols - 1);
    const row = clamp(Math.round(z / GRID_STEP), 0, this.rows - 1);
    return row * this.cols + col;
  }

  /**
   * Labels each connected (4-neighbor) patch of water and gives it the level of the first
   * seed point inside it, or else fills it to just below the lowest ground around it.
   */
  private findWaterRegions(seeds: LevelData['waterLevels']): Int32Array {
    const { cols, rows } = this;
    const water = surfaceId('water');
    const region = new Int32Array(cols * rows).fill(-1);
    const stack: number[] = [];
    for (let start = 0; start < region.length; start++) {
      if (this.surfaces[start] !== water || region[start] >= 0) continue;
      const id = this.regionLevels.length;
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
          if (this.surfaces[j] !== water) shore = Math.min(shore, this.heights[j]);
          else if (region[j] < 0) {
            region[j] = id;
            stack.push(j);
          }
        }
      }
      this.regionLevels.push(Number.isFinite(shore) ? shore - WATER_BELOW_SHORE : this.heights[start]);
    }
    const seeded = new Set<number>();
    for (const s of seeds) {
      const id = region[this.nearest(s.x, s.z)];
      if (id < 0) console.warn(`Water level at (${s.x}, ${s.z}) isn't on water, ignored`);
      else if (!seeded.has(id)) {
        this.regionLevels[id] = s.level;
        seeded.add(id);
      }
    }
    return region;
  }

  /**
   * Each grid point's zone wind, box-blurred WIND_BLEND wide so it ramps evenly from one zone
   * to the next. Null when nothing but the default zone is painted.
   */
  private blendWindZones(zones: Uint8Array, winds: THREE.Vector3[]): Float32Array | null {
    if (zones.every((id) => id === 0)) return null;
    const missing = new Set<number>();
    const field = new Float32Array(zones.length * 2);
    for (let i = 0; i < zones.length; i++) {
      let w = winds[zones[i]];
      if (!w) {
        missing.add(zones[i]);
        w = this.defaultWind;
      }
      field[i * 2] = w.x;
      field[i * 2 + 1] = w.z;
    }
    if (missing.size > 0) console.warn(`Wind zones ${[...missing].join(', ')} have no wind entry; using the default`);

    // Separable box blur, extending the map's edges outward.
    const radius = Math.round(WIND_BLEND / 2 / GRID_STEP);
    const { cols, rows } = this;
    /** Blurs each of `lines` runs of `count` points, where point k of run `l` is grid point `pointAt(l, k)`. */
    const blur = (count: number, lines: number, pointAt: (l: number, k: number) => number) => {
      const run = new Float32Array(count * 2);
      const at = (k: number) => clamp(k, 0, count - 1) * 2;
      for (let l = 0; l < lines; l++) {
        for (let k = 0; k < count; k++) run.set(field.subarray(pointAt(l, k) * 2, pointAt(l, k) * 2 + 2), k * 2);
        let sumX = 0;
        let sumZ = 0;
        for (let k = -radius; k <= radius; k++) {
          sumX += run[at(k)];
          sumZ += run[at(k) + 1];
        }
        for (let k = 0; k < count; k++) {
          field[pointAt(l, k) * 2] = sumX / (2 * radius + 1);
          field[pointAt(l, k) * 2 + 1] = sumZ / (2 * radius + 1);
          sumX += run[at(k + radius + 1)] - run[at(k - radius)];
          sumZ += run[at(k + radius + 1) + 1] - run[at(k - radius) + 1];
        }
      }
    };
    blur(cols, rows, (row, col) => row * cols + col);
    blur(rows, cols, (col, row) => row * cols + col);
    return field;
  }

  // --- Line of play ------------------------------------------------------------

  /** Distance along the route to its point nearest (x, z). */
  private projectOnRoute(x: number, z: number): number {
    const r = this.route;
    let best = Infinity;
    let bestS = 0;
    for (let k = 0; k < this.routeS.length - 1; k++) {
      const ax = r[k * 2];
      const az = r[k * 2 + 1];
      const abx = r[k * 2 + 2] - ax;
      const abz = r[k * 2 + 3] - az;
      const len2 = abx * abx + abz * abz;
      const t = len2 > 0 ? clamp(((x - ax) * abx + (z - az) * abz) / len2, 0, 1) : 0;
      const d = (x - ax - abx * t) ** 2 + (z - az - abz * t) ** 2;
      if (d < best) {
        best = d;
        bestS = this.routeS[k] + (this.routeS[k + 1] - this.routeS[k]) * t;
      }
    }
    return bestS;
  }

  // --- Objects -----------------------------------------------------------------

  /** Builds the physics data for each object; unknown types are skipped. */
  private placeObjects(data: LevelData): Float32Array {
    const trees: number[] = [];
    for (const o of data.objects) {
      const def = OBJECT_TYPES[o.type];
      if (!def) {
        console.warn(`Unknown object type "${o.type}" at (${o.x}, ${o.z}), skipped`);
        continue;
      }
      const ground = this.heightAt(o.x, o.z) + (o.y ?? 0);
      const s = o.scale;
      const i = this.treeMeshes.length;
      trees.push(o.x, o.z, ground, def.trunkRadius * s, ground + def.trunkHeight * s, ground + def.canopyCenter * s, def.canopyRadius * s);
      this.treeMeshes.push({ def, scale: s, rotation: o.rotation });
      const key = this.treeKey(Math.floor(o.x / TREE_CELL), Math.floor(o.z / TREE_CELL));
      const list = this.treeGrid.get(key);
      if (list) list.push(i);
      else this.treeGrid.set(key, [i]);
    }
    return Float32Array.from(trees);
  }

  private treeKey(col: number, row: number): number {
    return (col + 32768) * 65536 + (row + 32768);
  }

  // --- Meshes ----------------------------------------------------------------

  /** All trees as three instanced meshes: trunks, pine cones and round crowns. */
  private buildTrees(): THREE.Group {
    const group = new THREE.Group();
    const count = this.treeMeshes.length;
    const pines = this.treeMeshes.flatMap((m, i) => (m.def.shape === 'pine' ? [i] : []));
    const rounds = this.treeMeshes.flatMap((m, i) => (m.def.shape === 'round' ? [i] : []));

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
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const size = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    const t = this.trees;
    const place = (i: number, x: number, y: number, z: number, sx: number, sy: number) =>
      m.compose(pos.set(x, y, z), q.setFromAxisAngle(up, (this.treeMeshes[i].rotation * Math.PI) / 180), size.set(sx, sy, sx));
    // A per-tree tint, fixed by its position, so neighbors don't all match.
    const tint = (i: number) => mulberry32(Math.floor(t[i * TREE_STRIDE] * 97 + t[i * TREE_STRIDE + 1] * 131))();

    for (let i = 0; i < count; i++) {
      const o = i * TREE_STRIDE;
      trunks.setMatrixAt(i, place(i, t[o], t[o + 2] - 0.3, t[o + 1], t[o + 3], t[o + 4] - t[o + 2] + 0.6));
    }
    pines.forEach((i, n) => {
      const o = i * TREE_STRIDE;
      const tree = this.treeMeshes[i];
      const coneHeight = tree.def.shape === 'pine' ? tree.def.coneHeight : 0;
      cones.setMatrixAt(n, place(i, t[o], t[o + 4] - 0.6, t[o + 1], t[o + 6], coneHeight * tree.scale));
      cones.setColorAt(n, c.setHSL(0.31 + tint(i) * 0.04, 0.45, 0.17 + tint(i + 1) * 0.06));
    });
    rounds.forEach((i, n) => {
      const o = i * TREE_STRIDE;
      crowns.setMatrixAt(n, place(i, t[o], t[o + 5], t[o + 1], t[o + 6], t[o + 6] * 0.85));
      crowns.setColorAt(n, c.setHSL(0.22 + tint(i) * 0.06, 0.5, 0.24 + tint(i + 1) * 0.06));
    });

    for (const mesh of [trunks, cones, crowns]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
    return group;
  }

  /** Terrain as square tiles, leaving out those deep in out-of-bounds ground. */
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

    // Which blocks of the map hold any playable ground, to skip tiles far out of bounds.
    const BLOCK = 10;
    const bc = Math.ceil(this.cols / BLOCK);
    const br = Math.ceil(this.rows / BLOCK);
    const playable = new Uint8Array(bc * br);
    const oob = surfaceId('oob');
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        if (this.surfaces[row * this.cols + col] !== oob) playable[Math.floor(row / BLOCK) * bc + Math.floor(col / BLOCK)] = 1;
      }
    }
    const reach = Math.ceil(OOB_DRAW_MARGIN / (BLOCK * GRID_STEP));
    const nearPlay = (c0: number, r0: number, c1: number, r1: number) => {
      const b0 = Math.max(0, Math.floor(c0 / BLOCK) - reach);
      const b1 = Math.min(bc - 1, Math.floor(c1 / BLOCK) + reach);
      for (let r = Math.max(0, Math.floor(r0 / BLOCK) - reach); r <= Math.min(br - 1, Math.floor(r1 / BLOCK) + reach); r++) {
        for (let b = b0; b <= b1; b++) if (playable[r * bc + b]) return true;
      }
      return false;
    };

    const colors = new Noise2D(mulberry32(0x7e11a5));
    for (let r0 = 0; r0 < this.rows - 1; r0 += TILE_CELLS) {
      for (let c0 = 0; c0 < this.cols - 1; c0 += TILE_CELLS) {
        const c1 = Math.min(c0 + TILE_CELLS, this.cols - 1);
        const r1 = Math.min(r0 + TILE_CELLS, this.rows - 1);
        if (!nearPlay(c0, r0, c1, r1)) continue;
        const mesh = new THREE.Mesh(this.buildTile(c0, r0, c1, r1, colors), material);
        mesh.receiveShadow = true;
        terrain.add(mesh);
      }
    }
    return terrain;
  }

  /** One terrain tile spanning grid columns c0-c1 and rows r0-r1 (inclusive). */
  private buildTile(c0: number, r0: number, c1: number, r1: number, colors: Noise2D): THREE.BufferGeometry {
    const nx = c1 - c0 + 1;
    const nz = r1 - r0 + 1;
    const { cols, rows } = this;
    const h = this.heights;
    const at = (col: number, row: number) => h[clamp(row, 0, rows - 1) * cols + clamp(col, 0, cols - 1)];

    const positions = new Float32Array(nx * nz * 3);
    const normals = new Float32Array(nx * nz * 3);
    const vertexColors = new Float32Array(nx * nz * 3);
    const palette = SURFACE_LIST.map((s) => new THREE.Color(SURFACES[s].color));
    const c = new THREE.Color();
    const nrm = new THREE.Vector3();

    for (let j = 0; j < nz; j++) {
      const row = r0 + j;
      const z = row * GRID_STEP;
      for (let i = 0; i < nx; i++) {
        const col = c0 + i;
        const x = col * GRID_STEP;
        const v = (j * nx + i) * 3;
        positions[v] = x;
        positions[v + 1] = at(col, row);
        positions[v + 2] = z;
        // Smooth normals for lighting, shared across tile seams.
        nrm
          .set(-(at(col + 1, row) - at(col - 1, row)) / (2 * GRID_STEP), 1, -(at(col, row + 1) - at(col, row - 1)) / (2 * GRID_STEP))
          .normalize();
        normals[v] = nrm.x;
        normals[v + 1] = nrm.y;
        normals[v + 2] = nrm.z;

        const id = this.surfaces[row * cols + col];
        const surface = SURFACE_LIST[id];
        c.copy(palette[id]);
        if (surface === 'fairway') c.multiplyScalar(Math.floor(z / 4) & 1 ? 1.07 : 0.95);
        else if (surface === 'green') c.multiplyScalar(Math.floor((x + z) / 2.5) & 1 ? 1.05 : 0.96);
        c.multiplyScalar(1 + colors.sample(x * 0.2, z * 0.2) * (surface === 'bunker' ? 0.04 : 0.08));
        vertexColors[v] = c.r;
        vertexColors[v + 1] = c.g;
        vertexColors[v + 2] = c.b;
      }
    }

    // Split each cell along its b-d diagonal, matching heightAt.
    const indices = new Uint16Array((nx - 1) * (nz - 1) * 6);
    let k = 0;
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const d = a + nx;
        const e = d + 1;
        indices.set([a, d, b, b, d, e], k);
        k += 6;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(vertexColors, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    return geometry;
  }

  /**
   * Flat water surfaces at each region's level. They reach one grid point past the water's
   * edge, so the banks rise through them and hide where they end.
   */
  private buildWater(): THREE.Mesh {
    const { cols, rows } = this;
    const region = this.waterRegion;
    const vertex = new Int32Array(cols * rows).fill(-1);
    const positions: number[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const i = row * cols + col;
        let id = region[i];
        if (id < 0 && col > 0) id = region[i - 1];
        if (id < 0 && col < cols - 1) id = region[i + 1];
        if (id < 0 && row > 0) id = region[i - cols];
        if (id < 0 && row < rows - 1) id = region[i + cols];
        if (id < 0) continue;
        vertex[i] = positions.length / 3;
        positions.push(col * GRID_STEP, this.regionLevels[id], row * GRID_STEP);
      }
    }
    const indices: number[] = [];
    for (let row = 0; row < rows - 1; row++) {
      for (let col = 0; col < cols - 1; col++) {
        const a = vertex[row * cols + col];
        const b = vertex[row * cols + col + 1];
        const d = vertex[(row + 1) * cols + col];
        const e = vertex[(row + 1) * cols + col + 1];
        if (a >= 0 && d >= 0 && b >= 0) indices.push(a, d, b);
        if (b >= 0 && d >= 0 && e >= 0) indices.push(b, d, e);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
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
    const droop = (1 - Math.min(1, this.flagWind.length() / 5)) * 1.1;
    flag.rotation.set(0, Math.atan2(-this.flagWind.z, this.flagWind.x), -droop);
    flag.castShadow = true;
    this.group.add(flag);
    return flag;
  }

  /** Two markers either side of the tee, square to the line of play. */
  private buildTeeMarkers(): THREE.Group {
    const markers = new THREE.Group();
    const dirX = this.route[2] - this.route[0];
    const dirZ = this.route[3] - this.route[1];
    const len = Math.hypot(dirX, dirZ) || 1;
    const geometry = new THREE.SphereGeometry(0.14, 16, 12);
    const material = new THREE.MeshStandardMaterial({ color: 0x2b6fd6, roughness: 0.4 });
    for (const side of [-1, 1]) {
      const x = this.tee.x + (-dirZ / len) * 1.8 * side;
      const z = this.tee.z + (dirX / len) * 1.8 * side;
      const marker = new THREE.Mesh(geometry, side < 0 ? material : material.clone());
      marker.position.set(x, this.heightAt(x, z) + 0.1, z);
      marker.castShadow = true;
      markers.add(marker);
    }
    return markers;
  }
}
