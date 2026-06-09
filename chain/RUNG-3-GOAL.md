# Workstream B — rung 3 goal: close the loop on native JINN

Goal-prompt for an autonomous Claude Code session. Read it, plan against the live
environment, execute to a green gate. Implements issue [#1137](https://github.com/Jinn-Network/mono/issues/1137).
Builds on rung 1 (native-JINN devnet, PR #1134) and rung 2 (veJINN lock, PR #1136).

## Mission (definition of done)

Reusing the rung-1/2 devnet, on a clean run:

```
cd chain && ./up.sh && ./rung3.sh
```

`rung3.sh` exits `0` **iff ALL** of the following hold (the protocol loop —
lock → vote → tick — closing end-to-end on native JINN):

1. veJINN deployed and a locker holds a lock (reuse the rung-2 flow — fresh
   ephemeral, dev0-funded locker, so the gate stays idempotent).
2. `VoteWeighting(veJINN)` deployed; `addNomineeEVM(target, chainId)` registers a
   nominee; the locker calls `voteForNomineeWeights(target, chainId, weight)`;
   `getNomineeWeight(target, chainId)` reflects the vote.
3. `JinnRouterV3` and `TaskActivityCheckerV3` deploy **and initialize** on the
   native-JINN chain (both are EIP-1967 proxy + `initialize`).
4. One activity tick is recorded and the checker's read-back
   (`getSolutionEvidenceHashCount(operator)`) increments.
5. The ve-lock and JINN escrow from step 1 remain intact.

Stop when green. This is the last rung on the original ladder.

## Scope — loop closes, NOT a byte-diff

The substrate spike ([`../spec/2026-06-08-substrate-spike-cosmos-evm.md`](../spec/2026-06-08-substrate-spike-cosmos-evm.md))
already proved *EVM-execution* bit-identity (evmd vs an independent EVM) for these
exact contracts. Rung 3's novelty is the **native-JINN substrate underneath**, and
a deployed-JINN baseline has no native precompile to diff against. So the gate is
**self-consistent state on native JINN**, not a byte-for-byte baseline compare.
Re-litigating EVM fidelity is scope the spike closed — do not rebuild a baseline EVM.

## The activity tick — match the spike, not the mech stack

The spike's §5 records this caveat: *"the 'tick' exercised the activity checker
directly (deployer-as-router), not the full createTask → claim → deliver mech+IPFS
loop."* Match that. The minimal proven tick:

- deploy `JinnRouterV3` + `TaskActivityCheckerV3` (proxy + initialize) — this
  proves they stand up on native JINN;
- set `checker.setAuthorizedRouter(<the recording address>)`;
- record one delivery via the checker's authorized-router path (deployer-as-router
  is fine and is what the spike did), e.g. `recordSolutionDelivery(operator, digest)`;
- read `getSolutionEvidenceHashCount(operator)` back — it increments.

The **full mech-marketplace delivery loop (createTask → claim → deliver, IPFS) is
explicitly out of scope** (a later rung). Do not wire a mech marketplace.

## Key facts to build on

- **JINN** is the native `x/erc20` precompile at `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`
  (in [`lib.sh`](lib.sh)); `approve`/`allowance`/`transferFrom`/`balanceOf` all work
  (rung 2). Every contract that needs the token is pointed here — no `JINN.sol`.
- **veJINN** = `veOLAS`, `contracts/src/vendor/governance/veOLAS.sol`,
  `constructor(token, name, symbol)`, `createLock(amount, unlockTimeDURATION)`
  (the arg is a duration, veOLAS:433). The rung-2 script
  `contracts/scripts/deploy-vejinn-native.ts` already does deploy + fund + lock —
  reuse its pattern.
- **VoteWeighting**, `contracts/src/vendor/governance/VoteWeighting.sol`:
  `constructor(address _ve)`; `addNomineeEVM(address account, uint256 chainId)`;
  `voteForNomineeWeights(bytes32 account, uint256 chainId, uint256 weight)` (weight
  in bps, e.g. 10000 = 100%); read `getNomineeWeight(bytes32 account, uint256 chainId)`.
  *Voter must hold ve-weight (the locker).*
- **JinnRouterV3** (`contracts/src/staking/JinnRouterV3.sol`) and
  **TaskActivityCheckerV3** (`contracts/src/staking/TaskActivityCheckerV3.sol`):
  proxy + `initialize`. Checker: `setAuthorizedRouter`, `recordSolutionDelivery`
  / `recordVerdictDelivery` / `recordTaskCreationFinalized`,
  `getSolutionEvidenceHashCount(operator)`. Reuse the proven proxy-init pattern in
  `contracts/scripts/deploy-phase1b-router-checker.ts` /
  `deploy-task-coordinator-router-v3.ts`.
- **Toolchain:** Hardhat 3 at `contracts/`. Deploy via `network.connect()` →
  `conn.ethers`, guard with `isRunEntry(import.meta.url)`, ESM `.js` imports
  (see `deploy-vejinn-native.ts`). Point at the devnet with
  `LOCAL_RPC_URL=http://127.0.0.1:8545 LOCAL_CHAIN_ID=262144 LOCAL_PRIVATE_KEY=<dev0>`
  and `--network localhost` (the `localhost` network now takes `LOCAL_PRIVATE_KEY`).

## Timing caveat (real, will bite)

VoteWeighting applies weights at **week boundaries**; `nomineeRelativeWeight` can
read `0` until a checkpoint / the next week, and evmd has **no Anvil-style
time-travel** (`evm_increaseTime` won't work). So assert on the **immediate
`getNomineeWeight`** (the raw user vote), not the time-decayed relative weight.
`voteForNomineeWeights` also has a per-voter/per-nominee cooldown — fine on a first
vote; a fresh locker each run avoids it.

## Suggested shape (yours to refine)

- `contracts/scripts/deploy-loop-native.ts` — deploy veJINN + VoteWeighting +
  router + checker against the live devnet, run lock → vote → tick, assert (1)–(5).
  Exit non-zero on any failed assertion. Fresh ephemeral locker per run.
- `chain/rung3.sh` — wrapper: `./up.sh` (reuses the running node), then the
  Hardhat script with the env above. This is the acceptance gate.

## Hard fences (do not cross)

- **No full tokenomics stack** — only veJINN + VoteWeighting + JinnRouterV3 +
  TaskActivityCheckerV3. No Treasury / Depository / Dispenser / Tokenomics. If a
  constructor/init *strictly* requires a dependency (e.g. a Dispenser for
  `addNomineeEVM`, or registries for router init), deploy the **minimal repo stub**
  for just that, and document it — do not pull in the stack.
- **No mech marketplace / full delivery loop** (later rung).
- No `JINN.sol`. No genesis / validator / consensus / cold-start params. No
  bake-to-node / custom precompiles.

If you're doing any of these, you've left rung 3 — stop and report.

## Process

`feat` (engineering handbook): write `rung3.sh` / the assertion script as the
failing gate first, then implement to green; run `verification-before-completion`
before claiming done — paste the actual `./up.sh && ./rung3.sh` output and exit code.

**Babysit clause — do not fabricate.** The fragile, novel surface is the proxy
deploy+initialize wiring and any unexpected dependency (`addNomineeEVM` /
router-init demanding a Dispenser or registry). If a deploy reverts, an init
demands something, or a vote/tick reads back wrong, **stop and report the exact
revert/behaviour**. A clear finding (e.g. "addNomineeEVM needs a Dispenser") is a
**valid outcome** — minimal-stub or report, don't hack around it, and never claim a
closed loop that didn't close.

## Stacking / when green

Stacked on rung 2 (`feat/1135-vejinn-native-lock`) for `chain/` + the rung-2 flow.
Rebase down the stack toward `next` as PRs #1134/#1136 merge. Open a PR
(title `feat:`) referencing #1137, base the lowest unmerged ancestor (or `next`
once the stack has merged), and stop.
