---
name: gate-runner
description: Progressive integration validation with iterative fix-and-retry loop. Runs gates tier by tier — unit, inspect, tenderly, canary, smoke — and when one fails, diagnoses the failure, fixes the code, commits, and retries. Use when asked to "run gates", "validate integration", "run the pipeline", or "gate-runner".
allowed-tools: Bash Read Edit Write Glob Grep
user-invocable: true
disable-model-invocation: true
---

# Gate Runner

Progressive integration validation with an iterative fix-and-retry loop.

## Quick Start

```
/gate-runner                  # Resume or start with profile=full
/gate-runner quick            # Unit + inspect only (~2 min)
/gate-runner standard         # + Tenderly E2E (~35 min)
/gate-runner full             # + canary + smoke (~90 min)
```

## How It Works

1. Read `.tmp/gate-runner/state.json` + `.tmp/gate-runner/session-log.md`
2. If state exists with FAIL/PENDING gates → **resume** from current tier
3. If no state → **initialize** with all gates PENDING
4. Run gates tier by tier, fix failures, retry, advance
5. On completion → produce final summary

## Profiles

| Profile | Tiers | Estimated Time | Use Case |
|---------|-------|----------------|----------|
| `quick` | unit, inspect | ~2 min | Fast sanity check |
| `standard` | + tenderly | ~35 min | Pre-merge validation |
| `full` | + canary, smoke | ~90 min | Release candidate |

---

## Step 0: Initialize or Resume

### Resume (state.json exists)

```bash
# Read state and session log
cat .tmp/gate-runner/state.json
cat .tmp/gate-runner/session-log.md
```

Read the session-log.md header for current status. Resume from the last entry. Run `bd prime` to restore beads context.

### Initialize (no state)

Determine the profile from the argument (default: `full`). Determine the branch:

```bash
git branch --show-current
```

Read the gate registry to get all gate IDs for the profile:

```typescript
// tests/pipeline/gate-registry.ts
import { gateIdsForProfile } from './tests/pipeline/gate-registry.js';
```

Create initial state by writing `.tmp/gate-runner/state.json`:

```json
{
  "runId": "<branch>-<timestamp>",
  "branch": "<current-branch>",
  "profile": "<quick|standard|full>",
  "startedAt": "<ISO timestamp>",
  "currentTier": "unit",
  "ephemeralServices": {},
  "gates": { "<id>": { "status": "PENDING", "attempts": 0 } },
  "fixes": [],
  "recoveryNotes": ""
}
```

Create initial session-log.md with header (see Session Logging below).

---

## Step 1: Execute Tiers

Execute tiers in order. **Stop advancing** if a tier has unresolvable failures.

### Tier: unit

```bash
yarn vitest run 2>&1 | head -100
```

- Single gate: `UNIT`
- On pass: mark gate PASS, log tier pass
- On fail: read test output, diagnose, fix the production code (NOT the test), commit, retry

### Tier: inspect

```bash
yarn test:pipeline:inspect
```

- Runs all code inspection gates (P1-P6, CR9-CR12, W10-W12, C1, E1, N1-N4, F1-F5)
- On pass: mark all gates PASS
- On fail: read the output, check `failureHints` from the gate registry for each failing gate
- Fix the production code, commit, re-run only failing gates:

```bash
yarn test:pipeline:inspect -- --gates P4,CR9
```

### Tier: tenderly

Invoke the `/node-e2e-testing` skill. This tier uses AI judgment for failure diagnosis.

1. Run the e2e skill: `/node-e2e-testing`
2. Map phases to gates:
   - Phase 1 (setup): W1
   - Phase 2 (2nd service): W2, W3, W4
   - Phase 3 (worker): W5, W6, W7, W8, W9, W13
   - Phase 4 (rotation + creds): CR1, CR2, CR3, CR4, CR5
3. On failure:
   - Read the checkpoint output
   - Identify the failing phase
   - Fix the code
   - Re-run from the failing phase (not from scratch)

### Tier: canary

**Create ephemeral services first:**

```bash
yarn test:pipeline:canary:create --branch <branch> \
  --env-from-worker canary-worker-2 \
  --env-from-gateway x402-gateway-canary
```

Save the output service names to `state.json` → `ephemeralServices`.

**Run the canary harness:**

```bash
yarn test:railway:canary -- \
  --session pre-smoke \
  --repo Jinn-Network/jinn-node \
  --branch <branch> \
  --worker-service <ephemeral-worker> \
  --gateway-service <ephemeral-gateway> \
  --worker-project jinn-worker \
  --gateway-project jinn-shared
```

Map harness phases to gates:
- Phase 0 (preflight): part of CANARY_DEPLOY
- Phase 1 (deploy assert): CANARY_DEPLOY
- Phase 2 (baseline dispatch): CANARY_BASELINE
- Phase 3 (credential matrix): CANARY_CRED_TRUSTED, CANARY_CRED_UNTRUSTED, CANARY_FILTERING, CANARY_FAILCLOSED
- Phase 4 (log security): CANARY_SECURITY, CANARY_DELIVERY_RATE

