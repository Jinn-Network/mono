// Document-format ("protocol") URIs — program-gate confirmations (see plan Findings).
export const TASK_PROFILE_FORMAT_URI = "https://spec.jinn.network/profiles/task-profile/v1" as const;
export const EVALUATION_SPEC_FORMAT_URI = "https://spec.jinn.network/profiles/evaluation-spec/v1" as const;
// Media types (frozen).
export const TASK_PROFILE_MEDIA_TYPE = "application/vnd.jinn.task-execution.task-profile.v1+json" as const;
export const EVALUATION_SPEC_MEDIA_TYPE = "application/vnd.jinn.task-execution.evaluation-spec.v1+json" as const;
export const VERDICT_DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json" as const;
// Reserved profile-instance URIs (§8/§9).
export const REPOSITORY_WORK_PROFILE_URI = "https://spec.jinn.network/task-profiles/repository-work/1.0" as const;
/** Native deterministic forecast work; legacy prediction is not a repository-work task. */
export const PREDICTION_FORECAST_PROFILE_URI =
  "https://spec.jinn.network/task-profiles/prediction-forecast/1.0" as const;
export const EVALUATION_TASK_PROFILE_URI = "https://spec.jinn.network/task-profiles/evaluation-task/1.0" as const;
/** Backend-neutral binary judge work over one question/reference/candidate item. */
export const BINARY_JUDGMENT_PROFILE_URI =
  "https://spec.jinn.network/task-profiles/binary-judgment/1.0" as const;

// Binary-judgment v1 document-format URIs. These identify byte schemas, not particular records.
export const BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI =
  "https://spec.jinn.network/binary-judgment/judge-instrument/v1" as const;
export const BINARY_JUDGMENT_OBSERVATION_FORMAT_URI =
  "https://spec.jinn.network/binary-judgment/judge-observation/v1" as const;
export const BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI =
  "https://spec.jinn.network/binary-judgment/analysis-context/v1" as const;
export const BINARY_JUDGMENT_EVALUATION_CONTEXT_FORMAT_URI =
  "https://spec.jinn.network/binary-judgment/evaluation-context/v1" as const;
export const BINARY_JUDGMENT_PARSER_SEMANTICS_FORMAT_URI =
  "https://spec.jinn.network/binary-judgment/parser-semantics/v1" as const;

// Binary-judgment requirement and media vocabulary.
export const BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY =
  "network.jinn.binary-judgment.instrument" as const;
export const BINARY_JUDGMENT_INSTRUMENT_MEDIA_TYPE =
  "application/vnd.jinn.binary-judgment.instrument.v1+json" as const;
export const BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE =
  "application/vnd.jinn.binary-judgment.observation.v1+json" as const;
export const BINARY_JUDGMENT_ANALYSIS_CONTEXT_MEDIA_TYPE =
  "application/vnd.jinn.binary-judgment.analysis-context.v1+json" as const;
export const BINARY_JUDGMENT_EVALUATION_CONTEXT_MEDIA_TYPE =
  "application/vnd.jinn.binary-judgment.evaluation-context.v1+json" as const;
export const BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE = "text/plain; charset=utf-8" as const;
export const BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE =
  "application/vnd.inspect-ai.eval-log+json" as const;
// Evidence contract types the verdict output mirrors structurally (byte-compat via fixtures).
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const;
export const RESULT_EVALUATION_PREDICATE_TYPE = "https://spec.jinn.network/attestations/result-evaluation/v1" as const;
// semanticsVersion seed — promoted from EVAL_SEMANTICS_VERSION (§7.1).
export const EVAL_SEMANTICS_VERSION = "4" as const;
// Scheme IRIs for identifier propertyID values — UNREGISTERED; shared follow-up with TEP §28 (§17).
export const PROFILE_URI_SCHEME_IRI = "https://spec.jinn.network/schemes/task-profile-uri" as const;
export const TASK_DIGEST_SCHEME_IRI = "https://spec.jinn.network/schemes/task-digest" as const;
