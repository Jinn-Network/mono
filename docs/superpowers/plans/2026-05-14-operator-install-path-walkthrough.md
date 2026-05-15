# Operator Install-Path Clean-Room Walkthrough — `jinn-mono-uy6v.4` Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to run this plan as a live walkthrough — most tasks are observe-and-capture, not edit-and-test. Use `bd update jinn-mono-uy6v.4 --claim` before starting Phase 1.

**Goal:** Walk a fresh-machine operator from `npm install -g @jinn-network/client@latest` → joined SWE-rebench v2 SolverNet → first Solution settled on Base Sepolia, capture evidence per child bead, then close (or refile) each of the nine open P1 children plus the `uy6v.4` parent.

**Architecture:** Live operational walkthrough against `@jinn-network/client@0.1.5` (npm `latest` as of 2026-05-13) using an isolated `$HOME` so the operator's real `~/.jinn-client/` is untouched. The flow is **app-first** per `client/TESTNET_ACCEPTANCE.md` — terminal commands are diagnostic only; the bootstrap state machine, harness auth, SolverNet join, and task observation all happen in the dashboard SPA. Evidence (browser screenshots, log lines, tx hashes) accumulates in a single timestamped run directory, then maps back to the nine child beads via an explicit observed-vs-expected table.

**Tech Stack:** `@jinn-network/client@0.1.5`, npm 10+, Node 22, Base Sepolia (chainId 84532), Chrome DevTools MCP for browser walkthrough, BaseScan for on-chain evidence, `bd` + `gh` CLIs for closeout.

---

## Pre-flight context

**The hypothesis to test:** Most of these nine P1 children are already fixed by work that landed in v0.1.4 / v0.1.5 and are only stale-open because nobody has walked the canonical clean-room flow against the published artifact since the bootstrap + operator-app work shipped.

**Bead inventory** (read each via `bd show <id>` before execution; do **not** rely on this summary alone):

| Bead | Shape | Hypothesis on current state | Evidence that closes it |
|---|---|---|---|
| `jinn-mono-h74p` | bug | Open. ERC-1271 `setAgentWallet` reverts on fresh 1/1 Safes; bootstrap logs `safe_bound_to_agent=false` but proceeds. No fix shipped per bd history. | EITHER a successful `setAgentWallet` tx on Base Sepolia with `safe_bound_to_agent=true` in earning state → close; OR confirm the same revert reproduces → keep open with fresh repro evidence. |
| `jinn-mono-iwkh` | bug | Open. Safe.execTransaction fallback gas (2M) below mech-deploy estimate (2.23M). **Note:** Base Sepolia config sets `mechMarketplace = 0x000…0` (mech is out of scope for Phase 1a staking-only loop, per `client/src/earning/contracts.ts:264`). On Base Sepolia the `mech_deployed` step may be skipped entirely. | Bootstrap reaches `complete` on Base Sepolia without hitting the gas cliff → close as "not applicable on Base Sepolia testnet path; mainnet-only risk, reframe or downgrade." |
| `jinn-mono-l2zl.15.4.1` | bug | Likely fixed. Bead notes (`bd show`) describe the failure on `~/.jinn-client/config.json` with persisted mainnet network. A clean HOME has no config; default must resolve to testnet. | Daemon log shows `network=testnet` + `chainId=84532` on first start in clean HOME with no config edits → close. |
| `jinn-mono-l2zl.15.4.3` | bug | Likely fixed. Bead notes confirm "current live setup is blocked at app-led funding" — i.e., the only terminal step is `jinn run` and the rest is app-driven. | Walkthrough completes from `jinn run` only, no `jinn auth` / `jinn doctor` / env overrides in the operator path → close. |
| `jinn-mono-l2zl.15.4.4` | bug | Likely fixed. Bead notes show 2026-05-04 fix landed: legacy DB column migration. Clean HOME has no legacy DB, so this is *not* the right test — the test is upgrading a pre-task-native DB. **Reframe:** confirm fresh-DB startup works; defer legacy-DB regression to a separate diagnostic. | Fresh `jinn.db` created on first boot, no `no such column: task_id` error → close with note that legacy-DB upgrade was the original failure and is covered by the shipped regression test (`client/test/store/...`). |
| `jinn-mono-l2zl.15.4.5` | bug | Likely fixed. Bead notes: 2026-05-04 fix gates `client/.env` behind `JINN_LOAD_DEV_ENV=1` / `NODE_ENV=development`. From the npm-installed binary, there is no `client/.env` to load. | Clean-HOME `jinn run` from npm `latest` reaches setup API without `Phase 1a artifact not found` error → close. |
| `jinn-mono-l2zl.15.4.6` | bug | Likely fixed. Bead notes: 2026-05-04 fix wires `getClaudePath` / `onClaudePathSelected` through to setup routes. Walkthrough must include in-app Install Claude Code (or Codex equivalent) and verify the live auth probe flips to `binary.ok=true` without restart. | Sequence: `/v1/auth/claude` returns `binary.ok=false` → click Install in app → without daemon restart, `/v1/auth/claude` returns `binary.ok=true` with the installed path → close. |
| `jinn-mono-l2zl.15.4.7` | bug | Mostly N/A in clean HOME (no stale mainnet earning state to mismatch). The fix shipped 2026-05-04 archives mismatched state. | Clean HOME starts on testnet with no archive action, `chain=base-sepolia` from `/v1/bootstrap` first poll → close as "fixed and not reproducible on clean HOME; regression test in `client/test/...` covers the upgrade path." |
| `jinn-mono-uy6v.4.1` | bug | Possibly fixed. Test: with the daemon mid-task on SWE-rebench v2 and the catalog/subgraph deliberately broken (or 429), `/operator` must not render `RetiredManifest` for the joined SolverNet. | Browser screenshot of `/operator` while a SWE task is in flight, with the joined SolverNet NOT showing `RetiredManifest` even when Discover is degraded → close. If subgraph happens to be healthy during the walkthrough, this verification is partial — note that and downgrade rather than close. |

**Canonical SWE-rebench v2 manifest CID** (already broadcast — see `~/.jinn-client/earning/solvernets/launched/5474_swe-rebench-v2-v1_edb172d3.json`):

```
bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi
```

**Funding minimums** (from `client/src/earning/contracts.ts:283-284`):

- Agent EOA: `0.005 ETH` (Base Sepolia)
- Master Safe: `0.002 ETH` (Base Sepolia)
- Staking bond: `10 testnet-JINN` (the OLAS-equivalent at `0x4F177E56bd79c169742a1BF8907dB0A5e54F5524`, dispensed by the testnet-JINN faucet)

**Out of scope** (do **not** open these beads while executing):

- `jinn-mono-uy6v.7` (reward distribution observation)
- `jinn-mono-2sro` (multi-operator dogfood)
- `jinn-mono-hjex` (operator-app UX epic — friction reports collect here only after walkthrough is done)

---

## Phase 0 — Pre-flight (no on-chain cost)

### Task 0.1: Set up the run-evidence directory

