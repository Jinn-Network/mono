# Native evaluator ingestion legs stay deploy-time

| | |
|---|---|
| **Version** | 0.1 |
| **Date** | 2026-09-26 |
| **Author** | Autopilot implementation session for [#4777](https://github.com/Jinn-Network/mono/issues/4777) / [#3346](https://github.com/Jinn-Network/mono/issues/3346) |
| **Shape** | `docs` — written decision allowed by #3346's acceptance criteria |
| **Status** | Adopted for the hermetic native-evaluator activity gate |
| **Answers** | issue [#3346](https://github.com/Jinn-Network/mono/issues/3346) |

## Decision

**LEG 8** (signed `.well-known` public-record-source ingestion) and **LEG 9**
(DSSE subject-authority claim and the decision-grade NAMED verdict gate over a
live trust catalog) remain **deploy-time / seeded** for the hermetic
native-evaluator activity gate in
`operator/test/hermetic/native-evaluator-activity.test.ts`.

They are not promoted into that hermetic proof in this change. The gate's job
is the reward path: real `claimVerdictDelivery` credits
`eligibleActivityWeight`. The ingestion half is the serving plane the fork e2e
(`operator/test/e2e/native-fleet-loop.ts`) already labels the same way.

## Why not a hermetic signed-source rig here

A local signed-source server plus a rig-issued trust catalog is a tractable
shape, and still a separate program: it would prove signature verification on
the opportunity/admission path, not the activity-counter assertion this gate
exists for. Restoring that half belongs with the native G-loop's serving-plane
work, not with shrinking a residual follow-up sweep.

## What the hermetic rig may seed

The rig may stand in for:

- opportunity discovery from signed record sources (LEG 8);
- the subject-authority claim a live catalog would produce (LEG 9);
- `verification.gate`, `solutionDeliveryAuthority`, and
  `evaluationDeliveryAuthority`.

It must not stand in for `verifyExactGraph`, on-chain verdict settlement, or
the activity-counter read.

## Labels

The printed leg table must name this document on LEG 8 and LEG 9 so the
`SEEDED` rows have a citable decision, not an unexplained skip.
