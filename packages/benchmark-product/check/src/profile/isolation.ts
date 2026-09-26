/**
 * Product-local isolation posture shared by venue capability advertisement and Matrix
 * re-derivation. The local venue always retains its unrestricted native launchers; selecting
 * an OCI Inspect runtime adds container execution rather than replacing those launchers.
 */

export const VENUE_ISOLATION_POLICY = "unrestricted" as const;
export const INSPECT_OCI_ISOLATION_POLICY = "oci-container" as const;

type VenueIsolationPolicy =
  | typeof VENUE_ISOLATION_POLICY
  | typeof INSPECT_OCI_ISOLATION_POLICY;

export interface VenueIsolationPosture {
  readonly inventory: readonly VenueIsolationPolicy[];
  readonly provisionerCapabilities: readonly string[];
}

const POLICY_ORDER: readonly VenueIsolationPolicy[] = [
  VENUE_ISOLATION_POLICY,
  INSPECT_OCI_ISOLATION_POLICY,
];

/** Deduplicates into the product's stable policy order rather than caller or locale order. */
export function deriveVenueIsolationPosture(
  policies: readonly VenueIsolationPolicy[],
): VenueIsolationPosture {
  const selected = new Set(policies);
  const inventory = POLICY_ORDER.filter((policy) => selected.has(policy));
  return {
    inventory,
    provisionerCapabilities: inventory.map((policy) =>
      policy === VENUE_ISOLATION_POLICY ? "process" : policy
    ),
  };
}

/**
 * Converts the one policy sealed into a Run's submission baseline into the inventory of the
 * product venue that can execute it. Unknown values gain no capability and therefore fall back
 * to the native venue's conservative singleton inventory.
 */
export function venueIsolationPostureForPolicy(policy: unknown): VenueIsolationPosture {
  return deriveVenueIsolationPosture([
    VENUE_ISOLATION_POLICY,
    ...(policy === INSPECT_OCI_ISOLATION_POLICY ? [INSPECT_OCI_ISOLATION_POLICY] : []),
  ]);
}
