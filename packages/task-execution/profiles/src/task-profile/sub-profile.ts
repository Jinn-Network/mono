import { bytesEqual, canonicalJsonBytes } from "../bytes.js";
import { ProfilesError } from "../errors.js";
import type { TaskProfileDocument } from "./schema.js";

/** Sub-profile chain depth bound (frozen, design §6.3). */
export const SUB_PROFILE_MAX_DEPTH = 8;

/** One step of an already-resolved `extends` chain (leaf to root). */
export type ExtendsChainStep = { uri: string; digest: `sha256:${string}` };

/**
 * One resolved chain entry: its own `{uri, digest}` plus, unless it is the root, the parent
 * `{uri, digest}` it declares via `extends`. `resolveFamilyUri` walks a pre-resolved chain
 * (leaf-to-root order) rather than performing I/O itself — this package is pure and I/O-free;
 * resolving each digest from a store is the caller's job (Task 9's `resolveProfile`).
 */
export type SubProfileChainEntry = ExtendsChainStep & {
  extends?: ExtendsChainStep;
};

export type CheckAllOfConstructionResult =
  | { ok: true }
  | { ok: false; code: "invalid-document"; reason: string };

/**
 * Structural substitutability (design §6.3): a sub-profile's `payloadSchema` MUST be
 * `allOf: [<parent payloadSchema, byte-equal copy>, <refinement>]`, and the parent's
 * `payloadSchema` MUST be extension-tolerant (`additionalProperties` not `false`) — which is what
 * makes "a sub-profile may add required inputs/outputs/keys" well-formed in the first place. Every
 * conforming sub-profile Task is a conforming parent-profile Task *by construction*, not by
 * spot-check.
 */
export function checkAllOfConstruction(
  sub: TaskProfileDocument,
  parentDoc: TaskProfileDocument,
): CheckAllOfConstructionResult {
  const parentSchema = parentDoc.payloadSchema as Record<string, unknown>;
  if (parentSchema.additionalProperties === false) {
    return {
      ok: false,
      code: "invalid-document",
      reason: "parent payloadSchema is not extension-tolerant (additionalProperties: false); "
        + "a closed parent cannot be safely widened by a sub-profile refinement (§6.3).",
    };
  }

  const subSchema = sub.payloadSchema as Record<string, unknown>;
  const allOf = subSchema.allOf;
  if (!Array.isArray(allOf) || allOf.length < 1) {
    return {
      ok: false,
      code: "invalid-document",
      reason: "sub-profile payloadSchema must be allOf: [<parent payloadSchema copy>, <refinement>].",
    };
  }

  const embeddedParent = allOf[0];
  if (!bytesEqual(canonicalJsonBytes(embeddedParent), canonicalJsonBytes(parentSchema))) {
    return {
      ok: false,
      code: "invalid-document",
      reason: "sub-profile payloadSchema allOf[0] is not a byte-equal copy of the parent payloadSchema; "
        + "parent-validity would not hold by construction.",
    };
  }

  return { ok: true };
}

/**
 * Family URI (design §6.3): the unversioned URI of the root ancestor of a profile's `extends`
 * chain. `chain` is ordered leaf-to-root (already resolved by the caller); this function verifies
 * internal linkage — each entry's `extends {uri, digest}` matches the next entry's own
 * `{uri, digest}` — enforces the depth bound, and strips the version segment of the root URI.
 */
export function resolveFamilyUri(chain: SubProfileChainEntry[]): string {
  if (chain.length === 0) {
    throw new ProfilesError("invalid-document", "extends chain must contain at least one profile.");
  }
  if (chain.length > SUB_PROFILE_MAX_DEPTH) {
    throw new ProfilesError(
      "invalid-document",
      `extends chain depth ${chain.length} exceeds the maximum of ${SUB_PROFILE_MAX_DEPTH}.`,
    );
  }

  for (let index = 0; index < chain.length - 1; index += 1) {
    const step = chain[index];
    const next = chain[index + 1];
    if (step.extends === undefined || step.extends.uri !== next.uri || step.extends.digest !== next.digest) {
      throw new ProfilesError(
        "invalid-document",
        `extends chain entry ${index} ("${step.uri}") does not digest-verify against the next `
          + "chain entry.",
      );
    }
  }

  const root = chain[chain.length - 1];
  if (root.extends !== undefined) {
    throw new ProfilesError(
      "invalid-document",
      `extends chain is incomplete: the last entry ("${root.uri}") still declares a parent.`,
    );
  }

  return stripVersionSegment(root.uri);
}

function stripVersionSegment(uri: string): string {
  return uri.replace(/\/[^/]+$/, "");
}
