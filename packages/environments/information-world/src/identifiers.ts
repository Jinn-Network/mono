/**
 * Record-kind URI (design §4.1). The grammar
 * `https://spec.jinn.network/records/<segment>/<major>.<minor>` is discovery's; this constant is
 * validated against discovery's own `assertRecordKindUri` in the facts leaf, because this
 * package declares no Jinn dependency and mirrors the grammar in a test instead.
 */
export const INFORMATION_WORLD_KIND =
  "https://spec.jinn.network/records/information-world/v1" as const;

/** Media type (design §4.1), vendor tree, one major per record version. */
export const INFORMATION_WORLD_MEDIA_TYPE =
  "application/vnd.jinn.information-world.v1+json" as const;

/**
 * `$id` of the published JSON Schema shipped at the `./schemas/*` subpath. Re-homed out of the
 * `records/` prefix (DR-2026-08-04): a record-kind URI must never be a directory prefix of a
 * served doc, so this is an independent `schemas/<kind>/v<major>` identifier, not derived from
 * the record-kind constant above.
 */
export const INFORMATION_WORLD_SCHEMA_ID =
  "https://spec.jinn.network/schemas/information-world/v1" as const;
