/**
 * Read-only / mutable views of the operator config's `joinedSolverNets` map.
 *
 * Per spec §14 of `spec/2026-05-05-solvernet-creation-and-launch.md`,
 * operator claim eligibility is per-launch via `manifestDigest`
 * (= keccak256(manifestCid)).
 */

export interface JoinedSolverNetsView {
  /** Returns the joined-net entry for the given manifest CID, or undefined. */
  get(manifestCid: string): { roles: Array<'solver' | 'evaluator'> } | undefined;
  /** Enumerate all joined manifest CIDs (used for digest-based filtering). */
  manifestCids(): string[];
  /** Add/replace one joined entry live (used by the hot-apply join applier, #1037). */
  set(manifestCid: string, entry: { roles: Array<'solver' | 'evaluator'> }): void;
}

/**
 * Build a `JoinedSolverNetsView` from the raw operator-config block.
 */
export function joinedSolverNetsViewFromConfig(
  joined: Record<string, { manifestCid: string; roles: Array<'solver' | 'evaluator'> }> | undefined,
): JoinedSolverNetsView | undefined {
  if (!joined) return undefined;
  const map = new Map<string, { roles: Array<'solver' | 'evaluator'> }>();
  for (const [key, entry] of Object.entries(joined)) {
    const cid = entry.manifestCid ?? key;
    map.set(cid, { roles: entry.roles });
  }
  return {
    get: (cid: string) => map.get(cid),
    manifestCids: () => [...map.keys()],
    set: (cid, entry) => { map.set(cid, entry); },
  };
}

/**
 * Mutable `JoinedSolverNetsView` for the running daemon. The applier
 * (`daemon/join-applier.ts`, #1037) calls `set()` when a join is hot-applied.
 */
export function createMutableJoinedSolverNetsView(
  initial: Record<string, { manifestCid: string; roles: Array<'solver' | 'evaluator'> }> | undefined,
): JoinedSolverNetsView {
  const map = new Map<string, { roles: Array<'solver' | 'evaluator'> }>();
  for (const [key, entry] of Object.entries(initial ?? {})) {
    map.set(entry.manifestCid ?? key, { roles: entry.roles });
  }
  return {
    get: (cid: string) => map.get(cid),
    manifestCids: () => [...map.keys()],
    set: (cid, entry) => { map.set(cid, entry); },
  };
}