**Files:**
- Create: `client/acceptance-runs/2026-05-14T<HH-MM-SS>Z-uy6v4-cleanroom/` (timestamp at execution time)

- [ ] **Step 1: Compute timestamped evidence root**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo
RUN_TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
export RUN_DIR="client/acceptance-runs/${RUN_TS}-uy6v4-cleanroom"
mkdir -p "${RUN_DIR}"/{browser,logs,onchain,bd-notes}
echo "Evidence root: ${RUN_DIR}"
```

Expected: directory created; remember `${RUN_DIR}` for the rest of the walkthrough.

- [ ] **Step 2: Snapshot what's published on npm**

```bash
npm view @jinn-network/client@latest version dist-tags repository.url --json > "${RUN_DIR}/npm-target.json"
cat "${RUN_DIR}/npm-target.json"
```

Expected: `"version": "0.1.5"`, `dist-tags.latest = "0.1.5"`. If `latest` ≠ `0.1.5`, **stop** and ping Captain — a newer cut shipped while the plan was drafted; re-frame the verification target before continuing.

- [ ] **Step 3: Snapshot the nine open child beads**

```bash
for id in jinn-mono-h74p jinn-mono-iwkh jinn-mono-l2zl.15.4.1 jinn-mono-l2zl.15.4.3 jinn-mono-l2zl.15.4.4 jinn-mono-l2zl.15.4.5 jinn-mono-l2zl.15.4.6 jinn-mono-l2zl.15.4.7 jinn-mono-uy6v.4.1; do
  bd show "${id}" > "${RUN_DIR}/bd-notes/${id}.before.txt"
done
bd show jinn-mono-uy6v.4 > "${RUN_DIR}/bd-notes/uy6v.4.before.txt"
ls "${RUN_DIR}/bd-notes/"
```

Expected: 10 `.before.txt` files captured. These are the baseline; final close-reasons cite them.

- [ ] **Step 4: Claim the parent bead**

```bash
bd update jinn-mono-uy6v.4 --claim
bd show jinn-mono-uy6v.4 | grep -E "Status|Owner"
```

Expected: status `in_progress`, owner you. (If already claimed by another operator, pause and confirm with Captain.)

### Task 0.2: Provision the clean HOME

**Files:**
- Create: `/tmp/jinn-cleanroom-${RUN_TS}/` (operator HOME for the walkthrough)

- [ ] **Step 1: Create isolated HOME and confirm it's empty**

```bash
export CLEAN_HOME="/tmp/jinn-cleanroom-${RUN_TS}"
mkdir -p "${CLEAN_HOME}"
ls -la "${CLEAN_HOME}"
# Sanity: no .jinn-client subdir exists
test ! -e "${CLEAN_HOME}/.jinn-client" && echo "OK: clean HOME has no .jinn-client/"
```

Expected: directory created, no `.jinn-client/` present.

- [ ] **Step 2: Confirm the real operator HOME is untouched (defense-in-depth check)**

```bash
ls /Users/adrianobradley/.jinn-client/ | head -5
echo "Real operator HOME path: /Users/adrianobradley/.jinn-client/ — DO NOT WRITE TO THIS"
```

Expected: real HOME shows the long-running operator's `config.json`, `earning/`, `jinn.db`, etc. **This is the operator's production state; the walkthrough must never write to it.**

- [ ] **Step 3: Spin up an isolated shell environment for the walkthrough**

For each subsequent terminal command in Phases 1+, prefix with the env overrides:

```bash
# Use this exact env when running `jinn` for the walkthrough:
env HOME="${CLEAN_HOME}" \
    JINN_API_PORT=7333 \
    JINN_DB_PATH="${CLEAN_HOME}/.jinn-client/jinn.db" \
    JINN_EARNING_DIR="${CLEAN_HOME}/.jinn-client/earning" \
    jinn run
```

Rationale:
- `HOME=${CLEAN_HOME}` keeps `~/.jinn-client` → `${CLEAN_HOME}/.jinn-client`.
- `JINN_API_PORT=7333` avoids colliding with the long-running operator daemon on 7331.
- The explicit `JINN_DB_PATH` / `JINN_EARNING_DIR` are belt-and-braces in case any code path resolves them before the HOME override applies. Drop them if Phase 1 shows the override alone is enough — but record which case was true.

- [ ] **Step 4: Confirm Node/npm versions**

```bash
node --version
npm --version
which claude || echo "claude not on PATH (expected for cleanroom verification of bead 4.6)"
```

Expected: Node 22.x, npm 10.x. If `claude` *is* on PATH, that's fine — it just means the verification of `l2zl.15.4.6` will exercise the "already installed" branch rather than the in-app install branch. Record which branch fires.

### Task 0.3: Confirm faucet availability before burning npm install time

- [ ] **Step 1: Verify Base Sepolia ETH faucet access**

Open a browser tab and visit at least one Base Sepolia faucet (e.g., https://www.alchemy.com/faucets/base-sepolia or the Coinbase wallet faucet). Confirm:
- You can request testnet ETH without rate-limit lockout.
- You have a destination wallet ready to relay funds (the agent EOA address won't exist until Phase 1 prints it).

Record the faucet used and any rate-limit reset window in `${RUN_DIR}/logs/faucet-readiness.md`.

- [ ] **Step 2: Verify testnet-JINN faucet contract is funded**

```bash
# Faucet address resolved from deployment-jinn-testnet-faucet-baseSepolia-fast.json
FAUCET_DEPLOY="/Users/adrianobradley/harbor/jinn-mono/cargo/client/deployments/deployment-jinn-testnet-faucet-baseSepolia-fast.json"
test -f "${FAUCET_DEPLOY}" && jq -r '.contracts.JinnTestnetFaucet // .contracts.faucet // .contracts' "${FAUCET_DEPLOY}" || echo "Faucet artifact missing — locate via: find . -name 'deployment-jinn-testnet-faucet*' -not -path '*/node_modules/*' -not -path '*/.tasks/*' -not -path '*/.claude/*'"
```

If the artifact is missing locally, find it via the daemon's bundled deployment dir — the `JINN_FAUCET` address ends up in `chainConfig.jinnFaucet` and is reachable from the dashboard's setup endpoint.

Expected: a 0x-prefixed faucet address noted in `${RUN_DIR}/logs/faucet-readiness.md`. If the faucet is empty or broken, **stop** and surface that as a release blocker before continuing (it'd block any clean operator from joining).

---

## Phase 1 — Install and launch (`jinn-mono-l2zl.15.4.{3,5}` + `4.1`, `4.4`, `4.7`)

### Task 1.1: Global install of `@jinn-network/client@latest`

- [ ] **Step 1: Install the package globally**

```bash
npm install -g @jinn-network/client@latest 2>&1 | tee "${RUN_DIR}/logs/npm-install.log"
which jinn
jinn version --json | tee "${RUN_DIR}/logs/jinn-version.json"
```

Expected: install succeeds; `jinn version --json` reports `0.1.5`. If `which jinn` returns the repo-checkout path (not a global bin), the npm global prefix is leaking — record and use the absolute path from `npm root -g` for subsequent steps so the verification reflects the published artifact, not the repo build.

- [ ] **Step 2: Confirm no repo-checkout state leaks**

```bash
grep -E "harbor/jinn-mono|client/src" "${RUN_DIR}/logs/jinn-version.json" && echo "FAIL: version JSON references repo paths" || echo "OK: version JSON is pristine"
```

Expected: no repo paths in the version output (e.g., `resolvedPath` points at the global bin or a stable cache, not `harbor/jinn-mono/cargo/client/...`).

### Task 1.2: First `jinn run` in clean HOME

- [ ] **Step 1: Start the daemon in a foreground terminal**

In a terminal window (so the dashboard can auto-open):

```bash
env HOME="${CLEAN_HOME}" JINN_API_PORT=7333 jinn run 2>&1 | tee "${RUN_DIR}/logs/jinn-run-startup.log"
```

Watch for these log lines (capture each):

1. `[main] Setup-mode API up (mode=...). Dashboard: http://127.0.0.1:7333`
2. The handshake URL — something like `http://127.0.0.1:7333/?k=<key>`
3. Network/chain resolution: should log `network=testnet` / `chainId=84532` — record exact line(s).
4. Keystore-password autogen messages — if the password file is created in terminal output *before* the API is up, that's evidence for / against `l2zl.15.4.3`.

