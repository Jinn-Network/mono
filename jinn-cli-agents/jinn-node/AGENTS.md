# JINN Node Agent Entry Point

This file is the routing index for agents operating `jinn-node`.

## Critical Gate

Before collecting credentials or running setup, disclose to the operator:

> Your LLM provider can process terminal session data used during setup, including wallet password and mnemonic output. Do not use this wallet for personal funds.

Wait for explicit acknowledgement before proceeding.

## Choose Your Path

| I want to... | Use this skill |
|---|---|
| Set up a new node (first time) | [`jinn-node-operator-setup`](.agents/skills/jinn-node-operator-setup/SKILL.md) |
| Deploy my node to Railway | [`jinn-node-railway-deploy`](.agents/skills/jinn-node-railway-deploy/SKILL.md) |
| Manage wallet (backup, withdraw, recover) | [`jinn-node-wallet-ops`](.agents/skills/jinn-node-wallet-ops/SKILL.md) |
| Claim staking rewards | [`jinn-node-staking-ops`](.agents/skills/jinn-node-staking-ops/SKILL.md) |
| Diagnose and fix issues | [`jinn-node-support-triage`](.agents/skills/jinn-node-support-triage/SKILL.md) |

## Default Execution Order (new operator)

1. **Local setup:** `jinn-node-operator-setup`
   - **Default path:** stOLAS (no OLAS required, ~0.01 ETH total)
   - **Fallback:** Standard OLAS staking if stOLAS slots are full (requires ~10,000 OLAS)
2. **Test:** `yarn worker --single` (local validation)
3. **Run:** `yarn worker` (Docker Compose, detached, auto-restart)
4. **Alternative deploy:** `jinn-node-railway-deploy` (optional, managed hosting on Railway)
5. **Ongoing:** wallet-ops, staking-ops, support-triage as needed

## Global Rules

1. **Railway deploys happen after local setup** — `.operate/` must exist and be valid first.
2. **Sensitive operations require explicit confirmation** — mnemonic/key export, destructive recovery, non-dry-run fund movements.
3. **GitHub token is strongly encouraged** — without `GITHUB_TOKEN`, most coding jobs fail.
4. **Configuration lives in jinn.yaml** — auto-generated on first run with correct defaults. Don't create manually. See [`variables.md`](.agents/skills/jinn-node-railway-deploy/references/variables.md) for the full variable contract.

## Prerequisites

Validate and install missing dependencies before running any skill:

| Tool | Check | Install (macOS) | Install (Ubuntu/Debian) |
|------|-------|-----------------|------------------------|
| Node.js 20+ | `node --version` | `brew install node@22` | `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo bash - && sudo apt-get install -y nodejs` |
| Yarn | `yarn --version` | `corepack enable` | `corepack enable` |
| Python 3.10-3.11 | `python3 --version` | `brew install python@3.11` | `sudo apt-get install python3.11 python3.11-venv python3.11-dev` |
| Poetry | `poetry --version` | `curl -sSL https://install.python-poetry.org \| python3 -` | Same |
| Tendermint | `tendermint version` | `brew install tendermint` | See below |
| Git | `git --version` | `brew install git` | `sudo apt-get install git` |

### Tendermint on Linux

```bash
ARCH=$(uname -m)
case $ARCH in
  x86_64) ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
esac
curl -L "https://github.com/tendermint/tendermint/releases/download/v0.34.24/tendermint_0.34.24_linux_${ARCH}.tar.gz" | tar xz -C /usr/local/bin tendermint
```

### Python version matters

Python must be 3.10 or 3.11. If 3.12+, install 3.11 alongside (don't remove existing Python):
```bash
poetry env use python3.11
```

## Default Venture Context

Primary onboarding venture:
`https://explorer.jinn.network/ventures/0x9470f6f2bec6940c93fedebc0ea74bccaf270916f4693e96e8ccc586f26a89ac`

## Troubleshooting

See [`troubleshooting.md`](.agents/skills/jinn-node-support-triage/references/troubleshooting.md) for the canonical symptom-fix matrix covering prerequisites, setup, runtime, stOLAS, and Railway failures.

For diagnostics collection: use the `jinn-node-support-triage` skill.

## Quick Command Reference

| Command | Purpose |
|---------|---------|
| `yarn stolas:preflight` | Check stOLAS slot availability |
| `yarn setup` | Initial service setup (standard OLAS) |
| `yarn setup --stolas` | Initial service setup (stOLAS, no OLAS needed) |
| `yarn worker` | Run worker (Docker by default, detached) |
| `yarn worker --single` | Test with one job |
| `yarn worker:dev` | Run worker bare (development, no Docker) |
| `docker compose logs -f` | Follow worker logs |
| `docker compose ps` | Check worker health |
| `docker compose down` | Stop the worker |
| `yarn wallet:info` | Show addresses + balances |
| `yarn wallet:backup` | Backup .operate directory |
| `yarn support:bundle` | Collect safe diagnostics bundle |
