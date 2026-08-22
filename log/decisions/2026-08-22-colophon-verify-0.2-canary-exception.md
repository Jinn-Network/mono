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
