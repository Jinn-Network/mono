// Pinned identifiers (design defers exact strings to "implementation";
// pinned here per docs/superpowers/plans/2026-07-28-record-discovery.md
// "Pinned identifiers" section, flagged for the program gate). Every one of
// these is a naming decision the design left open (§7, §12, §15); nothing
// downstream may hardcode a copy -- import from here.

// Protocol version URI, unversioned family root (§15)
export const RECORD_DISCOVERY_FAMILY = "https://spec.jinn.network/record-discovery" as const;
export const RECORD_DISCOVERY_VERSION = "https://spec.jinn.network/record-discovery/v1" as const;

// Record-kind URIs (§12). Grammar: `<records-root>/<segment>/<version>`, segment matches
// SOURCE_NAME_GRAMMAR (below), version per `./origins.ts`.
//
// DR-2026-08-04 re-seal: the values below are canonical --
// `https://spec.jinn.network/records/<segment>/v<major>`. The grammar in `./grammar.ts` still
// recognizes the pre-migration `https://jinn.network/records/<segment>/<major>.<minor>`
// spelling too, but only to keep parsing documents sealed before the migration during the
// transition window; component C2 narrows the grammar to the canonical root alone once the
// re-seal has landed. `RECORDS_SEGMENT` is the origin-independent container name the
// dual-accept roots in `./grammar.ts` are built from.
export const RECORDS_SEGMENT = "records" as const;
export const RECORDS_ROOT = "https://spec.jinn.network/records" as const;
export const RECORD_KINDS = {
  task: "https://spec.jinn.network/records/task/v1",
  submission: "https://spec.jinn.network/records/submission/v1",
  delivery: "https://spec.jinn.network/records/delivery/v1",
  executionEvidence: "https://spec.jinn.network/records/execution-evidence/v1",
  resultEvaluation: "https://spec.jinn.network/records/result-evaluation/v1",
  executionVerification: "https://spec.jinn.network/records/execution-verification/v1",
  keyBinding: "https://spec.jinn.network/records/key-binding/v1",
  authorization: "https://spec.jinn.network/records/authorization/v1",
  trustPolicy: "https://spec.jinn.network/records/trust-policy/v1",
  profileDocument: "https://spec.jinn.network/records/profile-document/v1",
  evaluationSpec: "https://spec.jinn.network/records/evaluation-spec/v1",
  plugin: "https://spec.jinn.network/records/plugin/v1",
  checkpoint: "https://spec.jinn.network/records/checkpoint/v1",
} as const;

// Trust-layer signing scope (§5.5, program §7.11). Conformant with trust-core's
// namespaced-scope grammar (`namespace:custom`); both trees cite this constant and the
// discovery kit carries a cross-tree assertion that the value parses under trust's
// `ScopeVocabulary` (see equivalence.test.ts).
export const DISCOVERY_SIGNING_SCOPE = "jinn:discovery-announcements" as const;

// Location profiles (§7).
export const LOCATION_PROFILE_HTTPS = "https://spec.jinn.network/record-discovery/location/https/v1" as const;
export const LOCATION_PROFILE_IPFS = "https://spec.jinn.network/record-discovery/location/ipfs/v1" as const;

// Media types (§15).
export const MEDIA_ENTRY = "application/vnd.jinn.record-discovery.entry.v1+json" as const;
export const MEDIA_HEAD = "application/vnd.jinn.record-discovery.head.v1+json" as const;
export const MEDIA_FACTS_PROFILE = "application/vnd.jinn.record-discovery.facts-profile.v1+json" as const;
export const MEDIA_WELL_KNOWN = "application/vnd.jinn.record-discovery.well-known.v1+json" as const;

// Grammar (§5.1). Source names and record-kind segments share this shape.
export const SOURCE_NAME_GRAMMAR = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

// Sequence discipline (§5.1).
export const SEQUENCE_WIDTH = 16; // fixed-width decimal
export const GENESIS_SEQUENCE = "0000000000000001" as const;

// Serving paths (§7), derivable from identity alone, no query params.
export const WELL_KNOWN_PATH = "/.well-known/jinn-record-discovery" as const;
export const recordPath = (digest: `sha256:${string}`) => `/records/${digest.slice("sha256:".length)}`;
export const headPath = (sourceName: string) => `/sources/${sourceName}/head`;
export const archivePagePath = (sourceName: string, page: string) => `/sources/${sourceName}/entries/${page}`;

// Advisory ceilings (§5.1); HARD under the published-source profile.
export const CEILINGS = {
  entrySealedBytes: 1 << 20, // 1 MiB
  itemsPerEntry: 512,
  factsCardBytes: 4 << 10, // 4 KiB per item
  archivePageBytes: 4 << 20, // 4 MiB
} as const;
