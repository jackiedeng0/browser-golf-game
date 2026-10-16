import { describe, expect, test } from 'vitest';
import { Level } from './level';
import { decodeLevel, encodeLevel } from './levelFile';
import { makeData } from './testLevel';

const data = makeData({
  height: (x, z) => Math.sin(x) + z * 0.1,
  surface: (x) => (x < 4 ? 'rough' : x > 12 ? 'oob' : 'fairway'),
  wind: (_x, z) => (z > 20 ? 1 : 0),
  lineOfPlay: [{ x: 3, z: 20 }],
  winds: [
    { speed: 2, direction: 45 },
    { speed: 6, direction: 180 },
  ],
  objects: [{ type: 'tree-pine', x: 2, z: 30, rotation: 90, scale: 1.2 }],
});

describe('level files', () => {
  test('round-trip a level, with heights to the millimetre', async () => {
    const decoded = await decodeLevel(JSON.parse(await encodeLevel(data)));
    const { grids, ...meta } = decoded;
    const { grids: original, ...originalMeta } = data;
    expect(meta).toEqual(originalMeta);
    expect(grids.surface).toEqual(original.surface);
    expect(grids.wind).toEqual(original.wind);
    expect(grids.height).toBeInstanceOf(Float32Array);
    for (let i = 0; i < grids.height.length; i++) expect(Math.abs(grids.height[i] - original.height[i])).toBeLessThanOrEqual(0.0005);
    // Saving again changes nothing: what loads is exactly what was saved.
    expect((await decodeLevel(JSON.parse(await encodeLevel(decoded)))).grids.height).toEqual(grids.height);
    expect(decoded.grids.surface).toBeInstanceOf(Uint8Array);
    expect(() => new Level(decoded)).not.toThrow();
  });

  test('keep everything but the grids readable', async () => {
    const file = JSON.parse(await encodeLevel(data));
    expect(file.name).toBe('Test');
    expect(file.par).toBe(3);
    expect(file.tee).toEqual({ x: 8, z: 36 });
    expect(file.objects).toEqual(data.objects);
    expect(typeof file.grids.height).toBe('string');
  });

  test('compress the grids well, even on bumpy ground', async () => {
    const bumpy = makeData({ width: 200, length: 400, height: (x, z) => Math.sin(x * 0.05) * 8 + Math.sin(x * 1.7 + z * 2.3) * 0.2 + z * 0.3 });
    const text = await encodeLevel(bumpy);
    const raw = bumpy.grids.height.byteLength + bumpy.grids.surface.byteLength + bumpy.grids.wind.byteLength;
    expect(text.length).toBeLessThan(raw / 4);
  });

  test('reject things that are not level files, saying what is wrong', async () => {
    await expect(decodeLevel('hello')).rejects.toThrow(/not a level/i);
    const file = JSON.parse(await encodeLevel(data));
    delete file.cup;
    await expect(decodeLevel(file)).rejects.toThrow(/cup/);
    await expect(decodeLevel({ ...JSON.parse(await encodeLevel(data)), width: 20 })).rejects.toThrow(/height grid/);
    await expect(decodeLevel({ ...file, cup: { x: 1, z: 2 }, width: -5 })).rejects.toThrow(/width/);
    await expect(decodeLevel({ ...JSON.parse(await encodeLevel(data)), grids: { height: '!!', surface: '', wind: '' } })).rejects.toThrow(
      /height grid/,
    );
  });

  test('check the entries inside lists, not just the lists', async () => {
    const file = JSON.parse(await encodeLevel(data));
    await expect(decodeLevel({ ...file, winds: [] })).rejects.toThrow(/winds/);
    await expect(decodeLevel({ ...file, winds: [{ speed: 'fast', direction: 0 }] })).rejects.toThrow(/winds/);
    await expect(decodeLevel({ ...file, waterLevels: [{ x: 1, z: 2 }] })).rejects.toThrow(/waterLevels/);
    await expect(decodeLevel({ ...file, objects: [{ type: 'tree-pine', x: 1, z: 2, rotation: 0 }] })).rejects.toThrow(/objects/);
    await expect(decodeLevel({ ...file, objects: [{ type: 'tree-pine', x: 1, z: 2, y: 'up', rotation: 0, scale: 1 }] })).rejects.toThrow(
      /objects/,
    );
  });

  test('reject surface ids the game does not know', async () => {
    const bad = makeData();
    bad.grids.surface[5] = 200;
    await expect(decodeLevel(JSON.parse(await encodeLevel(bad)))).rejects.toThrow(/surface/);
  });

  test('keep only the fields a level has', async () => {
    const decoded = await decodeLevel({ ...JSON.parse(await encodeLevel(data)), junk: 1 });
    expect(decoded).not.toHaveProperty('junk');
  });
});
