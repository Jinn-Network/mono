// SPDX-License-Identifier: MIT

/**
 * The archive's format tokens and on-disk names (product design §8.3, §9).
 *
 * Product-convention tokens, exactly as `../tokens.ts` explains for the campaign layer: host-local
 * state, never record kinds, never media types, never a tier-2 surface. Both documents below are
 * versioned for the same reason the journal entry is (F-C7a-1) — this package writes them and
 * re-reads them across restarts, and a versionless envelope has no way to refuse a future
 * revision's bytes.
 */

/** The derived projection's `formatToken`. Everything under it is re-derivable and throwaway. */
export const ARCHIVE_PROJECTION_FORMAT_TOKEN =
  "network.jinn.policy-optimization.archive-projection/1.0" as const;

/** The adoption log's `formatToken`. The one archive document that is **not** re-derivable (§8.3). */
export const ADOPTION_RECORD_FORMAT_TOKEN =
  "network.jinn.policy-optimization.adoption/1.0" as const;

/** The archive's directory name inside (or beside) a campaign directory. */
export const ARCHIVE_DIRNAME = "archive" as const;

/**
 * The throwaway half. Deleting this directory loses nothing: `deriveArchive` rebuilds it from the
 * manifests, Reports, and rows it was built from.
 */
export const ARCHIVE_DERIVED_DIRNAME = "derived" as const;

export const ARCHIVE_PROJECTION_FILENAME = "projection.json" as const;

/** The non-derivable half, at the archive root rather than under `derived/` — the layout is the label. */
export const ADOPTION_LOG_FILENAME = "adoption.json" as const;

/** Where `campaign run` writes the sealed records a wave consists of, one directory per wave. */
export const WAVES_DIRNAME = "waves" as const;
