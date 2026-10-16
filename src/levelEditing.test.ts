import { describe, expect, test } from 'vitest';
import { Level } from './level';
import { GRID_STEP, gridSize, nearestIndex, waterRegions, type LevelData } from './levelData';
import { EditableLevel, brushWeight, insertLinePoint, nearestLinePoint, nearestObject } from './levelEditing';
import { decodeLevel, encodeLevel } from './levelFile';
import { mulberry32 } from './noise';
import { SURFACE_LIST } from './surfaces';
import { makeData } from './testLevel';

const hard = { radius: 5, strength: 1, falloff: 0 };

/** Height of the grid point nearest (x, z). */
const h = (level: EditableLevel, x: number, z: number) => level.data.grids.height[index(level.data, x, z)];
const surfaceAt = (level: EditableLevel, x: number, z: number) => SURFACE_LIST[level.data.grids.surface[index(level.data, x, z)]];
function index(data: LevelData, x: number, z: number): number {
  const { cols, rows } = gridSize(data.width, data.length);
  return nearestIndex(cols, rows, x, z);
}

function stroke(level: EditableLevel, tool: Parameters<EditableLevel['beginStroke']>[0], at: [number, number][], brush = hard) {
  level.beginStroke(tool, brush, at[0][0], at[0][1]);
  for (const [x, z] of at) level.dab(x, z);
  level.endStroke();
}

describe('new levels', () => {
  test('a blank level is flat rough, with the tee and cup at either end', () => {
    const level = EditableLevel.blank(100, 200);
    const { cols, rows } = gridSize(100, 200);
    expect(level.data.grids.height).toEqual(new Float32Array(cols * rows));
    expect(new Set(level.data.grids.surface)).toEqual(new Set([SURFACE_LIST.indexOf('rough')]));
    expect(level.data.tee.x).toBe(50);
    expect(level.data.tee.z).toBeGreaterThan(180);
    expect(level.data.cup.z).toBeLessThan(20);
    expect(level.data.winds.length).toBe(1);
    expect(() => new Level(level.data)).not.toThrow();
  });

  test('heights are kept to the millimetre, so a saved level plays exactly as edited', async () => {
    const level = new EditableLevel(makeData({ height: (x, z) => Math.sin(x) + z / 7 }));
    stroke(level, { kind: 'raise' }, [[8, 20]], { radius: 4, strength: 0.37, falloff: 0.6 });
    const saved = await decodeLevel(JSON.parse(await encodeLevel(level.data)));
    expect(saved.grids.height).toEqual(level.data.grids.height);
  });
});

