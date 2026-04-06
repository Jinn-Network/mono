---
name: onboard
description: Check service/worker status and browse available Jinn ventures to join. Verifies operate-profile setup, checks if the mech worker is running, lists active ventures with token details, and configures WORKSTREAM_FILTER.
allowed-tools: venture_query, Bash, Read, Edit, Glob
user-invocable: true
emoji: "\U0001F680"
---

# Onboard to a Venture

Help users verify their service setup, check worker status, browse active Jinn ventures, and configure their worker to participate.

## Flow

### 1. Check service status

Look for the operate-profile configuration:

- Use `Glob` to check for `.operate/services/*/config.json`
- If found, read the config and extract:
  - Service agent address (from `chain_configs.*.chain_data.instances[0]`)
  - Safe address (from `chain_configs.*.chain_data.multisig`)
  - Service ID
- If NOT found, tell the user:
  > Your operate-profile is not configured. Set up your service first.
  > See: `docs/runbooks/setup-worker.md`

  Then stop — the remaining steps require an active service.

### 2. Check worker status

Determine if the mech worker is currently running:

- Use `Bash` to run: `ps aux | grep -v grep | grep mech_worker || true`
- Also check if `WORKER_STOP_FILE` exists (read `.env` for its path, or check for `.worker-stop` in the project root)
- Report status:
  - **Running**: "Mech worker is currently running. Changing ventures will require restarting the worker."
  - **Stopped**: "Mech worker is not running."

### 3. List ventures

Call `venture_query` with `{ "mode": "list", "status": "active" }` to fetch all active ventures.

Filter to only show ventures that have a `root_workstream_id` set — ventures without one haven't been launched as workstreams yet and cannot be joined.

### 4. Present venture cards

For each eligible venture, show:

- **Name** and description
- **Token**: `$TOKEN_SYMBOL` if `token_symbol` is set, or "No token" otherwise
- **Staking**: Show `staking_contract_address` if set, or "Shared Jinn staking contract (`0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139`)" as default
- **Workstream ID**: `root_workstream_id`
- **Pool**: Link to Doppler pool if `pool_address` is set
- **Governance**: `governance_address` if set

### 5. Pick a venture

Ask the user to select a venture from the list.

### 6. Configure the worker

Read the `.env` file at the project root. Set or update:
```
WORKSTREAM_FILTER=<selected venture's root_workstream_id>
```
If `WORKSTREAM_FILTER` already exists, replace its value. If not, append it.

Use the `Edit` tool to make the change.

### 7. Show participation steps

After configuring:

- If the worker is running: "Restart the worker to pick up the new venture: stop the current process and run `yarn dev:mech`"
- If the worker is stopped: "Start the worker with `yarn dev:mech`"
- If the venture has a token:
  > Completed jobs earn **$TOKEN_SYMBOL** token rewards. Rewards are distributed periodically via the distribution script.
- Workers need **5,000 OLAS** staked to earn OLAS rewards
- Link to the venture's explorer page: `https://explorer.jinn.network/ventures/<root_workstream_id>`

## Important Notes

- Only show ventures with status "active" AND a `root_workstream_id`
- The shared Jinn staking contract is `0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139`
- Workers need 5,000 OLAS staked to earn OLAS rewards
- Venture token rewards (if available) are distributed separately via `scripts/ventures/distribute-rewards.ts`
