---
name: node-e2e-testing
description: End-to-end test the jinn-node operator experience using Tenderly VNets. Validates the full lifecycle in a single structured run with explicit pass/fail checkpoints. Use when asked to "run e2e tests", "test jinn-node", "validate operator flow", or "test on tenderly".
allowed-tools: Bash Read Edit Write Glob Grep
user-invocable: true
disable-model-invocation: true
---

# jinn-node E2E Testing

**IMPORTANT: Always start fresh.** Every session creates a new VNet and jinn-node clone.

## Sessions

This skill supports multiple test sessions. Each is self-contained with its own VNet.

| Session | Argument | What it tests | Reference |
|---------|----------|---------------|-----------|
| **Worker** *(default)* | *(none)* | Setup, 2nd service, worker execution, rotation, telemetry | Phases 0-5 below |
| **Lifecycle** | `lifecycle` | Service lifecycle without worker: setup, stake, checkpoint, rewards, recovery | [lifecycle-session.md](references/lifecycle-session.md) |

**Default session** (`/node-e2e-testing`): Full worker execution flow — 6 phases, requires Docker + Gemini CLI.

**Lifecycle session** (`/node-e2e-testing lifecycle`): Faster, lower-quota path — no Docker, no worker, no telemetry. Tests the operator experience from setup through fund recovery.

If the argument is `lifecycle`, read and follow [lifecycle-session.md](references/lifecycle-session.md) instead of the phases below.

## Diagnostic Only — Never Fix

This skill is a **test runner**. When something fails:
1. **Capture** the exact error output, relevant log lines, config state
2. **Diagnose** what went wrong and identify likely root cause
3. **Document** in the checkpoint with enough detail for the implementation session
4. **Continue or abort** per the abort logic — never attempt a fix
5. **Report** all diagnostic artifacts in the final report

The user takes the E2E report and passes it to their implementation session for fixing.

## Default Session — Phases

| Phase | Name | Reference | Abort on failure |
|-------|------|-----------|-----------------|
| 0 | Infrastructure | [phase-0-infrastructure.md](references/phase-0-infrastructure.md) | Abort run |
| 1 | Clone & Setup | [phase-1-setup.md](references/phase-1-setup.md) | Abort run |
| 2 | Add Second Service | [phase-2-add-service.md](references/phase-2-add-service.md) | Skip 3/4 |
| 3 | Worker Execution (Docker) | [phase-3-worker.md](references/phase-3-worker.md) | Skip 4/5 |
| 4 | Rotation + Credential Validation (Docker) | [phase-4-rotation.md](references/phase-4-rotation.md) | Continue |
| 5 | Telemetry Verification | [phase-5-telemetry.md](references/phase-5-telemetry.md) | Continue |

Execute phases sequentially. Read each phase's reference file and follow its instructions. Report CHECKPOINT at the end of each phase before moving to the next.

Operator scripts are tested at the points where their output is most meaningful:
- `service:add --dry-run` + `service:list` — Phase 2 (after deploying 2nd service)
- `service:status` — Phase 3 (after worker runs, shows real activity)

## Prerequisites

1. **Tenderly creds in `.env.test`**: `TENDERLY_ACCESS_KEY`, `TENDERLY_ACCOUNT_SLUG`, `TENDERLY_PROJECT_SLUG`
2. **Supabase creds in `.env`**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
3. **Umami creds in `.env.test`**: `UMAMI_HOST`, `UMAMI_USERNAME`, `UMAMI_PASSWORD` (gateway login/JWT path)
4. **Dispatch input config**: pass `--input <config.json>` containing `umamiWebsiteId` so blueprint maps it to `JINN_JOB_UMAMI_WEBSITE_ID`
5. **Runtime**: Node 22+, Python 3.10-3.11, Poetry, `yarn install` completed
6. **Gemini CLI**: Authenticated (`~/.gemini/oauth_creds.json`)
7. **Docker**: Running and accessible

**Env file priority**: `.env` -> `.env.test` override -> `.env.e2e` override