describe('brushes', () => {
  test('weight is full inside the falloff and fades to nothing at the radius', () => {
    const brush = { radius: 10, strength: 1, falloff: 0.5 };
    expect(brushWeight(0, brush)).toBe(1);
    expect(brushWeight(5, brush)).toBe(1);
    expect(brushWeight(7.5, brush)).toBeCloseTo(0.5, 5);
    expect(brushWeight(10, brush)).toBe(0);
    expect(brushWeight(4, { ...brush, falloff: 1 })).toBeLessThan(1);
    expect(brushWeight(9.9, { ...brush, falloff: 0 })).toBe(1);
  });

  test('raise and lower move ground inside the brush only', () => {
    const level = new EditableLevel(makeData({ width: 40, length: 40 }));
    stroke(level, { kind: 'raise' }, [[20, 20]]);
    expect(h(level, 20, 20)).toBeCloseTo(0.5, 3);
    expect(h(level, 24, 20)).toBeCloseTo(0.5, 3);
    expect(h(level, 26, 20)).toBe(0);
    stroke(level, { kind: 'lower' }, [[20, 20]], { ...hard, strength: 0.5 });
    expect(h(level, 20, 20)).toBeCloseTo(0.25, 3);
  });

  test('flatten pulls ground to the height where the stroke started', () => {
    const level = new EditableLevel(makeData({ width: 40, length: 60, height: (_x, z) => z * 0.1 }));
    stroke(level, { kind: 'flatten' }, [
      [20, 20],
      [20, 30],
      [20, 40],
    ]);
    expect(h(level, 20, 40)).toBeCloseTo(2, 3);
    expect(h(level, 22, 33)).toBeCloseTo(2, 3);
  });

  test('set height pulls ground to a typed height', () => {
    const level = new EditableLevel(makeData({ width: 40, length: 40 }));
    stroke(level, { kind: 'set', height: -1.5 }, [[20, 20]]);
    expect(h(level, 21, 21)).toBeCloseTo(-1.5, 3);
  });

  test('smooth evens out a spike', () => {
    const level = new EditableLevel(makeData({ width: 40, length: 40, height: (x, z) => (Math.abs(x - 20) < 0.01 && Math.abs(z - 20) < 0.01 ? 4 : 0) }));
    stroke(level, { kind: 'smooth' }, [[20, 20]]);
    expect(h(level, 20, 20)).toBeLessThan(1);
    expect(h(level, 20 + GRID_STEP, 20)).toBeGreaterThan(0);
  });

  test('painting changes surfaces or wind zones with a hard edge, never heights', () => {
    const level = new EditableLevel(makeData({ width: 40, length: 40, height: (x) => x * 0.01 }));
    const heights = level.data.grids.height.slice();
    stroke(level, { kind: 'surface', surface: 'bunker' }, [[20, 20]], { radius: 5, strength: 0.1, falloff: 1 });
    expect(surfaceAt(level, 24, 20)).toBe('bunker');
    expect(surfaceAt(level, 26, 20)).toBe('fairway');
    stroke(level, { kind: 'wind', zone: 2 }, [[20, 20]]);
    expect(level.data.grids.wind[index(level.data, 20, 20)]).toBe(2);
    expect(level.data.grids.height).toEqual(heights);
  });

  test('a stroke paints along the path between dabs', () => {
    const level = new EditableLevel(makeData({ width: 40, length: 60 }));
    stroke(level, { kind: 'surface', surface: 'green' }, [
      [20, 10],
      [20, 50],
    ], { radius: 2, strength: 1, falloff: 0 });
    expect(surfaceAt(level, 20, 30)).toBe('green');
  });
});

describe('scatter', () => {
  test('places objects of the chosen type inside the brush, spaced apart', () => {
    const level = new EditableLevel(makeData({ width: 100, length: 100 }));
    level.random = mulberry32(3);
    stroke(level, { kind: 'scatter', type: 'tree-oak' }, [
      [50, 50],
      [50, 50],
      [50, 50],
    ], { radius: 20, strength: 0.5, falloff: 0 });
    const objects = level.data.objects;
    expect(objects.length).toBeGreaterThan(5);
    for (const o of objects) {
      expect(o.type).toBe('tree-oak');
      expect(Math.hypot(o.x - 50, o.z - 50)).toBeLessThanOrEqual(20);
    }
    const closest = Math.min(...objects.flatMap((a, i) => objects.slice(i + 1).map((b) => Math.hypot(a.x - b.x, a.z - b.z))));
    expect(closest).toBeGreaterThan(3);
  });
});

describe('undo and redo', () => {
  test('undo a stroke and redo it', () => {
    const level = new EditableLevel(makeData({ width: 40, length: 40 }));
    expect(level.canUndo).toBe(false);
    stroke(level, { kind: 'raise' }, [[20, 20]]);
    expect(level.undo()).toBe(true);
    expect(h(level, 20, 20)).toBe(0);
    expect(level.redo()).toBe(true);
    expect(h(level, 20, 20)).toBeCloseTo(0.5, 3);
  });

  test('a new edit after undoing drops the redo', () => {
    const level = new EditableLevel(makeData({ width: 40, length: 40 }));
    stroke(level, { kind: 'raise' }, [[20, 20]]);
    level.undo();
    stroke(level, { kind: 'lower' }, [[10, 10]]);
    expect(level.canRedo).toBe(false);
  });

  test('changes to anything but the grids undo too, including drags', () => {
    const level = new EditableLevel(makeData());
    level.change((d) => (d.tee = { x: 1, z: 2 }));
    level.beginChange();
    level.data.cup = { x: 3, z: 3 };
    level.data.cup = { x: 4, z: 4 };
    level.endChange();
    level.undo();
    expect(level.data.cup).toEqual({ x: 8, z: 4 });
    level.undo();
    expect(level.data.tee).toEqual({ x: 8, z: 36 });
    level.redo();
    expect(level.data.tee).toEqual({ x: 1, z: 2 });
  });

  test('a stroke or change that changes nothing adds no undo step', () => {
    const level = new EditableLevel(makeData({ width: 40, length: 40 }));
    stroke(level, { kind: 'raise' }, [[-50, -50]]);
    level.change(() => {});
    expect(level.canUndo).toBe(false);
  });

  test('undo waits while a stroke or drag is still going', () => {
    const level = new EditableLevel(makeData({ width: 40, length: 40 }));
    stroke(level, { kind: 'raise' }, [[20, 20]]);
    level.beginStroke({ kind: 'raise' }, hard, 10, 10);
    level.dab(10, 10);
    expect(level.undo()).toBe(false);
    level.endStroke();
    level.beginChange();
    expect(level.undo()).toBe(false);
    level.endChange();
    expect(level.undo()).toBe(true);
    expect(level.undo()).toBe(true);
    expect(h(level, 20, 20)).toBe(0);
    expect(h(level, 10, 10)).toBe(0);
  });

  test('undo is not slowed by keeping whole copies of the map', () => {
    const level = new EditableLevel(makeData({ width: 400, length: 1200 }));
    stroke(level, { kind: 'raise' }, [[200, 600]]);
    expect(level.undoBytes()).toBeLessThan(level.data.grids.height.byteLength / 50);
  });
});

