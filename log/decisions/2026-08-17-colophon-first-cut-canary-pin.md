---
id: DR-2026-08-17-c
title: Colophon first public npm cut may pin one exact stack-canary receipt
date: 2026-08-17
verb: Decide
status: ratified — operator instruction this session (Ritsu): ship Colophon as
  `npx @colophon-claims/*` now; pin exact `0.1.0-canary.sha.<fullSha>` from one
  stack-canary receipt; disclose that `spec.jinn.network` is not live
authors: Cursor Grok 4.6 (drafted), repository operator (explicit choice)
amends: "2026-08-15 operator Decision 4 (products pin stable only) for one named
  Colophon first cut; spec/2026-08-13-colophon-self-serve.md §1, §3.2, §6.2
  (canary forbidden in the release proof); docs/superpowers/plans/2026-08-15-colophon-release-group-audit-plan.md
  §16 Decision 4 and §17 human gates 4–5"
relates-to: DR-2026-08-04; DR-2026-08-15; spec/2026-08-13-colophon-self-serve.md
---

## Context

Operator Decision 4 (2026-08-15) required a product's public npm release to pin
`@jinn-network/*` from a **stable** platform receipt only. That forces a named
`stack-v*` / `latest` cut. Stable publication is still held on live
`https://spec.jinn.network/` serving the attested profile root
(DR-2026-08-04; `docs/runbooks/jinn-network-profile-hosting.md`). The operator
does not currently have access to that host. Waiting for it would keep Colophon
on the contributor `yarn public-quickstart` path.

The operator chose to ship the accepted `npx` identity now rather than wait, and
rather than a GitHub-only tarball or a policy of products pinning floating
`@canary`.

Trusted-publisher rows for the 73 stack names exist. Stack canary remains
skipped until `PLATFORM_CANARY_PUBLISH_ENABLED` is set. `@colophon-claims`
packages remain `publishPolicy: never`. Those are still gates. This record does
not flip them.

## Decision

1. **Named first-cut exception.** Colophon's first public npm publications of
   `@colophon-claims/verify`, then `@colophon-claims/core` and
   `@colophon-claims/cli`, MAY depend on `@jinn-network/*` at **exact** versions
   `0.1.0-canary.sha.<fullSha>` taken from **one** `stack-canary` publication
   receipt (sealed-platform and implementations, same SHA). The visitor still
   installs from the public registry. The visitor still never clones this
   repository.

2. **Exact versions only.** Floating dist-tag `@canary`, mixed SHAs, workspace
   protocols, Yarn portals, local tarballs, and `resolutions` that hide a
   workspace remain forbidden in the Colophon release proof. Pinning a canary
   *version string* is not the same as depending on the `canary` tag.

3. **Decision 4 stands after the first cut.** Living on canary forever remains
   forbidden. The next Colophon public release that changes the Jinn pin must
   move that pin to the first stable stack receipt once
   `stable-live-host-verification` has been observed green against
   `https://spec.jinn.network/`. Product-only Colophon releases that do not
   change the Jinn pin remain allowed (Decision 6).

4. **This does not lift the Jinn stable hold.** No `stack-v*` tag, no stack
   `latest`, no stable publisher job, no claim that `$id` / `profile` URLs
   currently dereference at `spec.jinn.network`. Catalog `canary-and-stable` is
   still policy permission, not an operating stable publisher.

5. **Disclose the host gap.** Every first-cut public surface (npm `README`,
   `npx` help, product site if it cites the command, and a "What this does not
   yet prove" section) must state that protocol identifiers name
   `https://spec.jinn.network/…` and that origin is not hosted yet. Verification
   uses the exact platform bytes installed from npm. A third party who fetches
   those identifiers from the live origin will not retrieve them. That is the
   named gap, not a defect to paper over.

6. **Do not vendor the platform.** Colophon still imports `@jinn-network/*`. It
   does not copy, fork, or relabel tier-1–3 schemas, fixtures, or source as
   Colophon-owned. The reader may keep those installed bytes for offline use
   with their independent identity preserved (already in the self-serve spec).

7. **Human gates this record does not discharge.** Reserve `@colophon-claims`.
   Complete the stack-npm-publishing canary checklist and set
   `PLATFORM_CANARY_PUBLISH_ENABLED` only then. Publish stack canary from
   `stack-npm-publish.yml`, not a laptop. Add a demand-gated Colophon publish
   workflow. Change Colophon catalog `publishPolicy` from `never` only in that
   same product-workflow PR. Do not add `NODE_AUTH_TOKEN`. Protecting
   `npm-publish` remains optional and still gates operator/client canary.

## What this does not yet prove

- That `https://spec.jinn.network/` serves the attested profile root.
- That a third party can implement the record procedures by fetching `$id`
  URLs without npm or this repository.
- That Colophon is pinning the platform's public stable promise.
- That `@colophon-claims` is reserved or that any Colophon package is on npm.

## Rejected

- Waiting for host access before any Colophon npm publication (operator:
  ship now).
- Floating `@canary` or following every `next` stack canary.
- Treating bootstrap `0.0.0` as the pin.
- GitHub Pages or a preview URL as `spec.jinn.network`.
- Bundling Jinn source into Colophon to avoid publishing stack canary.
- Quietly ignoring Decision 4 without a named exception.

## Consequences

- Enable stack canary when the runbook checklist is recorded, then pin
  Colophon to that receipt, then publish Increment 1 (`verify`) first.
- Amend the self-serve spec so the first-cut release proof may name exact
  canary version strings, and so Increment 1 no longer waits on the live
  spec origin.
- The 2026-08-15 plan's "Colophon waits on the first stable cut" line is
  superseded for this first cut only.

## Observed first-cut pin (2026-08-18)

Stack npm Publish run 32128150291 (merge of PR #2788) published both
stack-published groups at SHA `05ab5a98a8b30392ca448de12748b19b0c947684`.
Colophon Increment 1 pins:

`0.1.0-canary.sha.05ab5a98a8b30392ca448de12748b19b0c947684`

`latest` on those `@jinn-network/*` packages remains bootstrap `0.0.0`.
`PLATFORM_CANARY_PUBLISH_ENABLED` is already true. Increment 1 moves only
`@colophon-claims/verify` to release group `colophon-claims-v1` with
`publishPolicy: independent` in the same product-workflow change. core, cli,
and web stay `never`.
