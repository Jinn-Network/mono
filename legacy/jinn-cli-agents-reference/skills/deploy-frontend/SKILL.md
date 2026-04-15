---
name: deploy-frontend
description: Deploy Jinn frontend apps to Vercel. Use when deploying the explorer, website, or other frontend projects, configuring Vercel environment variables, or troubleshooting frontend deployments.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# Deploy Jinn Frontends to Vercel

All frontend apps live under `frontend/` and deploy to Vercel under the `jinn-a6b5fa9d` org.

| App | Directory | Vercel Project | Production URL |
|-----|-----------|----------------|----------------|
| Explorer | `frontend/explorer/` | `jinn-explorer` | `https://explorer.jinn.network` |
| Website | `frontend/website/` | — | — |
| Gallery | `frontend/gallery/` | — | — |
| App | `frontend/app/` | — | — |

---

## General Vercel Gotchas

These apply to ALL frontend deployments.

### Setting env vars — NEVER pipe values

```bash
# CORRECT: Use heredoc (<<<) — no trailing characters
npx vercel env add MY_VAR production <<< 'https://example.com/key'

# WRONG: echo adds trailing newline, corrupts the value
echo "$VAR" | npx vercel env add MY_VAR production

# WRONG: printf can add 'n' character from \n interpretation
printf '%s' "$VAR" | npx vercel env add MY_VAR production
```

**Why:** `echo` appends `\n` which gets stored in the value. `printf '%s'` in some shells interprets `\n` and appends `n`. The corrupted URL causes `Failed to parse URL` or HTTP 401 errors at runtime. Always use `<<<` heredoc.

### CLI deploys fail with path doubling

Vercel projects have `rootDirectory` set (e.g., `frontend/explorer`). Running `npx vercel --prod` from the monorepo root doubles the path.

**Fix:** Don't use `vercel --prod` from the monorepo root. Instead:
- Push to git and let Vercel auto-deploy, OR
- Use `npx vercel redeploy <production-url>` to redeploy with fresh env vars

### Project link drift (`explorer` vs `jinn-explorer`)

There are multiple similarly named Vercel projects. If local linking points to `explorer` instead of `jinn-explorer`, builds fail with workspace package errors (for example `@jinn/shared-ui: Not found`).

**Check current link:**
```bash
cat frontend/explorer/.vercel/project.json
```

Expected:
- `projectName` should be `jinn-explorer`

Fix:
```bash
cd frontend/explorer
npx vercel link --project jinn-explorer --yes
```

### Workspace dependencies

All frontends depend on `@jinn/shared-ui` from the monorepo workspace. Vercel must install from the monorepo root. Each app's `vercel.json` sets `installCommand: "yarn install"` to handle this. If builds fail with unresolved workspace packages, verify the Vercel project root directory is set to the app subdirectory (not the monorepo root).

---

## Explorer (`frontend/explorer/`)

The explorer is the public-facing UI for browsing workstreams, jobs, staking state, and agent activity.

### Quick Deploy

```bash
# Via git push (preferred — auto-deploys)
git push origin main

# Via redeploy (picks up fresh env vars without code changes)
npx vercel redeploy https://explorer.jinn.network
```

### Environment Variables

#### Public Variables (in `vercel.json`)

Non-secret values baked into the client bundle at build time:

| Variable | Value | Purpose |
|----------|-------|---------|
| `NEXT_PUBLIC_SUBGRAPH_URL` | `https://indexer.jinn.network/graphql` | Ponder indexer endpoint |
| `NEXT_PUBLIC_X402_GATEWAY_URL` | `https://x402-gateway-production.up.railway.app` | x402 payment gateway |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://clnwgxgvmnrkwqdblqgf.supabase.co` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | (in vercel.json) | Supabase anon key (safe to expose) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | (in vercel.json) | WalletConnect/Reown project ID for vote page wallet connection |

#### Secret Variables (via `vercel env`)

