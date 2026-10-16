/**
 * Code-side definitions for the `type` of each LevelObject. Sizes are at scale 1 and in meters,
 * measured from the ground at the object's position.
 */
interface TreeDef {
  trunkRadius: number;
  trunkHeight: number;
  /** Physics canopy: a sphere this big, centered this high. */
  canopyRadius: number;
  canopyCenter: number;
}

/** Trees, by how the canopy is drawn: a cone or a round crown. */
export type ObjectDef = (TreeDef & { shape: 'pine'; coneHeight: number }) | (TreeDef & { shape: 'round' });

export const OBJECT_TYPES: Record<string, ObjectDef> = {
  // Short trunk under a tall cone; the physics canopy is the cone's lower bulk.
  'tree-pine': {
    shape: 'pine',
    trunkRadius: 0.35,
    trunkHeight: 2.55,
    canopyRadius: 2.65,
    canopyCenter: 2.55 + 8 * 0.3,
    coneHeight: 8,
  },
  // Taller trunk under a round crown.
  'tree-oak': {
    shape: 'round',
    trunkRadius: 0.35,
    trunkHeight: 3.25,
    canopyRadius: 3,
    canopyCenter: 3.25 + 3 * 0.6,
  },
};
