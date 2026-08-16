# Cutover one-swap — drain and deploy runbook

Contract 10 as amended by [DR-2026-08-05](../../log/decisions/2026-08-05-cutover-one-swap-collapse.md)
(one combined drain for the collapsed stages 2–4). Run in order. Do not deploy with
step 7 unfinished.

> **Status:** template — the deploy PR fills the status block, the straggler table, and
> the evidence tables at open time. Supersedes the per-stage drains for the collapsed
> flows: [`cutover-stage-2-drain.md`](cutover-stage-2-drain.md) (stage-2 sections are
> historical), the never-written stage-3/stage-4 runbooks.
> **Rollback pin (record at PR open, re-check before merge):** `@jinn-network/client@<version>-canary.sha.<sha40>`

## Before this deploy PR merges

- [ ] Rollback pin recorded above, verified installable (`npm view` the exact specifier)
- [ ] Full client suite + `e2e:daemon-harness` green on the train head, **both** mode
      variants (legacy + native)
- [ ] Config auto-migration round-trip verified on a copy of a real fleet
      `config.json` (additive, atomic, idempotent; pinned generation still boots from
      the migrated file — contract 4)
- [ ] Read-plane dual-read comparison green (legacy `task_runs` story vs native tables
      story, all five status builders)
- [ ] The e2e re-scope PR (DR-2026-08-05 decision 5) is merged — `e2e:app-flow` points
      at the replacement specs and is green
- [ ] Grader-container execution proven (DR decision 3a as decoupled 2026-08-07): the
      container-grade proof (gate artifact ii below) is recorded — a real container-graded
      evaluation, not only a green unit suite

## 1. Freeze evaluator intake (previous canary, no new build)

- [ ] Remove `evaluator` from every `joinedSolverNets[<manifestCid>].roles` (or stop the
      daemon) on every fleet operator; restart
- [ ] Confirm no new `evaluation_submitted` events after the freeze timestamp
- [ ] `sqlite3 ~/.jinn-client/jinn.db "SELECT count(*) FROM task_runs WHERE task_role='evaluation' AND state NOT IN ('COMPLETE','FAILED','RACE_LOST')"` — record the in-flight count

## 2. Freeze posting

- [ ] Set every `posting[].enabled: false`; pause launched-record generators; restart
- [ ] Record the freeze timestamp; confirm no new task-creation transactions from fleet
      Safes after it
- [ ] Leave the creator loop running until its in-flight posts reach terminal states

## 3. Freeze solver claims (deploy window)

> Operator call per DR-2026-08-05: required unless explicitly waived at PR open. The
> work-loop machinery itself is being swapped; a claim taken mid-window straddles the
> swap.

- [ ] Make `claimPolicy` unreachable (or stop the daemon) for the deploy window
- [ ] Record whether this step was run or waived, and by whom

## 4. Quiesce the read/publish side

- [ ] Peer-sync: `peers: []`, restart; confirm no peer heartbeat for one full 60 s
      interval
- [ ] Registry lifecycle: `GET /v1/solvernets/launched` (operator-token-gated) shows
      every owned record in a terminal state (no in-flight ERC-8004 lifecycle transition)
- [ ] Evidence driver: `evidenceIndexing.pending === 0` and
      `evidenceIndexing.failures.length === 0` on `/v1/status`
      (`operator/src/api/contract/status.ts` shape; announce-after-indexed, contract 6)

## 5. Wait for terminal states

- [ ] Poll every 5 minutes:
      `sqlite3 ~/.jinn-client/jinn.db "SELECT count(*) FROM task_runs WHERE task_role IN ('evaluation','restoration') AND state NOT IN ('COMPLETE','FAILED','RACE_LOST')"`
- [ ] Patience bound: 2 hours from the last freeze step
- [ ] Cross-check the chain signal per flow (router `claimed(requestId)` for
      evaluations; delivery events for solves)

## 6. Record stragglers

One table, all flows. This table plus the per-flow chain probe (`cast call
claimed(requestId)`) IS the loud-stranding record (contract 10 / design §4) — the
`unreleased_attempt` notification kind is not wired on this branch
(`operator/src/api/notifications-build.ts`) and nothing here depends on it.

