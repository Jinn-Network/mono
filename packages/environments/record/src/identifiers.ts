/**
 * Record-kind URI (§4.1). The grammar
 * `https://spec.jinn.network/records/<segment>/<major>.<minor>` is discovery's, and this
 * constant is validated against discovery's own `assertRecordKindUri` in the facts leaf —
 * this package declares no Jinn dependency, so it mirrors the grammar in a test instead.
 */
export const ENVIRONMENT_RECORD_KIND =
  "https://spec.jinn.network/records/environment/v1" as const;

/** Media type (§4.1), vendor tree, one major per record version. */
export const ENVIRONMENT_RECORD_MEDIA_TYPE =
  "application/vnd.jinn.environment.v1+json" as const;

/**
 * `$id` of the published JSON Schema shipped at the `./schemas/*` subpath. Re-homed out of the
 * `records/` prefix (DR-2026-08-04): a record-kind URI must never be a directory prefix of a
 * served doc, so this is an independent `schemas/<kind>/v<major>` identifier, not derived from
 * the record-kind constant above.
 */
export const ENVIRONMENT_RECORD_SCHEMA_ID =
  "https://spec.jinn.network/schemas/environment/v1" as const;
