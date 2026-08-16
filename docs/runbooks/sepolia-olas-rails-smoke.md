# Sepolia OLAS-Rails Smoke (Phase 0)

> Status: ready
> Date: 2026-06-29
> Network: Base Sepolia (chainId 84532)
> Token substrate: bridged-JINN standing in for OLAS (see note below)
> Coordinator: human operator runs the reads; no code changes required for Tier A.

This is the **Phase 0** stepping-stone for the tokenless-OLAS pivot. It does two
things on the already-deployed, already-funded Base Sepolia stack:

1. **Validates the funded OLAS economic rails** — the stOLAS distributor, the
   staking proxy, the reward pool, and the curating-agent split are live and
   readable with JINN-as-OLAS.
2. **Empirically confirms (or refutes) the activity-checker disconnect** — the
   pre-flight finding that the staking proxy paying rewards reads a *different*
   activity checker than the one the live V3 loop records into. This is the
   evidence that decides the shape of Phase 1d (clean-break re-wire vs. a cheap
   config re-point).

Run **Tier A** first — it is read-only, costs no gas, takes ~5 minutes, and is
decisive on its own. **Tier B** (a live loop) is the heavier dynamic
confirmation and is optional.

> **JINN-as-OLAS note.** There is no canonical Autonolas OLAS ERC-20 on Base
> Sepolia, so the bridged JINN at `0xAB9a01cd…` is the OLAS stand-in for the
> bond + reward token. The loop machinery (registry, bonding, staking proxy,
> marketplace, stOLAS distributor) is token-agnostic — it just takes an ERC-20.
> The token name is off the critical path; this runbook never depends on it.

---

## The hypothesis under test

```
   live V3 loop                                stOLAS reward path
   ────────────                                ──────────────────
   JinnRouterV3  ──records activity──▶  TaskActivityCheckerV3 (0x0e1B…)
   0xdC9B…                                          ▲
                                                    │  (NOT the same checker)
   stOLAS staking proxy (0xf358…) ──reads liveness──▶  ActivityCheckerV2 (0xF4Ca…)
            │
            └─ pays curating-agent reward via distributor 0x2095…
```

**Claim:** a loop completed through the V3 router increments `0x0e1B…`, but the
staking proxy that pays rewards reads `0xF4Ca…`. So `calculateStakingReward`
on the proxy stays ~0 no matter how many loops complete → **a full loop pays
zero**. If this holds, Phase 1d (fresh checker + fresh staking proxy wired to it
+ stOLAS re-point) is required before any reward can flow.

`0xF4Ca…` is a non-proxy contract and an OLAS staking proxy's `activityChecker`
is immutable (set once at init), so the disconnect cannot be fixed by an
in-place checker upgrade — hence the clean-break re-wire.

---

## Addresses (Base Sepolia)

