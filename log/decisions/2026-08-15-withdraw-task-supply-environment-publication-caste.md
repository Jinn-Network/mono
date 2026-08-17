---
id: DR-2026-08-15
title: Withdraw the task-supply/environment publication caste; classify by sealed-platform vs implementations
date: 2026-08-15
verb: Decide
status: ratified
authors: Cursor Grok 4.6 (drafted), repository operator (explicit instruction this session)
spec: docs/superpowers/specs/2026-08-03-phase-c-capability-boundaries.md
amends: "DR-2026-08-03 decision 6 (publication-disabled-until-graduation caste withdrawn; curation-into-discovery-facts deferral retained); docs/superpowers/specs/2026-08-03-phase-c-capability-boundaries.md §2.5"
relates-to: DR-2026-07-30; DR-2026-08-03; docs/superpowers/plans/2026-08-15-colophon-release-group-audit-plan.md
---

## Context

DR-2026-08-03 decision 6 held every task-supply and environment package off publication until
per-package graduation gates passed (approved authority, second independent consumer, frozen
conformance, packed external install, load-bearing live use). The hold existed so Phase B
native-vertical use would not be mistaken for ratification — the marketplace-pipeline failure
mode, where a product path became fake platform.

That hold became a second compatibility axis beside catalog grouping. It is not a property of
the packages. The 54 `platform-v1` members are themselves `candidate` / `canary-only`. They
have no external implementer, no npm tarball, and no live-origin schema host. They never passed
those five gates. The gates were applied only to packages that landed in
`experimental-task-supply` and `experimental-environment-supply` because of program lineage
(July stack specs vs August supply/environment work), not because those packages uniquely
needed a harder bar.

An operator audit of release-group membership (2026-08-15) decided the public compatibility
promise is two synchronized groups — sealed platform vs implementations — not one 54-package
kernel and not product closures. Keeping a publication caste on 13 packages makes that
classification unusable: consumers already install `@jinn-network/environment-record` and
`@jinn-network/task-admission`, and those names cannot appear on the same bar as
`trust-core` while remaining `publishPolicy: disabled`.

## Decision

1. **Withdraw the caste.** DR-2026-08-03 decision 6's clause "keep speculative publication
   disabled until each package's recorded graduation gate passes" is withdrawn. Task-supply and
   environment packages are not a special legal class. README banners that recite those five
   gates as a unique burden are stale; they will be rewritten when the catalog PR lands.

2. **Same bar as other platform candidates.** First-party use (native-vertical, Colophon,
   client) still does not *ratify* a package. Ratification remains: membership in a public
   receipt plus `canary-only` until a later stable cut. That is the bar the 54 already use.
   "On npm canary" is not graduation to `stable`, and is not an external independent consumer.

3. **Classify with the two-group promise** (DR-adjacent operator Decision 1 of 2026-08-15).
   Names below are `@jinn-network/<name>`.

   **Sealed platform** (tier-2 record families; produce and verify without running a Jinn
   product):

   - `environment-record`
   - `chain-environment-record`

   **Implementations** (capabilities, projections, facts leaves, mixed packages):

   - `task-admission` — capability; prediction-snapshot types remain in this package until an
     optional later split
   - `task-derivation`
   - `task-posting`
   - `task-curation` — projection, not a record kind
   - `chain-scenarios`
   - `environment-verification`
   - `chain-environment-verification`
   - `chain-state-extraction`
   - `information-world` — sealed record family mixed with loopback replay in one package;
     implementations until a split extracts the record kind
   - `record-discovery-facts-environments`
   - `record-discovery-facts-chain-environments`

4. **Curation extraction remains deferred.** Do not promote `task-curation` into Record
   Discovery facts, and do not treat it as a record family, until two real consumers prove
   that join. That is a seam decision, not a publication caste. The package may still sit in
   the implementations group as a projection.

5. **Catalog and publisher are not changed by this record.** `publishPolicy: disabled` and
   group names in `architecture/platform-packages.v1.json` remain the implemented state until
   a draft release design (remaining operator decisions on trusted-publisher, canary-vs-stable
   for products, scope identity, and demand-gated lanes) is approved and a catalog PR lands.
   This DR authorizes that PR to drop the caste. It does not enable
   `PLATFORM_CANARY_PUBLISH_ENABLED`.

## Consequences

- An outsider pinning the sealed-platform receipt will be allowed to include
  `environment-record` and `chain-environment-record` once the catalog PR lands. That is
  candidate canary, not a claim that independent producers already exist.
- `task-admission` travels with implementations. A verifier that only parses prediction-snapshot
  receipts still installs this package (and today `environment-record`) until a later optional
  package-boundary split.
- Phase C items 1–5 and 7–8 of DR-2026-08-03 are untouched (marketplace-pipeline, preclaim,
  no work-client, discovery plane, source writing, settlement, legacy default).
- `experimental-policy` was never under decision 6. It stays out of this amendment. Its
  `disabled` policy follows the still-draft policy-identity spec, not this caste.

## Alternatives rejected

- **Keep the five gates on these 13 only.** Arbitrary relative to the 54, which share the
  same unmet external-consumer and unpublished-schema facts.
- **Apply the five gates to every platform package before any canary.** That freezes all
  publishing until an external implementer exists. Architecture already names that implementer
  as an outstanding falsifier, not as a canary blocker.
- **Put all 13 in sealed platform.** Most are capabilities or projections. That recreates
  one-kernel lockstep under a new name.
- **Put `environment-record` in implementations because it was experimental.** Decision 1
  groups by concern (sealed records vs run/bind/persist), not by old catalog group.

## Ratification

Ratified on 2026-08-15 by the operator's explicit instruction: remove the caste, classify
with Decision 1, amend DR-2026-08-03.
