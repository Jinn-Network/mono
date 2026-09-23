// Hand-written types for `check-no-error-leak.mjs`.
//
// Without this, importing the module from `test/scripts/check-no-error-leak.test.ts` is TS7016
// ("implicitly has an 'any' type"), which turns the `typecheck:test` ratchet red on a file that
// was at zero. Recording that error in `test-typecheck-baseline.json` instead would defeat the
// ratchet's purpose, and it would leave the guard's own contract untyped inside the test that
// exists to pin it (issue #2665). Same trade as `scripts/lib/unbuilt-portals.d.mts`.

/** One raw-error-message leak: where it is, and the line that leaks. */
export interface ErrorLeakViolation {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

/**
 * Scan `apiDir` for raw RPC-derived error messages reaching a response body.
 *
 * `srcRoot` is the root the reported `file` paths are made relative to.
 */
export function findErrorLeaks(apiDir: string, srcRoot: string): ErrorLeakViolation[];
