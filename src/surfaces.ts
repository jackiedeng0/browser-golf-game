/** Surface ids are indices into this list; they're what the level's surface grid stores. */
export const SURFACE_LIST = ['tee', 'fairway', 'green', 'rough', 'bunker', 'water', 'oob'] as const;

export type Surface = (typeof SURFACE_LIST)[number];

export interface SurfaceProps {
  /** Fraction of normal speed kept on a bounce. */
  restitution: number;
  /** Coulomb friction coefficient applied during impacts. */
  friction: number;
  /** Rolling resistance coefficient (deceleration = rolling * g). */
  rolling: number;
  /** Base terrain color. */
  color: number;
}

export const SURFACES: Record<Surface, SurfaceProps> = {
  tee: { restitution: 0.35, friction: 0.45, rolling: 0.1, color: 0x5cae3e },
  fairway: { restitution: 0.38, friction: 0.54, rolling: 0.12, color: 0x4f9e34 },
  green: { restitution: 0.3, friction: 0.5, rolling: 0.08, color: 0x63c24a },
  rough: { restitution: 0.22, friction: 1.56, rolling: 0.72, color: 0x2f6b25 },
  // Soft sand: the ball barely bounces and stops quickly.
  bunker: { restitution: 0.08, friction: 1.2, rolling: 1.4, color: 0xdcc690 },
  // Lake and creek beds. A ball is out of play as soon as it reaches the water surface.
  water: { restitution: 0, friction: 1, rolling: 2, color: 0x3a4f36 },
  // Plays like rough; the ball is out of play as soon as it's over it.
  oob: { restitution: 0.22, friction: 1.56, rolling: 0.72, color: 0x2a5e22 },
};

export function surfaceId(surface: Surface): number {
  return SURFACE_LIST.indexOf(surface);
}
