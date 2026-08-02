// Document-format ("protocol") URIs — program-gate confirmations (see plan Findings).
export const TASK_PROFILE_FORMAT_URI = "https://jinn.network/profiles/task-profile/1.0" as const;
export const EVALUATION_SPEC_FORMAT_URI = "https://jinn.network/profiles/evaluation-spec/1.0" as const;
// Media types (frozen).
export const TASK_PROFILE_MEDIA_TYPE = "application/vnd.jinn.task-execution.task-profile.v1+json" as const;
export const EVALUATION_SPEC_MEDIA_TYPE = "application/vnd.jinn.task-execution.evaluation-spec.v1+json" as const;
export const VERDICT_DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json" as const;
// Reserved profile-instance URIs (§8/§9).
export const REPOSITORY_WORK_PROFILE_URI = "https://jinn.network/task-profiles/repository-work/1.0" as const;
/** Native deterministic forecast work; legacy prediction is not a repository-work task. */
export const PREDICTION_FORECAST_PROFILE_URI =
  "https://jinn.network/task-profiles/prediction-forecast/1.0" as const;
export const EVALUATION_TASK_PROFILE_URI = "https://jinn.network/task-profiles/evaluation-task/1.0" as const;
// Evidence contract types the verdict output mirrors structurally (byte-compat via fixtures).
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const;
export const RESULT_EVALUATION_PREDICATE_TYPE = "https://jinn.network/attestations/result-evaluation/v1" as const;
// semanticsVersion seed — promoted from EVAL_SEMANTICS_VERSION (§7.1).
export const EVAL_SEMANTICS_VERSION = "4" as const;
// Scheme IRIs for identifier propertyID values — UNREGISTERED; shared follow-up with TEP §28 (§17).
export const PROFILE_URI_SCHEME_IRI = "https://jinn.network/schemes/task-profile-uri" as const;
export const TASK_DIGEST_SCHEME_IRI = "https://jinn.network/schemes/task-digest" as const;
