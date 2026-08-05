// SPDX-License-Identifier: Apache-2.0

/**
 * Record-kind URIs follow the platform grammar `https://spec.jinn.network/records/<segment>/<major>.<minor>`.
 * Media types follow `application/vnd.jinn.<segment>.v<major>+json`.
 */
export const TRACE_PROTOCOL =
  "https://spec.jinn.network/protocols/trace/v1" as const;

export const TRACE_RECORD_KIND =
  "https://spec.jinn.network/records/trace/v1" as const;

export const TRACE_MEDIA_TYPE =
  "application/vnd.jinn.trace.v1+json" as const;

/**
 * The vocabulary profile is Jinn-owned and versioned here. Upstream GenAI semantic
 * conventions publish no release, tag, or schema URL, so there is no upstream version to
 * pin; `VOCABULARY_UPSTREAM` records the snapshot this profile was derived from.
 */
export const TRACE_VOCABULARY_PROFILE =
  "https://spec.jinn.network/profiles/trace-vocabulary/v1" as const;

export const TRACE_DERIVATION_PREDICATE_TYPE =
  "https://spec.jinn.network/attestations/trace-derivation/v1" as const;

export const TRACE_DERIVATION_STATEMENT_KIND =
  "https://spec.jinn.network/records/trace-derivation-statement/v1" as const;

/**
 * Published JSON Schema document identifiers. Re-homed out of the `records/` prefix: a
 * record-kind URI (above) must never double as a directory prefix of a served document
 * (audit `docs/superpowers/specs/2026-08-04-protocol-vocabulary-audit.md` §4.4).
 */
export const TRACE_RECORD_SCHEMA =
  "https://spec.jinn.network/schemas/trace/v1" as const;

export const TRACE_DERIVATION_STATEMENT_SCHEMA =
  "https://spec.jinn.network/schemas/trace-derivation-statement/v1" as const;

export const TRACE_SUBJECT_NAME = "trace.json" as const;

/** C1 owns this IRI. Forward-link PropertyValue.value MUST be a repository digest. */
export const TRACE_RECORD_IDENTIFIER_PROPERTY =
  "https://spec.jinn.network/schemes/trace-record-sha256" as const;

/** Closed linkage modes attested in derivation predicates. C2 uses sealed-parent; C4 uses forward-linked. */
export const LINKAGE_MODES = ["forward-linked", "sealed-parent"] as const;

export type LinkageMode = (typeof LINKAGE_MODES)[number];
