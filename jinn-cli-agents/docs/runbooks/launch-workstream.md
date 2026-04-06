---
title: Launch Workstream
purpose: runbook
scope: [worker, deployment]
last_verified: 2026-01-30
related_code:
  - scripts/launch_workstream.ts
  - gemini-agent/mcp/tools/dispatch_new_job.ts
  - worker/worker_launcher.ts
  - worker/orchestration/jobRunner.ts
  - services/x402-gateway/index.ts
keywords: [launch, workstream, dispatch, template, blueprint, x402]
when_to_read: "Use when starting a new workstream, testing a blueprint, or debugging workstream launch failures"
---

# Launch Workstream

How to dispatch the first job in a new workstream.

## Running the Worker

Before launching workstreams, ensure the worker is running:

```bash
# Local development
yarn worker

# With multiple parallel workers
WORKER_COUNT=3 yarn worker

# With custom worker ID
WORKER_ID=my-worker yarn worker
```

The worker launcher (`worker/worker_launcher.ts`) handles:
- Spawning worker processes
- Health check server on port 8080
- Graceful shutdown on SIGTERM/SIGINT
- Auto-restart on unexpected exits

**Railway deployment**: Uses `WORKER_COUNT` env var for parallel workers.

---

## Quick Start: Via Script

The simplest way to launch a workstream from a blueprint:

```bash
yarn launch:workstream <blueprint-name> [options]
```

### Examples

```bash
# Launch a template with venture-specific config
yarn launch:workstream blog-growth-template --input configs/the-lamp.json

# Launch from blueprints/my-venture.json (no config substitution)
yarn launch:workstream my-venture

# Use existing repo instead of creating new one
yarn launch:workstream my-venture --repo=owner/repo-name

# Enable cyclic (continuous) operation
yarn launch:workstream my-venture --cyclic

# Dry run to see what would happen
yarn launch:workstream blog-growth-template --input configs/the-lamp.json --dry-run

# Inject additional environment variables
yarn launch:workstream my-venture --env API_KEY=secret --env DEBUG=true
```

### Using Configs with Templates

Blueprints can define `{{variable}}` placeholders that get filled from a config file. This separates reusable template logic from venture-specific settings.

**Blueprint** (`blueprints/blog-growth-template.json`):
```json
{
  "templateMeta": {
    "inputSchema": {
      "properties": {
        "blogName": { "type": "string" },
        "mission": { "type": "string" },
        "domain": { "type": "string", "envVar": "BLOG_DOMAIN" }
      }
    }
  },
  "invariants": [
    {
      "id": "GOAL-MISSION",
      "condition": "Align content with mission: {{mission}}"
    }
  ]
}
```

**Config** (`configs/the-lamp.json`):
```json
{
  "blogName": "The Lamp",
  "mission": "Establish Jinn as the thought leader...",
  "repoUrl": "git@ritsukai:Jinn-Network/blog-the-lamp.git",
  "sshHost": "ritsukai",
  "domain": "blog.jinn.network"
}
```

**Launch with config**:
```bash
yarn launch:workstream blog-growth-template --input configs/the-lamp.json
```

The script:
1. Loads blueprint from `blueprints/blog-growth-template.json`
2. Substitutes `{{variable}}` placeholders with config values
3. Auto-extracts `repoUrl` from config for the `--repo` flag
4. Maps `envVar` fields (like `BLOG_DOMAIN`) to environment variables
5. Uses `sshHost` for SSH host alias if configured

### Script Options

| Option | Description |
|--------|-------------|
| `--input` | Path to config file for variable substitution (e.g., `configs/the-lamp.json`) |
| `--dry-run` | Print what would happen without executing |
| `--model` | Specify model (default: gemini-2.5-flash) |
| `--repo` | Use existing repo (e.g., "owner/repo"). Auto-extracted from config's `repoUrl` if not provided |
| `--cyclic` | Enable continuous operation (auto-redispatch) |
| `--skip-repo` | Skip GitHub repo creation (artifact-only mode) |
| `--context` | Additional context string to inject |
| `--env` | Environment variables (KEY=VALUE format, repeatable) |
| `--workspace-repo` | Repository URL to clone as workspace for the agent |

---

## Alternative: Via Agent Tool

## Prerequisites

- [ ] Worker running (`yarn worker` or see `setup-worker.md`)
- [ ] Mech service funded with OLAS/ETH
- [ ] `MECH_TO_CONFIG` environment variable set with target mech address
- [ ] Service private key available in `.operate/keys/`

## Blueprint Structure

Blueprint must be a JSON string with an `invariants` array. Each invariant requires:

| Field | Description |
|-------|-------------|
| `id` | Unique identifier (e.g., "QUAL-001") |
| `type` | One of: `FLOOR`, `CEILING`, `RANGE`, `BOOLEAN` |
| `assessment` | How to verify/measure (min 10 chars) |

### Type-Specific Fields