| taskId | attemptIndex | requestId | flow (evaluation \| solve \| post) |
| --- | --- | --- | --- |
| _(deploy PR fills; empty table = decision 7's `legacy-task-submission-synthesis` flip may proceed)_ | | | |

## 7. Deploy

- [ ] One operator first. Boot assertions, all four before fleet rollout:
  - [ ] projector catch-up before any claim (contract 3): `[work] claim gate open`
        within 10 minutes of boot
  - [ ] exactly one broadcaster (single-broadcaster architecture test green on the
        deployed sha; no legacy tx leg in the boot log)
  - [ ] loop registry: `evaluator` and `posting` present; `delivery-watcher`,
        `engine-tick`, `engine-watcher`, `creator`, `peer-sync` absent
  - [ ] archive listener answering on loopback (`curl` the head route); operator API
        still token-gated
- [ ] Dashboard is not dark: event stream renders under the preserved `emitEvent` kinds
- [ ] Then the fleet, one operator at a time

## 8. Gate (DR-2026-08-05 decision 3, decision 3a decoupled 2026-08-07)

> Decision 3a's container-graded requirement is satisfied by **two artifacts**, not one:
> a container-graded evaluation cannot occur inside the native G-loop as built (posted
> task pinned to one fixture, prediction-only claim allowlist, single-registration
> evaluator deployments — see the DR's 2026-08-07 addendum for the file:line record).
> **The bar is unchanged: both artifacts must be green before deploy and before any
> retirement-wave flip.**

### Gate artifact (i) — G-loop, natively-posted own task, end-to-end (prediction profile)

Two real Base Sepolia operators, honestly distinct: A = service 72, B = service 75.

| Field | Value |
| --- | --- |
| taskId | |
| profile | `prediction-forecast` (the only profile the claim allowlist admits) |
| creationTx | |
| claimTx (solver, 2nd operator) | |
| deliverTx | |
| claimSolutionDeliveryTx | |
| openVerdictAttemptTx | |
| claimVerdictDeliveryTx | |
| verdict announcement id | |
| decisionGrade | must be `true` |
| adoption receipt | |
| solver Safe / evaluator Safe | distinct operators (services 72 / 75) |

### Gate artifact (ii) — container-grade proof, separately run

A **real** container-graded evaluation through the M4c Docker path
(`operator/src/daemon/native-evaluator-container-runtime.ts` with
`operator/deployments/evaluator/swe-rebench-v2-deployment.mjs`). Run outside the G-loop;
a green unit suite does not satisfy this.

> **Correction (DR-2026-08-05 addendum, 2026-08-10 — operator ruling, strict reading):**
> a run against a **minimal** grader image (proving the container-runtime machinery
> only, because no image implementing `jinn.grader-context.v1` exists yet — issue
> [#2543](https://github.com/Jinn-Network/mono/issues/2543)) does **not** satisfy this
> artifact. The grader image digest recorded below must be a **real** swe-rebench
> grader image grading a **real** instance. Wave 4 does not proceed on a minimal-image
> mechanism-proof alone.

| Field | Value |
| --- | --- |
| evaluation subject (instance id) | |
| grader image digest | |
| container exit / grader report digest | |
| resulting verdict `decisionGrade` | |
| run log location | |

### G-archive — second-daemon consumption

- [ ] `e2e:archive-second-daemon` green against the live listener (cold sync → digest
      retrieval → resume → live tail) — *script is train-built (former stage-4 Task 6)*
- [ ] `runServingPlaneConformance` green against the live surface — *live-surface
      extension is train-built (former stage-4 Task 1)*
- [ ] Evidence: consuming daemon's operator id + the archive sequence range consumed

Optional, non-gating: attach the Phase B closure manifest as Class O observational
evidence (never the cited basis for any manifest flip — headless §7).

## After deploy

> **Reframed 2026-08-13 (DR-2026-08-05 addendum, decision 1 — operator ruling).** The
> Railway-hosted operator is retired, so there is no hosted fleet to roll out to and no
> separate deploy event to wait on. Step 7's *"Then the fleet, one operator at a time"* is
> **retired as written**: the swapped daemon runs on the local operator homes A (service 72)
> and B (service 75), and the one-swap deploy milestone is discharged by the two-operator
> gate run itself. Read every item below as **after gate closure** — gate artifact (i)
> closed 2026-08-13 (task 1236, Base Sepolia 84532; the close-out ledger, with transaction
> hashes, is in the DR's 2026-08-13 addendum). Step 7's boot assertions, the drain, and the
> rollback pin are unchanged and still apply to the operators that actually run.

- [ ] Gate evidence tables complete in the PR body
- [ ] Straggler disposition recorded (empty, or the surviving-synthesis note per DR
      decision 4)
- [ ] Retirement wave unlocked (Wave 4); each transition-manifest flip carries
      `evidenceCitation: log/decisions/2026-08-05-cutover-one-swap-collapse.md` (the
      only allowed roots are `log/decisions/` and `docs/superpowers/specs/`); this
      runbook's evidence tables go in the flipping PR's body

## Rollback

> Revert the deploy PR or pin the previous canary (specifier at the top). Rollback is
> **all-or-nothing across the three flows** — reverting abandons the native flows'
> in-flight engagements together. Chain state stays consistent (claims are chain facts;
> the backend journal persists), but the reverted daemon resumes none of them — record
> the abandoned set the same way as step 6 (table + `cast call claimed(requestId)`); the
> `unreleased_attempt` notification kind is not wired and nothing here depends on it.
> The additive config migration keeps the pinned generation bootable from the migrated
> file (contract 4).
