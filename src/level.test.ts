import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';
import { Level } from './level';
import { GRID_STEP, gridSize } from './levelData';
import { makeData } from './testLevel';

describe('grid size', () => {
  test('has a point every GRID_STEP including both edges', () => {
    expect(gridSize(8, 1.6)).toEqual({ cols: 11, rows: 3 });
  });
});

describe('height', () => {
  test('matches stored values at grid points', () => {
    const level = new Level(makeData({ height: (x, z) => Math.sin(x) * 3 + z * z * 0.01 }));
    for (const [x, z] of [[0, 0], [4, 8], [15.2, 39.2]]) {
      expect(level.heightAt(x, z)).toBeCloseTo(Math.sin(x) * 3 + z * z * 0.01, 4);
    }
  });

  test('is exact on a plane anywhere between grid points, with the plane normal', () => {
    const level = new Level(makeData({ height: (x, z) => 2 + 0.5 * x - 0.25 * z }));
    const n = new THREE.Vector3();
    const expected = new THREE.Vector3(-0.5, 1, 0.25).normalize();
    for (const [x, z] of [[1.13, 2.71], [7.9, 20.05], [3.3, 0.2]]) {
      expect(level.heightAt(x, z)).toBeCloseTo(2 + 0.5 * x - 0.25 * z, 4);
      expect(level.normalAt(x, z, n).distanceTo(expected)).toBeLessThan(1e-5);
    }
  });

  test('follows the rendered triangles: the cell is split along its b-d diagonal', () => {
    // A single raised corner at (0.8, 0.8): the far corner of the first cell, past the diagonal.
    const level = new Level(makeData({ height: (x, z) => (x === GRID_STEP && z === GRID_STEP ? 1 : 0) }));
    // On the near side of the diagonal the raised corner isn't part of the triangle.
    expect(level.heightAt(0.3, 0.3)).toBeCloseTo(0, 6);
    // Past it, height rises linearly toward the corner.
    expect(level.heightAt(0.6, 0.6)).toBeCloseTo(0.5, 5);
  });

  test('rejects grids that do not match the map size', () => {
    const data = makeData();
    expect(() => new Level({ ...data, grids: { ...data.grids, wind: new Uint8Array(3) } })).toThrow();
  });

  test('clamps to the edge outside the map', () => {
    const level = new Level(makeData({ height: (x) => x }));
    expect(level.heightAt(-5, 10)).toBeCloseTo(0, 5);
    expect(level.heightAt(30, 10)).toBeCloseTo(16, 5);
  });
});

describe('surfaces and bounds', () => {
  test('surface comes from the nearest grid point', () => {
    const level = new Level(makeData({ surface: (x) => (x < 4 ? 'rough' : 'bunker') }));
    expect(level.surfaceAt(3.5, 10)).toBe('rough');
    expect(level.surfaceAt(3.7, 10)).toBe('bunker');
  });

  test('painted oob and anywhere off the map are out of bounds', () => {
    const level = new Level(makeData({ surface: (x) => (x > 12 ? 'oob' : 'fairway') }));
    expect(level.isOutOfBounds(6, 10)).toBe(false);
    expect(level.isOutOfBounds(13, 10)).toBe(true);
    expect(level.isOutOfBounds(-0.5, 10)).toBe(true);
    expect(level.isOutOfBounds(6, 40.5)).toBe(true);
  });
});

describe('tee, cup and wind', () => {
  test('ball starts on the ground at the tee and the rim sits on the green at the cup', () => {
    const level = new Level(makeData({ height: (_x, z) => z * 0.1 }));
    expect(level.tee.x).toBe(8);
    expect(level.tee.z).toBe(36);
    expect(level.tee.y).toBeCloseTo(3.6 + 0.12, 4);
    expect(level.hole.x).toBe(8);
    expect(level.hole.y).toBe(4);
    expect(level.rimY).toBeCloseTo(0.4, 4);
    expect(level.par).toBe(3);
  });

  test('without zones, the first wind entry blows everywhere, direction in degrees from +x toward +z', () => {
    const level = new Level(makeData({ winds: [{ speed: 4, direction: 90 }] }));
    for (const [x, z] of [[0, 0], [8, 20], [-50, 300]]) {
      const w = level.windAt(x, z, new THREE.Vector3());
      expect(w.x).toBeCloseTo(0, 6);
      expect(w.y).toBe(0);
      expect(w.z).toBeCloseTo(4, 6);
    }
  });
});