Stop and screenshot the terminal if any error log appears before the Dashboard URL is printed.

- [ ] **Step 2: Verify clean HOME layout populated correctly**

In a separate terminal, while the daemon is running:

```bash
ls -la "${CLEAN_HOME}/.jinn-client/" | tee "${RUN_DIR}/logs/clean-home-layout.txt"
test -f "${CLEAN_HOME}/.jinn-client/keystore-password" && echo "keystore-password present"
test -f "${CLEAN_HOME}/.jinn-client/jinn.db" && echo "jinn.db present"
test ! -f "${CLEAN_HOME}/.jinn-client/config.json" && echo "no config.json yet (expected — app writes it on first save)"
```

Expected: `keystore-password` and `jinn.db` exist; `config.json` does *not* yet (the app writes it when the operator first saves a SolverNet join, or as part of bootstrap state persistence — record which).

- [ ] **Step 3: Capture the bootstrap state snapshot**

```bash
curl -s "http://127.0.0.1:7333/v1/bootstrap" -H "Authorization: Bearer $(cat ${CLEAN_HOME}/.jinn-client/keystore-password 2>/dev/null || echo SKIP)" | tee "${RUN_DIR}/logs/bootstrap-initial.json" | jq '.chain, .currentStep, .network'
```

Expected: `chain: "base-sepolia"`, `network: "testnet"`, `currentStep: "wallet"` or `"safe_predicted"` or `"awaiting_funding"` (depending on how far bootstrap has advanced by the time you query).

**If `chain` is `"base"` or `network` is `"mainnet"`:** that's `l2zl.15.4.1` reproducing — capture the bootstrap JSON, the log line that set the network, and the absence of a config.json. File a fresh bead under `uy6v.4` and **do not close 4.1**.

> **Closes (pending the rest of bootstrap completing):** `l2zl.15.4.1`, `l2zl.15.4.3`, `l2zl.15.4.5`, `l2zl.15.4.7` are *candidate* closes once Phase 1 + Phase 2 complete without their failure modes reproducing. Don't close them yet — close all together in Phase 7 to keep the evidence bundled.

### Task 1.3: Open the dashboard and capture initial state

- [ ] **Step 1: Open the printed handshake URL**

Either the daemon auto-opens the browser (`JINN_NO_UI` is unset), or paste the URL from Task 1.2 Step 1 into Chrome.

Capture a screenshot of the initial dashboard view:
- Save to `${RUN_DIR}/browser/01-dashboard-initial.png`.
- Confirm it shows a bootstrap-in-progress / setup view, not a 500/404/blank page.

- [ ] **Step 2: Confirm the SPA bundle was served**

If the SPA fails to load (e.g., the page shows "dashboard bundle missing"), that's a packaging bug in the published artifact — **stop**, file a fresh P0 bead under `uy6v.4` with the response body and `${RUN_DIR}/logs/jinn-run-startup.log` attached.

---

## Phase 2 — Bootstrap to `complete` (`jinn-mono-h74p`, `jinn-mono-iwkh`)

### Task 2.1: Walk to `awaiting_funding` and capture funding addresses

- [ ] **Step 1: Read the funding plan from the API**

```bash
# Replace TOKEN with the UI token from the handshake URL `?k=...`
TOKEN="<from handshake URL>"
curl -s "http://127.0.0.1:7333/v1/bootstrap" -H "Authorization: Bearer ${TOKEN}" | tee "${RUN_DIR}/logs/bootstrap-awaiting-funding.json" | jq '.currentStep, .agentEoa, .safeAddress, .funding'
```

Expected (when bootstrap is at `awaiting_funding`):
- `currentStep: "awaiting_funding"`
- `agentEoa: "0x..."` (the master EOA)
- `safeAddress: "0x..."` (the predicted Safe — may not be deployed yet)
- `funding.eoaShortfallWei` and `funding.safeShortfallWei` showing how much is needed.

Save the EOA and Safe addresses to `${RUN_DIR}/logs/funding-targets.txt`.

- [ ] **Step 2: Screenshot the in-app funding instructions**

Navigate the dashboard to the setup / funding view. Capture:
- `${RUN_DIR}/browser/02-awaiting-funding.png` — the operator-facing funding instructions, including the displayed amounts, addresses, and any in-app faucet affordance.

### Task 2.2: Fund the agent EOA and Safe

- [ ] **Step 1: Fund the agent EOA with ETH from a Base Sepolia faucet**

Use the faucet identified in Task 0.3 Step 1 to send at least `0.01 ETH` to the agent EOA. Record:
- Faucet tx hash → `${RUN_DIR}/onchain/eoa-funding-tx.txt`
- BaseScan link → same file

Expected: 1-2 confirmations within a minute on Base Sepolia.

- [ ] **Step 2: Fund the Safe with ETH**

The Safe needs ≥ `0.002 ETH`. Easiest path: send `0.005 ETH` directly to the predicted Safe address (Safe can receive ETH before deployment via `selfdestruct`-style send, but on Base Sepolia just use a normal ETH transfer — it lands in the address and is available when the Safe deploys).

Record tx hash + BaseScan link in `${RUN_DIR}/onchain/safe-eth-funding-tx.txt`.

- [ ] **Step 3: Mint testnet-JINN from the faucet to the Safe**

The Phase 1a bond is paid in testnet-JINN. Trigger the in-app faucet affordance if present (Discover the funding view; there may be a button), or call the faucet contract directly:

```bash
# Faucet address from Task 0.3 Step 2:
FAUCET_ADDR="<from logs/faucet-readiness.md>"
SAFE_ADDR="<from logs/funding-targets.txt>"
# Use cast or the in-app affordance to call faucet.drip(SAFE_ADDR, 10e18) or equivalent.
```

