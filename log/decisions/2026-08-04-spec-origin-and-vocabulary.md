---
id: DR-2026-08-04
title: Dedicated identifier origin (spec.jinn.network) and the pre-publication vocabulary re-seal
date: 2026-08-04
verb: Steer
status: ratified — every decision below made explicitly by the operator (Ritsu) in the
  2026-08-04 session, question by question
authors: claude (drafted on claude/jinn-docs-sdk-strategy-220e52), Ritsu (rulings)
relates-to: DR-2026-07-30 (amends §8.4 reserved-URI language), DR-2026-06-14 (reaffirmed),
  DR-2026-06-30, docs/superpowers/specs/2026-08-04-protocol-vocabulary-audit.md,
  docs/superpowers/specs/2026-08-03-devx-surface-design.md
---

## Context

The DevX surface program requires hosting the platform's digest-bound document root, which
is the mechanical blocker on stable npm publication. Implementation exposed that the served
namespace was an accretion, not a design: the protocol URIs shared an origin with the
marketing site, five version conventions coexisted, "profile" carried six senses, and the
`/manifest.json` name collided with the browser PWA convention.

The decisive fact: **the identifier-immutability law binds *published* identifiers, and
none of these had ever been published** — by the platform's own definition (retrievable
without cloning the repository), every `https://jinn.network/…` URI was pre-publication.
No URI had ever resolved; no external party had ever fetched one. This was therefore the
last moment at which renaming was lawful and cheap; the first green live-host gate would
have frozen the accreted namespace permanently. An earlier in-session decision to keep the
origin-root shape was reversed on exactly this ground — it was a cost argument wearing a
law costume.

A three-lane standards audit (repository census; provenance/attestation cluster;
work/market + namespace cluster — primary sources throughout) preceded the rulings. Full
findings and per-term reasoning: the
[vocabulary audit](../../docs/superpowers/specs/2026-08-04-protocol-vocabulary-audit.md).

## Decisions

1. **Dedicated identifier origin: `https://spec.jinn.network/`.** The protocol's definition
   surface (schemas, profiles, specifications, conformance fixtures, the signed digest
   manifest) lives on its own origin, governed like an artifact registry — pure static,
   immutable, no framework. The apex `jinn.network` becomes purely product/website. This
   amends DR-2026-07-30 §8.4's "reserved `https://jinn.network/…` URIs" to
   `https://spec.jinn.network/…`.
2. **One origin for everything.** All protocol URIs — resolvable locators and pure
   vocabulary names alike — use the new origin. The locator-only split (a permanent
   two-origin namespace arbitrated by the register) was considered and rejected as a
   cost-shaped compromise. The `resolvableIdentifiers` register continues to say which URIs
   dereference; everything else is a name.
3. **Names are identity; digests are integrity; transport is replaceable.** IPFS mirroring
   of the document root is an anticipated future transport (DNSLink/pinning) — cheap
   because the content is already immutable — but CIDs cannot replace the names: a sealed
   document cannot contain its own hash, so self-claiming documents require name-based
   identity.
4. **Version convention: major-only `/v1` for type and protocol identifiers** (SLSA/in-toto
   TypeURI practice; atproto's breaking-=-new-name). The dominant `/1.0` contradicted the
   identifier law. Exception, named: task-profile *instances* are digest-pinned artifacts
   whose revision is part of the name; their URIs keep full revisions and the manifest +
   digest do the pinning.
5. **Namespace shape:** plural container segments, singular lowercase-kebab type names,
   exactly one version segment, last. The six-sense "profile" pile-up is folded
   (`profiles/<name>/v1` formats; `task-profiles/<name>/<rev>` instances; facts profiles to
   their own namespace); nested versions are eliminated; identifier-hygiene rules (one
   canonical string form, byte-exact comparison, Cool-URIs permanence commitments) are
   written into the namespace's governing spec; the root manifest stays, at
   `spec.jinn.network/manifest.json`.
6. **Vocabulary rulings** (full reasoning in the audit §4):
   - *evidence* stays — RFC 9334 RATS is the citable authority; "attestation" for the raw
     record would be wrong under every surveyed standard.
   - *attested* (tier) stays — the tier is mechanism-neutral by design (`AttestationSchema.
     profile` names the mechanism; TEE quotes are the current profile). The draft
     `tee-attested` rename was rejected by the operator's challenge and the schema evidence.
   - *trajectory → trace, full convergence* — the re-seal mints `records/trace/v1`,
     `jinn.trace.v1`, `profiles/trace-vocabulary/v1`; pre-migration bytes stay recognized as
     legacy input.
   - *envelope* is reserved for DSSE; the legacy SignedEnvelope exits with `packages/core`
     as chartered; `records/delivery-envelope/1.0` is renamed in the migration.
   - *claim/attempt*: DR-2026-06-14 stands (claim = the act, attempt = the record);
     evidence/trust prose says "assertion," never "claim."
   - *execution-evidence* stays; docs gloss the SLSA "provenance" mapping.
   - *requester* is the demand-side role, everywhere; no product-layer role term. The
     glossary's "Curator" entry is stale (defined against dissolved SolverNets) and is
     corrected via the canonical-doc process.
   - *submission* keeps its requester-side meaning with the guardrail: the operator-side
     artifact is always a Delivery. *Lifecycle observation* stays, with its glossary gloss.
7. **Frozen things stay frozen:** `TEP_ATTEMPT_NAMESPACE` (the v5 UUID seeded from
   `"jinn.network/task-execution/attempt"`) is opaque sealed entropy and is not
   regenerated; deployed contract vocabulary (`ClaimRegistry.sol`) and pre-migration
   content-addressed bytes are never retro-edited.

## Consequences

- **One migration** executes the re-seal: new origin + `/v1` convention + vocabulary
  renames + the audit's §4.4 defect list (grammar-violating versions, orphan spellings,
  the false marketplace-pipeline invariant, `agents/`–`agent/` drift, trust-URI variants,
  the `corpus` field collision), with facts-profile regeneration, a DR-sanctioned one-time
  fixture-manifest regeneration, and the GLOSSARY.md pass through Discussion + CODEOWNERS.
  The migration is its own planned program; this DR authorizes it but does not schedule it.
- The DevX program's W4/W5 (deploy bundle, live-host gate) and the operator's key
  provisioning resume against `spec.jinn.network` after the migration lands. The stage-2
  website design simplifies: the apex no longer serves protocol bytes, so the
  Next-vs-static header-override question falls away for the protocol root.
- PR #2382 stands as merged substance: the signing machinery, receipt validation, guards,
  and register are origin-parameterized; its three profile indexes are re-pointed by the
  migration.
- Historical testnet records citing `jinn.network` URIs remain valid history: readers keep
  recognizing legacy names; nothing content-addressed is edited.

## Rejected

- Keeping the accreted origin-root shape (rejected by the operator: "what is right, not
  what is easiest — we are designing a protocol, not an MVP").
- The locator-only migration (permanent two-origin split).
- `records.jinn.network` (suggests record *instances*, which live on IPFS/discovery) and
  `registry.jinn.network` (names the governance posture, collides with npm/OCI registry
  connotations) as origin names.
- Reverse-DNS identifiers; date-based versions; a w3id-style indirection layer.
- CIDs as identifiers (self-hash impossibility, §Decision 3).
