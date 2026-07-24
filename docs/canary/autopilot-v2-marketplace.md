# Autopilot V2 marketplace canary

This is a deliberately narrow canary for the marketplace session backend. It
does not authorize unrestricted issue routing.

## Eligibility

Choose exactly one disposable issue for the first run. Before starting, verify
all of the following:

- the issue is open, on the engineering Project, and has **Effort = Low**;
- the issue and its likely patch do not touch a path matched by
  `.github/CODEOWNERS`;
- the issue does not require Human judgment, secrets, production operations,
  or an external side effect;
- the issue number is the sole value in `JINN_AUTOPILOT_ONLY_ISSUES`;
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
indexer, gateway, or RPC connectivity. Do not work around a failed preflight
by enabling the local backend.

After the first cycle posts the Task, keep the same environment and run active
mode normally. Do not remove or broaden `JINN_AUTOPILOT_ONLY_ISSUES` during the
canary.

## Evidence and stop conditions

Record, without secrets:

1. the deterministic Task key `autopilot:<v2AttemptId>`, Task ID/CID, creation
   transaction, and selected SolverNet manifest CID;
2. the verified Solution delivery and accepted Solution receipt comment;
3. the resulting exact PR head and its evaluator-leg review claim;
4. either an exact-head approval, or one aggregated review-finding child;
5. for requested changes, the child fix Task, its adopted new head, and a
   fresh full-head evaluator verdict;
6. restart evidence showing no duplicate Task, patch application, commit,
   GitHub mutation, receipt, Solution claim, or Verdict claim.

Stop the canary and leave the attempt recoverable or Human if any correlation
field disagrees, a CODEOWNER/Human surface appears, receipt authorship is
unexpected, deterministic verification fails, or a local agent process is
spawned. A rejected marketplace result remains unclaimed.

Expand beyond one allowlisted issue only after at least five real marketplace
Tasks have passed correctness, restart recovery, and review-quality checks.
Keep every expansion Low effort and non-CODEOWNER until a separate rollout
decision changes that policy.

## Current automated-proof boundary

The repository has local Anvil coverage for Router Task/Solution/Verdict
claims and separate production-boundary coverage for Autopilot delivery
verification, adoption receipts, mutation recovery, and evaluator adoption.
The closed-loop Autopilot test composes the production session backend and
adoption state machines with deterministic delivery fixtures; it does not yet
run GitHub receipt comments and the Router contracts together in one Anvil
process. The live canary above is therefore still required before broadening
routing.
