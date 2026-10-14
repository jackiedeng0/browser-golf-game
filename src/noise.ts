/** Small, fast seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Seeded 2D gradient (Perlin-style) noise. */
export class Noise2D {
  private readonly perm = new Uint8Array(512);
  private readonly grad = new Float32Array(512);

  constructor(rand: () => number) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    for (let i = 0; i < 256; i++) {
      const a = rand() * Math.PI * 2;
      this.grad[i * 2] = Math.cos(a);
      this.grad[i * 2 + 1] = Math.sin(a);
    }
  }

  /** Noise value in roughly [-1, 1]. */
  sample(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const perm = this.perm;
    const n00 = this.dot(perm[X + perm[Y]], xf, yf);
    const n10 = this.dot(perm[X + 1 + perm[Y]], xf - 1, yf);
    const n01 = this.dot(perm[X + perm[Y + 1]], xf, yf - 1);
    const n11 = this.dot(perm[X + 1 + perm[Y + 1]], xf - 1, yf - 1);
    const u = fade(xf);
    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), fade(yf)) * 1.41;
  }

  /** Fractal sum of `octaves` noise layers, normalized to roughly [-1, 1]. */
  fbm(x: number, y: number, octaves: number): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let freq = 1;
    for (let i = 0; i < octaves; i++) {
      sum += this.sample(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }

  private dot(h: number, x: number, y: number): number {
    return this.grad[h * 2] * x + this.grad[h * 2 + 1] * y;
  }
}
