// SPDX-License-Identifier: Apache-2.0

/**
 * The native role vocabulary. It lives here rather than in the daemon because both sides of the
 * artifact now need it: the daemon verifies role bindings against it at boot, and this package
 * AUTHORS those bindings (spec/2026-08-07-native-identity-ceremony.md §3.1). `role-identities.ts`
 * re-exports these names, so every existing daemon importer is unaffected.
 */

import { TrustAuthoringError } from "./errors.js";

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

/**
 * The Record Discovery announce-plane scope, duplicated here as a literal rather than imported from
 * `@jinn-network/record-discovery-protocol`.
 *
 * The duplication is deliberate and is the same shape the discovery program §7.11 already chose for
 * this constant elsewhere: a cross-tree parse-assertion fixture rather than a build edge. This
 * package is the trust tree's authoring half and the discovery tree depends on trust, so importing
 * discovery from here would invert that dependency. `roles.test.ts` pins the literal in this tree,
 * and `operator/test/daemon/trust-authoring-round-trip.test.ts` — which imports both constants —
 * compares them, so a drift is a red test rather than a silent divergence.
 */
const DISCOVERY_ANNOUNCEMENT_SCOPE = "jinn:discovery-announcements";

/**
 * The dedicated trust scope an admission agent's key must declare to issue admission receipts,
 * duplicated here as a literal for the same reason as `DISCOVERY_ANNOUNCEMENT_SCOPE` above: this
 * (trust authoring) tree must not take a build edge on `@jinn-network/marketplace-binding` (which
 * depends on the whole task-execution + trust-resolve stack), so the constant is pinned here and
 * `operator/test/daemon/trust-authoring-round-trip.test.ts` imports both and asserts they match — a
 * drift is a red test, not a silent divergence. Canonical definition:
 * `ADMISSION_RECEIPT_TRUST_SCOPE` in `@jinn-network/marketplace-binding`.
 */
const ADMISSION_RECEIPT_TRUST_SCOPE = "https://spec.jinn.network/trust-scopes/admission-receipts/v1";

/**
 * Trust-core record families each native key is permitted to sign.
 *
 * The three `*-discovery` roles carry TWO scopes, and the second one is not a record family at all:
 *
 *  - `observations` is the trust-core family the native stack verifies discovery envelopes under
 *    (`native-discovery-trust.ts` and `native-consumer/driver.ts` both build their resolver with
 *    `family: 'observations'`);
 *  - `jinn:discovery-announcements` is the Record Discovery announce-plane scope. The discovery
 *    client's `KeyResolver` will not treat a key as able to sign announcements unless its BINDING
 *    declares that scope (`packages/discovery/client/src/trust-adapter.ts`), which is the ratified
 *    rule from the discovery program §7.11.
 *
 * Both are required because both are checked, at different layers, over the same key. Before issue
 * #2525's investigation the discovery roles carried only `observations`, so every native discovery
 * key failed the announce-plane filter and every head resolved to zero authorized signers — the
 * live DR-2026-08-05 gate's leg 3 could not have worked at any catalog. This is additive: nothing
 * that was checked before is checked less, the keys simply now DECLARE the announcement authority
 * they were already being used to exercise.
 *
 * This resolves a genuine conflict between two ratified documents — the native identity ceremony
 * spec (2026-08-07 §3.2, which mapped roles to trust-core families only) and the discovery program
 * (§7.11, which fixed the announce-plane scope) — in favour of §7.11, on the coordinator's ruling.
 * Widening a role's scope invalidates already-authored bindings: an existing catalog's discovery
 * bindings lack this scope, so `RoleIdentitySet.open` refuses them until the bindings are
 * re-authored. See `docs/runbooks/native-trust-reauthor.md`.
 *
 * `admission` carries `ADMISSION_RECEIPT_TRUST_SCOPE`, NOT `authorizations`. Every admission-receipt
 * verifier — the fleet evaluator (`native-subject-authority.ts`), the canonical marketplace-binding
 * consumer (`named-checks.ts`), and the native consumer (`native-consumer/verification.ts`) — checks
 * the admission-agent key's binding under `family: ADMISSION_RECEIPT_TRUST_SCOPE`. The map originally
 * mapped admission to `["authorizations"]`, so an authored admission binding could NEVER satisfy any
 * of them: the first eval ever to reach CP6 (the live two-operator gate, round 19, task 1227) threw
 * `admission-binding-failed: scope-violation` deterministically and retried to the 4h SLA with no
 * verdict (#33). This mirrors the #2525 discovery-scope fix exactly and is likewise additive —
 * nothing checked before is checked less; the key now DECLARES the receipt-issuing authority it was
 * already being used to exercise. An existing catalog's admission binding lacks this scope and must
 * be re-authored before its receipts admit (see `docs/runbooks/native-trust-reauthor.md`).
 * `requester-submission` stays `["authorizations"]` — that is the family `authenticateRequester`
 * verifies submissions under, and is correct.
 */
export const NATIVE_ROLE_IDENTITY_REQUIREMENTS: Readonly<Record<NativeRoleIdentityRole, readonly string[]>> = {
  "requester-submission": ["authorizations"],
  admission: [ADMISSION_RECEIPT_TRUST_SCOPE],
  "requester-discovery": ["observations", DISCOVERY_ANNOUNCEMENT_SCOPE],
  "solver-delivery": ["deliveries"],
  "solver-settlement": ["settlements"],
  "solver-discovery": ["observations", DISCOVERY_ANNOUNCEMENT_SCOPE],
  "evaluator-verdict": ["verdicts", "deliveries"],
  "evaluator-settlement": ["settlements"],
  "evaluator-discovery": ["observations", DISCOVERY_ANNOUNCEMENT_SCOPE],
};

/**
 * The canonical owned-role order a store's `metadata.ownedRoles` must carry. `RoleIdentitySet.open`
 * derives its expected set exactly this way and then byte-compares, so an authoring call that
 * supplied roles in any other order would mint a store the daemon refuses to load.
 *
 * A duplicated role is a REFUSAL, not a silent dedupe — symmetric with the verification side, where
 * `RoleIdentitySet.open` rejects a role requested more than once. The two sides seeing the same
 * input differently is the whole hazard: this function is what a `--role-sets requester,requester`
 * invocation lands on, and quietly accepting it would let the CLI report a role set the daemon
 * would then refuse.
 */
export function orderedNativeRoles(
  roles: readonly NativeRoleIdentityRole[],
): readonly NativeRoleIdentityRole[] {
  const requested = new Set<NativeRoleIdentityRole>();
  for (const role of roles) {
    if (requested.has(role)) {
      throw new TrustAuthoringError(`native role "${role}" is requested more than once`);
    }
    requested.add(role);
  }
  return NATIVE_ROLE_IDENTITY_ROLES.filter((role) => requested.has(role));
}

/** Roles whose scope includes `settlements` — the §2.3b three-resource ceremony family. */
export function isSettlementRole(role: NativeRoleIdentityRole): boolean {
  return NATIVE_ROLE_IDENTITY_REQUIREMENTS[role].includes("settlements");
}
