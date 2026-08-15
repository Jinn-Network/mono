// packages/marketplace/pipeline/src/facts-mapper-kinds.ts
// SPDX-License-Identifier: MIT

/**
 * Duplicated by value, not imported: the pipeline declares no record-discovery dependency
 * (source-boundary guard). It must equal `RECORD_KINDS.submission` in
 * `@jinn-network/record-discovery-protocol`; that equality is enforced by
 * `.github/scripts/marketplace-source-boundaries.test.mjs`'s "drift: pipeline's duplicated
 * RECORD_KINDS_SUBMISSION still equals record-discovery-protocol's RECORD_KINDS.submission" test.
 */
export const RECORD_KINDS_SUBMISSION =
  "https://spec.jinn.network/records/submission/v1";