On failure:
1. Read the artifact JSON from `.tmp/railway-canary-e2e/<run-id>/`
2. Diagnose the failure
3. Fix production code, commit, push to branch
4. If jinn-node/ changed: `yarn subtree:push` to push to standalone repo
5. Redeploy ephemeral services: `railway redeploy -s <service> -y`
6. Re-run only the failing phase

### Tier: smoke

```bash
yarn test:railway:canary -- \
  --session smoke \
  --worker-service <ephemeral-worker> \
  --gateway-service <ephemeral-gateway> \
  --worker-project jinn-worker \
  --gateway-project jinn-shared
```

- Single gate: CANARY_SMOKE (30-minute stability window)
- Not retryable — if it fails, investigate root cause before re-running

**Teardown ephemeral services after smoke (pass or fail):**

```bash
yarn test:pipeline:canary:teardown \
  --worker-service <ephemeral-worker> \
  --gateway-service <ephemeral-gateway>
```

---

## The Fix Loop

When a gate fails:

```
1. Log FAIL in session-log.md (error output, root cause, files to check)
2. Read failureHints from gate registry: tests/pipeline/gate-registry.ts
3. Read the failing source files
4. Diagnose: Is this a CODE issue or a PIPELINE issue? (see below)
5. Apply the appropriate fix:
   - CODE issue → fix production code, commit, log as FIX
   - PIPELINE issue → fix the check, commit with "fix(pipeline): ...", log as PIPELINE_FIX
6. Push to branch
7. If jinn-node/ changed: yarn subtree:push
8. Re-run ONLY the failed gate
9. After a CODE fix: consider adding a new inspect gate (see Evolving the Pipeline)
10. Max 3 retries per gate — then STOP and ask human
```

---

## Evolving the Pipeline

The gate registry and inspect checks evolve during runs. This keeps the pipeline accurate and grows coverage over time.

### Diagnosing Code vs Pipeline Issues

When a gate fails, determine whether the **production code** is wrong or the **check itself** is wrong:

| Symptom | Diagnosis | Action |
|---------|-----------|--------|
| File not found, but the feature exists at a different path | Stale path in check | PIPELINE_FIX |
| Pattern doesn't match, but the feature works correctly | Outdated regex/pattern | PIPELINE_FIX |
| Count assertion fails, but the actual count is correct and expected | Wrong threshold | PIPELINE_FIX |
| Code genuinely doesn't do what the gate asserts | Production bug | CODE FIX (existing loop) |

**PIPELINE_FIX log entry:**
```markdown
## [HH:MM:SS] PIPELINE_FIX: <gate-id>
- File: `tests/pipeline/gate-registry.ts` or `scripts/test/pipeline/inspect-gates.ts`
- Old: <old path/pattern/threshold>
- New: <new path/pattern/threshold>
- Commit: `<SHA>`
```

Pipeline fixes are committed with the prefix `fix(pipeline): ...` to distinguish them from production code fixes in git history.

### Auto-Adding Inspect Gates

After every CODE fix, ask: **"Would a new inspect gate catch this earlier in future runs?"**

If the fix involves a pattern verifiable by reading files (grep, exists, count), add a new inspect gate:

1. Add the gate to `tests/pipeline/gate-registry.ts` with `addedAt` and `addedReason`
2. Add the check to `scripts/test/pipeline/inspect-gates.ts`
3. Log as `NEW_GATE` entry in session-log.md
4. Commit alongside the code fix or as a separate `feat(pipeline): ...` commit
5. Run the new gate to verify it passes

Only auto-add **inspect-tier** gates. These are cheap and deterministic.

### Proposing Higher-Tier Gates

If a fix reveals something that needs runtime validation (Tenderly fork, canary deploy, live RPC), do NOT auto-add it. Instead log a proposal:

```markdown
## [HH:MM:SS] GATE_PROPOSAL: <proposed-id>
- Tier: tenderly|canary
- Name: <description>
- Rationale: <why existing gates didn't catch this>
- Suggested check: <what to validate>
- Files: <relevant paths>
```

Proposals appear in the session log for human review during the post-run retrospective.

### Retiring Gates

If a gate is permanently irrelevant (feature removed, superseded by another gate):

