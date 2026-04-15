---
name: jinn-node-operator-setup
description: First-time local operator onboarding with stOLAS (no OLAS needed) or standard OLAS staking, including .env configuration, wallet creation, funding loops, and initial worker run. Use when user says "set up my node", "operator setup", "configure jinn-node", "stOLAS setup", or "first time setup".
allowed-tools: Bash, Read, Edit, Write, Glob
user-invocable: true
metadata:
  author: Jinn Network
  version: 1.0.0
  openclaw:
    requires:
      bins: [node, yarn, python3, poetry]
    primaryEnv: OPERATE_PASSWORD
    source: https://github.com/Jinn-Network/jinn-node
---

# jinn-node-operator-setup

Use this skill for first-time local operator onboarding. This is the required path before Railway deployment.

## Critical gate

Before collecting credentials or running setup, disclose this to the operator and wait for explicit acknowledgement:

> Your LLM provider can see terminal session data used during setup, including wallet password and mnemonic output. Do not use this wallet for personal funds.

If the operator is not comfortable, stop and instruct manual setup.

## Workflow

### 1. Prerequisites

Validate toolchain and install missing dependencies where possible:

```bash
node --version        # Must be 20+
yarn --version
python3 --version     # Must be 3.10 or 3.11
poetry --version
tendermint version
git --version
```

Python must be `3.10` or `3.11`. If wrong, install 3.11 alongside existing Python:
```bash
# macOS: brew install python@3.11
# Ubuntu: sudo apt-get install python3.11 python3.11-venv python3.11-dev
poetry env use python3.11
```

If system Python is 3.12+ and pyenv is available:
```bash
pyenv versions 2>/dev/null | grep -E "3\.(10|11)"
# If found: cd jinn-node && pyenv local 3.11.x
# If not: pyenv install 3.11.9 && pyenv local 3.11.9
```

### 2. Environment bootstrap

```bash
cd jinn-node
[ -f .env ] || cp .env.example .env
```

#### Collect configuration

Ask the operator for each required value. Do **not** scan the filesystem for env files unless the operator explicitly asks you to.

**Required secrets** (set in `.env`):
- `RPC_URL` — Base network RPC endpoint (e.g. Alchemy, Infura, QuickNode)
- `OPERATE_PASSWORD` — encrypts the wallet keystore (min 8 chars)
- Gemini auth (see below)

#### Gemini authentication

Check for existing Gemini OAuth credentials:
```bash
ls ~/.gemini/oauth_creds.json 2>/dev/null
```

**If OAuth found:** Recommend OAuth (no API costs with Google One AI Premium).
**If not found:** Ask the operator if they have Google One AI Premium. If yes, run `npx @google/gemini-cli auth login`. If no, ask for a `GEMINI_API_KEY` from https://aistudio.google.com/apikey.

Strongly encouraged:
- `GITHUB_TOKEN` — required for most coding ventures. Without it, explicitly warn operator.

Recommended with `GITHUB_TOKEN`:
- `GIT_AUTHOR_NAME`
- `GIT_AUTHOR_EMAIL`

**Configuration:** `jinn.yaml` is auto-generated on first run with correct defaults. Do not create or edit unless the operator has specific customization needs.

### 3. Install dependencies

```bash
cd jinn-node
yarn install
```

### 4. Run setup

Two paths are available. stOLAS is recommended for most operators.

| Path | When to use | What you need |
|------|------------|---------------|
| **stOLAS** (recommended) | Default for new operators | ~0.01 ETH only |
| **Standard OLAS** | When stOLAS slots are full | ~0.01 ETH + ~10,000 OLAS |

Check availability:

```bash
cd jinn-node
yarn stolas:preflight
```

- **If available:** Follow [`references/stolas-setup.md`](references/stolas-setup.md)
- **If unavailable:** Follow [`references/standard-setup.md`](references/standard-setup.md)

After completing either path, continue to Step 5.