Record the faucet drip tx hash + BaseScan link in `${RUN_DIR}/onchain/jinn-faucet-tx.txt`. Confirm the Safe's testnet-JINN balance is ≥ 10 JINN via BaseScan.

- [ ] **Step 4: Watch bootstrap auto-advance in the dashboard**

Poll the bootstrap endpoint while watching the SPA:

```bash
while true; do
  STEP=$(curl -s "http://127.0.0.1:7333/v1/bootstrap" -H "Authorization: Bearer ${TOKEN}" | jq -r '.currentStep')
  echo "$(date -u +%H:%M:%S) currentStep=${STEP}"
  [ "${STEP}" = "complete" ] || [ "${STEP}" = "awaiting_funding" ] && [ "${STEP}" = "complete" ] && break
  sleep 10
done
```

Capture every step transition in `${RUN_DIR}/logs/bootstrap-progress.log`.

Expected sequence on Base Sepolia (Phase 1a):
```
wallet → safe_predicted → awaiting_funding → safe_deployed → service_created → service_activated → agents_registered → service_deployed → service_staked → mech_deployed (SKIPPED on Base Sepolia — mech is out of scope per contracts.ts:264) → complete
```

### Task 2.3: Verify ERC-1271 `setAgentWallet` outcome (`jinn-mono-h74p`)

- [ ] **Step 1: Check the earning state for `safe_bound_to_agent`**

```bash
cat "${CLEAN_HOME}/.jinn-client/earning/earning_state.json" | tee "${RUN_DIR}/logs/earning-state-final.json" | jq '.step, .safe_bound_to_agent, .agentId, .identityRegistryTx // .erc8004 // {}'
```

Decision tree:

**Case A: `safe_bound_to_agent: true`** — the bind succeeded. Capture the `setAgentWallet` tx hash from the earning state; verify on BaseScan that the tx succeeded and the IdentityRegistry's `agentWallet(agentId)` returns the Safe address (read via BaseScan's "Read Contract" tab on `0x8004A818BFB912233c491871b3d84c89A494BD9e`). Save to `${RUN_DIR}/onchain/set-agent-wallet-tx.txt`. **→ `jinn-mono-h74p` is verified fixed.**

**Case B: `safe_bound_to_agent: false`** — the bind still reverts. Capture the failing tx hash if one was attempted (look in daemon logs for `setAgentWallet`), record the revert reason, and save to `${RUN_DIR}/onchain/set-agent-wallet-revert.txt`. **→ `jinn-mono-h74p` stays open; update with fresh repro evidence.**

- [ ] **Step 2: Verify mech-deploy gas (`jinn-mono-iwkh`)**

```bash
jq '.step, .mech // null, .services[0].mechAddress // null' "${RUN_DIR}/logs/earning-state-final.json"
```

Decision tree:

**Case A:** Mech step skipped on Base Sepolia (`mech: null`, no `mechAddress`) because `chainConfig.mechMarketplace = 0x0000…0`. **→ `jinn-mono-iwkh` is N/A on testnet; reframe as "mainnet-only gas-limit risk; not reproducible on Base Sepolia." Close with that reasoning.**

**Case B:** Mech step *was* executed (config differs from expectation) and succeeded with no out-of-gas — close with the tx hash as evidence.

**Case C:** Mech step ran and failed at exactly the 2M gas cliff — keep open with fresh tx hash and gas-used evidence.

### Task 2.4: Snapshot bootstrap-complete evidence

- [ ] **Step 1: Capture the dashboard's "bootstrap complete" view**

Screenshot: `${RUN_DIR}/browser/03-bootstrap-complete.png` — should show the operator-app post-setup state (likely `/operator` or the main running view).

- [ ] **Step 2: Snapshot the full earning state for the run record**

```bash
cp "${CLEAN_HOME}/.jinn-client/earning/earning_state.json" "${RUN_DIR}/logs/earning-state-complete.json"
```

---

## Phase 3 — Harness install and live auth (`jinn-mono-l2zl.15.4.6`)

This phase intentionally exercises the in-app install path even if `claude` is already on PATH, so we verify the live auth probe behavior. If `claude` is on PATH from a prior install, do Step 1 + Step 2 to verify the probe sees it; otherwise do Step 3.

### Task 3.1: Verify Claude auth probe

- [ ] **Step 1: Hit the live auth probe**

```bash
curl -s "http://127.0.0.1:7333/v1/auth/claude" -H "Authorization: Bearer ${TOKEN}" | tee "${RUN_DIR}/logs/auth-claude-initial.json" | jq '.authenticated, .context, .resolvedPath, .binary, .email // null'
```

Two cases:

**Case A: `binary.ok=true` from the start** — `claude` was already on PATH in this `HOME`. Note the `resolvedPath` and `authenticated` status. If `authenticated=true`, harness auth is already complete. Skip to Phase 4.

**Case B: `binary.ok=false`** — `claude` is missing. Proceed to Step 2.

- [ ] **Step 2: Trigger in-app Claude install**

Navigate the dashboard to the Step 01 / harness-setup view. Screenshot: `${RUN_DIR}/browser/04-install-claude-pre.png`.

Click the in-app **Install Claude Code** action. Watch for:
- Progress UI (download / extract / install).
- Completion state showing the installed binary path (e.g., `${CLEAN_HOME}/.jinn-client/tools/claude-code/node_modules/.bin/claude`).

Screenshot result: `${RUN_DIR}/browser/05-install-claude-post.png`.

- [ ] **Step 3: Verify the live auth probe sees the installed binary WITHOUT restart**

```bash
curl -s "http://127.0.0.1:7333/v1/auth/claude" -H "Authorization: Bearer ${TOKEN}" | tee "${RUN_DIR}/logs/auth-claude-post-install.json" | jq '.authenticated, .resolvedPath, .binary'
```

Expected: `binary.ok=true`, `resolvedPath` matches the freshly installed path. The daemon must **not** have restarted between the install and this probe.

Decision tree:

**Case A: `binary.ok=true` after install, no restart** → `jinn-mono-l2zl.15.4.6` is verified fixed. **Candidate close.**

**Case B: `binary.ok=false` still, or operator had to restart `jinn run`** → bug still present; keep open and update with fresh evidence.

### Task 3.2: Sign in to Claude (or Codex) for solver runs

- [ ] **Step 1: Authenticate the harness in-app**

Follow the in-app sign-in affordance. For Claude Code, this is typically a `claude setup-token` flow or an OAuth redirect — capture whichever the SPA presents. Save the auth-result screenshot to `${RUN_DIR}/browser/06-harness-authenticated.png`.

Verify:

```bash
curl -s "http://127.0.0.1:7333/v1/auth/claude" -H "Authorization: Bearer ${TOKEN}" | jq '.authenticated, .email'
```

Expected: `authenticated=true`, an email or account identifier present.

> **Note:** If Codex is the chosen harness, swap to `/v1/auth/codex` and the corresponding install action. SWE-rebench v2 defaults to `claude-code-learner` per the runbook §Join As Solver Or Evaluator step 4; prefer Claude for the verification.

---

