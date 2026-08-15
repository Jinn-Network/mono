# Autopilot V2 marketplace canary

This is a deliberately narrow canary for the marketplace session backend. It
does not authorize unrestricted issue routing.

## Eligibility

Choose exactly one disposable issue for the first run. Before starting, verify
all of the following:

- the issue is open, on the engineering Project, and has **Effort = Low**;
- the issue and its likely patch do not touch a path matched by
  `.github/CODEOWNERS`;
- the likely patch does not add or change tests, package manifests, lockfiles,
  build configuration, or other package-control surfaces excluded by the V1
  patch policy;
- the issue does not require Human judgment, secrets, production operations,
  or an external side effect;
- the issue number is the sole **initial** value in
  `JINN_AUTOPILOT_ONLY_ISSUES`;
- the creator Safe/keystore is already bootstrapped and has enough escrow
  funds to post a Task;
- the Autopilot GitHub credentials are the intended adoption-receipt authors.

Do not use an existing reviewable PR as the first canary. Marketplace V1 needs
an originating marketplace mutation Task to anchor the evaluator leg.

## Configuration

Keep the official testnet network defaults unless the canary is explicitly
testing a network override. In particular, there is no launcher URL, launcher
token, or local daemon to configure.

```sh
export JINN_AUTOPILOT_EXECUTION_BACKEND=marketplace
export JINN_AUTOPILOT_ONLY_ISSUES=<one-low-effort-issue-number>
```

Leave `JINN_AUTOPILOT_MARKETPLACE_SOLVERNET_MANIFEST_CID` unset when exactly
one live SolverNet advertises `jinn-repo.v1`. Set it to the reviewed manifest
CID only if automatic selection reports zero or multiple matches.

The normal active-mode requirements still apply: a fresh
`JINN_AUTOPILOT_CAPABILITY_ATTESTATION`, the dedicated canonical HTTPS Git
remote, and the implementation/review GitHub credential pool. Marketplace
mode replaces agent-session execution only; Autopilot still owns deterministic
GitHub and Git lifecycle work.

## Run

From `packages/autopilot`, first run one active cycle:

```sh
yarn autopilot --mode active --once --json status
```

Startup preflight uses the one-shot `jinn tasks submit --dry-run` path. Stop if
preflight reports missing creator identity, funds, contracts, SolverNet,
indexer, gateway, RPC connectivity, or immutable Docker verifier readiness. Do
not work around a failed preflight by enabling the local backend.

After the first cycle posts the Task, keep the same environment and run active
mode normally. Do not remove the parent issue or add unrelated issues to
`JINN_AUTOPILOT_ONLY_ISSUES`.

If the evaluator requests changes, Autopilot files one review-finding child.
The scheduler identifies that continuation by the **child issue number**, not
the parent number, so the parent-only allowlist intentionally leaves it
unclaimed. Before resuming:

1. stop active cycles;
2. inspect the exact generated child and verify its marker names the canary PR,
   it is the single open review-finding child, its requested patch is still
   canary-sized, and neither the child nor likely patch is a Human/CODEOWNER
   surface;
3. replace the allowlist with exactly
   `<parent-issue-number>,<generated-child-issue-number>`;
4. resume active mode for the child fix Task and its fresh evaluator leg.

Do not add a range, wildcard, second root issue, or an uninspected child. The
generated review-finding child is a controlled continuation of the Low-effort
root canary (the review protocol labels finding children Medium by default),
not permission to route unrelated Medium work. Stop at Human instead if the
finding is no longer canary-sized.

The allowlist filters new-work claims only. Deterministic reconciliation of
existing lifecycle items remains active even when their issue numbers are not
listed.

## Evidence and stop conditions

Record, without secrets:

1. the deterministic Task key `autopilot:<v2AttemptId>`, Task ID/CID, creation
   transaction, and selected SolverNet manifest CID;
2. the verified Solution delivery and accepted Solution receipt comment;
3. the resulting exact PR head and its evaluator-leg review claim;
4. either an exact-head approval, or one aggregated review-finding child;
5. for requested changes, the exact allowlist update above, the child fix
   Task, its adopted new head, and a fresh full-head evaluator verdict;
6. restart evidence showing no duplicate Task, patch application, commit,
   GitHub mutation, receipt, Solution claim, or Verdict claim.

Stop the canary and leave the attempt recoverable or Human if any correlation
field disagrees, a CODEOWNER/Human surface appears, receipt authorship is
unexpected, deterministic verification fails, or a local agent process is
spawned. A rejected marketplace result remains unclaimed.

Expand to another independent root issue only after at least five real
marketplace Tasks have passed correctness, restart recovery, and review-quality
checks. Keep every independent root expansion Low effort and non-CODEOWNER
until a separate rollout decision changes that policy.

## Current automated-proof boundary

The repository has local Anvil coverage for Router Task/Solution/Verdict
claims and separate production-boundary coverage for Autopilot delivery
verification, adoption receipts, mutation recovery, and evaluator adoption.
The closed-loop Autopilot test composes the production session backend and
adoption state machines with deterministic delivery fixtures; it does not yet
run GitHub receipt comments and the Router contracts together in one Anvil
process. The live canary above is therefore still required before broadening
routing.