1. Set `retired: true` on the gate in `tests/pipeline/gate-registry.ts` (don't delete — history matters)
2. Remove or comment out the check in `inspect-gates.ts`
3. Log as `GATE_RETIRED` entry in session-log.md

Retired gates are automatically skipped by `gatesForTier()` and `gateIdsForProfile()`.

---

## Session Logging Protocol

**CRITICAL**: Update the session log after EVERY significant action. This is the compaction recovery mechanism AND the post-session review artifact.

### Session Log Structure

**File**: `.tmp/gate-runner/session-log.md`

**Header** (updated in-place after every state change):

```markdown
# Gate Runner Session — <branch>
Branch: <branch> | Profile: <profile> | Started: <timestamp>
Status: IN_PROGRESS | Current tier: <tier> | Gates: X/Y PASS, Z FAIL, W PENDING

## Recovery Instructions
1. Read this file top-to-bottom for full context
2. Read `.tmp/gate-runner/state.json` for current gate statuses
3. Run `bd prime` to restore beads context
4. Resume from the last log entry below
```

**Body** (append-only — never delete entries):

```markdown
---

## [HH:MM:SS] Tier: <tier> — START
<what you're about to run>

## [HH:MM:SS] Tier: <tier> — PASS
<summary: X/Y gates, time elapsed>

## [HH:MM:SS] Gate <id> — FAIL
<error output>
**Root cause**: <diagnosis>
**Files to check**: <list>

## [HH:MM:SS] FIX: <gate-id>
- File: `<path>`
- Change: <description>
- Commit: `<SHA>`
- Subtree pushed: yes/no

## [HH:MM:SS] RETRY: <gate-id> (attempt N)
<what you're re-running>
```

### When to Log

| Event | Log Entry |
|-------|-----------|
| Starting a tier | `Tier: <tier> — START` with what you'll run |
| Tier passes | `Tier: <tier> — PASS` with gate counts and time |
| Gate fails | `Gate <id> — FAIL` with error, root cause, files |
| Applying a fix | `FIX: <id>` with file, change, commit, subtree |
| Retrying a gate | `RETRY: <id> (attempt N)` |
| Fixing a stale check | `PIPELINE_FIX: <gate-id>` with old → new path/pattern |
| Adding a new inspect gate | `NEW_GATE: <id>` with name, tier, rationale |
| Proposing a higher-tier gate | `GATE_PROPOSAL: <id>` with tier, rationale, suggested check |
| Retiring a gate | `GATE_RETIRED: <id>` with reason |
| Run complete | `COMPLETE` or `STOPPED` with summary |
| Post-run review | `RETROSPECTIVE` with fix counts, proposals, coverage delta |

### State Updates

After every gate result:
1. Update `state.json` → `gates[id]`
2. Update `state.json` → `currentTier`
3. Update session-log.md header
4. If fix applied: add to `state.json` → `fixes[]`

---

## Rules

1. **Never finish with failing gates.** Either fix them or stop and escalate.
2. **Fix code, not tests.** Never weaken a gate assertion to make it pass. Exception: if a check itself is wrong (stale file path, outdated pattern, wrong directory), fix the check and log it as a `PIPELINE_FIX`. Code fixes change production code; pipeline fixes change `tests/pipeline/` or `scripts/test/pipeline/`.
3. **Update state.json** after every gate result change.
4. **Log every action** in session-log.md (START, PASS, FAIL, FIX, RETRY).
5. **Update session-log.md header** after every state change.
6. **Commit fixes** to the branch under test. Include descriptive messages.
7. **Push + subtree push** when jinn-node/ files change.
8. **Max 3 retries** per gate. After 3 failures, stop and report to human.
9. **Don't skip ahead.** A tier must fully pass before advancing.
10. **Teardown ephemeral services** when done (pass or fail).

---

## Recovery After Compaction

If you're resuming after context compaction:

1. Read `.tmp/gate-runner/session-log.md` — header has status + last action
2. Read `.tmp/gate-runner/state.json` — current gate statuses
3. Run `bd prime` to restore beads context
4. Find the last log entry — that's where you stopped
5. Continue from there

---

## Reference Files

| File | Purpose |
|------|---------|
| `tests/pipeline/gate-registry.ts` | Gate definitions: tiers, deps, failureHints |
| `scripts/test/pipeline/state.ts` | State + session log read/write helpers |
| `scripts/test/pipeline/inspect-gates.ts` | Automated code inspection checks |
| `scripts/test/pipeline/ephemeral-canary.ts` | Ephemeral Railway service lifecycle |
| `scripts/test/railway/canary-harness.ts` | Canary test orchestrator |
| `skills/node-e2e-testing/SKILL.md` | Tenderly E2E skill (used for tenderly tier) |

---

## Completion

When all gates pass:

1. Log `COMPLETE` entry in session-log.md with final summary
2. Update state.json — all gates PASS
3. Teardown ephemeral services if created
4. Print final gate status table
5. Clean up orphaned canary services:

```bash
yarn test:pipeline:canary:cleanup --max-age-hours 2
```

### Post-Run Retrospective

Before declaring complete, review the session:

1. Count `PIPELINE_FIX` entries — are there patterns? (e.g., many stale paths suggest code moved)
2. Count `FIX` entries — for each, check if a `NEW_GATE` was added
3. Review any `GATE_PROPOSAL` entries — summarize them for the user
4. If 3+ pipeline fixes in one run, note: "Consider refactoring inspect checks to be more resilient to file moves"

Append a `RETROSPECTIVE` entry to session-log.md:

```markdown
## [HH:MM:SS] RETROSPECTIVE
- Code fixes: N (M had new gates added)
- Pipeline fixes: N
- Gate proposals: (list or "none")
- New gates added: (list or "none")
- Gates retired: N
- Coverage delta: was X gates, now Y gates
```

The session-log.md + state.json together are the review artifact. Share them for post-session audit.
