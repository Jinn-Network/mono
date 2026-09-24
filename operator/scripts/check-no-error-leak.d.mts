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

/** File-scope adjacency: viem / PublicClient / masking helper / named seam. */
export function isRpcAdjacent(text: string): boolean;

/** Relative `./` / `../` import specs in `text`, in source order. */
export function parseRelativeImportSpecs(text: string): string[];

/**
 * True when `absPath` imports `viem`, a relative import inside `srcRoot/api`
 * does, or a one-hop import outside `api/` reaches the viem package root /
 * an RPC client type. `viem/accounts` one-hops are not adjacency.
 * Recursion past that hop is out of scope — injected-port seams stay on
 * `INDIRECT_RPC_PATTERN`. `cache` / `visiting` are optional and shared
 * across a scan.
 */
export function moduleTouchesViem(
  absPath: string,
  srcRoot: string,
  cache?: Map<string, boolean>,
  visiting?: Set<string>,
): boolean;

/**
 * Graph-adjacent api files (transitively import `viem`) that are not
 * `isRpcAdjacent`. Empty on a healthy live tree.
 */
export function findGraphCompletenessGaps(apiDir: string, srcRoot: string): string[];

/**
 * `api/` files with a raw error-to-string conversion that are neither
 * `isRpcAdjacent` nor on the guard's `NON_RPC_API_ALLOWLIST`. Empty on a
 * healthy live tree.
 */
export function findRawHitCompletenessGaps(apiDir: string, srcRoot: string): string[];
