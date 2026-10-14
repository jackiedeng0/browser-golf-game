import * as THREE from 'three';
import { mulberry32, Noise2D } from './noise';

// World units are meters. The ball and cup are oversized (keeping the real
// ~2.5:1 cup-to-ball ratio) so they stay readable at course scale.
export const BALL_RADIUS = 0.12;
export const HOLE_RADIUS = 0.3;
export const CUP_DEPTH = 0.4;
export const PIN_RADIUS = 0.022;
export const PIN_HEIGHT = 3.0;
export const MAX_WIND = 9;

export type Surface = 'tee' | 'fairway' | 'green' | 'rough';

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
};

const PATH_SAMPLES = 48;
const GRID_STEP = 0.6;
const MARGIN = 40;

interface GreenShape {
  /** Center of the green (x, z); the cup sits off-center. */
  x: number;
  z: number;
  cos: number;
  sin: number;
  /** Semi-axes of the base ellipse. */
  a: number;
  b: number;
  /** Mean radius, used to turn normalized distances into meters. */
  size: number;
  /** Angular harmonics that bulge and pinch the outline. */
  lobes: { k: number; amp: number; phase: number }[];
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * A randomly generated hole: an analytic heightfield (shared by rendering and
 * physics), surface types, and the meshes for terrain, cup, pin and flag.
 */
export class Level {
  readonly seed: number;
  /** Ball start position (ball center). */
  readonly tee: THREE.Vector3;
  /** Cup center on the XZ plane (x, z). */
  readonly hole: THREE.Vector2;
  /** Height of the green at the cup rim. */
  readonly rimY: number;
  /** Straight-line tee-to-pin distance. */
  readonly distance: number;
  readonly par: number;
  /** Constant wind velocity for this hole (m/s, horizontal). */
  readonly wind: THREE.Vector3;
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  readonly group = new THREE.Group();

  private readonly hills: Noise2D;
  private readonly bumps: Noise2D;
  private readonly detail: Noise2D;
  private readonly green: GreenShape;
  private readonly fairwayHalfWidth: number;
  /** Fairway centerline as flattened (x, z) pairs. */
  private readonly path: Float32Array;
  private readonly teeBase: number;
  private readonly greenBase: number;
  private readonly flag: THREE.Mesh;
  private readonly flagRest: Float32Array;

  constructor(seed: number) {
    this.seed = seed;
    const rand = mulberry32(seed);
    const range = (a: number, b: number) => a + (b - a) * rand();
    this.hills = new Noise2D(rand);
    this.bumps = new Noise2D(rand);
    this.detail = new Noise2D(rand);

    this.distance = range(70, 260);
    const heading = range(-0.3, 0.3);
    this.hole = new THREE.Vector2(Math.sin(heading) * this.distance, -Math.cos(heading) * this.distance);
    this.par = this.distance < 120 ? 3 : this.distance < 200 ? 4 : 5;
    this.green = this.makeGreen(range);
    this.fairwayHalfWidth = range(9, 14);

    // Fairway follows a gentle dogleg (quadratic Bézier) from the tee to the green.
    const bend = range(-0.22, 0.22) * this.distance;
    const cx = this.hole.x / 2 - (this.hole.y / this.distance) * bend;
    const cz = this.hole.y / 2 + (this.hole.x / this.distance) * bend;
    this.path = new Float32Array((PATH_SAMPLES + 1) * 2);
    let minX = 0;
    let maxX = 0;
    let minZ = 0;
    let maxZ = 0;
    for (let i = 0; i <= PATH_SAMPLES; i++) {
      const t = i / PATH_SAMPLES;
      const x = 2 * (1 - t) * t * cx + t * t * this.hole.x;
      const z = 2 * (1 - t) * t * cz + t * t * this.hole.y;
      this.path[i * 2] = x;
      this.path[i * 2 + 1] = z;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    this.bounds = { minX: minX - MARGIN, maxX: maxX + MARGIN, minZ: minZ - MARGIN, maxZ: maxZ + MARGIN };

    this.teeBase = this.rawHeight(0, 0);
    this.greenBase = this.rawHeight(this.hole.x, this.hole.y);
    this.rimY = this.greenBase;
    this.tee = new THREE.Vector3(0, this.teeBase + BALL_RADIUS, 0);

    this.group.add(this.buildTerrain());
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
    let h = this.rawHeight(x, z);

    const tb = smoothstep(7, 3, Math.hypot(x, z));
    if (tb > 0) h = lerp(h, this.teeBase, tb);

    const dHole = Math.hypot(x - this.hole.x, z - this.hole.y);
    const gb = smoothstep(10, -0.3 * this.green.size, this.greenEdgeDistance(x, z));
    if (gb > 0) {
      // Gentle green undulation that fades out so the cup sits on level ground.
      const undulation = this.detail.fbm(x * 0.06, z * 0.06, 2) * 0.6 * smoothstep(1, 5, dHole);
      h = lerp(h, this.greenBase + undulation, gb);
    }
    return h;
  }

  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = 0.05;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return out.set(-dx, 1, -dz).normalize();
  }