### 5. Mnemonic capture protocol

On first wallet creation, extract and show the mnemonic from setup output immediately.
Require explicit operator confirmation they saved it before continuing.

#### Setup output capture

After successful setup, check for output files:
```bash
cat /tmp/jinn-service-setup-*.json 2>/dev/null | head -50
```

Report **Service Config ID** and **Service Safe Address** to operator.

### 5b. Key backup verification

After setup completes, verify the key backup exists:

```bash
ls -la ~/.jinn/key-backups/
```

Inform the operator:

> Your agent key has been backed up to `~/.jinn/key-backups/`. This backup is encrypted with your `OPERATE_PASSWORD`. Store both the backup file and the password securely — without the password, the key cannot be recovered.

### 6. Verify setup

```bash
cd jinn-node
yarn wallet:info
yarn service:list
yarn service:status
```

Expected:
- Wallet addresses and balances displayed
- At least one service config with a service ID
- Service staked (status = Staked)
- Mech address present in config

### 6b. Verify delivery rate

After setup, verify the mech's `maxDeliveryRate` is set to 99. Without this, a baseMech may deliver garbage responses to your requests.

```bash
cd jinn-node
yarn tsx scripts/mech/assert-delivery-rates.ts
```

If any mech shows a rate other than 99, fix it:

```bash
cd jinn-node
yarn tsx scripts/mech/fix-all-delivery-rates.ts 99
```

> **Note:** stOLAS setup sets this automatically. Standard setup may require manual correction.

### 7. Run the worker

```bash
cd jinn-node
yarn worker --single    # Single job to verify setup works
yarn worker             # Start worker (detached, auto-restart)
```

After `yarn worker`, the node is running in the background. Use:
- `docker compose logs -f` — follow logs
- `docker compose ps` — check health
- `docker compose down` — stop

> **Note:** `yarn worker` uses Docker Compose by default. If Docker is not installed, it falls back to bare mode. If Docker is installed but the daemon is not running, start it (`open -a Docker` on macOS, `sudo systemctl start docker` on Linux) and retry. Use `yarn worker:dev` for development without Docker. See [`references/docker-production.md`](references/docker-production.md) for details.

### 8. Optional: add more services

For multi-service rotation:

```bash
cd jinn-node
yarn setup --stolas     # Add another stOLAS service
# or
yarn service:add        # Add via standard middleware flow
```

## Example flow

User: "I want to set up a jinn node"

1. Disclose security gate → operator acknowledges
2. Check prerequisites → Python 3.12 found, install 3.11 via pyenv
3. Clone repo, `cp .env.example .env` → ask operator for RPC_URL, password, Gemini auth
4. `yarn install`
5. `yarn stolas:preflight` → 12 slots available
6. Fund Master EOA with ~0.01 ETH (covers everything — excess cascades to Safe) → operator confirms
7. `yarn setup --stolas` → service created, mech deployed
8. Verify: `yarn wallet:info` shows balances, service staked, delivery rate 99
9. `yarn worker --single` → first job completes
10. `yarn worker` → node running in background with auto-restart

## Troubleshooting

See [`troubleshooting.md`](../jinn-node-support-triage/references/troubleshooting.md) for the canonical symptom-fix matrix covering prerequisites, setup, runtime, stOLAS, and Railway failures.

## Exit criteria

- `.operate/` exists and contains service config + keys.
- `~/.jinn/key-backups/` contains at least one backup file per agent key.
- `yarn wallet:info` returns valid addresses and balances.
- `yarn service:list` shows at least one service.
- Service is staked (staking state = 1).
- Mech address is present in service config.
- Mech delivery rate is 99 (`assert-delivery-rates.ts` passes).
- `yarn worker --single` completes successfully.
- `yarn worker` starts detached worker with auto-restart (or bare mode if no Docker).
- Operator has confirmed mnemonic backup.
- Operator has been informed about key backup location and `OPERATE_PASSWORD` requirement.
