import type { LevelData } from './levelData';
import { decodeLevel } from './levelFile';

export interface LevelEntry {
  /** Shown in the level list: the file name without its extension, dashes and underscores as spaces. */
  title: string;
  file: string;
  source: 'official' | 'user';
  load: () => Promise<LevelData>;
}

// Vite finds these files at build time. Official levels are served as files and fetched.
const official = Object.fromEntries(
  Object.entries(import.meta.glob<string>('../levels/official/*.json', { query: '?url', import: 'default' })).map(([path, url]) => [
    path,
    async () => {
      const response = await fetch(await url());
      if (!response.ok) throw new Error(`Couldn't load ${path} (${response.status})`);
      return response.json();
    },
  ]),
);
// Personal levels are only picked up by the dev server, as plain JSON modules: a production
// build drops this branch, and the files with it, so they never end up in dist/.
const user = import.meta.env.DEV ? import.meta.glob<unknown>('../levels/user/*.json', { import: 'default' }) : {};

/** Official levels, then (in dev) your own, each in file-name order. */
export function listLevels(): LevelEntry[] {
  return [...levelEntries(official, 'official'), ...levelEntries(user, 'user')];
}

/** True when the game also lists levels from levels/user/ (only on the dev server). */
export const listsUserLevels = import.meta.env.DEV;

/** Level list entries for files found by a glob, each loading to the file's parsed JSON. */
export function levelEntries(files: Record<string, () => Promise<unknown>>, source: LevelEntry['source']): LevelEntry[] {
  return Object.entries(files)
    .map(([path, read]) => {
      const file = path.slice(path.lastIndexOf('/') + 1);
      return {
        title: file.replace(/\.json$/, '').replace(/[-_]+/g, ' '),
        file,
        source,
        load: async () => {
          try {
            return await decodeLevel(await read());
          } catch (err) {
            throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}
