// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod/v3';
import {
  InputRightsRefV1Schema,
  type InputRightsRefV1,
} from './contracts.js';

export const DEFAULT_PUBLICATION_RIGHTS_POLICY_VERSION = 'jinn.publication-rights.v1' as const;
const DEFAULT_ALLOWED_SOURCE_LICENSES = new Set(['Apache-2.0', 'MIT']);

export type RepositoryPublicationMetadata = {
  visibility: 'public' | 'private' | 'unknown';
  licenseSpdxId: string | null;
};

/** Facts are keyed by their exact disclosed input reference, never globally. */
export type VerifiedInputPublicationFacts = {
  inputRef: string;
  locator: string;
  visibility: 'public' | 'private' | 'unknown';
  licenseSpdxId: string | null;
  evidenceRef: string;
  authorizationRef?: string;
};

const VerifiedInputPublicationFactsSchema = z.object({
  inputRef: z.string().min(1),
  locator: z.string().min(1),
  visibility: z.enum(['public', 'private', 'unknown']),
  licenseSpdxId: z.string().min(1).nullable(),
  evidenceRef: z.string().min(1),
  authorizationRef: z.string().min(1).optional(),
}).strict();

export type RightsPolicyDecision =
  | { allowed: true }
  | { allowed: false; code: 'repository-not-public' | 'input-not-public' | 'missing-or-unapproved-rights' };

/**
 * Default disclosure policy. A public source repository needs matching MIT or
 * Apache-2.0 evidence for every ordinary source input; an explicit recorded
 * authorization is sufficient even when GitHub cannot report a license.
 */
export function evaluateDefaultRightsPolicy(input: {
  /** Legacy caller context; it is never used as rights evidence. */
  repository?: RepositoryPublicationMetadata;
  inputRights: readonly InputRightsRefV1[];
  verifiedInputs: Readonly<Record<string, VerifiedInputPublicationFacts>>;
}): RightsPolicyDecision {
  if (input.inputRights.length === 0) {
    return { allowed: false, code: 'missing-or-unapproved-rights' };
  }

  const rights = input.inputRights.map((entry) => InputRightsRefV1Schema.parse(entry));
  for (const entry of rights) {
    const parsedFacts = VerifiedInputPublicationFactsSchema.safeParse(input.verifiedInputs[entry.inputRef]);
    if (!parsedFacts.success || parsedFacts.data.inputRef !== entry.inputRef) {
      return { allowed: false, code: 'missing-or-unapproved-rights' };
    }
    const facts = parsedFacts.data;
    if (facts.visibility !== 'public') return { allowed: false, code: 'input-not-public' };
    if (entry.basis === 'authorization') {
      if (
        facts.evidenceRef !== entry.rightsRef ||
        facts.authorizationRef !== entry.authorizationRef
      ) {
        return { allowed: false, code: 'missing-or-unapproved-rights' };
      }
      continue;
    }
    if (
      facts.evidenceRef !== entry.rightsRef ||
      facts.licenseSpdxId !== entry.spdxId ||
      !DEFAULT_ALLOWED_SOURCE_LICENSES.has(entry.spdxId)
    ) {
      return { allowed: false, code: 'missing-or-unapproved-rights' };
    }
  }
  return { allowed: true };
}

// Zod regex schemas validate the digest at the artifact boundary but infer a
// plain string in TypeScript, so this policy seam intentionally accepts the
// parsed structural type and compares both values exactly.
export type ApprovedImage = { reference: string; digest: string };

/** Pure allowlist check; image acquisition and scanning belong to Task 3. */
export function isApprovedImage(
  image: ApprovedImage,
  approvedImages: readonly ApprovedImage[],
): boolean {
  return approvedImages.some((approved) =>
    approved.reference === image.reference && approved.digest === image.digest,
  );
}
