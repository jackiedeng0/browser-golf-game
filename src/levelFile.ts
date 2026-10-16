import { gridSize, type LevelData, type Point } from './levelData';
import { SURFACE_LIST } from './surfaces';

/**
 * A level as saved to a .json file: LevelData with each grid gzipped and base64-encoded, so
 * everything but the grids stays readable. Heights are stored to the millimetre (see
 * encodeHeights), so they compress several times smaller than raw floats.
 */
type LevelFile = Omit<LevelData, 'grids'> & { grids: Record<keyof LevelData['grids'], string> };

/** Serializes a level to the text of a .json level file. */
export async function encodeLevel(data: LevelData): Promise<string> {
  const { grids, ...meta } = data;
  const { cols } = gridSize(data.width, data.length);
  const file: LevelFile = {
    ...meta,
    grids: {
      height: await pack(encodeHeights(grids.height, cols)),
      surface: await pack(grids.surface),
      wind: await pack(grids.wind),
    },
  };
  return JSON.stringify(file, null, 2);
}

/** Reads a parsed .json level file back into level data; throws a readable error if it isn't one. */
export async function decodeLevel(json: unknown): Promise<LevelData> {
  if (!isRecord(json)) throw new Error('Not a level file');
  const f = json;
  const check = (ok: boolean, key: string) => {
    if (!ok) throw new Error(`Not a level file: "${key}" is missing or invalid`);
  };
  check(typeof f.name === 'string', 'name');
  check(isNumber(f.par), 'par');
  check(isNumber(f.width) && f.width > 0, 'width');
  check(isNumber(f.length) && f.length > 0, 'length');
  check(isPoint(f.tee), 'tee');
  check(isPoint(f.cup), 'cup');
  check(f.lineOfPlay === undefined || isList(f.lineOfPlay, isPoint), 'lineOfPlay');
  // Entry 0 is the default wind, so there must be one.
  check(isList(f.winds, (w) => isNumber(w.speed) && isNumber(w.direction)) && f.winds.length > 0, 'winds');
  check(isList(f.waterLevels, (w) => isPoint(w) && isNumber(w.level)), 'waterLevels');
  check(
    isList(
      f.objects,
      (o) =>
        typeof o.type === 'string' && isPoint(o) && (o.y === undefined || isNumber(o.y)) && isNumber(o.rotation) && isNumber(o.scale),
    ),
    'objects',
  );
  check(isRecord(f.grids), 'grids');
  const meta = f as unknown as LevelFile;

  const { cols, rows } = gridSize(meta.width, meta.length);
  const n = cols * rows;
  const grid = async (key: keyof LevelData['grids'], bytesPer: number) => {
    const text = meta.grids[key];
    let bytes: Uint8Array | null = null;
    if (typeof text === 'string') bytes = await unpack(text).catch(() => null);
    if (!bytes || bytes.length !== n * bytesPer) {
      throw new Error(`Level file's ${key} grid doesn't match its ${meta.width} × ${meta.length} m map`);
    }
    return bytes;
  };
  const height = await grid('height', Int32Array.BYTES_PER_ELEMENT);
  const surface = await grid('surface', 1);
  const wind = await grid('wind', 1);
  if (surface.some((id) => id >= SURFACE_LIST.length)) throw new Error("Level file's surface grid has surfaces the game doesn't know");

  const point = (p: Point): Point => ({ x: p.x, z: p.z });
  return {
    name: meta.name,
    par: meta.par,
    width: meta.width,
    length: meta.length,
    tee: point(meta.tee),
    cup: point(meta.cup),
    ...(meta.lineOfPlay && { lineOfPlay: meta.lineOfPlay.map(point) }),
    winds: meta.winds.map((w) => ({ speed: w.speed, direction: w.direction })),
    waterLevels: meta.waterLevels.map((w) => ({ ...point(w), level: w.level })),
    objects: meta.objects.map((o) => ({
      type: o.type,
      ...point(o),
      ...(o.y !== undefined && { y: o.y }),
      rotation: o.rotation,
      scale: o.scale,
    })),
    grids: { height: decodeHeights(new Int32Array(height.buffer, height.byteOffset, n), cols), surface, wind },
  };
}

/** Heights are stored as whole millimetres. */
const MM = 1000;

/** A height as a level file stores it. Editing keeps heights this way, so what's saved is what was played. */
export const toMillimetre = (h: number): number => Math.round(h * MM) / MM;

/**
 * Each height in millimetres, minus a prediction from the neighbors before it (left + up -
 * up-left: exact on any plane). Smooth ground predicts well, so most values are tiny.
 */
function encodeHeights(height: Float32Array, cols: number): Int32Array {
  const mm = Int32Array.from(height, (h) => Math.round(h * MM));
  const out = new Int32Array(mm.length);
  for (let i = 0; i < mm.length; i++) out[i] = mm[i] - predictHeight(mm, i, cols);
  return out;
}

function decodeHeights(residuals: Int32Array, cols: number): Float32Array {
  const mm = new Int32Array(residuals.length);
  for (let i = 0; i < mm.length; i++) mm[i] = residuals[i] + predictHeight(mm, i, cols);
  return Float32Array.from(mm, (v) => v / MM);
}

/** Predicted value at index i from its already-known left, upper and upper-left neighbors. */
function predictHeight(mm: Int32Array, i: number, cols: number): number {
  const first = i % cols === 0;
  if (i < cols) return first ? 0 : mm[i - 1];
  if (first) return mm[i - cols];
  return mm[i - 1] + mm[i - cols] - mm[i - cols - 1];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPoint = (v: unknown) => isRecord(v) && isNumber(v.x) && isNumber(v.z);
/** An array whose entries are all objects passing `valid`. */
const isList = (v: unknown, valid: (entry: Record<string, unknown>) => boolean): v is unknown[] =>
  Array.isArray(v) && v.every((entry) => isRecord(entry) && valid(entry));

/** Gzips a typed array's bytes and base64-encodes them. */
async function pack(array: Int32Array | Uint8Array): Promise<string> {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  const zipped = await pipeBytes(bytes, new CompressionStream('gzip'));
  let binary = '';
  // In chunks: String.fromCharCode can't take millions of arguments at once.
  for (let i = 0; i < zipped.length; i += 0x8000) binary += String.fromCharCode(...zipped.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Reverses pack, returning the raw bytes (in a fresh, aligned buffer). */
async function unpack(text: string): Promise<Uint8Array> {
  const binary = atob(text);
  const zipped = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) zipped[i] = binary.charCodeAt(i);
  return pipeBytes(zipped, new DecompressionStream('gzip'));
}

async function pipeBytes(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
