import { describe, expect, test } from 'vitest';
import { levelEntries } from './levelLibrary';

describe('level library', () => {
  test('lists files in name order, titled from the file name', () => {
    const load = async () => '';
    const entries = levelEntries(
      {
        '../levels/official/02_island-green.json': load,
        '../levels/official/01-dogleg-left.json': load,
      },
      'official',
    );
    expect(entries.map((e) => e.title)).toEqual(['01 dogleg left', '02 island green']);
    expect(entries.map((e) => e.file)).toEqual(['01-dogleg-left.json', '02_island-green.json']);
    expect(entries.every((e) => e.source === 'official')).toBe(true);
  });
});
