/**
 * Record-kind URI (§4.1). The grammar
 * `https://jinn.network/records/<segment>/<major>.<minor>` is discovery's, and this
 * constant is validated against discovery's own `assertRecordKindUri` in the facts leaf —
 * this package declares no Jinn dependency, so it mirrors the grammar in a test instead.
 */
export const ENVIRONMENT_RECORD_KIND =
  "https://jinn.network/records/environment/1.0" as const;

/** Media type (§4.1), vendor tree, one major per record version. */
export const ENVIRONMENT_RECORD_MEDIA_TYPE =
  "application/vnd.jinn.environment.v1+json" as const;

/** `$id` of the published JSON Schema shipped at the `./schemas/*` subpath. */
export const ENVIRONMENT_RECORD_SCHEMA_ID =
  `${ENVIRONMENT_RECORD_KIND}/schema` as const;
