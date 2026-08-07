// SPDX-License-Identifier: Apache-2.0

/**
 * The native role vocabulary. It lives here rather than in the daemon because both sides of the
 * artifact now need it: the daemon verifies role bindings against it at boot, and this package
 * AUTHORS those bindings (spec/2026-08-07-native-identity-ceremony.md §3.1). `role-identities.ts`
 * re-exports these names, so every existing daemon importer is unaffected.
 */

export const NATIVE_ROLE_IDENTITY_ROLES = [
  "requester-submission",
  "admission",
  "requester-discovery",
  "solver-delivery",
  "solver-settlement",
  "solver-discovery",
  "evaluator-verdict",
  "evaluator-settlement",
  "evaluator-discovery",
] as const;

export type NativeRoleIdentityRole = (typeof NATIVE_ROLE_IDENTITY_ROLES)[number];

/** Trust-core record families each native key is permitted to sign. */
export const NATIVE_ROLE_IDENTITY_REQUIREMENTS: Readonly<Record<NativeRoleIdentityRole, readonly string[]>> = {
  "requester-submission": ["authorizations"],
  admission: ["authorizations"],
  "requester-discovery": ["observations"],
  "solver-delivery": ["deliveries"],
  "solver-settlement": ["settlements"],
  "solver-discovery": ["observations"],
  "evaluator-verdict": ["verdicts", "deliveries"],
  "evaluator-settlement": ["settlements"],
  "evaluator-discovery": ["observations"],
};

/**
 * The canonical owned-role order a store's `metadata.ownedRoles` must carry. `RoleIdentitySet.open`
 * derives its expected set exactly this way and then byte-compares, so an authoring call that
 * supplied roles in any other order would mint a store the daemon refuses to load.
 */
export function orderedNativeRoles(
  roles: readonly NativeRoleIdentityRole[],
): readonly NativeRoleIdentityRole[] {
  const requested = new Set(roles);
  return NATIVE_ROLE_IDENTITY_ROLES.filter((role) => requested.has(role));
}

/** Roles whose scope includes `settlements` — the §2.3b three-resource ceremony family. */
export function isSettlementRole(role: NativeRoleIdentityRole): boolean {
  return NATIVE_ROLE_IDENTITY_REQUIREMENTS[role].includes("settlements");
}
