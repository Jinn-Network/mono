// SPDX-License-Identifier: Apache-2.0

export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json" as const;
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const;
export const TRUST_KEY_BINDING_MEDIA_TYPE = "application/vnd.jinn.trust.key-binding.v1+json" as const;
export const TRUST_POLICY_MEDIA_TYPE = "application/vnd.jinn.trust.policy.v1+json" as const;
// Working title -- the revocation-companion media type is unspecified in the
// design (docs/superpowers/plans/2026-07-28-trust-layer.md Global
// Constraints; surfaced as a finding).
export const TRUST_REVOCATION_MEDIA_TYPE = "application/vnd.jinn.trust.revocation.v1+json" as const;
export const TRUST_KEY_BINDING_FORMAT = "https://jinn.network/trust/key-binding/v1" as const;
export const TRUST_POLICY_FORMAT = "https://jinn.network/trust/policy/v1" as const;
export const AUTHORIZATION_PREDICATE_TYPE = "https://jinn.network/trust/authorization/v1" as const;
