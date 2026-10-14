import * as THREE from 'three';
import {
  BALL_RADIUS,
  CUP_DEPTH,
  HOLE_RADIUS,
  Level,
  PIN_HEIGHT,
  PIN_RADIUS,
  SURFACES,
  type SurfaceProps,
} from './level';

/** Slightly lower than Earth gravity. */
export const GRAVITY = 9.81 * 0.8;
/** Quadratic air drag coefficient (1/m): a = -k |v| v. */
const AIR_DRAG = 0.0022;
const STEP = 1 / 240;
const CONTACT_EPS = 0.004;
/** Below this normal impact speed the ball settles instead of bouncing. */
const BOUNCE_MIN_SPEED = 0.6;
const STOP_SPEED = 0.05;
const MAX_SHOT_TIME = 45;
/** Fraction of slope gravity that accelerates a solid sphere rolling without slipping. */
const ROLLING_FACTOR = 5 / 7;

const CUP: SurfaceProps = { restitution: 0.2, friction: 0.6, rolling: 0.5 };
const PIN: SurfaceProps = { restitution: 0.45, friction: 0.15, rolling: 0 };

export type BallEvent = 'stopped' | 'sunk' | 'out';

const UP = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _g = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Ball {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** Visual orientation, rolled as the ball travels along the ground. */
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
    this.moving = false;
    this.sunk = false;
    this.accumulator = 0;
  }

  /** Launch along a horizontal unit `direction` at `speed` (m/s) and `loft` (radians). */
  strike(direction: THREE.Vector3, speed: number, loft: number): void {
    const h = Math.cos(loft) * speed;
    this.velocity.set(direction.x * h, Math.sin(loft) * speed, direction.z * h);
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
    const contact = p.y - BALL_RADIUS <= ground.y + CONTACT_EPS;

    if (contact) {
      const vn = v.dot(_n);
      if (vn < 0) v.addScaledVector(_n, -vn);
      // Slope component of gravity: g - (g·n)n.
      _g.set(0, -GRAVITY, 0).addScaledVector(_n, GRAVITY * _n.y);
      v.addScaledVector(_g, ROLLING_FACTOR * h);
      const speed = v.length();
      const decel = ground.surface.rolling * GRAVITY * _n.y * h;
      if (speed <= decel) v.set(0, 0, 0);
      else v.multiplyScalar(1 - decel / speed);
    } else {
      v.y -= GRAVITY * h;
      v.multiplyScalar(1 / (1 + AIR_DRAG * v.length() * h));
    }

    const prevX = p.x;
    const prevZ = p.z;
    p.addScaledVector(v, h);
    this.collide();

    if (contact) {
      // Roll the visual ball: rotation axis is up × direction of travel.
      const dx = p.x - prevX;
      const dz = p.z - prevZ;
      const dist = Math.hypot(dx, dz);
      if (dist > 1e-6) {
        _axis.set(dz, 0, -dx).divideScalar(dist);
        this.orientation.premultiply(_q.setFromAxisAngle(_axis, dist / BALL_RADIUS));
      }
    }

    const dHole = Math.hypot(p.x - L.hole.x, p.z - L.hole.y);
    if (!this.sunk && dHole < HOLE_RADIUS && p.y + BALL_RADIUS < L.rimY) {
      this.sunk = true;
      return 'sunk';
    }
    if (L.isOutOfBounds(p.x, p.z)) {
      this.moving = false;
      return 'out';
    }
    if (contact) {
      const slopePull = _g.length() * ROLLING_FACTOR;
      const hold = ground.surface.rolling * GRAVITY * _n.y;
      if (v.length() < STOP_SPEED && slopePull < hold) {
        v.set(0, 0, 0);
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
  private groundAt(x: number, z: number, normal: THREE.Vector3): { y: number; surface: SurfaceProps } {
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
    if (pd < minD && p.y - r < floorY + PIN_HEIGHT) {
      p.x = L.hole.x + (px / pd) * minD;
      p.z = L.hole.y + (pz / pd) * minD;
      this.impact(_c.set(px / pd, 0, pz / pd), PIN);
    }
  }

  /** Resolves velocity against a contact normal with restitution and Coulomb friction. */
  private impact(n: THREE.Vector3, surface: SurfaceProps): void {
    const v = this.velocity;
    const vn = v.dot(n);
    if (vn >= 0) return;
    _t.copy(v).addScaledVector(n, -vn);
    if (-vn > BOUNCE_MIN_SPEED) {
      const e = surface.restitution;
      const vt = _t.length();
      if (vt > 1e-9) {
        // Friction can at most bring a sliding sphere to pure rolling (lose 2/7 of slip).
        const dvt = Math.min(surface.friction * (1 + e) * -vn, (2 / 7) * vt);
        _t.multiplyScalar(1 - dvt / vt);
      }
      v.copy(_t).addScaledVector(n, -vn * e);
    } else {
      v.copy(_t);
    }
  }
}