Sourced from the bundled deploy artifacts in `operator/deployments/`. Treat these
as the starting point; **Tier A re-reads the live wiring rather than trusting the
artifacts** (the stOLAS artifact's reward-split fields are known-stale — see A4).

| Component | Address | Source artifact |
|---|---|---|
| bridged-JINN (OLAS stand-in) | `0xAB9a01cd4A379e36006ec6df2960CF39EF79df63` | `deployment-stolas-l2-baseSepolia-fast.json` `.config.l2Jinn` |
| stOLAS distributor | `0x20951FBDb4F9cB1f051ef416BCB11A9Cfe3CEf81` | `…stolas….json` `.contracts.distributor` |
| stOLAS staking proxy (reward proxy) | `0xf358b5c1ac4ddc4e807b5baf008826bf193eab3b` | `…stolas….json` `.config.stakingContract` |
| stOLAS collector | `0x21c52Be4F656435F97d0335B37e21B417c8b6DFa` | `…stolas….json` `.contracts.collector` |
| stOLAS activity module (curating agent) | `0x73e2713B535540A3378ddA3DC62F1e75b35469c3` | `…stolas….json` `.contracts.activityModule` |
| distributor owner / deployer | `0x15e78734481bD31F6e183dad05225505a45ACd07` | `…stolas….json` `.deployer` |
| **ActivityCheckerV2 (proxy reads this)** | `0xF4Ca4943Eb0b0927d754A6A95206364f017D45f6` | `contracts/scripts/create-staking-proxy.ts` line 13 |
| JinnRouterV3 (live loop) | `0xdC9BCcEB7aca21Ad4Ca2Fc5B4d7aea6b4F6CedD9` | `deployment-task-coordinator-router-v3-baseSepolia-fast.json` |
| TaskCoordinator | `0x9ce736d3CB367cC5Db538B7962bdf416EbD7451B` | same |
| **TaskActivityCheckerV3 (loop records here)** | `0x0e1B5f264F4FAdcFAA950fb00c58d9A39C040f70` | same |
| Mech marketplace (fee 0) | `0xD3233FdAaB51E9775f6bFCE8242B02C181D7c0e7` | `deployment-phase1b-mech-baseSepolia-fast.json` |
| Autonolas service registry | `0x31D3202d8744B16A120117A053459DDFAE93c855` | same |
| L1 distributor proxy (Sepolia) | `0x12F14eF5b4881a932BE3F334599cB9473aBE987A` | `…stolas….json` `.config.l1DistributorProxy` |
| L1 treasury proxy (Sepolia) | `0xa87c117cB54d9C6C8a8e0aA0b336a1125E485Cb7` | `…stolas….json` `.config.l1TreasuryProxy` |

---

## Pre-flight

```bash
# A no-auth public endpoint is fine for read-only Tier A. Swap in your own
# Alchemy/Tenderly key for Tier B's bootstrap if you hit rate limits.
export BASE_SEPOLIA_RPC_URL="https://base-sepolia-rpc.publicnode.com"

# Sanity: foundry's cast must be on PATH (used for all reads).
cast --version
```

Convenience handles for the reads below:

```bash
export STOLAS_PROXY=0xf358b5c1ac4ddc4e807b5baf008826bf193eab3b
export STOLAS_DIST=0x20951FBDb4F9cB1f051ef416BCB11A9Cfe3CEf81
export CHECKER_V2=0xF4Ca4943Eb0b0927d754A6A95206364f017D45f6
export ROUTER_V3=0xdC9BCcEB7aca21Ad4Ca2Fc5B4d7aea6b4F6CedD9
export CHECKER_V3=0x0e1B5f264F4FAdcFAA950fb00c58d9A39C040f70
export JINN_OLAS=0xAB9a01cd4A379e36006ec6df2960CF39EF79df63
```

---

## Tier A — wiring audit (read-only, decisive, ~5 min)

This tier produces the proof. Every step is a `cast call`; nothing is mutated.

### A1 — what checker does the reward proxy read?

```bash
cast call --rpc-url $BASE_SEPOLIA_RPC_URL $STOLAS_PROXY "activityChecker()(address)"
```

**Expect:** `0xF4Ca4943Eb0b0927d754A6A95206364f017D45f6` (the V2 checker the proxy
was created with). Record the actual value.

### A2 — what checker does the live V3 loop record into?

```bash
cast call --rpc-url $BASE_SEPOLIA_RPC_URL $ROUTER_V3 "activityChecker()(address)"
```

**Expect:** `0x0e1B5f264F4FAdcFAA950fb00c58d9A39C040f70` (the V3 checker).

### A3 — the disconnect gate

Compare A1 and A2.

- **A1 ≠ A2 → disconnect confirmed.** The proxy that pays rewards is wired to a
  checker the loop never touches. Phase 1d (clean-break re-wire) is required.
  This is the expected outcome.
- **A1 == A2 → no disconnect.** The pre-flight finding is stale; Phase 1d
  collapses to a cheap re-point (or nothing). Stop and re-scope Phase 1 before
  building anything.

### A4 — decode the reward split (refutes the stale artifact)

The deploy artifact claims `collectorRewardFactor: 10000` (100%-to-collector),
but the pre-flight on-chain read decoded to an 80/20 curating-agent/collector
split. Read the live config word and decode it — do not trust the artifact.

```bash
CFG=$(cast call --rpc-url $BASE_SEPOLIA_RPC_URL \
  $STOLAS_DIST "mapStakingProxyConfigs(address)(uint256)" $STOLAS_PROXY)
echo "raw config word: $CFG"

python3 - "$CFG" <<'PY'
import sys
c = int(sys.argv[1].split()[0])            # cast returns a decimal uint256
print("stakingType              =", c & 0xff)                 # 0 = OLAS_V1, 1 = OLAS_V2
print("curatingAgentRewardBps   =", (c >> 8)  & 0xffff)       # operator side
print("protocolRewardBps        =", (c >> 24) & 0xffff)       # → L1 treasury
print("collectorRewardBps       =", (c >> 40) & 0xffff)       # bond-capital providers
print("stakingGuard             =", hex((c >> 56) & ((1 << 160) - 1)))
PY
```

Bit layout is from `ExternalStakingDistributor.unwrapStakingConfig`
(`stakingGuard 160 | collector 16 | protocol 16 | curatingAgent 16 | stakingType 8`).
Factors are basis points out of 10000.

**Expect (per pre-flight):** `curatingAgentRewardBps ≈ 8000`, `collectorRewardBps
≈ 2000`, `stakingType = 1`. That is the live "operator earns ~80%" economics.
**Record the actual values** — if `curatingAgentRewardBps == 0` then the artifact
was right and the operator earns nothing as curating agent (a different gap).

> `0` for the whole word means the proxy is not stOLAS-configured at all — in
> that case re-run A4 against the daemon's resolved `config.stakingContract`
> (the mech artifact's `stakingToken`) to find the proxy that *is* configured.

### A5 — is the pool funded, and what would a staked service earn today?

```bash
# Reward pool sitting in the staking proxy (JINN-as-OLAS available rewards):
cast call --rpc-url $BASE_SEPOLIA_RPC_URL \
  $JINN_OLAS "balanceOf(address)(uint256)" $STOLAS_PROXY

# Bond-lend headroom held by the distributor:
cast call --rpc-url $BASE_SEPOLIA_RPC_URL \
  $JINN_OLAS "balanceOf(address)(uint256)" $STOLAS_DIST

# Which services are currently staked on the reward proxy:
cast call --rpc-url $BASE_SEPOLIA_RPC_URL $STOLAS_PROXY "getServiceIds()(uint256[])"

# Pending reward for a currently-staked service (pre-flight observed service #61;
# substitute a real id from the line above):
cast call --rpc-url $BASE_SEPOLIA_RPC_URL \
  $STOLAS_PROXY "calculateStakingReward(uint256)(uint256)" 61
```

**Expect:** non-zero pool + lend headroom (the rails are funded), and
`calculateStakingReward` ≈ `0` for the staked service — because the loop that
would earn it records into `0x0e1B…`, not the `0xF4Ca…` checker this proxy reads.
That zero, against a funded pool, **is** the disconnect made concrete.

### Tier A verdict

| Observation | Meaning |
|---|---|
| A1 ≠ A2 | reward proxy and loop are on different checkers → re-wire needed |
| A4 curating ≈ 80% | operator-earns-most economics already live (good) |
| A5 pool funded, reward ≈ 0 | funded rails, but nothing flows through the gap |

If all three hold, the funded rails are real **and** the disconnect is real →
proceed to Phase 1d clean-break re-wire. You can stop here; Tier B only adds a
dynamic, moving-counter demonstration of the same fact.

---

## Tier B — live loop exercise (optional, heavier)

Goal: show the counters move the way the hypothesis predicts — the V3 checker
counter climbs for the operator while the reward proxy's `calculateStakingReward`
stays flat at ~0.

> **Honest caveat — no automated live-Sepolia loop harness exists yet.** Every
> e2e in `operator/test/e2e/` (`_daemon-harness-helpers.ts`, `stolas.ts`) drives
> the loop against an **Anvil fork** with mock mech/marketplace. Driving a real
> loop on live Base Sepolia means running the production daemon (creator +
> solver + evaluator legs) against the real marketplace, real IPFS, and a real
> deployed mech. Building that harness is itself part of the pivot plan
> (smoke-harness follow-up). Until then, Tier B is daemon-driven and manual.

### B0 — scripted smoke harness (2026-06-29)

Gitignored operator-local files under `.local/` drive a **prediction-only**
loop without touching the main `~/.jinn-client` launched generators.

**Gotcha:** if `BASE_SEPOLIA_RPC_URL` is set in your shell (many dev envs
default to `https://base-sepolia.publicnode.com`), it **overrides** the
`rpcUrl` array in the smoke config and archive `getLogs` will fail. Unset it
before starting the daemon:

```bash
unset BASE_SEPOLIA_RPC_URL
```

**Start daemon** (prediction-only; isolated earning dir; no SWE generator):

```bash
cd operator
export JINN_PASSWORD="$(cat ~/.jinn-client/keystore-password)"
export JINN_CLAIM_LOOP_ENABLED=false
export JINN_REWARD_CLAIM_INTERVAL_MS=60000

# Optional smoke-only workaround: if gamma-api.polymarket.com fails from your
# region, point the evaluator at a local Gamma mock that returns the smoke
# conditionId and resolved outcome for /markets/:marketId.
export JINN_POLYMARKET_GAMMA_BASE_URL=http://127.0.0.1:7388

yarn jinn run --config "../.local/smoke-config.json"
```

**Post one task** (regenerate the spec file so `window` is open now):

```bash
node -e "/* see .local/prediction-v1-smoke-task.json — window.startTs = now-60s */"
yarn jinn tasks submit --yes \
  --config "../.local/smoke-config.json" \
  --id "olas-smoke-$(date +%s)" \
  --description "Tokenless OLAS smoke prediction task" \
  --manifest-cid bafkreihifplza3hmixqgp4x7yjrpk2rhwzkm72hk2ampfviuthd7asvi34 \
  --spec-file "../.local/prediction-v1-smoke-task.json"
```

**Repeatable local harness** (dry-run by default, real chain only with
`--execute`):

```bash
cd operator
yarn release:olas-rails-smoke
yarn release:olas-rails-smoke --execute
```

The harness regenerates `.local/prediction-v1-smoke-task.json`, starts the local
Gamma fixture, starts the daemon with `BASE_SEPOLIA_RPC_URL` stripped from the
child environment, submits one `prediction.v1` task, polls `/v1/status`, and
writes evidence under `.local/olas-rails-smoke/`.

**Watch:** `tail -f ../.local/smoke-daemon.log` for
`DISCOVERED → CLAIMED → … → COMPLETE`, or `GET /v1/status` on port 7332.

**2026-06-29 live result:** green on Base Sepolia with Tenderly RPC, isolated
earning dir, Node 22, `JINN_CLAIM_LOOP_ENABLED=false`, and a local Gamma mock for
the prediction evaluator.

Task `9272` (`olas-smoke-1782748546`) completed both legs:

| Leg | requestId | delivery tx | claim tx |
|---|---|---|---|
| Solution/restoration | `0xbc357b25dfb3e546e3f22568f9e3b4c6d00db5e03bb4dab4c8997a6b562745b6` | `0x0d3eb666921504e4247bf9658662ad8db6f3548708f8b5ec5847146c526ff82f` | `0xd3b2401e18e4781288c2b4daf4647e97bf77dc48549e6f95977bfcf5e3fc81cd` |
| Verdict/evaluation | `0x4b3be2fd8a86d2de99d81d7dc485aab80f7d81c198d42791d303ddb52431c322` | `0x6f39fb1f9ad79389dd1377b08689cea07ef6341105764fa03a540722a9084d16` | `0x83114c8e3c0c5c34ebe7720829c92abf791e8b312960164f46068203cbe1cd9d` |

The daemon reached `COMPLETE` for both requests. Router claim receipts emitted
`SolutionDeliveryClaimed` and `VerdictDeliveryClaimed`; the verdict claim also
emitted TaskActivityCheckerV3 logs. `GET /v1/status` reported
`shutdownState: "running"`, no in-flight task runs, and prediction totals of
`solutions: 2`, `verdicts: 2`, `failed: 0`.

The earlier stuck evaluator leg for task `9238` was caused by
`gamma-api.polymarket.com` failing TLS from the operator's region
(`ERR_TLS_CERT_ALTNAME_INVALID`, Belgian Gaming Commission certificate). With
`JINN_POLYMARKET_GAMMA_BASE_URL=http://127.0.0.1:7388`, the same daemon cleared
that stuck verdict before running fresh task `9272`.

Service 46 was restaked on the live fleet proxy
`0x24e34E5037956a5Feca1AAAfaA30297084C228B8` via tx
`0x02a9de283deaeefa65807a44d0ba381eef4ea3e4ef75fd66a5648c2dd1d545ac`.
This proxy is sufficient for the reward smoke because it reads
TaskActivityCheckerV3, is funded, and actually contains service 46
(`getServiceIds() = [46, 50, 63]`, `getStakingState(46) = 1`). The fresh
`0x3A14...` proxy is also V3-wired and funded (`availableRewards = 4e18`) but
has no staked service 46 yet (`getServiceIds() = []`), so it was not the paying
proxy for this run.

Reward path proof: V3 checker weight for the Safe increased from
`2531000000000000000000` to `2534000000000000000000` after the fresh verdict.
The reward loop then claimed `30000000000000000` wei from the stOLAS distributor
in tx `0x8ee3e417badaa3b81d155df8ed0abb9585601519ecae1b7ba1093569cbc93658`
(block `43490233`). `/v1/status` reported
`claimedStakingRewardsWei: "30000000000000000"`; `calculateStakingReward(46)`
returned `0` afterward because the fast-test staking period reward had already
been claimed.

### B1 — bootstrap a fresh stOLAS-mode operator (ETH-only)

stOLAS mode means the distributor lends the bond; the operator funds only gas.
Both relevant config defaults already point the right way (`network: 'testnet'`
→ Base Sepolia, `stakingMode: 'standard'` → stOLAS), so a minimal config plus a
funded agent EOA is all that is needed.

```bash
mkdir -p ~/.jinn-client
cat > ~/.jinn-client/config.json <<'EOF'
{
  "network": "testnet",
  "stakingMode": "standard"
}
EOF

cd operator
yarn build
JINN_PASSWORD=<choose-one> node dist/bin/jinn.js run --bootstrap-only
# Pauses at awaiting_funding and prints the agent EOA. Fund it with Base Sepolia
# ETH (faucet), then re-run the same command to walk steps to `complete`
# (stOLAS stake → mech deploy).
```

Capture from `~/.jinn-client/earning/earning_state.json`: `service_id`,
`safe_address`, and `staking_address` (the proxy actually staked into).

### B2 — confirm staked, and on which proxy

```bash
export SAFE=<safe_address from earning_state.json>
export SVC=<service_id>
export PROXY=<staking_address from earning_state.json>

cast call --rpc-url $BASE_SEPOLIA_RPC_URL $PROXY "getServiceIds()(uint256[])"   # includes $SVC
cast call --rpc-url $BASE_SEPOLIA_RPC_URL $PROXY "getStakingState(uint256)(uint8)" $SVC  # 1 = Staked
cast call --rpc-url $BASE_SEPOLIA_RPC_URL $PROXY "activityChecker()(address)"     # re-confirm A1 for THIS proxy
```

If `$PROXY` differs from `0xf358…`, redo A1/A4/A5 against `$PROXY` so the rest of
Tier B reasons about the proxy you actually staked into.

### B3 — snapshot counters + reward (before)

```bash
# V3 checker counter for the operator Safe (the loop increments this):
cast call --rpc-url $BASE_SEPOLIA_RPC_URL \
  $CHECKER_V3 "eligibleActivityWeight(address)(uint256)" $SAFE

# Pending reward on the proxy that actually pays (should be ~0):
cast call --rpc-url $BASE_SEPOLIA_RPC_URL \
  $PROXY "calculateStakingReward(uint256)(uint256)" $SVC
```

### B4 — drive one loop through the V3 stack

Run the daemon (`node dist/bin/jinn.js run`) with a creator task so it posts →
claims → delivers → and an evaluator settles a verdict (loop completion) on the
V3 router. Because `requiredVerdicts` defaults to 1, the first verdict finalizes
the attempt. Two ways to get the verdict leg:

- **Two operators** — a second daemon (separate earning dir) claims the
  evaluation request and settles the verdict. This mirrors the
  producer/evaluator pattern in `operator/test/release/tier-2/T2.2-producer-evaluator.ts`.
- **Self-eval allowed** — post the task with `disallowSolverSelfEvaluation:
  false` so the same operator can settle its own verdict (fine for a smoke).

Watch for the on-chain `SolutionDeliveryClaimed` then `VerdictDeliveryClaimed`
events on `$ROUTER_V3`. With the credit-on-verdict change (Phase 1c), the
solver's activity credit fires on the **verdict**, not at solution-delivery.

### B5 — re-read counters + reward (after)

```bash
cast call --rpc-url $BASE_SEPOLIA_RPC_URL \
  $CHECKER_V3 "eligibleActivityWeight(address)(uint256)" $SAFE   # ↑ increased

# If the paying proxy is V3-wired, reward becomes observable after the staking
# liveness period or after the daemon reward loop claims it.
cast call --rpc-url $BASE_SEPOLIA_RPC_URL \
  $PROXY "calculateStakingReward(uint256)(uint256)" $SVC
```

### Tier B verdict

- **V3 checker counter rose and a V3-wired paying proxy accrued or claimed
  reward** -> post-rewire OLAS rails are green.
- **V3 checker counter rose but a V2-wired paying proxy stayed ~0** -> dynamic
  proof of the pre-rewire disconnect.

---

## Phase 1d deployed (2026-06-29)

Clean-break re-wire executed on live Base Sepolia:

| Component | Address |
|---|---|
| JinnRouterV3 (credit-on-verdict impl upgraded) | `0xdC9BCcEB7aca21Ad4Ca2Fc5B4d7aea6b4F6CedD9` |
| TaskActivityCheckerV3 (loop recorder) | `0x0e1B5f264F4FAdcFAA950fb00c58d9A39C040f70` |
| **Fresh staking proxy** (wired to V3 checker) | `0x3A14c71e94F3d38A6BE4319808B259FbFb47B86f` |
| Current fleet staking proxy (wired to V3 checker; service 46 staked here) | `0x24e34E5037956a5Feca1AAAfaA30297084C228B8` |
| Legacy staking proxy (V2 checker — do not stake here) | `0xf358b5c1ac4ddc4e807b5baf008826bf193eab3b` |
| stOLAS distributor | `0x20951FBDb4F9cB1f051ef416BCB11A9Cfe3CEf81` |

**2026-06-29 staking note:** service 46 was recovered in-place on
`0x24e34...`, not migrated to `0x3A14...`. That was acceptable for Tier B
because `0x24e34...` reads the same V3 checker, is funded, and pays rewards.
Move service 46 to `0x3A14...` only when exercising the fresh-proxy migration
path directly.

**2026-06-29 fresh-proxy migration preflight:** do not run the
service-46 migration sequence live yet. A live `eth_call` for
`unstakeAndWithdraw(0x24e34..., 46, bytes32(0x24e34...))` from the master EOA
returned success, and the same call succeeded on an Anvil fork at block
`43490999`, moving service 46 out of the old proxy. The follow-up fork tx
`stake(0x3A14..., 46, 103, 0x16842c...0101, 0x63192d...)` reverted during
`ServiceRegistry.deploy(..., recoveryModule, ...)` with
`UnauthorizedMultisig(0x5E3327C73834502f14e93e6b7D74742De1f9F3FD)` (selector
`0x14460f20`). The deployed distributor's nonzero-service reuse path depends
on that recovery module, but the live service registry does not authorize it as
a multisig implementation. Fix owner-side registry/distributor authorization
before attempting to migrate service 46 to the fresh proxy on Base Sepolia.

**Fork-only rehearsal command (non-live):** this proves the blocker and the
owner-side fix without mutating Base Sepolia. The script refuses to run unless
it sees chainId `84532` and an Anvil fork node.

```bash
# Terminal A: fork the observed failure block.
anvil --fork-url "$BASE_SEPOLIA_RPC_URL" \
  --fork-block-number 43490999 \
  --chain-id 84532 \
  --port 8547

# Terminal B: run from contracts/.
LOCAL_RPC_URL=http://127.0.0.1:8547 LOCAL_CHAIN_ID=84532 \
  yarn hardhat run scripts/rehearse-stolas-service-migration.ts --network localhost
```

Expected result:

- pre-authorization `stake(0x3A14..., 46, ...)` reverts with selector
  `0x14460f20` (`UnauthorizedMultisig`);
- impersonated registry owner
  `0xeDd71796B90eaCc56B074C39BAC90ED2Ca6D93Ee` authorizes recovery module
  `0x5E3327C73834502f14e93e6b7D74742De1f9F3FD` on the fork;
- the rerun migration unstake/stake succeeds locally, service 46 is owned by
  `0x3A14c71e94F3d38A6BE4319808B259FbFb47B86f`, and the fresh proxy lists
  service 46 with staking state `1`;
- evidence is written to
  `.local/stolas-service46-fresh-proxy-rehearsal.json`.

**Reward pool:** the fresh proxy is now funded (`availableRewards = 4e18`) but
empty (`getServiceIds() = []`). The current fleet proxy had
`availableRewards = 25596000000000000000` after the Tier B reward claim.

---

## Decision → next step

| Result | Next |
|---|---|
| Disconnect confirmed (expected) | Proceed to **Phase 1d**: deploy the new consolidated checker, create a fresh staking proxy wired to it (`create-staking-proxy.ts`, swap the line-13 checker), `setStakingProxyConfigs` on the distributor (owner `0x15e7…`) to re-point, fund the fresh proxy, re-stake. |
| No disconnect | Re-scope Phase 1: the re-wire may reduce to a config re-point, or be a no-op. Do not build the fresh-proxy path. |
| Reward split not ~80% curating | Separate gap: tweak the split with one `setStakingProxyConfigs` owner tx before relying on operator-earns-most economics. |

---

## What this does NOT prove

- **Testnet only.** Base Sepolia with fast epochs; not mainnet parameters.
- **JINN-as-OLAS.** The bond/reward token is bridged JINN, not canonical OLAS
  (none exists on Sepolia). Mechanically equivalent; not the same asset.
- **stakingType 1 vs mainnet's 0.** The testnet proxy is `stakingType 1`
  (`OLAS_V2`); the eventual mainnet cut targets a different type. Confirm
  recorder/checker compatibility during Phase 1d.
- **Self-seeded pool.** On testnet the reward pool + bond-lend headroom were
  funded by Jinn-controlled addresses, so the collector's 20% loops back to Jinn
  — there are no external stOLAS depositors on Sepolia. On mainnet that share
  genuinely leaves the operator-and-Jinn system.
- **Tier B harness exists but is operator-local.** See **B0** above
  (`.local/smoke-config.json`, `.local/smoke-earning/`). Not yet a CI job.

---

## Appendix — capture sheet

Fill in as you run (paste into the PR / pivot memory):

```
A1 proxy.activityChecker()      = 0x__________   (expect 0xF4Ca…)
A2 router.activityChecker()     = 0x__________   (expect 0x0e1B…)
A3 disconnect?                  = yes / no
A4 stakingType                  = __
   curatingAgentRewardBps       = ____   (expect ~8000)
   protocolRewardBps            = ____
   collectorRewardBps           = ____   (expect ~2000)
A5 pool balance (JINN-as-OLAS)  = __________ wei
   distributor lend headroom    = __________ wei
   staked serviceIds            = [ ___ ]
   calculateStakingReward(svc)  = __________ wei  (expect ~0)

B1 service_id / safe / proxy    = ___ / 0x____ / 0x____
B3 V3 counter (before)          = __________
   proxy reward (before)        = __________
B5 V3 counter (after)           = __________   (expect ↑)
   proxy reward / claimed after = __________   (expect >0 if V3-wired)
```

### 2026-06-29 Tier B capture

```
Config / daemon                  = .local/smoke-config.json; prediction-only; isolated .local/smoke-earning
RPC boot log                     = fallback chain (4 providers), primary base-sepolia.gateway.tenderly.co
Status endpoint                  = shutdownState "running"; activeTaskRuns 0; failed 0
Gamma evaluator source           = local mock via JINN_POLYMARKET_GAMMA_BASE_URL=http://127.0.0.1:7388

Task id / submit id              = 9272 / olas-smoke-1782748546
Solution requestId               = 0xbc357b25dfb3e546e3f22568f9e3b4c6d00db5e03bb4dab4c8997a6b562745b6
Solution delivery tx             = 0x0d3eb666921504e4247bf9658662ad8db6f3548708f8b5ec5847146c526ff82f
Solution claim tx                = 0xd3b2401e18e4781288c2b4daf4647e97bf77dc48549e6f95977bfcf5e3fc81cd
Verdict requestId                = 0x4b3be2fd8a86d2de99d81d7dc485aab80f7d81c198d42791d303ddb52431c322
Verdict delivery tx              = 0x6f39fb1f9ad79389dd1377b08689cea07ef6341105764fa03a540722a9084d16
Verdict claim tx                 = 0x83114c8e3c0c5c34ebe7720829c92abf791e8b312960164f46068203cbe1cd9d

Service / safe / paying proxy    = 46 / 0x0e767E28C6889CcD0DfB88E631a3702D56Ce24FC / 0x24e34E5037956a5Feca1AAAfaA30297084C228B8
Restake tx                       = 0x02a9de283deaeefa65807a44d0ba381eef4ea3e4ef75fd66a5648c2dd1d545ac
Staking state                    = 1 (Staked)
Paying proxy checker             = 0x0e1B5f264F4FAdcFAA950fb00c58d9A39C040f70
Paying proxy serviceIds          = [46, 50, 63]
Fresh proxy state                = funded (4e18 availableRewards), empty serviceIds []

V3 counter before                = 2531000000000000000000
V3 counter after                 = 2534000000000000000000
V3 counter delta                 = 3000000000000000000
Reward before                    = 0 wei
Reward claim tx                  = 0x8ee3e417badaa3b81d155df8ed0abb9585601519ecae1b7ba1093569cbc93658
Reward after (/v1/status)        = claimedStakingRewardsWei 30000000000000000
Pending reward after claim       = 0 wei
```
