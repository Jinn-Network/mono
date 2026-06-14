---
id: DR-2026-06-14
title: Baseline failure-cause distribution for FAILED task_runs — harness-subprocess crashes dominate; the single `failure_reason` field is the classification ceiling
date: 2026-06-14
verb: Steer
status: proposed
authors: opus (spike #577)
relates-to: issue [#577](https://github.com/Jinn-Network/mono/issues/577) (this spike), [#896](https://github.com/Jinn-Network/mono/issues/896) (RACE_LOST transition — the `race_loss_misclassified` data artifact), `client/scripts/classify-failure.ts` (the 21-rule cascade), `client/scripts/audit-task-run-failures.ts` (the read-only audit), `client/src/harnesses/engine/persistence.ts` (`markFailed`, `TASK_RUNS_SCHEMA`)
---

## Context

Issue #577 asked for a baseline: when an operator's `task_runs` row lands in
`state = 'FAILED'`, *why* did it fail, and in what proportions? Until now there was
no classification — just a free-text `failure_reason` string per row. We need a
reproducible cause distribution so future changes (e.g. the #896 RACE_LOST
transition, harness hardening) have something to regress against.

The structural constraint that shapes everything below: **`failure_reason` is the
only error-carrying column in `task_runs`.** `PRAGMA table_info(task_runs)` confirms
there is no `last_error`, `stderr`, `stdout`, `log`, `trace`, `exit_code`, or
`http_status` column. Everything we know about a failure is the single (often
truncated) string the engine wrote via `markFailed()`. So the classifier is, of
necessity, a deterministic string matcher over one field — and its accuracy ceiling
is whatever the engine chose to serialize into that field.

## Method

A pure, priority-ordered **21-rule first-match-wins cascade**
(`client/scripts/classify-failure.ts`) maps each `failure_reason` into exactly one
of the 8 fixed buckets from #577 (`harness_subprocess_crash`, `provider_api_error`,
`rpc_outage`, `daemon_restart_mid_attempt`, `lease_expired_no_delivery`,
`solver_produced_wrong_answer`, `race_loss_misclassified`, `unknown`). Rule r21 is
an explicit always-true `unknown` catch-all so every classification can name the
rule that fired. The cascade is flat and auditable, with four load-bearing ordering
invariants (provider-error before the generic `child exited` crash; claim-expiry
before recovery/Safe-revert; SIGTERM/143 before generic child-exit; `patch_*` split
from `pytest_missing`/`docker_unavailable`/`eval_timeout`) locked by unit tests in
`client/test/scripts/classify-failure.test.ts`.

The read-only audit (`client/scripts/audit-task-run-failures.ts`,
`yarn audit:failures`) opens `~/.jinn-client/jinn.db`
`{ readonly: true, fileMustExist: true }`, windows on `state_updated_at` (unix ms),
classifies each FAILED row, and emits a per-bucket count table, an optional per-row
drilldown, and a `--json` form. It never writes to the DB (verified: file mtime
unchanged across all runs).

**Corpus as of 2026-06-14** (this operator's local DB; the issue was filed at
375/137 on 2026-05-25, the DB has since grown): **410 FAILED rows lifetime**, span
`2026-05-05 .. 2026-06-01`; **325 in the trailing 30 days**. (885 COMPLETE.) Note
the most-recent failure is 2026-06-01, so the "last 30 days" window from 2026-06-14
captures the tail of the active span, not a fresh fortnight.

## Baseline distribution

Buckets ordered by lifetime count. Both windows reported; percentages are of the
window total.

| Bucket | 30-day n | 30-day % | Lifetime n | Lifetime % |
|---|---:|---:|---:|---:|
| `harness_subprocess_crash`     | 213 | 65.5% | 225 | 54.9% |
| `unknown`                      |  57 | 17.5% |  67 | 16.3% |
| `race_loss_misclassified`      |   0 |  0.0% |  33 |  8.0% |
| `solver_produced_wrong_answer` |  13 |  4.0% |  25 |  6.1% |
| `provider_api_error`           |  17 |  5.2% |  23 |  5.6% |
| `rpc_outage`                   |   8 |  2.5% |  14 |  3.4% |
| `lease_expired_no_delivery`    |   8 |  2.5% |  13 |  3.2% |
| `daemon_restart_mid_attempt`   |   9 |  2.8% |  10 |  2.4% |
| **TOTAL**                      | **325** | **100%** | **410** | **100%** |

## Key findings

1. **Harness-subprocess crash dominance.** Over half of all failures (225/410
   lifetime, **65.5% in the trailing 30 days**) are the adapter subprocess dying
   non-zero. Composition: 208 `child exited` rows (overwhelmingly `code=1` from the
   hermes/claude/codex adapters; only 2 are `code=143` = SIGTERM, which the cascade
   correctly diverts to `daemon_restart_mid_attempt`) plus 19 `session-start hook
   failed` rows (the codex-code learner hook resolving a stale absolute path,
   `bash: /…/plugins/learner/hooks/session-start: No such file or directory`). This
   is the single highest-leverage failure class to attack, and the 19 session-hook
   rows in particular look like a concrete, fixable config defect, not a model
   capability gap.

2. **`race_loss_misclassified` is a #896 data artifact, not a steady-state failure
   mode.** 33 lifetime rows (8.0%), **all of them outside the trailing-30-day window
   (0 in 30d)** — they are the older `operator cleanup after swe generator burst;
   superseded by single-flight retry` rows. These were benign supersedes that
   *should* have transitioned to RACE_LOST but were written `FAILED`. With the #896
   RACE_LOST transition live, future DBs should carry **zero** such rows; this
   bucket's count is therefore a regression signal for #896, not a real failure to
   reduce. The 30-day zero is consistent with the burst being a one-time historical
   event.

3. **`unknown` (16.3% lifetime) is dominated by one un-ruled signal.** Of the 67
   `unknown` rows, **52 are bare `Required artifact missing: …/<reqid>/.orient/
   summary.json`** with **no `recovery:` prefix**. The cascade's r07 deliberately
   scopes the artifact-missing rule to the `recovery:`-wrapped variant (which is
   provably restart-attributable); the 52 bare rows are genuinely ambiguous from the
   single field — they could be a mid-attempt interruption that never routed through
   the recovery path, or an engine work-dir bug. The remaining `unknown` rows are
   10 `admission_missing_or_unscorable`, 4 `eval_not_gradeable:{pytest_missing,
   docker_unavailable,eval_timeout}` (deliberately left `unknown` — task/eval-infra
   faults, not cleanly the solver's or a provider's fault), and 1 generic eval-runner
   stderr. **This bare `Required artifact missing` family is the strongest candidate
   for a new rule** (or a structured category) in the next iteration — but adding it
   is out of scope for this fixed-8-bucket spike.

4. **The "tail" buckets are small but real.** `provider_api_error` (23 lifetime) =
   9× OpenRouter/hermes 403 budget-limit (correctly skimmed out of the child-exit
   crash bucket by r01), 10× IPFS-registry 413, 13× HF/substrate-pool fetch.
   `lease_expired_no_delivery` (13) = on-chain `TCAttemptClaimExpired`, including the
   recovery-/Safe-revert-wrapped variants r06 correctly reclaims from restart/rpc.
   `solver_produced_wrong_answer` (25) = `eval_not_gradeable:patch_*` (the solver's
   patch itself failed to apply/was corrupt/conflicted) plus evaluator
   `did not produce verdictPayload` packaging failures.

## Confidence / caveats

- **Single-field ceiling (structural, not classifier-fixable).** `failure_reason`
  is the only error column, and rows are frequently **truncated** — hermes rows
  often end at a `session_id:` with the real error scrolled off. A
  provider/RPC/SIGTERM signature present in the live process can be **absent from
  the stored string**, in which case the row falls through to
  `harness_subprocess_crash` or `unknown`. This is the dominant misclassification
  risk and it cannot be fixed in the classifier — it has to be fixed at write-time.

- **Lowest-confidence buckets:** `rpc_outage` (rules r12 `fetch failed` /
  ECONN* / r13 nonce-desync / r18 `GS0xx` Safe revert) and the `aborted`→
  `daemon_restart_mid_attempt` heuristic (r11). `fetch failed` is a bare Node error
  that could be *any* HTTP host (IPFS, HF, OpenRouter), assigned to RPC on a
  chain-RPC-heavy-daemon prior. `GS0xx` Safe reverts are mapped to `rpc_outage` as
  the least-wrong of the 8 fixed buckets, not because they are literally RPC
  outages. Treat these counts as upper-bounds with meaningful slack.

- **`unknown` is load-bearing by design, not a defect.** The
  `pytest_missing`/`docker_unavailable`/`eval_timeout`/`admission_missing_or_unscorable`
  rows are deliberately left `unknown` rather than force-fit into a fixed bucket
  whose meaning they would pollute. The 52 bare `Required artifact missing` rows are
  honest ambiguity from the truncated field.

- **Ordering note surfaced during validation:** the real
  `recovery: HF datasets-server returned 502 …` rows land in `provider_api_error`
  (r04 `datasets-server` precedes the recovery catch r08 in the verbatim cascade),
  not `daemon_restart_mid_attempt`. This is a deliberate consequence of the
  most-specific-first ordering and is locked by a test; it shifts at most a handful
  of rows and does not change the headline picture.

## Highest-leverage follow-up

**Persist a structured `failure_category` enum at `markFailed()`-time.** The engine
*knows* the cause at the moment it fails the row (it has the exit code, the HTTP
status, whether it is in the recovery path, whether a supersede triggered it) — it
just throws that knowledge away and serializes a lossy string. Writing a small
enum column (plus, ideally, an un-truncated stderr tail, separate integer
`exit_code`/`signal` columns, and an `http_status` column) would convert several of
this spike's heuristic rules into exact ones and collapse most of the `unknown`
bucket. **This single change is worth more than any number of additional string
rules** and should be filed as a `feat`/`refactor` issue against
`client/src/harnesses/engine/persistence.ts`. The string cascade in this spike is
the right stopgap for reading the *existing* corpus, but it should not be the
long-term mechanism.

Secondary, concrete, already-actionable from this baseline:
- Fix the 19 `session-start hook failed` rows (stale absolute hook path in the
  codex-code learner plugin) — a config defect, not a capability gap.
- Investigate the 52 bare `Required artifact missing` rows (the top `unknown`
  contributor): are they restart-interruptions that bypassed recovery, or an engine
  work-dir reaper/race bug?

## Status

`proposed` — spike output; ratification is a separate human step. Per the handbook's
spike rules the audit script + unit test are spike artifacts that do not themselves
merge to `next`; this DR is the durable finding.