| Type | Required Fields | Meaning |
|------|-----------------|---------|
| `FLOOR` | `metric`, `min` | metric >= min |
| `CEILING` | `metric`, `max` | metric <= max |
| `RANGE` | `metric`, `min`, `max` | min <= metric <= max |
| `BOOLEAN` | `condition` | condition must be true |

### Example Blueprint

```json
{
  "invariants": [
    {
      "id": "QUAL-001",
      "type": "FLOOR",
      "metric": "content_quality_score",
      "min": 70,
      "assessment": "Rate 0-100 based on originality and depth"
    },
    {
      "id": "BUILD-001",
      "type": "BOOLEAN",
      "condition": "Build passes without errors",
      "assessment": "Run yarn build and verify exit code is 0"
    }
  ]
}
```

## Step 1: Dispatch via Agent Tool

```typescript
dispatch_new_job({
  jobName: "my-workstream-root",
  blueprint: JSON.stringify({
    invariants: [
      {
        id: "TASK-001",
        type: "BOOLEAN",
        condition: "Complete the requested task",
        assessment: "Verify all outputs are present and valid"
      }
    ]
  }),
  enabledTools: ["web_fetch", "create_artifact"]
})
```

### Optional Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `model` | `auto-gemini-3` | Gemini model for execution |
| `enabledTools` | `[]` | Tools available to the job |
| `message` | - | Additional context for the job |
| `dependencies` | `[]` | Job definition UUIDs to wait for |
| `skipBranch` | `false` | Skip git branch creation |
| `responseTimeout` | `61` | Priority mech exclusivity window in seconds (min/max queried from on-chain marketplace contract) |

## Step 2: Verify Dispatch Success

Successful dispatch returns:

```json
{
  "data": {
    "request_ids": ["12345678901234567890"],
    "jobDefinitionId": "550e8400-e29b-41d4-a716-446655440000",
    "ipfs_gateway_url": "https://gateway.autonolas.tech/ipfs/bafybeig..."
  },
  "meta": { "ok": true }
}
```

## Step 3: Verify Ponder Indexing

After ~5 seconds, the request should appear in Ponder:

```bash
curl -X POST $PONDER_GRAPHQL_URL \
  -H "Content-Type: application/json" \
  -d '{"query":"{ request(id: \"<request_id>\") { id jobName workstreamId delivered } }"}'
```

## Step 4: Monitor Worker Processing

The worker picks up the request and runs through phases:

1. **Initialization**: Fetch IPFS metadata, clone repo, checkout branch
2. **Agent Execution**: Run Gemini agent with blueprint
3. **Git Operations**: Commit, push, create branch artifact
4. **Reporting**: Store execution report via Control API
5. **Delivery**: Submit result on-chain via Safe transaction

Watch logs:
```bash
yarn worker
```

## Verification Checklist

- [ ] `meta.ok === true` in dispatch response
- [ ] `request_ids` array is non-empty
- [ ] `jobDefinitionId` is a valid UUID
- [ ] Request appears in Ponder within 10 seconds
- [ ] Worker logs show "Processing request" for this ID
- [ ] Delivery transaction succeeds (check worker logs)

## Common Errors

| Error Code | Cause | Fix |
|------------|-------|-----|
| `INVALID_BLUEPRINT` | Not valid JSON | Validate with `jq` |
| `INVALID_BLUEPRINT_STRUCTURE` | Missing invariants array | Add `{"invariants":[...]}` |
| `INVALID_INVARIANT_SEMANTICS` | RANGE min > max | Ensure min <= max |
| `DISPATCH_FAILED` | No request IDs | Check mech funding/config |
| `UNAUTHORIZED_TOOLS` | Tool not in policy | Check template's `availableTools` |

See `docs/runbooks/troubleshoot-dispatch.md` for detailed error handling.

---

## Via x402 Gateway (Paid Templates)

For external users to execute templates via HTTP with x402 payments:

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/templates` | List available templates (free) |
| `POST` | `/templates/:id/execute` | Execute template (requires x402 payment) |
| `GET` | `/runs/:requestId/status` | Check run status (free) |
| `GET` | `/runs/:requestId/result` | Get run result (free, 202 if pending) |

### Example: Execute Template

```bash
curl -X POST https://x402-gateway.example.com/templates/my-template/execute \
  -H "Content-Type: application/json" \
  -H "X-402-Payment: <payment-token>" \
  -d '{"inputs": {"repoUrl": "https://github.com/org/repo"}}'
```

### Required Environment (Gateway Service)

| Variable | Description |
|----------|-------------|
| `PAYMENT_WALLET_ADDRESS` | Address to receive payments |
| `CDP_API_KEY_ID` | Coinbase Developer Platform key ID |
| `CDP_API_KEY_SECRET` | Coinbase Developer Platform key secret |
| `PONDER_GRAPHQL_URL` | Ponder GraphQL endpoint |
| `PRIVATE_KEY` | Wallet private key for dispatching |
| `MECH_ADDRESS` | Target mech address |

See `services/x402-gateway/` for full implementation.
