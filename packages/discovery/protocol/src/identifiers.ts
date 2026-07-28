// Pinned identifiers (design defers exact strings to "implementation";
// pinned here per docs/superpowers/plans/2026-07-28-record-discovery.md
// "Pinned identifiers" section, flagged for the program gate). Every one of
// these is a naming decision the design left open (§7, §12, §15); nothing
// downstream may hardcode a copy -- import from here.

// Protocol version URI, unversioned family root (§15)
export const RECORD_DISCOVERY_FAMILY = "https://jinn.network/record-discovery" as const;
export const RECORD_DISCOVERY_VERSION = "https://jinn.network/record-discovery/1.0" as const;

// Record-kind URIs (§12). Grammar: `${RECORDS_ROOT}/<segment>/<major>.<minor>`,
// segment matches SOURCE_NAME_GRAMMAR (below).
export const RECORDS_ROOT = "https://jinn.network/records" as const;
export const RECORD_KINDS = {
  task: "https://jinn.network/records/task/1.0",
  submission: "https://jinn.network/records/submission/1.0",
  delivery: "https://jinn.network/records/delivery/1.0",
  executionEvidence: "https://jinn.network/records/execution-evidence/1.0",
  resultEvaluation: "https://jinn.network/records/result-evaluation/1.0",
  executionVerification: "https://jinn.network/records/execution-verification/1.0",
  keyBinding: "https://jinn.network/records/key-binding/1.0",
  authorization: "https://jinn.network/records/authorization/1.0",
  trustPolicy: "https://jinn.network/records/trust-policy/1.0",
  profileDocument: "https://jinn.network/records/profile-document/1.0",
  evaluationSpec: "https://jinn.network/records/evaluation-spec/1.0",
  plugin: "https://jinn.network/records/plugin/1.0",
  checkpoint: "https://jinn.network/records/checkpoint/1.0",
} as const;

// Trust-layer signing scope (§5.5, program §7.11). Conformant with trust-core's
// namespaced-scope grammar (`namespace:custom`); both trees cite this constant and the
// discovery kit carries a cross-tree assertion that the value parses under trust's
// `ScopeVocabulary` (see equivalence.test.ts).
export const DISCOVERY_SIGNING_SCOPE = "jinn:discovery-announcements" as const;

// Location profiles (§7).
export const LOCATION_PROFILE_HTTPS = "https://jinn.network/record-discovery/location/https/1.0" as const;
export const LOCATION_PROFILE_IPFS = "https://jinn.network/record-discovery/location/ipfs/1.0" as const;

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