## Quick Reference

| Script | Purpose |
|--------|---------|
| `yarn test:e2e:vnet create` | Create VNet, save RPC to `.env.e2e` |
| `yarn test:e2e:vnet fund <addr> --eth N --olas N` | Fund address on VNet |
| `yarn test:e2e:vnet time-warp <seconds>` | Advance VNet time |
| `yarn test:e2e:vnet status` | Check VNet health + quota |
| `yarn test:e2e:vnet cleanup --max-age-hours=0` | Delete all VNets |
| `yarn test:e2e:dispatch --workstream <id> --cwd <path> --input <json>` | Dispatch job |
| `yarn test:e2e:stack` | Start local Ponder + Control API + Gateway |
| `yarn test:e2e:docker-run --cwd <path> [--single] [--telemetry]` | Run worker in Docker |
| `yarn test:e2e:parse-telemetry <file> [--required-tools t1,t2]` | Parse Gemini telemetry |

## State Tracking

Shell state does not persist between bash calls. Persist values in `.env.e2e`:

| Variable | Set in | Used by |
|----------|--------|---------|
| `CLONE_DIR` | Phase 1 | All phases |
| `SERVICE_A_SAFE` | Phase 1 | Phase 4 |
| `SERVICE_B_SAFE` | Phase 2 | Phase 4 |
| `AGENT_EOA_1` | Phase 1 | Phase 3 |
| `AGENT_EOA_2` | Phase 2 | Phase 3 |
| `TELEMETRY_DIR_WORKER` | Phase 3 | Phase 5 |
| `TELEMETRY_DIR_ROTATION` | Phase 4 | Phase 5 |
| `TELEMETRY_DIR_ROTATION_CRED` | Phase 4 | Phase 5 |

## Checkpoint Format

Every phase ends with a checkpoint block:
```
## CHECKPOINT: Phase N — <Name>
- [PASS] Criterion passed
- [FAIL] Criterion failed — <diagnostic detail>
```

## Final Report

After all phases (or after abort), produce:

```
## E2E TEST REPORT
Branch: <branch>
VNet ID: <from .env.e2e>
Clone: <CLONE_DIR>
Date: <timestamp>

| Phase | Name                       | Result |
|-------|----------------------------|--------|
| 0     | Infrastructure             | PASS   |
| 1     | Clone & Setup              | PASS   |
| 2     | Add Second Service         | PASS   |
| 3     | Worker Execution (Docker)  | PASS   |
| 4     | Rotation + Credential Val  | PASS   |
| 5     | Telemetry Verification     | PASS   |

Overall: N/6 PASS

### Debugging Artifacts
- Clone: $CLONE_DIR
- VNet config: .env.e2e
- Telemetry (worker): $TELEMETRY_DIR_WORKER
- Telemetry (rotation): $TELEMETRY_DIR_ROTATION
- Telemetry (rotation-cred): $TELEMETRY_DIR_ROTATION_CRED
- Ponder logs: <background task output>
```

## Known Benign Conditions

These are NOT failures — do not mark FAIL for these:
- **Delivery 403 (quota exhausted)**: Key validation is agent execution + IPFS upload
- **AEA deployment failed during setup**: Expected CLI version mismatch
- **Web search returns no results**: Tool was *called* — that's what matters
- **Chromium sandbox warning in Docker**: Expected with `GEMINI_SANDBOX=false`
- **Empty stats from `blog_get_stats`**: The Umami website may have no traffic data. An empty stats result is acceptable — the credential bridge flow (agent → signing proxy → ERC-8128 → bridge → ACL → Umami login → JWT → API call) is what's being validated.

## Cleanup

After reporting, ask user: clean up or leave for debugging?
- `yarn test:e2e:vnet cleanup --max-age-hours=0` — delete all VNets
- `rm -rf "$CLONE_DIR"` — remove temp clone
- Ctrl+C — stop local stack

## Troubleshooting

See [references/troubleshooting.md](references/troubleshooting.md) for common issues.
