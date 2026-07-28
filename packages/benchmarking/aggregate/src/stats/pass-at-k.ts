/**
 * Chen et al. 2021 ("Evaluating Large Language Models Trained on Code") unbiased pass@k
 * estimator, plus the plain per-task average success rate (avg@k, design §9.2 `avg-at-k@1` /
 * `pass-at-k@1`). Adoption of a well-established closed-form estimator (design §9.2), computed
 * from scratch here since no in-repo seed exists for it.
 *
 * pass@k = E_task[ 1 - C(n-c, k) / C(n, k) ], where `n` is the number of replicates sampled for
 * a task and `c` is the number that passed. Computed via the numerically stable product form
 * `1 - prod_{i=n-c+1}^{n} (1 - k / i)` (never the raw binomial-coefficient ratio, which overflows
 * for even moderate `n`).
 */
export function passAtK(n: number, c: number, k: number): number {
  if (n < 0 || c < 0 || c > n || !Number.isInteger(n) || !Number.isInteger(c) || !Number.isInteger(k) || k < 1) {
    throw new Error(`passAtK: invalid arguments n=${n} c=${c} k=${k} (require 0<=c<=n, k>=1 integers)`);
  }
  if (n - c < k) return 1;
  let product = 1;
  for (let i = n - c + 1; i <= n; i += 1) product *= 1 - k / i;
  return 1 - product;
}

/** The plain per-task average success rate: `c / n`. */
export function avgAtOne(n: number, c: number): number {
  if (n <= 0) throw new Error(`avgAtOne: n must be positive (got ${n})`);
  return c / n;
}
