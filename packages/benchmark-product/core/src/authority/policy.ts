/**
 * Principals and authority v1 (spec §4.2, assumption A3).
 *
 * **Honest scope: this is LOCAL-PROCESS policy enforcement.** The document this
 * module reads and writes constrains operations executed *through this library*
 * — every operations-boundary check runs in-process before a mutation happens.
 * It is not a cryptographic access-control system: anyone with filesystem access
 * to the workspace can open `authority.json` and edit it directly, bypassing
 * every check here. What this module provides is supervisability and
 * attribution (paired with the audit journal, §4.4) — a record of who was
 * authorized to do what, and a gate that a well-behaved caller cannot route
 * around. It does not, and cannot, stop a caller with raw filesystem or process
 * access from acting outside it.
 */

import { z } from "zod";
import { refuse, refuseWithIssues, type ProductIssue } from "../errors.js";
import { atomicWriteFileSync, readTextIfExistsSync } from "../fs/atomic.js";
import { authorityPath } from "../workspace/layout.js";

/**
 * The approval-gated operations (spec §4.1's lifecycle table). A3 names
 * `lock`, `launch`, `cancel`, and `publish` and leaves further refinement to
 * BP-10; `report` is also gated by the §4.1 table (`closed --report--> reported`
 * is listed "approval-gated"). Publication intent and registration are irreversible public
 * disclosure boundaries, so they receive their own granular grants rather than inheriting a
 * broader lifecycle permission.
 */
export const GATED_OPERATIONS = [
  "lock",
  "launch",
  "cancel",
  "report",
  "publish",
  "publication.configure",
  "publication.register",
  "publication.accounting",
  "publication.report",
] as const;

export type GatedOperation = (typeof GATED_OPERATIONS)[number];

function isGatedOperation(operation: string): operation is GatedOperation {
  return (GATED_OPERATIONS as readonly string[]).includes(operation);
}

export const PrincipalSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["sponsor", "delegated-agent"]),
  grants: z.array(z.enum(GATED_OPERATIONS)),
});

export type Principal = z.infer<typeof PrincipalSchema>;

export const AuthorityPolicySchema = z
  .object({
    policyVersion: z.literal(1),
    principals: z.array(PrincipalSchema).min(1),
  })
  .superRefine((policy, ctx) => {
    const seenAt = new Map<string, number>();
    policy.principals.forEach((principal, index) => {
      const firstIndex = seenAt.get(principal.id);
      if (firstIndex !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate principal id: ${principal.id} (first seen at index ${firstIndex})`,
          path: ["principals", index],
        });
        return;
      }
      seenAt.set(principal.id, index);
    });
  });

export type AuthorityPolicy = z.infer<typeof AuthorityPolicySchema>;

function issuesFromZodError(error: z.ZodError): ProductIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
}

/** The workspace-initialization default: the initializing sponsor holding every gated grant. */
export function foundingAuthorityPolicy(sponsorId: string): AuthorityPolicy {
  return {
    policyVersion: 1,
    principals: [
      {
        id: sponsorId,
        role: "sponsor",
        grants: [...GATED_OPERATIONS],
      },
    ],
  };
}

/** Atomic write to `authorityPath(workspaceDir)`; validates first (refuse "validation"). */
export function writeAuthorityPolicy(workspaceDir: string, policy: AuthorityPolicy): void {
  const result = AuthorityPolicySchema.safeParse(policy);
  if (!result.success) {
    refuseWithIssues("validation", issuesFromZodError(result.error));
  }
  atomicWriteFileSync(authorityPath(workspaceDir), JSON.stringify(result.data, null, 2));
}

/** Refuses "not-found" when absent, "validation" when malformed. */
export function readAuthorityPolicy(workspaceDir: string): AuthorityPolicy {
  const text = readTextIfExistsSync(authorityPath(workspaceDir));
  if (text === "") {
    refuse("not-found", "authority", "no authority policy found for this workspace");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    refuse("validation", "authority", "authority.json is not valid JSON");
  }

  const result = AuthorityPolicySchema.safeParse(parsed);
  if (!result.success) {
    refuseWithIssues("validation", issuesFromZodError(result.error));
  }
  return result.data;
}

/**
 * The operations-boundary check (spec §4.2: approval is a permission policy, not a
 * human-only path):
 * - a `principalId` not in the policy refuses "authority-denied" (workspace membership
 *   is required for every operation, A3);
 * - an operation in `GATED_OPERATIONS` whose grant the principal lacks refuses
 *   "authority-denied";
 * - any other operation (reads, draft mutation) is allowed for any member.
 */
export function checkAuthority(policy: AuthorityPolicy, principalId: string, operation: string): void {
  const principal = policy.principals.find((candidate) => candidate.id === principalId);
  if (principal === undefined) {
    refuse("authority-denied", `principals.${principalId}`, `${principalId} is not a member of this workspace`);
  }

  if (isGatedOperation(operation) && !principal.grants.includes(operation)) {
    refuse("authority-denied", `principals.${principalId}`, `${principalId} lacks the ${operation} grant`);
  }
}