## Phase 4 — Join SWE-rebench v2 (`jinn-mono-uy6v.4.1`)

### Task 4.1: Verify Discover renders the canonical SolverNet

- [ ] **Step 1: Navigate to `/operator`**

Open `http://127.0.0.1:7333/dashboard/operator` (or wherever the SPA routes — the link is on the post-bootstrap home).

Screenshot: `${RUN_DIR}/browser/07-operator-discover.png`.

Expected:
- A **Discover** section lists the canonical SWE-rebench v2 SolverNet (manifest CID `bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi`).
- The joined list is empty (this is a clean HOME).
- The Data donation section renders without errors (we don't need to enable it for the install-path gate).

### Task 4.2: Join as solver + evaluator

- [ ] **Step 1: Click Join on the SWE-rebench v2 row**

In the Discover panel, click into the SWE-rebench v2 row, select roles `solver` and `evaluator`. Confirm:
- Harness defaults to `claude-code-learner` (per runbook step 4).
- Model defaults to `claude-haiku-4-5-20251001`.
- Network Tools and the SWE-rebench v2 runtime plugin are default-included.

Save the join confirmation modal/screen: `${RUN_DIR}/browser/08-join-config.png`.

- [ ] **Step 2: Save the join**

Click Save / Join. The SPA should show a "restart required" state per the runbook.

Screenshot: `${RUN_DIR}/browser/09-join-saved-restart-required.png`.

- [ ] **Step 3: Verify config.json was written by the app, not by hand**

```bash
cat "${CLEAN_HOME}/.jinn-client/config.json" | tee "${RUN_DIR}/logs/config-after-join.json" | jq '.joinedSolverNets, .network'
```

Expected: `joinedSolverNets["bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi"]` exists with the expected shape; `network: "testnet"`.

### Task 4.3: Restart the daemon and verify the join took effect

- [ ] **Step 1: Stop the daemon (Ctrl-C in the terminal)**

Capture the shutdown log lines in `${RUN_DIR}/logs/jinn-run-shutdown-1.log`.

- [ ] **Step 2: Relaunch with the same env**

```bash
env HOME="${CLEAN_HOME}" JINN_API_PORT=7333 jinn run 2>&1 | tee "${RUN_DIR}/logs/jinn-run-after-join.log"
```

Watch for:
- `loaded SolverNet swe-rebench-v2 with manifest bafkreichdzx...` log line.
- `solver/evaluator roles active` (or equivalent — the exact phrasing comes from the daemon's loops).

- [ ] **Step 3: Verify joined SolverNet appears only in the joined list**

Re-open `/operator`. Screenshot: `${RUN_DIR}/browser/10-operator-after-restart.png`.

Expected:
- SWE-rebench v2 appears in the **Joined** list, *not* in Discover.
- No `RetiredManifest` warning on the joined row.

### Task 4.4: Verify `uy6v.4.1` (RetiredManifest false-positive)

- [ ] **Step 1: Capture the joined state under normal conditions**

If the Discover catalog refresh is healthy, the joined SolverNet should simply show as active. Screenshot: `${RUN_DIR}/browser/11-operator-joined-healthy.png`.

- [ ] **Step 2 (optional but recommended): Force a degraded catalog state**

The runbook scenario for `uy6v.4.1` requires Discover to be degraded (e.g., subgraph 429) while the joined SolverNet is active locally. Two approaches:

**Option A — wait for natural degradation:** Discover catalog throttling is common; check `/operator` 2-3 times over Phase 5 (which takes minutes) and capture if/when the catalog goes stale.

**Option B — force it via env override:** Stop the daemon, restart with `JINN_DISCOVERY_URL="https://invalid-host.example/graphql"` so the HTTP discovery fails, then `/operator` will fall back to the floor. Capture the screenshot of `/operator` in this state.

Decision tree:

- **Joined SolverNet renders as active (no `RetiredManifest`) under degraded catalog** → `jinn-mono-uy6v.4.1` is verified fixed.
- **Joined SolverNet renders as `RetiredManifest` under degraded catalog** → bug still present; keep open.
- **Could not induce degraded catalog within the walkthrough window** → leave bd open with a note "couldn't induce 429 during walkthrough; healthy state showed correct rendering; full verification requires a separate degraded-catalog test" — downgrade rather than close.

---

## Phase 5 — Claim and solve one Task

### Task 5.1: Watch the launcher's task feed

- [ ] **Step 1: Open `/launcher/launched/:id` for the canonical SolverNet**

Discover the SolverNet ID from the launched record:

```bash
# This file lives under the launcher's home — for the cleanroom operator,
# the launched record won't be local. Read the SolverNet ID from the
# manifest CID via the dashboard's launched-record lookup, or from the
# subgraph. Easiest path: navigate the SPA to /launcher and find the
# launched SWE-rebench v2 row, then click into it.
```

Once on `/launcher/launched/<id>`, screenshot: `${RUN_DIR}/browser/12-launcher-launched.png`.

Expected:
- Contract identity: `swe-rebench-v2.v1`.
- Generator status: `launched` (and posting if cooldown has elapsed).
- Task table with at least one Open task.

> If the launcher view shows zero open tasks for a long stretch, the canonical generator may be paused or cooled down. Cross-check with the long-running operator's daemon log (`~/.jinn-client/daemon-*.log`) for recent task posts. If genuinely no tasks are flowing testnet-wide, pause Phase 5 and ping Captain — the verification is blocked on the canonical launcher, not on the operator install path.

### Task 5.2: Claim and solve

- [ ] **Step 1: Let the daemon claim a task**

The cleanroom daemon should pick up an Open task on its next claim tick. Watch the daemon logs:

```bash
tail -f "${RUN_DIR}/logs/jinn-run-after-join.log" | grep -E "claim|claimed|solving|delivered" | tee "${RUN_DIR}/logs/claim-events.log"
```

When you see `claimed task <task-id>`:
- Note the task ID and task CID in `${RUN_DIR}/onchain/claimed-task.txt`.
- Capture the BaseScan link for the `JinnRouter.submitClaim` (or equivalent) tx.

- [ ] **Step 2: Watch the solve complete**

The Claude-Code-learner harness will execute the SWE-rebench v2 instance in `${CLEAN_HOME}/.jinn-client/engine/work/<task-id>/`. This takes single-digit to ~20 minutes depending on instance difficulty.

Capture in `${RUN_DIR}/logs/solve-progress.log`:
- Engine spawn time.
- Solve duration.
- The output `solution.cid` (IPFS CID of the solution envelope).
- The `JinnRouter` `submitSolution` (or task-native equivalent) tx hash.

- [ ] **Step 3: Verify the solution row in the launcher view**

Refresh `/launcher/launched/<id>`. The task row should now show:
- A claim count > 0.
- A solution submitted (state transition visible).

Screenshot: `${RUN_DIR}/browser/13-task-solved.png`.

### Task 5.3: Evaluate (same daemon, evaluator role)

- [ ] **Step 1: Wait for the evaluator loop to pick up the solution**

The same daemon runs both solver and evaluator (since we joined with both roles). The protocol disallows self-evaluation, so this daemon may evaluate someone else's solution rather than its own. Capture either:
- Self-solution is evaluated by another operator (look for `verdict submitted` referencing your task), OR
- This daemon evaluates a different operator's solution on the same SolverNet.

Save the evaluator's submitted Verdict tx hash + envelope CID to `${RUN_DIR}/onchain/verdict.txt`.

### Task 5.4: Watch settlement

- [ ] **Step 1: Watch for `N_target_successes` Verdicts on your task**

The launched record has `N_target_successes: 3`. The task settles after 3 score=1 Verdicts. Refresh `/launcher/launched/<id>` periodically and watch the task state transition through:

```
Open → Claims in flight → Fully claimed → Settled
```

Capture screenshots at each transition: `${RUN_DIR}/browser/14-task-settled.png`.

Settlement evidence:
- Final task state in the launcher view.
- Settlement tx hash (if a discrete settle tx exists) or the Nth Verdict tx that completes the task.

Save to `${RUN_DIR}/onchain/settlement.txt`.

> **If the task does not settle within the verification window** (say, 2 hours): the canonical SolverNet may not have 3 evaluators currently active. In that case, "first Solution settled" cannot be reached without coordinating with other testnet operators. **Capture the partial state** (one Solution submitted, one Verdict — even if not Settled) as evidence that the install path works through the operator's reachable surface; flag the settle blocker as a separate finding and continue to closeout. The parent bead's acceptance criteria *requires* settlement, so this would mean `uy6v.4` stays open with a "blocked on operator coverage" note rather than closes.

---

## Phase 6 — Per-bead verification matrix

After Phases 1-5 are complete (or have hit a blocking failure), fill in this matrix in `${RUN_DIR}/bd-notes/verification-matrix.md`:

| Bead | Observed | Evidence path | Decision |
|---|---|---|---|
| `jinn-mono-h74p` | `safe_bound_to_agent` = ? | `logs/earning-state-final.json` + `onchain/set-agent-wallet-*.txt` | close / keep open |
| `jinn-mono-iwkh` | mech step skipped / succeeded / OOG'd | `logs/earning-state-final.json` | close (N/A on testnet) / close (succeeded) / keep open |
| `jinn-mono-l2zl.15.4.1` | network at first boot = ? | `logs/bootstrap-initial.json` | close / keep open |
| `jinn-mono-l2zl.15.4.3` | terminal commands needed beyond `jinn run` = ? | `logs/jinn-run-startup.log` | close / keep open |
| `jinn-mono-l2zl.15.4.4` | fresh-DB startup error = ? | `logs/jinn-run-startup.log` | close (with note that legacy-DB regression is covered by shipped test) / keep open |
| `jinn-mono-l2zl.15.4.5` | dev-env leakage in startup = ? | `logs/jinn-run-startup.log` | close / keep open |
| `jinn-mono-l2zl.15.4.6` | live auth probe after in-app install = ? | `logs/auth-claude-{initial,post-install}.json` + screenshots | close / keep open |
| `jinn-mono-l2zl.15.4.7` | first-boot `/v1/bootstrap` chain = ? | `logs/bootstrap-initial.json` | close (clean HOME N/A; regression test covers upgrade) / keep open |
| `jinn-mono-uy6v.4.1` | RetiredManifest under degraded catalog = ? | `browser/11-operator-joined-healthy.png` (+ optional degraded screenshot) | close / keep open / downgrade |
| `jinn-mono-uy6v.4` (parent) | first Solution settled on-chain = ? | `onchain/settlement.txt` | close / keep open |

---

## Phase 7 — Closeout

### Task 7.1: Draft per-bead close-reasons

For each child marked `close` in the matrix, draft a close-reason like:

> Verified fixed in `@jinn-network/client@0.1.5` via cleanroom walkthrough on YYYY-MM-DD.
> Evidence: `client/acceptance-runs/<RUN_TS>-uy6v4-cleanroom/<files>`.
> [Specific observed behavior, e.g., "First-boot `/v1/bootstrap` returned chain=base-sepolia with no config.json present; default resolved to testnet."]

Save drafts to `${RUN_DIR}/bd-notes/close-reasons.md` before mutating any state.

### Task 7.2: Close in bd

For each bead in the close set:

- [ ] **Step 1: Add the close-reason as a note**

```bash
bd update <bd-id> --notes "Close-reason: <drafted text from close-reasons.md>"
```

- [ ] **Step 2: Close the bead**

```bash
bd close <bd-id>
bd show <bd-id> | grep -E "Status|Updated"
```

Expected: status `closed`.

### Task 7.3: Close mirrored GitHub Issues

For each bead with an `External:` URL (mirrored to GitHub), close the GH issue manually — `bd close` does **not** propagate per the user's instruction.

- [ ] **Step 1: Look up the GH issue number per bead**

```bash
for id in <closed-bd-ids>; do
  bd show "${id}" | grep External | head -1
done
```

- [ ] **Step 2: Close each GH issue**

```bash
gh issue close <issue-number> --reason completed --comment "$(cat <<'EOF'
Verified fixed in @jinn-network/client@0.1.5 via cleanroom walkthrough on YYYY-MM-DD.

Evidence: client/acceptance-runs/<RUN_TS>-uy6v4-cleanroom/.

<specific observed behavior>

Internal tracking: jinn-mono-<id>
EOF
)"
```

### Task 7.4: Refile any remaining failures as fresh beads

For each bead in the matrix marked `keep open`:

- [ ] **Step 1: File a fresh bead under `uy6v.4` with the specific repro shape**

```bash
bd create \
  --title "<specific failure shape from walkthrough>" \
  --description "$(cat <<'EOF'
**Context**

During the jinn-mono-uy6v.4 cleanroom walkthrough on YYYY-MM-DD against @jinn-network/client@0.1.5:

<observed shape>

**Reproduction**

<minimal repro steps>

**Evidence**

client/acceptance-runs/<RUN_TS>-uy6v4-cleanroom/<files>

**Impact**

<blocking / partial / cosmetic>

**Related**

Originally surfaced via jinn-mono-<original-bd-id> (now superseded by this fresh repro).
EOF
)" \
  --type=bug \
  --priority=1
```

Then optionally mirror via `cargo/scripts/bd-mirror <new-bd-id> <sprint-date>` if the team wants public visibility.

### Task 7.5: Close (or update) the parent `uy6v.4`

Two paths:

**Path A: full walkthrough succeeded, first Solution settled.**

- [ ] **Step 1: Close `uy6v.4` with the evidence bundle**

```bash
bd update jinn-mono-uy6v.4 --notes "$(cat <<'EOF'
Verified end-to-end on YYYY-MM-DD against @jinn-network/client@0.1.5.

Evidence bundle: client/acceptance-runs/<RUN_TS>-uy6v4-cleanroom/

Acceptance criteria:
- ✅ Clean-machine `npm install -g @jinn-network/client@latest` + `jinn run` with no manual config: logs/jinn-run-startup.log
- ✅ Dashboard auto-opened / URL printed clearly: logs/jinn-run-startup.log line N
- ✅ Joined canonical SWE-rebench v2 from /operator Discover: browser/08-join-config.png, browser/10-operator-after-restart.png
- ✅ First Solution settled on chain: onchain/settlement.txt
- ✅ Documented walkthrough retained as release evidence: this evidence dir + bd-notes/verification-matrix.md

Closed children: <list>
Refiled / kept open: <list>
EOF
)"
bd close jinn-mono-uy6v.4
gh issue close 160 --reason completed --comment "<same as above>"
```

This ticks v1 release definition item 6 (operator install path) for the `uy6v` epic.

**Path B: walkthrough succeeded up to a specific blocker (e.g., couldn't settle within the window).**

- [ ] **Step 1: Update `uy6v.4` with partial evidence and the remaining blocker**

```bash
bd update jinn-mono-uy6v.4 --notes "$(cat <<'EOF'
Cleanroom walkthrough on YYYY-MM-DD against @jinn-network/client@0.1.5 verified the install path through <last successful phase> but did not reach first-Solution-settled.

Blocker: <specific shape — e.g., "canonical SolverNet had no second/third evaluator online during the verification window">

Evidence bundle: client/acceptance-runs/<RUN_TS>-uy6v4-cleanroom/
Refiled blocker: jinn-mono-<new-id>
Closed children: <list>

Re-run this walkthrough after the blocker clears to complete the acceptance.
EOF
)"
# Leave uy6v.4 open.
```

### Task 7.6: Commit and push the evidence bundle

- [ ] **Step 1: Stage and commit the evidence run**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo
git add "${RUN_DIR}"
git status
git commit -m "$(cat <<'EOF'
docs(acceptance): uy6v.4 cleanroom walkthrough evidence

Captures fresh-HOME npm-install → joined SolverNet → solve → (settle if reached)
walkthrough against @jinn-network/client@0.1.5, verifying nine P1 children
of jinn-mono-uy6v.4. See bd-notes/verification-matrix.md for the per-bead
decisions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: Hold the push until Phase 8 cleanup is done**

Do **not** push yet. Phase 8 (cleanup) may produce an additional commit (e.g., to record sweep tx hashes alongside the evidence). Bundle commits before pushing once at the end of Phase 8.

---

## Phase 8 — Cleanup

The walkthrough leaves several artifacts on the verification machine that should be cleaned up so the cleanroom is genuinely transient:

- A running daemon process holding API port 7333 + loops.
- `${CLEAN_HOME}/.jinn-client/` containing an encrypted keystore, autogen password file, SQLite db, installed Claude binary (~hundreds of MB), and possibly a SWE-rebench V2 upstream clone (~1+ GB).
- A funded Base Sepolia EOA + Safe (testnet ETH + testnet-JINN + a staked service bond).
- A globally installed `@jinn-network/client` from `npm install -g` that didn't exist on this machine before Phase 1.
- A signed-in Claude (or Codex) session that ties the cleanroom's HOME to the operator's account.

Order matters: kill the daemon first (so loops don't auto-top-up after we sweep), then sweep funds, then archive secrets / remove the cleanroom dir, then uninstall the global package, then push.

### Task 8.1: Shut the daemon down cleanly

- [ ] **Step 1: Stop the daemon via Ctrl-C in its terminal**

Watch for clean shutdown — the loops should report "stopped" in `${RUN_DIR}/logs/jinn-run-after-join.log`. If the process hangs > 30s, escalate to `kill <pid>` (NOT `kill -9`) so the SQLite db closes cleanly.

- [ ] **Step 2: Confirm port 7333 is released**

```bash
lsof -iTCP:7333 -sTCP:LISTEN | tee "${RUN_DIR}/logs/port-7333-after-shutdown.txt"
```

Expected: empty output (no listener). If something else is still bound, identify and stop it before proceeding.

### Task 8.2: Sign out of the harness (revoke OAuth)

- [ ] **Step 1: Revoke the Claude session bound to the cleanroom HOME**

The signed-in Claude (or Codex) auth in `${CLEAN_HOME}/.jinn-client/tools/claude-code/...` ties the operator's account to a directory we're about to delete. Revoke server-side before delete:

```bash
# For Claude Code: the in-app sign-out or `claude logout` against the installed binary.
env HOME="${CLEAN_HOME}" "${CLEAN_HOME}/.jinn-client/tools/claude-code/node_modules/.bin/claude" logout || \
  echo "(claude binary already gone or never installed — skipping)"
```

If the harness was Codex, swap the binary path. Capture the revocation outcome in `${RUN_DIR}/logs/harness-logout.txt`.

> If the harness has no programmatic logout, sign out from the account's web dashboard (claude.ai → settings → revoke device, or equivalent) and note that in the log.

### Task 8.3: Sweep on-chain funds back (optional but kind)

Goal: return testnet ETH + testnet-JINN to a faucet-friendly sink so the next operator's faucet capacity isn't burned. **This is optional — if you skip it, document why in `${RUN_DIR}/logs/sweep-skipped.md`.**

- [ ] **Step 1: Read the EOA + Safe balances**

```bash
EOA_ADDR=$(jq -r '.agentEoa' "${RUN_DIR}/logs/bootstrap-awaiting-funding.json")
SAFE_ADDR=$(jq -r '.safeAddress' "${RUN_DIR}/logs/bootstrap-awaiting-funding.json")
RPC="https://sepolia.base.org"
JINN_TOKEN="0x4F177E56bd79c169742a1BF8907dB0A5e54F5524"

# ETH balances
cast balance --rpc-url "${RPC}" "${EOA_ADDR}" | tee "${RUN_DIR}/onchain/sweep-pre-eoa-eth.txt"
cast balance --rpc-url "${RPC}" "${SAFE_ADDR}" | tee "${RUN_DIR}/onchain/sweep-pre-safe-eth.txt"
# Testnet-JINN balance on Safe
cast call --rpc-url "${RPC}" "${JINN_TOKEN}" "balanceOf(address)(uint256)" "${SAFE_ADDR}" | tee "${RUN_DIR}/onchain/sweep-pre-safe-jinn.txt"
```

- [ ] **Step 2: Decide sink wallet**

Pick a sink address you control on Base Sepolia (e.g., the operator's regular Base Sepolia EOA, or a known team sink). Record it in `${RUN_DIR}/logs/sweep-sink.txt` with a one-line rationale.

- [ ] **Step 3: Unstake the service so the JINN bond returns to the Safe**

The Phase 1a staking contract holds a 10 testnet-JINN bond. Calling `unstake` (or the dashboard's equivalent affordance, if exposed) returns it. If the staking contract has a minimum-stake-duration enforcement that hasn't elapsed, the bond stays locked — note in `${RUN_DIR}/logs/sweep-skipped.md` and move on; don't burn time waiting for the lockup.

- [ ] **Step 4: Sweep testnet-JINN from the Safe to the sink**

The Safe owns the JINN. Either:
- (a) Submit a Safe transaction transferring JINN to the sink via the Safe UI or `cast` against the Safe's `execTransaction`, OR
- (b) Skip if the operator workflow doesn't expose a clean Safe-tx path outside the daemon — note the skip.

Record the tx hash in `${RUN_DIR}/onchain/sweep-jinn-tx.txt`.

- [ ] **Step 5: Sweep ETH from the EOA and Safe**

```bash
# EOA: direct send (we control the key in ${CLEAN_HOME}/.jinn-client/keystore)
# This is the trickier one — the keystore is encrypted; decrypt with the password file.
# Skip if there's no clean CLI affordance and document the skip.
echo "Manual ETH sweep — document tx hashes in onchain/sweep-eth-*.txt or document skip in logs/sweep-skipped.md"
```

> Pragmatic call: if sweep takes more than ~15 minutes of fiddling, **skip it**. Testnet ETH on Base Sepolia is essentially free; the JINN faucet is the only constrained resource. Sweeping JINN (Step 4) matters more than sweeping ETH (Step 5).

### Task 8.4: Archive secrets, then delete `${CLEAN_HOME}`

- [ ] **Step 1: Move the cleanroom keystore + password out of `/tmp` into the evidence dir as encrypted-only**

The keystore is encrypted, but the keystore-password file is plaintext alongside it. Don't commit either — instead, move them to a local archive (outside the repo) in case post-walkthrough debugging needs the cleanroom wallet:

```bash
ARCHIVE_DIR="${HOME}/jinn-cleanroom-archives/${RUN_TS}"
mkdir -p "${ARCHIVE_DIR}"
# Copy (not move) so a partial archive doesn't lose the originals.
cp -r "${CLEAN_HOME}/.jinn-client/master_keystore.json" \
      "${CLEAN_HOME}/.jinn-client/keystore-password" \
      "${CLEAN_HOME}/.jinn-client/earning/earning_state.json" \
      "${ARCHIVE_DIR}/" 2>/dev/null || echo "(some files missing — expected if cleanroom didn't reach bootstrap)"
ls "${ARCHIVE_DIR}"
echo "Archived to ${ARCHIVE_DIR} (not committed — outside the repo)"
```

Record the archive path in `${RUN_DIR}/logs/cleanroom-archive.txt`. The archive is for your local recovery only; do **not** commit it.

- [ ] **Step 2: Confirm `${CLEAN_HOME}` is the path you think it is**

```bash
echo "About to delete: ${CLEAN_HOME}"
test -d "${CLEAN_HOME}" && echo "OK: dir exists"
[[ "${CLEAN_HOME}" == /tmp/jinn-cleanroom-* ]] && echo "OK: path matches /tmp/jinn-cleanroom-* shape" || { echo "FAIL: clean HOME path doesn't match expected shape — aborting delete"; exit 1; }
```

Expected: both `OK` lines print. If the path-shape check fails, **stop** and investigate — never delete something outside `/tmp/jinn-cleanroom-*`.

- [ ] **Step 3: Delete the cleanroom dir**

```bash
rm -rf "${CLEAN_HOME}"
test ! -e "${CLEAN_HOME}" && echo "OK: ${CLEAN_HOME} removed"
```

Expected: dir gone.

### Task 8.5: Uninstall the global `@jinn-network/client`

- [ ] **Step 1: Confirm the global install was added by Phase 1, not pre-existing**

```bash
npm ls -g --depth=0 2>&1 | grep -E "jinn-network/client|jinn" || echo "no jinn install found globally"
```

If `@jinn-network/client` was pre-installed before the walkthrough (e.g., from the operator's day-to-day), **leave it** — don't undo a state we didn't create. Document in `${RUN_DIR}/logs/global-uninstall-skipped.md`.

Otherwise:

```bash
npm uninstall -g @jinn-network/client 2>&1 | tee "${RUN_DIR}/logs/npm-uninstall.log"
which jinn || echo "OK: jinn no longer on PATH"
```

Expected: `jinn` no longer resolves.

### Task 8.6: Final commit (sweep evidence) and push

- [ ] **Step 1: Commit any additions to `${RUN_DIR}` since Task 7.6**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo
git status "${RUN_DIR}"
git add "${RUN_DIR}"
git diff --cached --stat
# If there are changes, commit them.
git commit -m "$(cat <<'EOF'
docs(acceptance): uy6v.4 cleanroom walkthrough — sweep + cleanup evidence

Adds Phase 8 cleanup artifacts: harness logout, optional fund sweep tx
hashes (or skip rationale), cleanroom dir teardown confirmation, global
npm uninstall log.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)" || echo "(no changes — Phase 8 produced no new evidence)"
```

- [ ] **Step 2: Push per CLAUDE.md session-completion protocol**

```bash
git pull --rebase
bd dolt push
git push
git status   # MUST show "up to date with origin"
```

Expected: `up to date with origin/main`. The walkthrough is complete only when this prints.

---

## Self-review checklist (before execution)

1. **Spec coverage:** every requirement in the user's prompt section "What I want from you" is covered:
   - Plan first, execute second — ✅ structured as Phases 0-8 with explicit checkpoints.
   - Clean HOME provisioning — ✅ Task 0.2.
   - Funding minimums + faucet pointer — ✅ Task 0.3 + Task 2.2 reference `0.005 ETH` / `0.002 ETH` / `10 testnet-JINN`.
   - npm install + `jinn run` in clean HOME — ✅ Tasks 1.1-1.2 with explicit env-prefix.
   - Browser walkthrough through bootstrap → harness auth → join → claim → solve → settle — ✅ Phases 2-5.
   - Per-child evidence — ✅ matrix in Phase 6.
   - Decision tree (close vs refile) — ✅ in Phase 7.
   - bd close + GH issue close — ✅ Tasks 7.2 + 7.3.
   - Close parent on full success — ✅ Task 7.5 Path A.
   - Refile failures — ✅ Task 7.4.
   - Cleanup (kill daemon, sweep funds, archive secrets, delete cleanroom dir, uninstall global npm package) — ✅ Phase 8.

2. **Placeholder scan:** the only `<placeholder>` tokens are intentional runtime values (timestamp, bd IDs from execution, addresses, tx hashes). No TODOs.

3. **Type consistency:** bead IDs are spelled identically throughout. Manifest CID, port (`7333`), HOME path (`${CLEAN_HOME}`), and evidence root (`${RUN_DIR}`) are consistent.

4. **Scope discipline:** the plan only verifies the install path and the nine children. Reward observation, multi-operator, and UX-nits epics are explicitly excluded per the user's "out of scope" section.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-operator-install-path-walkthrough.md`.

This plan is **operational, not TDD** — Phases 0-5 are live observation against the published artifact, Phases 6-7 are closeout. Inline execution (one phase at a time with checkpoints between) is the right shape; subagent-driven would fragment the live state across separate processes and lose the running daemon.

**Recommended next step:** Captain reviews this plan, then execute Phase 0 inline. Pause after Phase 0 to confirm the evidence-dir layout and clean-HOME provisioning look right before moving to Phase 1 (which is the first phase that touches the published artifact and on-chain funding).
