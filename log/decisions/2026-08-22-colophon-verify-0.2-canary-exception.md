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

## Amendment (2026-10-01): check 0.2.1 receipt, and the core and cli re-pin

Issues #4733 and #4886. `@colophon-claims/check@0.2.1`, the checker under the
name #4188 gave it, is released under the operator's authorization in #4733.
Its receipt lives in
`packages/benchmark-product/product-release-platform-pins.json` under
decision `operator-authorization-2026-09-23-issue-4733`, with the same 15
package names as the verify 0.2.1 receipt; that receipt is not re-keyed.
This supersedes the 2026-09-18 statement that this record does not introduce
`@colophon-claims/check`.

Only `@colophon-claims/check@0.2.1`, `@colophon-claims/core@0.1.0` and
`@colophon-claims/cli@0.1.0` MAY pin `@jinn-network/*` to the exact
already-attested platform version
`0.1.0-canary.sha.1c023eb4c24201435e665ddae9d297f286a196bc` (Stack npm
Publish run 36838465494 attempt 1, push to `next`). For core and cli this
supersedes the 0533a22 pin the 2026-09-18 amendment gave them; neither
version has been published. core depends on the checker and shares platform
packages with it, so the three receipts carry one sha. The verify 0.2.0 and
0.2.1 receipts are unchanged.

Why the pin is not 0533a22 (#4886): the checker sets
`extendedKeyUsageCritical`, a field `@jinn-network/trust-core` gained in
436fe2368c, after 0533a22, so it does not compile against that canary. No
sha after 436fe2368c had the checker's closure published until the
`benchmarking-product-v1` release group regained a canary lane (#4909).
1c023eb is on `next` after both.

The `check` dispatch of the demand-gated workflow also publishes
`@colophon-claims/verify@0.2.2`, a passthrough alias that depends on
`@colophon-claims/check@0.2.1` exactly and declares no `@jinn-network/*`
dependency, so it carries no receipt. From then on
`@colophon-claims/verify@0.2` resolves to that alias. This supersedes the
2026-09-18 statement that the published verify 0.2 line remains the checker
itself; the published verify 0.2.0 and 0.2.1 are unchanged.

This does not permit a floating `@canary`, a mixed SHA closure, another
product or product version, an implicit future exception, or a stable-stack
claim. `npm publish` remains a human act after the recording change merges.

## Amendment (2026-10-12): the check, core and cli receipts move to 272455a

Issue #4974. Decision 1 of DR-2026-10-06, the ruling on #4959, gives each
task of the official Terminal-Bench 2.1 slate an EvaluationSpec in a new
grader family, `external-verifier`, and names this step: one canary publish
and re-pinned receipts for check, core and cli. #4979 added the family to
`@jinn-network/task-execution-profiles` and merged to `next` as
272455add1170766f064181c105071519a6baf95.

Only `@colophon-claims/check@0.2.1`, `@colophon-claims/core@0.1.0` and
`@colophon-claims/cli@0.1.0` MAY pin `@jinn-network/*` to the exact
already-attested platform version
`0.1.0-canary.sha.272455add1170766f064181c105071519a6baf95` (Stack npm
Publish run 38246145514 attempt 1, push to `next`). This supersedes the
1c023eb pin the 2026-10-01 amendment gave the three. None of the three
versions has been published, so no package version changes. The three
receipts still carry one sha, the decision each receipt names is unchanged,
and the verify 0.2.0 and 0.2.1 receipts are unchanged.

Why the pin is not 1c023eb: that canary predates #4979. Its
`@jinn-network/task-execution-profiles` knows five grader families and
refuses a spec of any other. core seals the official-slate specs with that
package and the checker parses the spec a bundle carries with it, so a
release against 1c023eb could neither seal nor check an official-slate
bundle. 272455a is the merge of #4979, and its run published every
`@jinn-network/*` package the three releases install: 15 for check, 36 for
core, and cli adds none of its own.

This does not permit a floating `@canary`, a mixed SHA closure, another
product or product version, an implicit future exception, or a stable-stack
claim. `npm publish` remains a human act after the recording change merges.