describe('wind zones', () => {
  // Zone 1 (6 m/s toward +x) covers z > 30 of a 60 m map; zone 0 is calm.
  const level = new Level(
    makeData({
      width: 30,
      length: 60,
      winds: [
        { speed: 0, direction: 0 },
        { speed: 6, direction: 0 },
      ],
      wind: (_x, z) => (z > 30 ? 1 : 0),
    }),
  );
  const at = (x: number, z: number) => level.windAt(x, z, new THREE.Vector3()).x;

  test('each zone has its own wind away from borders', () => {
    expect(at(15, 10)).toBeCloseTo(0, 6);
    expect(at(15, 50)).toBeCloseTo(6, 6);
  });

  test('blends across a border over about 10 m', () => {
    expect(at(15, 30.4)).toBeCloseTo(3, 0);
    expect(at(15, 26)).toBeGreaterThan(0);
    expect(at(15, 26)).toBeLessThan(at(15, 30.4));
    expect(at(15, 34)).toBeLessThan(6);
    expect(at(15, 24)).toBeCloseTo(0, 6);
    expect(at(15, 37)).toBeCloseTo(6, 6);
  });

  test('changes smoothly between grid points, with no steps', () => {
    for (let z = 27; z < 34; z += 0.1) {
      expect(Math.abs(at(15, z + 0.1) - at(15, z))).toBeLessThan(0.1);
    }
  });

  test('zone ids with no wind entry fall back to the default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = new Level(makeData({ winds: [{ speed: 2, direction: 0 }], wind: () => 5 }));
    expect(bad.windAt(8, 20, new THREE.Vector3()).x).toBeCloseTo(2, 6);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('5'));
    warn.mockRestore();
  });
});

describe('line of play', () => {
  test('without one, distance and aim are straight at the pin', () => {
    const level = new Level(makeData());
    expect(level.distance).toBeCloseTo(32, 5);
    expect(level.remainingDistance(8, 20)).toBeCloseTo(16, 5);
    // Even from off to the side of the tee-to-pin line.
    expect(level.targetAhead(2, 30, 10, new THREE.Vector2()).toArray()).toEqual([8, 4]);
  });

  test('runs tee → points → cup and drives distance and camera aim', () => {
    const level = new Level(makeData({ tee: { x: 2, z: 36 }, cup: { x: 14, z: 4 }, lineOfPlay: [{ x: 2, z: 4 }] }));
    expect(level.distance).toBeCloseTo(44, 5);
    // Halfway up the first leg: 16 m left on it plus the 12 m second leg.
    expect(level.remainingDistance(2.5, 20)).toBeCloseTo(28, 5);
    // Aiming 20 m ahead from there turns the corner.
    const p = level.targetAhead(2.5, 20, 20, new THREE.Vector2());
    expect(p.x).toBeCloseTo(6, 5);
    expect(p.y).toBeCloseTo(4, 5);
    // Near the end, aim straight at the pin.
    expect(level.targetAhead(12, 4, 20, new THREE.Vector2()).toArray()).toEqual([14, 4]);
  });

  test('distance left never reads less than the straight line to the pin', () => {
    const level = new Level(makeData({ tee: { x: 2, z: 36 }, cup: { x: 14, z: 4 }, lineOfPlay: [{ x: 2, z: 4 }] }));
    // Past the cup, the route has nothing left but the pin is still 4 m away.
    expect(level.remainingDistance(14, 0)).toBeCloseTo(4, 5);
  });
});

describe('water', () => {
  test('each connected water region takes the level of the seed point inside it', () => {
    const water = (x: number, z: number) => (x < 5 && z < 10) || (x > 10 && z > 30);
    const level = new Level(
      makeData({
        height: (x, z) => (water(x, z) ? -2 : 0),
        surface: (x, z) => (water(x, z) ? 'water' : 'rough'),
        waterLevels: [
          { x: 2, z: 2, level: -0.5 },
          { x: 12, z: 35, level: -0.25 },
        ],
      }),
    );
    expect(level.waterLevelAt(1, 9)).toBe(-0.5);
    expect(level.waterLevelAt(15, 31)).toBe(-0.25);
    expect(level.waterLevelAt(8, 20)).toBeNaN();
  });

  test('a region with no seed fills to just below its lowest shore', () => {
    const water = (x: number, z: number) => x > 4 && x < 8 && z > 4 && z < 8;
    const level = new Level(
      makeData({
        height: (x, z) => (water(x, z) ? -2 : z < 6 ? 1 : 0.6),
        surface: (x, z) => (water(x, z) ? 'water' : 'rough'),
      }),
    );
    expect(level.waterLevelAt(6, 6)).toBeCloseTo(0.5, 5);
  });
});

describe('objects', () => {
  test('trees become solid trunks and canopies on the ground, scaled', () => {
    const level = new Level(
      makeData({
        height: () => 2,
        objects: [
          { type: 'tree-pine', x: 4, z: 10, rotation: 0, scale: 1 },
          { type: 'tree-oak', x: 12, z: 20, y: 1, rotation: 45, scale: 2 },
        ],
      }),
    );
    expect(level.trees.length).toBe(2 * 7);
    const [x, z, ground] = level.trees.slice(7, 10);
    expect([x, z, ground]).toEqual([12, 20, 3]);
    const pineTrunk = level.trees[3];
    expect(level.trees[7 + 3]).toBeCloseTo(pineTrunk * 2, 5);
    expect(level.treesNear(12, 21)).toContain(1);
  });

  test('unknown object types are skipped with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const level = new Level(makeData({ objects: [{ type: 'windmill', x: 4, z: 10, rotation: 0, scale: 1 }] }));
    expect(level.trees.length).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('windmill'));
    warn.mockRestore();
  });
});
