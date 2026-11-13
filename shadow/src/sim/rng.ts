/**
 * A small seeded random number generator (mulberry32), so every run can be repeated exactly from its seed.
 *
 * Each purpose gets its own stream per round (`streamFor`): a run with the rank limits and its control then draw the
 * same numbers in the same round (the same arrivals, the same Intern answer drawn from the record) even after their
 * pools have drifted apart, so the two differ only by what the limits did.
 */
export class Rng {
  #s: number;

  constructor(seed: number) {
    this.#s = seed >>> 0;
  }

  /** A number in [0, 1). */
  next(): number {
    this.#s = (this.#s + 0x6d2b79f5) >>> 0;
    let t = this.#s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** A whole number in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error("cannot pick from an empty list");
    return item;
  }

  /** Uniform between min and max. */
  between(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Spread evenly on a log scale between min and max (both above 0): as many deposits near $50 as near $500. */
  logUniform(min: number, max: number): number {
    return Math.exp(Math.log(min) + (Math.log(max) - Math.log(min)) * this.next());
  }

  /** A Poisson count with the given mean (Knuth's method; the means used here are small). */
  poisson(mean: number): number {
    if (mean <= 0) return 0;
    const limit = Math.exp(-mean);
    let k = 0;
    let p = this.next();
    while (p > limit) {
      k += 1;
      p *= this.next();
    }
    return k;
  }
}

/** FNV-1a over the parts, as a 32-bit seed. */
export function hashSeed(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join("|")) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The stream for one purpose in one round of one seed. */
export function streamFor(seed: number, purpose: string, round = 0): Rng {
  return new Rng(hashSeed(seed, purpose, round));
}
