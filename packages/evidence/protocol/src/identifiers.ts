export const EXECUTION_EVIDENCE_PROFILE_URI =
  "https://jinn.network/profiles/execution-evidence/1.0" as const;

/** Exact wire media type for an ExecutionEvidenceDocument (the RO-Crate JSON-LD record). */
export const EXECUTION_EVIDENCE_MEDIA_TYPE =
  "application/vnd.jinn.execution-evidence.v1+json" as const;

export const RESULT_EVALUATION_PREDICATE_TYPE =
  "https://jinn.network/attestations/result-evaluation/v1" as const;

export const EXECUTION_VERIFICATION_PREDICATE_TYPE =
  "https://jinn.network/attestations/execution-verification/v1" as const;

export const IN_TOTO_STATEMENT_TYPE =
  "https://in-toto.io/Statement/v1" as const;

export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json" as const;

export const ABANDONED_ACTION_STATUS =
  "https://jinn.network/terms/AbandonedActionStatus" as const;

export const DISPOSITION_COUNT =
  "https://jinn.network/terms/dispositionCount" as const;

// PropertyValue scheme IRIs. These stable spellings are unregistered pending the shared
// Evidence/TEP/profiles/trust scheme-IRI registration follow-up.
export const DID_PKH_IDENTIFIER_SCHEME_IRI =
  "https://jinn.network/schemes/did-pkh" as const;

export const DID_KEY_IDENTIFIER_SCHEME_IRI =
  "https://jinn.network/schemes/did-key" as const;

export const CAIP19_IDENTIFIER_SCHEME_IRI =
  "https://jinn.network/schemes/caip-19" as const;

export const GITHUB_IDENTIFIER_SCHEME_IRI =
  "https://jinn.network/schemes/github" as const;

export const PROFILE_URI_SCHEME_IRI =
  "https://jinn.network/schemes/task-profile-uri" as const;

export const TASK_DIGEST_SCHEME_IRI =
  "https://jinn.network/schemes/task-digest" as const;