  surfaceAt(x: number, z: number): Surface {
    const outside = this.distanceOutsideGreen(x, z);
    if (outside < 0) return 'green';
    // The fringe around the green is cut to fairway length.
    if (this.isFringe(x, z, outside)) return 'fairway';
    if (Math.hypot(x, z) < 2.5) return 'tee';
    const edge = this.fairwayHalfWidth + this.bumps.sample(x * 0.03 + 50, z * 0.03) * 3;
    return this.distToPath(x, z) < edge ? 'fairway' : 'rough';
  }

  isOutOfBounds(x: number, z: number): boolean {
    const b = this.bounds;
    return x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ;
  }

  /** Animates the flag in the wind: stronger wind flaps it faster and harder. */
  update(time: number): void {
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

  /**
   * A rotated ellipse with random lobes, placed so the cup lies well inside it
   * (at most 25% of the way to the edge) and the ground around the cup stays level.
   */
  private makeGreen(range: (a: number, b: number) => number): GreenShape {
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
    };
  }

  /** Signed distance (meters) to the green's actual edge, including its small wobble; negative on the green. */
  private distanceOutsideGreen(x: number, z: number): number {
    return this.greenEdgeDistance(x, z) - this.detail.sample(x * 0.15, z * 0.15) * 0.6;
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

  /** Approximate signed distance (meters) to the green's base outline; negative inside. */
  private greenEdgeDistance(x: number, z: number): number {
    const g = this.green;
    const dx = x - g.x;
    const dz = z - g.z;
    const u = (dx * g.cos + dz * g.sin) / g.a;
    const v = (-dx * g.sin + dz * g.cos) / g.b;
    const theta = Math.atan2(v, u);
    let edge = 1;
    for (const l of g.lobes) edge += l.amp * Math.cos(l.k * theta + l.phase);
    return (Math.hypot(u, v) - edge) * g.size;
  }

  /** Terrain before the tee box and green are flattened into it. */
  private rawHeight(x: number, z: number): number {
    let h = this.hills.fbm(x * 0.014, z * 0.014, 4) * 6 + this.bumps.fbm(x * 0.07, z * 0.07, 2) * 0.35;
    // Banks rise away from the fairway to keep wayward shots in play.
    const bank = Math.min(35, Math.max(0, this.distToPath(x, z) - this.fairwayHalfWidth * 1.8));
    h += bank * bank * 0.012;
    return h;
  }

  private distToPath(x: number, z: number): number {
    const p = this.path;
    let best = Infinity;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i];
      const az = p[i + 1];
      const abx = p[i + 2] - ax;
      const abz = p[i + 3] - az;
      const t = clamp(((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz), 0, 1);
      const dx = x - (ax + abx * t);
      const dz = z - (az + abz * t);
      best = Math.min(best, dx * dx + dz * dz);
    }
    return Math.sqrt(best);
  }

  private buildTerrain(): THREE.Mesh {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const nx = Math.ceil((maxX - minX) / GRID_STEP) + 1;
    const nz = Math.ceil((maxZ - minZ) / GRID_STEP) + 1;
    const positions = new Float32Array(nx * nz * 3);
    const colors = new Float32Array(nx * nz * 3);
    const palette: Record<Surface, THREE.Color> = {
      tee: new THREE.Color(0x5cae3e),
      fairway: new THREE.Color(0x4f9e34),
      green: new THREE.Color(0x63c24a),
      rough: new THREE.Color(0x2f6b25),
    };
    const c = new THREE.Color();

    for (let iz = 0; iz < nz; iz++) {
      const z = Math.min(maxZ, minZ + iz * GRID_STEP);
      for (let ix = 0; ix < nx; ix++) {
        const x = Math.min(maxX, minX + ix * GRID_STEP);
        const i = (iz * nx + ix) * 3;
        positions[i] = x;
        positions[i + 1] = this.heightAt(x, z);
        positions[i + 2] = z;

        const surface = this.surfaceAt(x, z);
        c.copy(palette[surface]);
        // Fringe is left unstriped so it reads as a collar around the green.
        if (surface === 'fairway' && !this.isFringe(x, z)) c.multiplyScalar(Math.floor(z / 4) & 1 ? 1.07 : 0.95);
        else if (surface === 'green') c.multiplyScalar(Math.floor((x + z) / 2.5) & 1 ? 1.05 : 0.96);
        c.multiplyScalar(1 + this.bumps.sample(x * 0.2, z * 0.2) * 0.08);
        colors[i] = c.r;
        colors[i + 1] = c.g;
        colors[i + 2] = c.b;
      }
    }

    const indices = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let k = 0;
    for (let iz = 0; iz < nz - 1; iz++) {
      for (let ix = 0; ix < nx - 1; ix++) {
        const a = iz * nx + ix;
        const b = a + 1;
        const d = a + nx;
        const e = d + 1;
        indices.set([a, d, b, b, d, e], k);
        k += 6;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();

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

    const mesh = new THREE.Mesh(geometry, material);
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
