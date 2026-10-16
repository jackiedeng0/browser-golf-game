import * as THREE from 'three';
import { BALL_RADIUS, CUP_DEPTH, HOLE_RADIUS, Level, PIN_HEIGHT, PIN_RADIUS, TREE_STRIDE } from './level';
import { SURFACES, type SurfaceProps } from './surfaces';

/** Slightly lower than Earth gravity. */
export const GRAVITY = 9.81 * 0.8;
/** Quadratic air drag coefficient (1/m): a = -k |v - wind| (v - wind). */
const AIR_DRAG = 0.0045;
/** Backspin (Magnus) lift coefficient (1/m): |a| = k |v - wind|², perpendicular to the airflow, upward. */
const AIR_LIFT = 0.003;
/** Magnus coefficient for sidespin (spin about the vertical axis): a = k ω_y (up × v_rel). */
const SIDESPIN_MAGNUS = 0.0006;
/** Wind right at the turf is slower than aloft; this fraction of it acts on a rolling ball. */
const GROUND_WIND = 0.5;
const STEP = 1 / 240;
const CONTACT_EPS = 0.004;
/** Below this normal impact speed the ball settles instead of bouncing. */
const BOUNCE_MIN_SPEED = 0.6;
const STOP_SPEED = 0.05;
const MAX_SHOT_TIME = 45;
/** Fraction of slope gravity that accelerates a solid sphere rolling without slipping. */
const ROLLING_FACTOR = 5 / 7;
/** Contact-point slip speed (m/s) below which the ball counts as rolling rather than skidding. */
const SLIP_EPS = 0.02;
/** Spin decays in flight with this time constant (s). */
const SPIN_DECAY_TIME = 20;
/** For a solid sphere, a friction impulse Δv at the contact changes spin by -(5 / 2r) n × Δv. */
const SPIN_PER_IMPULSE = 5 / (2 * BALL_RADIUS);
/** Visual spin is capped in flight so a fast-spinning ball doesn't strobe. */
const MAX_VISUAL_AIR_SPIN = 25;

type Contact = Omit<SurfaceProps, 'color'>;

const CUP: Contact = { restitution: 0.2, friction: 0.6, rolling: 0.5 };
const PIN: Contact = { restitution: 0.45, friction: 0.15, rolling: 0 };
const TRUNK: Contact = { restitution: 0.45, friction: 0.3, rolling: 0 };
/** Inside a tree's canopy the ball loses speed at this rate (1/s). */
const CANOPY_DRAG = 3.5;
/** ...and spin at this rate (1/s): the same, so backspin and curve stay in proportion to its speed. */
const CANOPY_SPIN_DRAG = CANOPY_DRAG;

export type BallEvent = 'stopped' | 'sunk' | 'out' | 'water';

