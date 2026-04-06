---
name: jinn-node-railway-deploy
description: Deploy a jinn-node worker to Railway with volume mount, credential import, and health verification. Use when user says "deploy to Railway", "railway setup", "deploy worker", "run on Railway", or "move to cloud". Requires local setup complete first.
allowed-tools: Bash, Read, Edit, Write, Glob
user-invocable: true
metadata:
  author: Jinn Network
  version: 1.0.0
  openclaw:
    requires:
      bins: [railway, tar]
      railway_min_version: "4.16.0"
    primaryEnv: OPERATE_PASSWORD
    source: https://github.com/Jinn-Network/jinn-node
---

# jinn-node-railway-deploy

Deploy a `jinn-node` worker to Railway using the standalone `jinn-node` runtime contract.

Use this skill only **after local setup is complete** and `.operate/` exists with a working service.

## When to use

Use this skill when the user asks to:
- deploy a worker to Railway,
- migrate a locally configured operator node to Railway,
- run canary worker validation with a canary `X402_GATEWAY_URL`.

Do not use this skill for local-only setup (`yarn setup`, local worker loops).

## Workflow

Run the deploy script from `jinn-node/`:

```bash
cd jinn-node
bash scripts/deploy-railway.sh --project <name> [--service <name>]
```

Both `--project` and `--service` are "upsert" — links to existing if found, creates if not.

### Options

| Flag | Description |
|------|-------------|
| `--project <name>` | Railway project name or ID (required unless already linked) |
| `--service <name>` | Service name (default: `jinn-worker`) |
| `--skip-import` | Skip `.operate/.gemini` SSH import (for re-deploys) |
| `--dry-run` | Preview commands without executing |
| `--help` | Show usage |

### Examples

```bash
# First-time deploy
bash scripts/deploy-railway.sh --project jinn-worker

# Deploy with custom service name
bash scripts/deploy-railway.sh --project jinn-shared --service canary-worker

# Re-deploy (credentials already on volume)
bash scripts/deploy-railway.sh --project jinn-worker --skip-import

# Preview
bash scripts/deploy-railway.sh --project jinn-worker --dry-run
```

### What the script does

1. Validates preconditions (`.operate/`, `.env`, Railway CLI >= 4.16.0, auth)
2. Links or creates Railway project + service
3. Creates persistent volume at `/home/jinn`
4. Reads `.env` and pushes all non-empty variables to Railway (batched, `--skip-deploys`)
5. First-time only: deploys idle container (`tail -f /dev/null`), imports `.operate/` (on-chain keys, wallets) and `.gemini/` (LLM OAuth tokens) via SSH, then restores real start command
6. Deploys the worker
7. Verifies deployment and shows recent logs

### Canary validation

For canary rollout:
1. Set `X402_GATEWAY_URL` to canary gateway and `WORKSTREAM_FILTER` to canary workstream in `.env`
2. Deploy with the script
3. Validate tool/business success
4. Promote: update `.env` with prod gateway URL, re-deploy with `--skip-import`

## Credential bridge

Workers do **not** carry third-party API keys (Twitter, Umami, Supabase, etc.). Instead:

- **On-chain identity** (`.operate/`): Contains private keys, wallets, and service configs. Imported to volume at `/home/jinn/.operate`. Used for ERC-8128 signed HTTP requests to the Control API.
- **LLM auth** (`.gemini/`): Contains Gemini CLI OAuth tokens. Imported to `/home/jinn/.gemini`. Alternatively, set `GEMINI_API_KEY` in `.env`.
- **Third-party credentials**: Served at runtime by the credential bridge at `X402_GATEWAY_URL`. The worker probes the bridge at startup and on each job claim to discover which credential providers are available. No API keys in `.env`.
- **Configuration**: `jinn.yaml` (auto-generated on volume) contains service URLs, chain config, worker tuning, and feature flags. Secrets (RPC_URL, OPERATE_PASSWORD, GEMINI_API_KEY, GITHUB_TOKEN) stay in `.env`.

This means `.env` should contain only secrets and git identity — not infrastructure URLs or worker configuration.

## Runtime contract reminders

- Railway deployment is `.operate`-first (`/home/jinn/.operate`).
- `JINN_SERVICE_MECH_ADDRESS` and `JINN_SERVICE_SAFE_ADDRESS` are fallback overrides, not primary operator flow.
- Use `railway.toml` in the repo root.
- **Healthcheck port:** Railway auto-sets `PORT`. The worker reads `HEALTHCHECK_PORT` > `PORT` > `8080`. Do not set `PORT` manually.
- **Do NOT use `railway logs -f`** — in CLI 4.16+, `-f` is `--filter`, not "follow". Use `railway logs --lines N`.

## Failure handling

If deployment fails:

1. List deployments and identify the failed one:
   ```bash
   railway deployment list
   ```

2. Capture deployment-specific logs:
   ```bash
   railway logs --lines 300 <failed-deployment-id>
   ```

3. Confirm volume exists and is attached:
   ```bash
   railway volume list
   ```

4. Confirm `/home/jinn/.operate` and `/home/jinn/.gemini` are present:
   ```bash
   railway ssh -- 'ls -la /home/jinn/.operate /home/jinn/.gemini'
   ```

5. Verify `OPERATE_PASSWORD` matches local keystore.

6. Verify endpoint URLs and gateway mode (canary vs prod).

## References

- `references/variables.md` — full variable contract
- `references/volume-import.md` — manual SSH import steps (if script import fails)