describe('water', () => {
  const pond = (x: number, z: number) => Math.hypot(x - 20, z - 20) < 6;
  const level = () =>
    new EditableLevel(makeData({ width: 40, length: 40, surface: (x, z) => (pond(x, z) ? 'water' : 'rough'), height: (x, z) => (pond(x, z) ? -2 : 0) }));

  test('clicking a water region sets its level, replacing any earlier one', () => {
    const edit = level();
    expect(edit.setWaterLevel(20, 20, -0.4)).toBe(true);
    expect(edit.setWaterLevel(22, 18, -0.3)).toBe(true);
    expect(edit.data.waterLevels.length).toBe(1);
    expect(waterRegions(edit.data).levels).toEqual([-0.3]);
  });

  test('clicking dry ground does nothing', () => {
    const edit = level();
    expect(edit.setWaterLevel(2, 2, -0.4)).toBe(false);
    expect(edit.data.waterLevels).toEqual([]);
    expect(edit.canUndo).toBe(false);
  });
});

describe('markers and objects', () => {
  test('new line-of-play points go where they lengthen the route least', () => {
    const data = makeData({ width: 100, length: 200, tee: { x: 50, z: 190 }, cup: { x: 50, z: 10 } });
    insertLinePoint(data, { x: 60, z: 100 });
    insertLinePoint(data, { x: 55, z: 150 });
    insertLinePoint(data, { x: 52, z: 40 });
    expect(data.lineOfPlay).toEqual([
      { x: 55, z: 150 },
      { x: 60, z: 100 },
      { x: 52, z: 40 },
    ]);
    expect(nearestLinePoint(data, 59, 101, 3)).toBe(1);
    expect(nearestLinePoint(data, 70, 101, 3)).toBe(-1);
  });

  test('finds the object under the cursor', () => {
    const data = makeData({
      objects: [
        { type: 'tree-oak', x: 5, z: 5, rotation: 0, scale: 1 },
        { type: 'tree-pine', x: 10, z: 10, rotation: 0, scale: 1 },
      ],
    });
    expect(nearestObject(data, 9, 9, 3)).toBe(1);
    expect(nearestObject(data, 20, 20, 3)).toBe(-1);
  });

});

describe('wind zones', () => {
  test('removing the last wind zone repaints its ground with the default wind, undoably', () => {
    const level = new EditableLevel(
      makeData({ width: 40, length: 40, winds: [{ speed: 1, direction: 0 }, { speed: 5, direction: 90 }], wind: (x) => (x > 20 ? 1 : 0) }),
    );
    level.removeWindZone();
    expect(level.data.winds.length).toBe(1);
    expect(level.data.grids.wind.every((z) => z === 0)).toBe(true);
    level.undo();
    expect(level.data.winds.length).toBe(2);
    expect(level.data.grids.wind[index(level.data, 30, 10)]).toBe(1);
  });

  test('the default wind zone cannot be removed', () => {
    const level = new EditableLevel(makeData());
    level.removeWindZone();
    expect(level.data.winds.length).toBe(1);
    expect(level.canUndo).toBe(false);
  });
});
