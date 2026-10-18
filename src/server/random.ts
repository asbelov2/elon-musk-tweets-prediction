/** Seeded Mulberry32 + Marsaglia–Tsang Gamma and Hörmann PTRS Poisson.
 * Sampling is reproducible in TS; seeds do not reproduce NumPy's bit stream.
 */
export class Random {
  private state: number;
  constructor(seed = 42) {
    this.state = seed >>> 0;
  }
  uniform(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
  }
  normal(): number {
    return Math.sqrt(-2 * Math.log(this.uniform())) * Math.cos(2 * Math.PI * this.uniform());
  }
  gamma(shape: number, scale = 1): number {
    if (!Number.isFinite(shape) || shape <= 0 || !Number.isFinite(scale) || scale <= 0)
      throw new RangeError('Gamma parameters must be positive and finite');
    if (shape < 1) return this.gamma(shape + 1, scale) * this.uniform() ** (1 / shape);
    const d = shape - 1 / 3,
      c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const x = this.normal(),
        base = 1 + c * x;
      if (base <= 0) continue;
      const v = base ** 3,
        u = this.uniform();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v)))
        return scale * d * v;
    }
  }
  poisson(lambda: number): number {
    if (!Number.isFinite(lambda) || lambda < 0)
      throw new RangeError('Poisson mean must be nonnegative and finite');
    if (lambda === 0) return 0;
    if (lambda < 30) {
      const limit = Math.exp(-lambda);
      let product = 1,
        count = 0;
      do {
        product *= this.uniform();
        count++;
      } while (product > limit);
      return count - 1;
    }
    const root = Math.sqrt(lambda),
      b = 0.931 + 2.53 * root,
      a = -0.059 + 0.02483 * b;
    const invAlpha = 1.1239 + 1.1328 / (b - 3.4),
      vr = 0.9277 - 3.6224 / (b - 2);
    for (;;) {
      const u = this.uniform() - 0.5,
        v = this.uniform(),
        us = 0.5 - Math.abs(u);
      const k = Math.floor(((2 * a) / us + b) * u + lambda + 0.43);
      if (k < 0) continue;
      if (us >= 0.07 && v <= vr) return k;
      if (us < 0.013 && v > us) continue;
      if (
        Math.log((v * invAlpha) / (a / (us * us) + b)) <=
        -lambda + k * Math.log(lambda) - logGamma(k + 1)
      )
        return k;
    }
  }
}

function logGamma(z: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
    12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  let x = 0.99999999999980993;
  z--;
  for (let i = 0; i < coefficients.length; i++) x += coefficients[i] / (z + i + 1);
  const t = z + coefficients.length - 0.5;
  return 0.9189385332046727 + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
