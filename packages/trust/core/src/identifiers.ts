// SPDX-License-Identifier: Apache-2.0

export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json" as const;
/** Media type of the DSSE envelope bytes, distinct from the envelope's payloadType. */
export const DSSE_ENVELOPE_MEDIA_TYPE = "application/vnd.dsse.envelope.v1+json" as const;
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const;
export const TRUST_KEY_BINDING_MEDIA_TYPE = "application/vnd.jinn.trust.key-binding.v1+json" as const;
export const TRUST_POLICY_MEDIA_TYPE = "application/vnd.jinn.trust.policy.v1+json" as const;
// Working title -- the revocation-companion media type is unspecified in the
// design (docs/superpowers/plans/2026-07-28-trust-layer.md Global
// Constraints; surfaced as a finding).
export const TRUST_REVOCATION_MEDIA_TYPE = "application/vnd.jinn.trust.revocation.v1+json" as const;
export const TRUST_KEY_BINDING_FORMAT = "https://spec.jinn.network/trust/key-binding/v1" as const;
export const TRUST_POLICY_FORMAT = "https://spec.jinn.network/trust/policy/v1" as const;
export const TRUST_REVOCATION_FORMAT = "https://spec.jinn.network/trust/revocation/v1" as const;
export const AUTHORIZATION_PREDICATE_TYPE = "https://spec.jinn.network/trust/authorization/v1" as const;
export const ANCHOR_EVIDENCE_KIND = "https://spec.jinn.network/records/anchor-evidence/v1" as const;
export const ANCHOR_EVIDENCE_MEDIA_TYPE = "application/vnd.jinn.anchor-evidence.v1+json" as const;
