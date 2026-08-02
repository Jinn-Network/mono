/**
 * Record-kind URIs (§4.1). The grammar
 * `https://jinn.network/records/<segment>/<major>.<minor>` is discovery's; this package
 * declares no Jinn dependency, so the grammar is mirrored in `identifiers.test.ts` and
 * checked for real against discovery's own `assertRecordKindUri` in the facts leaf.
 */
export const CHAIN_ENVIRONMENT_KIND =
  "https://jinn.network/records/chain-environment/1.0" as const;

export const CRYPTO_ENVIRONMENT_KIND =
  "https://jinn.network/records/crypto-environment/1.0" as const;

/** Media types (§4.1, §14): vendor tree, one major per record version. */
export const CHAIN_ENVIRONMENT_MEDIA_TYPE =
  "application/vnd.jinn.chain-environment.v1+json" as const;

export const CRYPTO_ENVIRONMENT_MEDIA_TYPE =
  "application/vnd.jinn.crypto-environment.v1+json" as const;

/** `$id`s of the published JSON Schemas shipped at the `./schemas/*` subpath. */
export const CHAIN_ENVIRONMENT_SCHEMA_ID = `${CHAIN_ENVIRONMENT_KIND}/schema` as const;
export const CRYPTO_ENVIRONMENT_SCHEMA_ID = `${CRYPTO_ENVIRONMENT_KIND}/schema` as const;

/**
 * The egress policy a `closed-state` world declares: every outbound interface is dead at run
 * time (§4.2, §5.1 step 2). It is an identifier the record commits to, not an implementation —
 * enforcing it is the runner's job and probing it is the attestation layer's.
 */
export const BLACKHOLE_EGRESS_POLICY_ID = "jinn.egress.blackhole/1" as const;
