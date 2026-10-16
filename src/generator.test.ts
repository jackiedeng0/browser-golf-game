import { describe, expect, test } from 'vitest';
import { generateLevel } from './generator';
import { Level } from './level';
import { GRID_STEP, gridSize } from './levelData';
import { OBJECT_TYPES } from './objects';
import { surfaceId } from './surfaces';

describe('generateLevel', () => {
  const seeds = [1, 2, 3];
  const generated = seeds.map((seed) => generateLevel(seed));

  test('is deterministic for a seed', () => {
    const again = generateLevel(seeds[0]);
    const { grids, ...meta } = generated[0];
    const { grids: grids2, ...meta2 } = again;
    expect(meta2).toEqual(meta);
    expect(grids2.height).toEqual(grids.height);
    expect(grids2.surface).toEqual(grids.surface);
  });

  test.each(seeds.map((seed, i) => [seed, i]))('seed %i makes a playable hole', (_seed, i) => {
    const data = generated[i];
    const { cols, rows } = gridSize(data.width, data.length);
    expect(data.grids.height.length).toBe(cols * rows);
    expect(data.grids.surface.length).toBe(cols * rows);
    expect(data.grids.wind.length).toBe(cols * rows);

    const level = new Level(data);
    expect(level.surfaceAt(data.tee.x, data.tee.z)).toBe('tee');
    expect(level.surfaceAt(data.cup.x, data.cup.z)).toBe('green');
    expect(level.isOutOfBounds(data.tee.x, data.tee.z)).toBe(false);
    // A long hole, measured along the fairway's bends.
    expect(level.distance).toBeGreaterThan(1050);
    expect(level.distance).toBeLessThan(1450);
    for (const p of data.lineOfPlay ?? []) expect(level.isOutOfBounds(p.x, p.z)).toBe(false);

    // The cup sits on level ground.
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      expect(Math.abs(level.heightAt(data.cup.x + dx, data.cup.z + dz) - level.rimY)).toBeLessThan(0.1);
    }

    const water = surfaceId('water');
    for (const w of data.waterLevels) {
      expect(data.grids.surface[Math.round(w.z / GRID_STEP) * cols + Math.round(w.x / GRID_STEP)]).toBe(water);
      expect(level.waterLevelAt(w.x, w.z)).toBe(w.level);
    }

    expect(data.objects.length).toBeGreaterThan(50);
    for (const o of data.objects) {
      expect(OBJECT_TYPES[o.type]).toBeDefined();
      expect(o.x).toBeGreaterThanOrEqual(0);
      expect(o.z).toBeGreaterThanOrEqual(0);
      expect(o.x).toBeLessThanOrEqual(data.width);
      expect(o.z).toBeLessThanOrEqual(data.length);
    }
  });
}, 60_000);
