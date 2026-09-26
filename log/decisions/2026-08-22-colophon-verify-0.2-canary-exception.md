---
id: DR-2026-08-22-a
title: One-time verifier 0.2 prompted-screening canary exception
date: 2026-08-22
verb: Decide
status: ratified - operator instruction this session (Ritsu)
amends: DR-2026-08-17-c Decision 3 for one named product release only
relates-to: DR-2026-08-17-c; packages/benchmark-product/product-release-platform-pins.json
---

## Context

@colophon-claims/verify@0.2.0 adds prompted-screening v2 support. The historic
first-cut platform receipt at SHA 1ed36166faf16ea4b96b021ceff0397f83a0a80c
does not contain the matching platform parameter. A publish-shaped 0.2 test run
therefore rejects promptedScreeningProfile.

Stack npm Publish run 32544891098 attempt 2 published and attested the matching,
complete canary receipt at SHA e00b2fc47fc5635b007eb349fb1e41aa81bb3c50. Its
registry tag is canary; latest remains bootstrap 0.0.0. The live
spec.jinn.network host gap remains open.

## Decision

Only @colophon-claims/verify@0.2.0 MAY use the exact platform version
0.1.0-canary.sha.e00b2fc47fc5635b007eb349fb1e41aa81bb3c50, as recorded with
the complete 15-package verifier closure registry integrity and provenance in
packages/benchmark-product/product-release-platform-pins.json.

This is a one-time exception for prompted-screening v2. It does not change or
relabel the historical 0.1 first-cut receipt. It does not permit a floating
@canary, a mixed SHA closure, another product or product version, an implicit
future exception, a stable-stack claim, or a claim that spec.jinn.network is
hosted. The demand-gated trusted-publisher workflow remains the only publisher.

## Consequences

The publish transform selects a receipt by exact product name and version and
rejects any other 0.2 candidate. A later product pin change again requires the
first stable stack receipt after green live-host verification, unless a new
named operator decision explicitly amends that rule.

## Amendment (2026-09-18) — cli and core first-cut receipts

Issue #3989. DR-2026-09-03 has not opened stable publication (#3910, #3911,
and #3912 remain open). `@colophon-claims/cli@0.1.0` and
`@colophon-claims/core@0.1.0` therefore take the same named canary-exception
route as verify 0.2.

Only those two product versions, in addition to the verify 0.2 receipts
already named above and the 0.2.1 operator authorization of 2026-08-26, MAY
pin `@jinn-network/*` to the exact already-attested platform version
`0.1.0-canary.sha.0533a224cf99f06d7facf0c23455f2781a5b9e62` (the verify 0.2.1
stack-canary receipt; run 33517790412 attempt 2). The receipts live in
`packages/benchmark-product/product-release-platform-pins.json` under the
existing verifier 0.2 receipt shape. This does not relabel the historical
first-cut or 0.2.0 receipts. It does not permit a floating `@canary`, a mixed
SHA closure, `@colophon-claims/web`, another product or product version, an
implicit future exception, or a stable-stack claim.

The demand-gated trusted-publisher workflow remains the only publisher.
`npm publish` is a public-surface act and is not dispatched by the change
that records this route.

Checker rename coordination: #3292 and #3315 closed on 2026-09-07 because
PR #3285 never merged; the rename is re-filed as #4188. This amendment does
not introduce `@colophon-claims/check` and does not turn
`@colophon-claims/verify@0.2` into an alias. The published verify 0.2 line
remains the checker itself.

## Amendment (2026-09-24): check 0.2.1 receipt

Issue #4733. `@colophon-claims/check@0.2.1`, the checker under the name
#4188 gave it, is released under the operator's authorization in that issue.
Only that product version, in addition to the receipts already named above,
MAY pin `@jinn-network/*` to the exact already-attested platform version
`0.1.0-canary.sha.0533a224cf99f06d7facf0c23455f2781a5b9e62` (run 33517790412
attempt 2). Its receipt lives in
`packages/benchmark-product/product-release-platform-pins.json` under
decision `operator-authorization-2026-09-23-issue-4733`, with the same
15-package closure as the verify 0.2.1 receipt; that receipt is not
re-keyed. This supersedes the 2026-09-18 statement that this record does not
introduce `@colophon-claims/check`.

The `check` dispatch of the demand-gated workflow also publishes
`@colophon-claims/verify@0.2.2`, a passthrough alias that depends on
`@colophon-claims/check@0.2.1` exactly and declares no `@jinn-network/*`
dependency, so it carries no receipt. From then on
`@colophon-claims/verify@0.2` resolves to that alias. This supersedes the
2026-09-18 statement that the published verify 0.2 line remains the checker
itself; the published verify 0.2.0 and 0.2.1 are unchanged.

This does not permit a floating `@canary`, a mixed SHA closure, another
product or product version, an implicit future exception, or a stable-stack
claim. The pinned closure predates platform changes merged to `next` after
0533a22, including trust-core fixes, and the published checker does not
carry them. `npm publish` remains a human act after the recording change
merges.
