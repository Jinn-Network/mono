# E2E Troubleshooting Guide

## Common Issues

| Issue | Solution |
|-------|----------|
| Ponder stuck at old block | `PONDER_START_BLOCK` not near VNet head. Restart stack — it auto-calculates from current VNet block. |
| Control API claim "Unexpected error" | Control API querying production Ponder, not local. Ensure `PONDER_GRAPHQL_URL=http://localhost:42069/graphql` in Control API env. The `yarn test:e2e:stack` script handles this automatically. |
| Worker finds 0 requests | `workstreamId` in IPFS payload doesn't match `WORKSTREAM_FILTER` in .env. Always use `--workstream` flag with the dispatch script. |
| Tenderly quota error (403) | Free tier exhausted. `yarn test:e2e:vnet cleanup && yarn test:e2e:vnet create` then restart from Module 1 (Infrastructure). On-chain state is lost with the old VNet. |
| RPC delivery verification fails | Expected on Tenderly VNets. Ponder fallback verification works. Adds ~20s retry delay but is not a blocker. |
| Agent key "invalid BytesLike" | Agent key is an encrypted JSON keystore, not raw hex. Must decrypt with `OPERATE_PASSWORD` via `decryptKeystoreV3` from jinn-node. The dispatch script handles both formats (raw hex and encrypted). |
| Agent didn't use tools (no google_web_search calls) | Check telemetry `core_tools_enabled` field — if empty, native tools weren't configured. The Gemini CLI reads tool config from `settings.tools.core` (not top-level `coreTools`). See "Verify Tool Use" in worker-session.md. |
| Telemetry shows "No tool calls found" but agent used tools | The telemetry file contains concatenated JSON objects (NOT a JSON array). `json.JSONDecoder().raw_decode()` does NOT work reliably — use the streaming brace-counting parser from worker-session.md. Tool calls are under `event.name == 'gemini_cli.tool_call'` with `function_name`, `function_args`, `success`, `duration_ms`. |
| `DISABLE_STS_CHECKS` | Dead code — declared in config schema but never consumed anywhere. Don't set it. |
| Ponder uses wrong RPC | Only set `RPC_URL`. Don't set `BASE_RPC_URL` or `PONDER_RPC_URL`. Ponder resolves `BASE_RPC_URL || RPC_URL`, so just `RPC_URL` suffices. |
| Setup needs multiple funding rounds | Setup is iterative. It prints exact addresses + amounts needed, then exits. Fund the shortfall shown, re-run `yarn setup --no-staking`. Repeat until it completes. Don't guess amounts — read them from setup output. The `fund` command is additive (reads current balance, adds requested amount). |
| Setup fails reading staking params | The middleware can't read `min_staking_deposit` from the staking contract on Tenderly VNets. Use `yarn setup --no-staking` for worker and docker sessions. Only wallet sessions need staking. If you already ran `yarn setup` (without the flag) and it created a service config with staking enabled, delete `.operate/services/` and re-run with `--no-staking`. |
| `$CLONE_DIR` lost between shell calls | Save it to `.env.e2e`: `echo "CLONE_DIR=$CLONE_DIR" >> .env.e2e`. Read it back: `source .env.e2e`. |
| Dispatch fails with MAC mismatch / wrong password | `OPERATE_PASSWORD` in `.env` or `.env.test` is overriding the E2E password. Fix: ensure `OPERATE_PASSWORD=e2e-test-password-2024` is in `.env.e2e` (loaded last with `override: true`). The skill instructs saving it there during Module 2. |
| Agent went off-task (explored codebase instead of doing the job) | Blueprint invariants describe tool-validation meta-goals, not the actual task. The worker reads ONLY `metadata.blueprint` — it ignores `metadata.prompt`. The blueprint must contain GOAL invariants describing what the agent should do. The dispatch script's `DEFAULT_BLUEPRINT` has this correct. If using a custom `--blueprint`, ensure it has a GOAL-001 invariant with the actual task description. |
| Gateway won't start (`[ACL] Set CREDENTIAL_ACL_PATH...`) | The stack script auto-creates `.env.e2e.acl.json` on first run. If it's missing, create it: `echo '{"grants":{},"connections":{}}' > .env.e2e.acl.json`. |
| Worker credential probe returns empty providers | Check: 1) `X402_GATEWAY_URL=http://localhost:3001` is set in clone's `.env`. 2) Gateway is running (check stack output for `[gateway]` lines). 3) ACL file has a grant for the agent's address (lowercase). |
| Gateway returns 403 NOT_AUTHORIZED | The agent address in the ACL file must be lowercase (e.g., `0xabcd...`). The `getGrant()` method normalizes to lowercase. Also check the grant has `"active": true` and isn't expired. |
| Gateway test-e2e.ts fails with ECONNREFUSED | Gateway not running. Start it via `yarn test:e2e:stack` or manually: `PORT=3001 CREDENTIAL_ACL_PATH=.env.e2e.acl.json npx tsx services/x402-gateway/index.ts`. |

## VNet Quota Strategy

- Paid Tenderly tier supports higher write quotas (sufficient for multi-service setup + job execution + rotation testing)
- If quota is hit: reads continue working, writes fail with 403 Forbidden
- `yarn test:e2e:vnet status` detects quota exhaustion
- On-chain state is lost when creating a new VNet, so you must restart from the Infrastructure step

## Encrypted Keystore Pattern

Files in `.operate/keys/<address>` contain encrypted JSON keystores (not raw private keys).

```typescript
// WRONG — this returns an encrypted keystore string, not a hex key
const rawKey = keyData.private_key; // '{"address":"19d3d825...","crypto":{"cipher":"aes-128-ctr",...}}'

// RIGHT — decrypt first
const wallet = await ethers.Wallet.fromEncryptedJson(keyData.private_key, OPERATE_PASSWORD);
const actualKey = wallet.privateKey; // '0x...'
```

See `loadAgentPrivateKey()` in `jinn-node/src/worker/MechMarketplaceRequester.ts`.

## Design Constraints

- **One VNet per session**: Modules are sequential (setup -> worker -> wallet -> recovery). Quota exhaustion means restart.
- **All test scripts in monorepo**: Ponder + Control API are monorepo-only components. jinn-node standalone stays clean for production operators.
- **RPC_URL only**: Ponder resolves `BASE_RPC_URL || RPC_URL`. Just setting `RPC_URL` is sufficient everywhere.
