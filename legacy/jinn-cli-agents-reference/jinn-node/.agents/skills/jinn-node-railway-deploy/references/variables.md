# Railway Variables

Use this file when setting Railway environment variables for `jinn-node`.

**Architecture:** Secrets go in Railway variables (or `.env` on volume). Configuration goes in `jinn.yaml` on the persistent volume (auto-generated on first run with correct defaults).

**No third-party API keys needed.** Credentials for tools (Twitter, Umami, Supabase, etc.) are served at runtime by the credential bridge (`X402_GATEWAY_URL`). Workers only need on-chain keys (in `.operate/`) and the secrets below.

**Important:** When setting multiple variables, use `--skip-deploys` on each call to avoid triggering a redundant redeployment per variable. Deploy explicitly after all variables are configured.

```bash
railway variables --set "KEY=value" --skip-deploys
```

## Required Secrets

| Variable | Notes |
|---|---|
| `RPC_URL` | Base RPC endpoint |
| `OPERATE_PASSWORD` | Must decrypt `.operate` keystore |

## Strongly Recommended Secrets

| Variable | Notes |
|---|---|
| `GITHUB_TOKEN` | Needed for most code-task workflows |
| `GIT_AUTHOR_NAME` | Commit author identity |
| `GIT_AUTHOR_EMAIL` | Commit author identity |

## Optional Secrets

| Variable | Notes |
|---|---|
| `GEMINI_API_KEY` | If not using persisted Gemini CLI OAuth files |
| `WORKER_ID` | Distinct worker ID for logs/observability |
| `HEALTHCHECK_PORT` | Override healthcheck port (takes priority over Railway's `PORT`) |

**Note:** Railway auto-sets the `PORT` environment variable. The worker reads `HEALTHCHECK_PORT` > `PORT` > `8080` (default). Do not set `PORT` manually.

## Configuration (jinn.yaml on volume)

These are **NOT** Railway variables. They live in `jinn.yaml` on the persistent volume at `/home/jinn/jinn.yaml` (auto-generated on first run):

| YAML Path | Default | Description |
|-----------|---------|-------------|
| `chain.chain_id` | `8453` | Base mainnet |
| `services.ponder_url` | Jinn production | Shared Ponder GraphQL endpoint |
| `services.control_api_url` | Jinn production | Shared Control API endpoint |
| `staking.contract` | Jinn contract | Staking contract address |
| `worker.mech_filter_mode` | `single` | `staking` for production multi-operator |
| `worker.multi_service` | `false` | Set `true` for multiple `.operate/services` |
| `worker.poll_base_ms` | `30000` | Base polling interval |
| `worker.job_delay_ms` | `0` | Delay between job cycles |
| `worker.auto_restake` | `true` | Auto-restake evicted services |
| `filtering.workstreams` | `[]` | Restrict to specific workstreams |
| `filtering.earning_schedule` | `""` | Time window, e.g. `22:00-08:00` |
| `filtering.earning_max_jobs` | `0` | Max jobs per window (0 = unlimited) |
| `agent.sandbox` | `sandbox-exec` | Set `false` for Railway containers |

To edit on Railway:
```bash
railway shell
nano /home/jinn/jinn.yaml
```

Legacy env var overrides (e.g., `WORKSTREAM_FILTER`, `CHAIN_ID`, `GEMINI_SANDBOX`) also work if set as Railway variables, but prefer `jinn.yaml` for clarity.

## Canary -> Prod gateway switch

Update the X402 gateway URL in `.env` on the volume or as a Railway variable:

```bash
railway variables --set "X402_GATEWAY_URL=https://<prod-gateway-domain>"
railway up --detach
```
