# Cutover stage 1 — drain and deploy runbook

Contract 10. Run in order. Do not deploy with step 2 unfinished.

> **Gate status (2026-08-01):** E39–E47 landed on `integration/evidence-v1` via #2345 + #2351.
> Anvil gate `JINN_E2E_HARNESS=prediction-v1-baseline yarn e2e:daemon-harness` is green.
> **Step 4 closed-loop green** on Base Sepolia — task **1216**, two operators (op-d solver /
> op-c evaluator), `allowSolverSelfEvaluation: false`. Evidence:
> `.local/stage1-closed-loop/evidence.json`.
>
> **E41 disposition:** `synthesizeLegacyExecutionDocuments` is the sole remaining SignedTaskV1→solve
> bridge — legacy cards only, retires with stage 5.
>
> See `docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md` (leg H).
> Runner: `cd client && yarn stage1:closed-loop` (`scripts/release/stage1-closed-loop.ts`).
> Gold operators: **op-c** (evaluator/producer) + **op-d** (solver, staged from `~/.jinn-client`
> services 72+). Do not use op-a/op-b — their Safes are stOLAS-distributor-owned (GS026).
>
> **Composition signer fix:** `buildOperatorComposition` must receive the **agent** walletClient
> (service Safe owner), not `masterWallet` — master-as-signer caused GS026 on every venue claim.

## Before this deploy PR merges

- [ ] Confirm the fleet's current image / npm pin so rollback names a known value.
      Recorded rollback pin at open time: `@jinn-network/client@0.2.2-canary.sha.9b01706bc82437536b11f33efaeb013fb7fa2a2a`
      (npm `canary` as of 2026-08-01). Re-check before merge if the fleet has moved.
- [ ] Stop posting new tasks against the fleet's manifest digests (pause launched-record
      generators). Record the stop time in the deploy PR thread.
- [ ] Confirm the bridge fixture gate is green:
      `client/test/bridge/converged-delivery-legacy-parse.test.ts`.
- [ ] Confirm the single-broadcaster architecture test reports zero offenders.

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
      is per-daemon state. *(E20: per-daemon broadcaster landed on the cutover train.)*
- [ ] Composition is built only when `config.network === 'testnet'` — `BASE_SEPOLIA_TODAY` is the
      only real `MarketplaceChainConfig` in the repo. Stage 1 is a testnet cutover; mainnet
      operators get `composition: undefined` and the legacy path.

## 4. Gate

- [x] One real task closed-loop on testnet through the new flow, including the verdict leg via the
      still-legacy evaluator on a *second* operator (self-evaluation is prevented on chain).
- [x] Record the task id, the claim tx, the mech `Deliver` tx, the `claimSolutionDelivery` tx,
      and the verdict tx (written to `.local/stage1-closed-loop/evidence.json` by the runner).

| Field | Value |
|-------|-------|
| taskId | `1216` |
| creationTx | `0x6e432cca6a60133ec27a95a76c60e148c4ac7f7b69632430c7076eeadffbdc10` |
| claimTx | `0x624e4a1836f65f965933dda777bbb7ba28b7aed3aaa9d1fbc88369b2e074d1af` |
| deliverTx | `0x6257830d1e4e5e03d7ac31dd29a8347481f93d5a17a9f308ed899c883294adeb` |
| claimSolutionDeliveryTx | `0x38ff8d32c702d688324f7d0543e163fab5a5b2bcb670152c1c4301a16fcca9a6` |
| verdictTx | `0xecca7bb022f6ecd6f4ce095cd6cb6719af818dfdffcde1483fe761b93b8d2b4f` |
| solver Safe | `0xf11edaf5330852bd77c79e3e30af6248c64f963b` (op-d / service 72) |
| evaluator Safe | `0x8683f8e06555f6b30399eac4179654f830c91d12` (op-c / service 65) |
| verdictCode | `2` |
| finishedAt | `2026-08-01T10:08:23.317Z` |

## After deploy

- [ ] Watch the projector's durable cursor advance; the work loop issues no claim until it
      reaches the finalized chain head.
- [ ] Confirm one claim → deliver → settle cycle on the fleet.
- [ ] Confirm the two chain readers running in parallel (the retiring discovery floor until
      stage 4, plus the new projector) are not storming RPC quota — this window is accepted
      explicitly and kept short.

## Rollback

> Rollback is reverting this deploy PR train and pinning the previous canary image
> `@jinn-network/client@0.2.2-canary.sha.9b01706bc82437536b11f33efaeb013fb7fa2a2a`
> (re-confirm the live fleet pin before executing). Chain state stays consistent — claims are
> chain facts and the backend journal persists — but the reverted daemon does **not** resume
> the new flow's in-flight engagements. Those engagements are abandoned and are named by the
> unreleased-attempt state message. The config migration is additive and the legacy
> `joinedSolverNets` keys survive until stage 5, so a rolled-back daemon generation boots from
> the migrated file and claims exactly as it did before.
