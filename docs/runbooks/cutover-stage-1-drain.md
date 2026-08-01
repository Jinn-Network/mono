# Cutover stage 1 — drain and deploy runbook

Contract 10. Run in order. Do not deploy with step 2 unfinished.

> **Do not run this runbook yet.** Leg H closed E39–E43. Re-run the gate before deploying.
>
> **E41 disposition:** `synthesizeLegacyExecutionDocuments` is the sole remaining SignedTaskV1→solve
> bridge — legacy cards only, retires with stage 5.
>
> See `docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md` (leg H). Step 4's gate
> must pass before deploy.

## 1. Stop claiming (previous canary, no new build)

- [ ] On every fleet operator, make `claimPolicy.mode` unreachable by setting `joinedSolverNets`
      roles to evaluator-only, or stop the daemon outright. Confirm with:

```bash
sqlite3 ~/.jinn-client/jinn.db \
  "SELECT count(*) FROM task_runs WHERE task_role='restoration' AND state NOT IN ('COMPLETE','FAILED','RACE_LOST')"
```

## 2. Wait for terminal states

- [ ] Poll the same query every 5 minutes until it returns 0, or until the operator's patience
      bound (recommended: 2 hours) elapses.
- [ ] Record any remaining rows. Each one is a straggler: its attempt stays claimed on the venue
      and occupies a `maxClaims` slot until the revised generation's deadline reap. They strand
      loudly through the unreleased-attempt state message — they are never silently dropped.

## 3. Deploy

- [ ] Deploy the stage-1 build to one operator first. Confirm on that operator:
  - the `[rpc] L2 transport` line is present, and exactly one broadcaster is installed
    (`grep 'no venue broadcaster installed' logs` returns nothing)
  - `[work] claim gate open` appears within 10 minutes of boot
  - the Claim policy & wiring page shows the one-time migration message
  - `~/.jinn-client/config.json.backup-*` exists with mode 600
- [ ] Deploy to the rest of the fleet.

**Before deploying, confirm these three carried gaps are acceptable or closed** (findings E16, E20,
E22):

- [ ] The standalone CLI verbs `jinn tasks submit` and `jinn solver-plugins publish | revoke |
      block | feedback` install no broadcaster and will fail with `no venue broadcaster installed`.
      Either close them or accept that they are unavailable for the stage.
- [ ] The broadcaster is a process-wide singleton bound to one Safe. Any host running two
      operators in one process (release scenario T2.2, `jinn-repo-loop.ts`) cannot work until it
      is per-daemon state.
- [ ] Composition is built only when `config.network === 'testnet'` — `BASE_SEPOLIA_TODAY` is the
      only real `MarketplaceChainConfig` in the repo. Stage 1 is a testnet cutover; mainnet
      operators get `composition: undefined` and the legacy path.

## 4. Gate

- [ ] One real task closed-loop on testnet through the new flow, including the verdict leg via the
      still-legacy evaluator on a *second* operator (self-evaluation is prevented on chain).
- [ ] Record the task id, the claim tx, the mech `Deliver` tx, the `claimSolutionDelivery` tx, and
      the verdict tx in the deploy PR.

## Rollback

Revert the stage-1 PR train or pin the previous canary image. Rollback is symmetric and honest:
chain state stays consistent (claims are chain facts; the backend journal persists), but the
reverted daemon does not resume the new flow's in-flight engagements. The engagement ledger rows
stay at `claimed`; the same unreleased-attempt state message names them. The migrated config is
forward- and backward-compatible: the pre-cutover daemon boots from it because `joinedSolverNets`
was never removed.
