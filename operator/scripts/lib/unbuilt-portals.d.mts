// Hand-written types for `unbuilt-portals.mjs`.
//
// Without this, importing the module from a test under `operator/test/` is TS7016 ("implicitly has
// an 'any' type") and the new file lands in `test-typecheck-baseline.json` carrying errors. The
// ratchet only tightens to a strict `0 → 1` gate for files that are at zero (issue #3735), so a
// declaration file is worth more here than a baseline entry.

/** One `@jinn-network/*` dependency whose built entrypoint is absent, and why. */
export interface UnbuiltPortalPackage {
  readonly name: string;
  readonly reason: string;
}

export function findUnbuiltPortalPackages(dir: string): UnbuiltPortalPackage[];

export function formatUnbuiltPortalsMessage(
  unbuilt: readonly UnbuiltPortalPackage[],
): string;