| Variable | Purpose | Set Via |
|----------|---------|---------|
| `RPC_URL` | Tenderly Base RPC for on-chain reads (staking state, request counts) | `npx vercel env add RPC_URL production <<< 'https://base.gateway.tenderly.co/KEY'` |

**CRITICAL:** `RPC_URL` must be a Tenderly endpoint. NEVER use public RPCs. The code throws if `RPC_URL` is missing — it does not silently degrade.

```bash
# List all env vars
npx vercel env ls

# Add a secret (from frontend/explorer/ directory)
npx vercel env add RPC_URL production <<< 'https://base.gateway.tenderly.co/KEY'

# Remove a secret
npx vercel env rm RPC_URL production
```

### Ponder URL Migration

The Ponder indexer URL has been migrated to a stable domain. Old Railway URLs are dead.

| Status | URL |
|--------|-----|
| **Current** | `https://indexer.jinn.network/graphql` |
| Dead | `https://indexer.jinn.network/graphql` |
| Dead | `https://ponder-production-2e9e.up.railway.app/graphql` |

`NEXT_PUBLIC_SUBGRAPH_URL` must match in three places:
1. `frontend/explorer/vercel.json` (production builds)
2. `frontend/explorer/package.json` `dev` script (local dev)
3. Vercel project env vars (if set as override)

### RPC_URL and On-Chain Reads

The explorer makes server-side on-chain reads for:
- Staking contract state (`getStakingState()`, `getServiceIds()`)
- Request counts per mech
- Service registry lookups

Without `RPC_URL`:
- Staking state shows "unknown" (yellow badge) — the API does NOT lie about state when RPC is unavailable
- Request counts show "Request count unavailable"
- Any server component or API route that calls `viem` will fail

The `next.config.js` loads env vars from the monorepo root via `loadEnvConfig()` for local dev, but on Vercel the env var must be set through the dashboard or CLI.

### Local Dev

```bash
cd frontend/explorer

yarn dev              # Standard dev (production Ponder + x402 gateway)
yarn dev:local        # Dev with local Ponder instance
yarn dev:with-ponder  # Dev with Ponder co-started
```

The `yarn dev` script sets `NEXT_PUBLIC_SUBGRAPH_URL` inline. For `RPC_URL`, `next.config.js` calls `loadEnvConfig()` on the monorepo root, reading from the root `.env` file.

### Project Structure

| File | Purpose |
|------|---------|
| `frontend/explorer/vercel.json` | Vercel config: build/install commands, public env vars |
| `frontend/explorer/next.config.js` | Next.js config, loads root `.env` via `loadEnvConfig()` |
| `frontend/explorer/package.json` | Scripts, dependencies |

### Troubleshooting

#### Staking page shows wrong status / "Request count unavailable"

**Cause:** `RPC_URL` is missing, set to a public RPC, or has trailing characters.

**Fix:**
```bash
npx vercel env add RPC_URL production <<< 'https://base.gateway.tenderly.co/YOUR_KEY'
npx vercel redeploy https://explorer.jinn.network
```

Check Vercel function logs for `Failed to parse URL` or `Status: 401` — these indicate a corrupted env var value.

#### GraphQL queries return empty data or errors

**Cause:** `NEXT_PUBLIC_SUBGRAPH_URL` points to a dead Ponder URL.

**Fix:** Verify the URL in `frontend/explorer/vercel.json` is `https://indexer.jinn.network/graphql`. Check for Vercel-level overrides:
```bash
npx vercel env ls
npx vercel env rm NEXT_PUBLIC_SUBGRAPH_URL production  # if override exists
```

#### Preview deploys show stale data

Preview deploys use production env vars unless overridden:
```bash
npx vercel env add NEXT_PUBLIC_SUBGRAPH_URL preview
```

#### Local dev shows "RPC_URL not configured"

Ensure the monorepo root `.env` file contains `RPC_URL`. The `next.config.js` loads it via:
```js
loadEnvConfig(path.resolve(__dirname, '..', '..'));
```
This resolves to the monorepo root, not `frontend/explorer/`.
