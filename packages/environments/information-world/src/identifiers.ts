/**
 * Record-kind URI (design §4.1). The grammar
 * `https://jinn.network/records/<segment>/<major>.<minor>` is discovery's; this constant is
 * validated against discovery's own `assertRecordKindUri` in the facts leaf, because this
 * package declares no Jinn dependency and mirrors the grammar in a test instead.
 */
export const INFORMATION_WORLD_KIND =
  "https://jinn.network/records/information-world/1.0" as const;

/** Media type (design §4.1), vendor tree, one major per record version. */
export const INFORMATION_WORLD_MEDIA_TYPE =
  "application/vnd.jinn.information-world.v1+json" as const;

/** `$id` of the published JSON Schema shipped at the `./schemas/*` subpath. */
export const INFORMATION_WORLD_SCHEMA_ID =
  `${INFORMATION_WORLD_KIND}/schema` as const;