const UP = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _g = new THREE.Vector3();
const _s = new THREE.Vector3();
const _w = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Ball {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** Angular velocity (rad/s). */
  readonly spin = new THREE.Vector3();
  /** Visual orientation, integrated from the spin. */
  readonly orientation = new THREE.Quaternion();
  moving = false;
  sunk = false;
  private accumulator = 0;
  private shotTime = 0;

  constructor(private level: Level) {
    this.placeAt(level.tee);
  }

  setLevel(level: Level): void {
    this.level = level;
    this.placeAt(level.tee);
  }

  placeAt(p: THREE.Vector3): void {
    this.position.copy(p);
    this.velocity.set(0, 0, 0);
    this.spin.set(0, 0, 0);
    this.moving = false;
    this.sunk = false;
    this.accumulator = 0;
  }

  /**
   * Launch along a horizontal unit `direction` at `speed` (m/s) and `loft` (radians),
   * with `backspin` in rad/s (negative for topspin) and `sidespin` in rad/s about the
   * vertical axis (positive curves the ball left: a draw).
   */
  strike(direction: THREE.Vector3, speed: number, loft: number, backspin: number, sidespin = 0): void {
    const h = Math.cos(loft) * speed;
    this.velocity.set(direction.x * h, Math.sin(loft) * speed, direction.z * h);
    // Backspin axis is direction × up: the opposite of a forward roll.
    this.spin.crossVectors(direction, UP).normalize().multiplyScalar(backspin);
    this.spin.y += sidespin;
    this.moving = true;
    this.shotTime = 0;
  }

  /** Advances the simulation in fixed substeps; returns the first event that occurs. */
  update(dt: number): BallEvent | null {
    if (!this.moving) return null;
    this.accumulator += Math.min(dt, 0.1);
    while (this.accumulator >= STEP) {
      this.accumulator -= STEP;
      const event = this.substep(STEP);
      if (event) return event;
    }
    return null;
  }

  private substep(h: number): BallEvent | null {
    const L = this.level;
    const p = this.position;
    const v = this.velocity;
    this.shotTime += h;

    const ground = this.groundAt(p.x, p.z, _n);
    const wind = L.windAt(p.x, p.z, _wind);
    const contact = p.y - BALL_RADIUS <= ground.y + CONTACT_EPS;

    let skidding = false;
    if (contact) {
      const vn = v.dot(_n);
      if (vn < 0) v.addScaledVector(_n, -vn);
      // Driving force along the surface: slope gravity, g - (g·n)n, plus a slight push from the wind.
      _g.set(0, -GRAVITY, 0).addScaledVector(_n, GRAVITY * _n.y);
      _t.copy(wind).multiplyScalar(GROUND_WIND).sub(v);
      _g.addScaledVector(_t, AIR_DRAG * _t.length());
      _g.addScaledVector(_n, -_g.dot(_n));

      const slip = this.contactSlip(_n, _s).length();
      if (slip > SLIP_EPS) {
        // Skidding: kinetic friction opposes the contact point's slip and trades speed for spin.
        skidding = true;
        v.addScaledVector(_g, h);
        const dv = Math.min(ground.surface.friction * GRAVITY * _n.y * h, (2 / 7) * slip);
        this.applyFriction(_n, _s.multiplyScalar(-dv / slip));
      } else {
        v.addScaledVector(_g, ROLLING_FACTOR * h);
        const speed = v.length();
        const decel = ground.surface.rolling * GRAVITY * _n.y * h;
        if (speed <= decel) v.set(0, 0, 0);
        else v.multiplyScalar(1 - decel / speed);
        // Rolling without slipping: spin follows the velocity.
        this.spin.crossVectors(_n, v).divideScalar(BALL_RADIUS);
      }
    } else {
      this.spin.multiplyScalar(1 - h / SPIN_DECAY_TIME);
      v.y -= GRAVITY * h;
      // Drag and lift act on the velocity relative to the moving air, which is how wind moves the ball.
      _g.subVectors(v, wind);
      const airSpeed = _g.length();
      _t.crossVectors(UP, _g);
      _c.crossVectors(_g, _t);
      const liftLen = _c.length();
      v.addScaledVector(_g, -AIR_DRAG * airSpeed * h);
      if (liftLen > 1e-9) v.addScaledVector(_c, (AIR_LIFT * airSpeed * airSpeed * h) / liftLen);
      // Sidespin curves the flight sideways: a draw bends left, a fade right.
      v.addScaledVector(_w.crossVectors(UP, _g), SIDESPIN_MAGNUS * this.spin.y * h);
    }

    p.addScaledVector(v, h);
    this.collide();
    this.collideTrees(h);

    const spinRate = this.spin.length();
    if (spinRate > 1e-6) {
      const visualRate = contact ? spinRate : Math.min(spinRate, MAX_VISUAL_AIR_SPIN);
      _w.copy(this.spin).divideScalar(spinRate);
      this.orientation.premultiply(_q.setFromAxisAngle(_w, visualRate * h));
    }

    const dHole = Math.hypot(p.x - L.hole.x, p.z - L.hole.y);
    if (!this.sunk && dHole < HOLE_RADIUS && p.y + BALL_RADIUS < L.rimY) {
      this.sunk = true;
      return 'sunk';
    }
    const waterLevel = L.waterLevelAt(p.x, p.z);
    if (p.y - BALL_RADIUS <= waterLevel) {
      this.moving = false;
      return 'water';
    }
    if (L.isOutOfBounds(p.x, p.z)) {
      this.moving = false;
      return 'out';
    }
    if (contact) {
      const pull = _g.length() * ROLLING_FACTOR;
      const hold = ground.surface.rolling * GRAVITY * _n.y;
      if (!skidding && v.length() < STOP_SPEED && pull < hold) {
        v.set(0, 0, 0);
        this.spin.set(0, 0, 0);
        this.moving = false;
        return 'stopped';
      }
    }
    if (this.shotTime > MAX_SHOT_TIME) {
      v.set(0, 0, 0);
      this.moving = false;
      return 'stopped';
    }
    return null;
  }

  /** Supporting surface directly below (x, z); over the cup that's the cup floor. */
  private groundAt(x: number, z: number, normal: THREE.Vector3): { y: number; surface: Contact } {
    const L = this.level;
    if (Math.hypot(x - L.hole.x, z - L.hole.y) < HOLE_RADIUS) {
      normal.copy(UP);
      return { y: L.rimY - CUP_DEPTH, surface: CUP };
    }
    L.normalAt(x, z, normal);
    return { y: L.heightAt(x, z), surface: SURFACES[L.surfaceAt(x, z)] };
  }

  private collide(): void {
    const L = this.level;
    const p = this.position;
    const r = BALL_RADIUS;
    const dx = p.x - L.hole.x;
    const dz = p.z - L.hole.y;
    const d = Math.hypot(dx, dz);

    if (d >= HOLE_RADIUS) {
      const gy = L.heightAt(p.x, p.z);
      if (p.y - r < gy) {
        p.y = gy + r;
        this.impact(L.normalAt(p.x, p.z, _c), SURFACES[L.surfaceAt(p.x, p.z)]);
      }
      return;
    }

    // Over the cup: floor, wall, rim edge and the pin.
    const floorY = L.rimY - CUP_DEPTH;
    if (p.y - r < floorY) {
      p.y = floorY + r;
      this.impact(UP, CUP);
    }
    if (p.y < L.rimY) {
      const maxD = HOLE_RADIUS - r;
      if (d > maxD) {
        p.x = L.hole.x + (dx / d) * maxD;
        p.z = L.hole.y + (dz / d) * maxD;
        this.impact(_c.set(-dx / d, 0, -dz / d), CUP);
      }
    } else if (d > 1e-6) {
      // The rim is a circular edge: collide with its nearest point.
      const ex = L.hole.x + (dx / d) * HOLE_RADIUS;
      const ez = L.hole.y + (dz / d) * HOLE_RADIUS;
      _c.set(p.x - ex, p.y - L.rimY, p.z - ez);
      const len = _c.length();
      if (len < r && len > 1e-6) {
        _c.divideScalar(len);
        p.set(ex, L.rimY, ez).addScaledVector(_c, r);
        this.impact(_c, SURFACES.green);
      }
    }

    const px = p.x - L.hole.x;
    const pz = p.z - L.hole.y;
    const pd = Math.hypot(px, pz) || 1e-6;
    const minD = r + PIN_RADIUS;
    if (!L.pinLifted && pd < minD && p.y - r < floorY + PIN_HEIGHT) {
      p.x = L.hole.x + (px / pd) * minD;
      p.z = L.hole.y + (pz / pd) * minD;
      this.impact(_c.set(px / pd, 0, pz / pd), PIN);
    }
  }

  /** Trunks are solid; canopies (approximated as spheres) slow the ball and take spin off it. */
  private collideTrees(h: number): void {
    const L = this.level;
    const p = this.position;
    const v = this.velocity;
    const t = L.trees;
    for (const i of L.treesNear(p.x, p.z)) {
      const o = i * TREE_STRIDE;
      const dx = p.x - t[o];
      const dz = p.z - t[o + 1];
      const d = Math.hypot(dx, dz) || 1e-6;
      const minD = t[o + 3] + BALL_RADIUS;
      if (d < minD && p.y - BALL_RADIUS < t[o + 4]) {
        p.x = t[o] + (dx / d) * minD;
        p.z = t[o + 1] + (dz / d) * minD;
        this.impact(_c.set(dx / d, 0, dz / d), TRUNK);
      }
      const cy = p.y - t[o + 5];
      const r = t[o + 6];
      if (dx * dx + dz * dz + cy * cy < r * r) {
        v.multiplyScalar(Math.exp(-CANOPY_DRAG * h));
        this.spin.multiplyScalar(Math.exp(-CANOPY_SPIN_DRAG * h));
      }
    }
  }

  /** Velocity of the ball's contact point along the surface: v_t - r (ω × n). */
  private contactSlip(n: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const v = this.velocity;
    return out
      .crossVectors(this.spin, n)
      .multiplyScalar(-BALL_RADIUS)
      .add(v)
      .addScaledVector(n, -v.dot(n));
  }

  /** Applies a tangential friction impulse `dv` (per unit mass) at the contact point. */
  private applyFriction(n: THREE.Vector3, dv: THREE.Vector3): void {
    this.velocity.add(dv);
    this.spin.addScaledVector(_w.crossVectors(n, dv), -SPIN_PER_IMPULSE);
  }

  /** Resolves an impact against a contact normal with restitution and Coulomb friction on the slip. */
  private impact(n: THREE.Vector3, surface: Contact): void {
    const v = this.velocity;
    const vn = v.dot(n);
    if (vn >= 0) return;
    const e = -vn > BOUNCE_MIN_SPEED ? surface.restitution : 0;
    const slip = this.contactSlip(n, _s).length();
    v.addScaledVector(n, -vn * (1 + e));
    if (slip > 1e-9) {
      // Friction can at most stop the slip, which takes 2/7 of it for a solid sphere.
      const dv = Math.min(surface.friction * (1 + e) * -vn, (2 / 7) * slip);
      this.applyFriction(n, _s.multiplyScalar(-dv / slip));
    }
  }
}
