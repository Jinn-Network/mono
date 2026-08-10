/**
 * Grant / revoke / show authority (spec §4.6 "Principals & authority" row):
 * granting and revoking authority is itself a SPONSOR-only action.
 *
 * `operate`'s own boundary check (`checkAuthority`, see operate.ts and
 * authority/policy.ts) only refuses a non-member outright, and only refuses a
 * member on `GATED_OPERATIONS` (lock/launch/cancel/report/publish) they lack
 * the grant for. `"authority.grant"` and `"authority.revoke"` are deliberately
 * NOT in `GATED_OPERATIONS` — they are membership/role concerns, not
 * lifecycle-transition approvals — so the generic boundary check alone would
 * let any member grant or revoke anyone's authority. This module adds its own,
 * narrower rule on top: the ACTING principal must hold role `"sponsor"`, or the
 * operation refuses `"authority-denied"` (a delegated agent may not grant or
 * revoke, including granting itself more).
 *
 * `authorityRevoke` narrows a principal's operation grants; it never removes
 * workspace membership itself — dropping a principal from the roster entirely
 * is not a v1 operation.
 */

import {
  GATED_OPERATIONS,
  readAuthorityPolicy,
  writeAuthorityPolicy,
  type AuthorityPolicy,
  type GatedOperation,
} from "../authority/policy.js";
import { refuse, refuseWithIssues } from "../errors.js";
import type { OperationContext } from "./context.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";

function isGatedOperation(operation: string): operation is GatedOperation {
  return (GATED_OPERATIONS as readonly string[]).includes(operation);
}

/** Refuses "validation" naming every unrecognized operation; returns the validated, typed list. */
function assertGatedOperations(operations: readonly string[]): readonly GatedOperation[] {
  const unknown = operations.filter((operation) => !isGatedOperation(operation));
  if (unknown.length > 0) {
    refuseWithIssues(
      "validation",
      unknown.map((operation) => ({ path: "operations", message: `unknown gated operation: ${operation}` })),
    );
  }
  return operations.filter(isGatedOperation);
}

/** Refuses "authority-denied" unless `principalId` is a member holding role "sponsor". */
function assertSponsor(policy: AuthorityPolicy, principalId: string): void {
  const principal = policy.principals.find((candidate) => candidate.id === principalId);
  if (principal === undefined || principal.role !== "sponsor") {
    refuse(
      "authority-denied",
      `principals.${principalId}`,
      `${principalId} is not a sponsor and may not grant or revoke authority`,
    );
  }
}

export interface AuthorityGrantInput {
  readonly principalId: string;
  /** Only meaningful for a not-yet-a-member principal; see the existing-principal role check below. */
  readonly role?: "sponsor" | "delegated-agent";
  /** Gated operation names to grant. An empty list is legal — it grants workspace membership only. */
  readonly operations: readonly string[];
}

export function authorityGrant(
  context: OperationContext,
  input: AuthorityGrantInput,
): OperationResult<{ policy: AuthorityPolicy }> {
  return operate({
    context,
    action: "authority.grant",
    subject: input.principalId,
    inputs: input,
    run: () => {
      const policy = readAuthorityPolicy(context.workspaceDir);
      assertSponsor(policy, context.principal);
      const validatedOperations = assertGatedOperations(input.operations);

      const existingIndex = policy.principals.findIndex((candidate) => candidate.id === input.principalId);

      let principals: AuthorityPolicy["principals"];
      if (existingIndex === -1) {
        principals = [
          ...policy.principals,
          {
            id: input.principalId,
            role: input.role ?? "delegated-agent",
            grants: [...new Set(validatedOperations)].sort(),
          },
        ];
      } else {
        const existing = policy.principals[existingIndex]!;
        if (input.role !== undefined && input.role !== existing.role) {
          refuse(
            "validation",
            `principals.${input.principalId}.role`,
            `principal ${input.principalId} already holds role "${existing.role}"; cannot re-grant with role "${input.role}"`,
          );
        }
        const grants = [...new Set([...existing.grants, ...validatedOperations])].sort();
        principals = policy.principals.map((candidate, index) =>
          index === existingIndex ? { ...existing, grants } : candidate,
        );
      }

      const nextPolicy: AuthorityPolicy = { ...policy, principals };
      writeAuthorityPolicy(context.workspaceDir, nextPolicy);
      return { policy: nextPolicy };
    },
  });
}

export interface AuthorityRevokeInput {
  readonly principalId: string;
  /** Omitted clears every grant the principal holds; membership itself is untouched. */
  readonly operations?: readonly string[];
}

export function authorityRevoke(
  context: OperationContext,
  input: AuthorityRevokeInput,
): OperationResult<{ policy: AuthorityPolicy }> {
  return operate({
    context,
    action: "authority.revoke",
    subject: input.principalId,
    inputs: input,
    run: () => {
      const policy = readAuthorityPolicy(context.workspaceDir);
      assertSponsor(policy, context.principal);

      const index = policy.principals.findIndex((candidate) => candidate.id === input.principalId);
      if (index === -1) {
        refuse("not-found", `principals.${input.principalId}`, `${input.principalId} is not a member of this workspace`);
      }

      const existing = policy.principals[index]!;
      const toRevoke = input.operations === undefined ? undefined : assertGatedOperations(input.operations);
      const grants = toRevoke === undefined ? [] : existing.grants.filter((grant) => !toRevoke.includes(grant));
      const principals = policy.principals.map((candidate, i) =>
        i === index ? { ...existing, grants } : candidate,
      );

      const nextPolicy: AuthorityPolicy = { ...policy, principals };
      writeAuthorityPolicy(context.workspaceDir, nextPolicy);
      return { policy: nextPolicy };
    },
  });
}

export function authorityShow(context: OperationContext): OperationResult<{ policy: AuthorityPolicy }> {
  return operate({
    context,
    action: "authority.show",
    subject: "workspace",
    inputs: {},
    run: () => ({ policy: readAuthorityPolicy(context.workspaceDir) }),
  });
}
