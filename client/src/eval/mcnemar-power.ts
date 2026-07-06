/** Acklam's rational approximation to the inverse normal CDF (|err| < 1.15e-9). */
export function zFor(p: number): number {
  if (p <= 0 || p >= 1) throw new Error('zFor expects 0 < p < 1');
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  let q: number, r: number;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]!*q+c[1]!)*q+c[2]!)*q+c[3]!)*q+c[4]!)*q+c[5]!) / ((((d[0]!*q+d[1]!)*q+d[2]!)*q+d[3]!)*q+1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]!*q+c[1]!)*q+c[2]!)*q+c[3]!)*q+c[4]!)*q+c[5]!) / ((((d[0]!*q+d[1]!)*q+d[2]!)*q+d[3]!)*q+1); }
  q = p - 0.5; r = q * q;
  return (((((a[0]!*r+a[1]!)*r+a[2]!)*r+a[3]!)*r+a[4]!)*r+a[5]!)*q / (((((b[0]!*r+b[1]!)*r+b[2]!)*r+b[3]!)*r+b[4]!)*r+1);
}

export interface SampleSizeOpts { alpha?: number; power?: number; }

/**
 * Connor (1987) total task-PAIRS N for McNemar's test.
 * pb = P(B passes, A fails); pc = P(A passes, B fails).
 */
export function mcnemarSampleSize(pb: number, pc: number, opts: SampleSizeOpts = {}): { pairs: number; discordant: number } {
  const alpha = opts.alpha ?? 0.05;
  const power = opts.power ?? 0.8;
  const diff = pb - pc;
  if (diff <= 0) throw new Error('mcnemarSampleSize expects pb > pc (a positive effect)');
  const pd = pb + pc;
  const za = zFor(1 - alpha / 2);
  const zb = zFor(power);
  const m = Math.pow(za * Math.sqrt(pd) + zb * Math.sqrt(pd - diff * diff), 2) / (diff * diff);
  const pairs = m / pd;
  return { pairs: Math.ceil(pairs), discordant: Math.ceil(m) };
}
