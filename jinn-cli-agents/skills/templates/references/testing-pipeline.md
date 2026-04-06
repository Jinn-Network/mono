# Template Testing Pipeline

Every template goes through 4 phases before publishing: **Smoke → Quality → Robustness → Validation**

Target: ~10 total runs.

---

## Prerequisites

Before starting the pipeline:

1. Blueprint file exists at `blueprints/<slug>.json` with `templateMeta` + `invariants`
2. Test input exists at `blueprints/inputs/<slug>-test.json`
3. Environment configured: `OPERATE_PROFILE_DIR`, `OPERATE_PASSWORD`, `RPC_URL`, `CHAIN_ID`
4. Blueprint passes the [quality checklist](blueprint-quality-checklist.md)

## Phase 1: Smoke Test (2 runs)

Dispatch + execute locally. Pass criteria:

- Reaches a successful terminal state within SLA (allow interim `DELEGATING` while children run)
- All `outputSpec` fields present in the artifact
- Correct tools called (check against `tools` list in blueprint)
- No references to removed systems (e.g., Telegram in a data-only template)
- `create_artifact` called with correct topic and sensible tags

**Common failures:**
- Agent fails to delegate when it should → check that tools list includes `dispatch_new_job` and invariants describe outcomes that benefit from parallel research
- Wrong repo/input parsing → check variable substitution in dispatch output
- Auth errors → re-authenticate Gemini CLI (`gemini` in terminal), verify `GEMINI_API_KEY` in `.env`

## Phase 2: Quality Calibration (4 runs)

Vary inputs to stress different scenarios. Example for a time-based template:

| Run | Input variation | Why |
|-----|-----------------|-----|
| 3 | `7 days` | Normal case |
| 4 | `24 hours` | Few results edge case |
| 5 | `30 days` | High volume, pagination test |
| 6 | `3 days` | Medium volume |

**Grading checklist per run:**

- [ ] **Completeness**: all outputSpec fields present and correctly typed
- [ ] **Accuracy**: spot-check against external source (e.g., GitHub API, manual count)
- [ ] **Quality**: output is useful and well-organized (not raw data dumps)
- [ ] **Consistency**: counts/totals are internally consistent
- [ ] **Tags**: artifact tags are useful for `search_artifacts` discovery
- [ ] **Time compliance**: completes within the configured marketplace response timeout

**Between runs**: iterate on invariant wording based on inspection findings.

## Phase 3: Robustness (2 runs)

Test edge cases:

- Very short period / zero results — verify graceful handling (empty output, not errors)
- Very large result set — verify pagination works and doesn't timeout
- Unusual inputs — repos with no conventional commits, empty repos, etc.

## Phase 4: Validation (2 runs)

Two identical runs with production inputs. Pass criteria:

- Both produce valid output
- Key metrics match between runs (e.g., commit counts, section structure)
- Highlights/themes overlap >=60%
- Output format is consistent
- If delegation occurs, both runs converge within SLA and preserve source coverage evidence

---

## Commands

```bash
# Dispatch a test run (generic — works for any blueprint + input pair)
yarn tsx scripts/dispatch-template.ts \
  blueprints/<slug>.json \
  blueprints/inputs/<slug>-test.json

# Execute locally — run IMMEDIATELY after dispatch to beat Railway workers
MECH_TARGET_REQUEST_ID=<id> yarn dev:mech --single

# Inspect results
yarn inspect-job-run <requestId>

# Check invariant conformance (content-template specific)
yarn tsx scripts/validation/check-content-template-conformance.ts <requestId>
```

## Invariant Iteration Tips

- **Agent doesn't delegate when it should** → Delegation is how the network achieves depth. If the agent does all work sequentially in one execution, check that invariants describe outcomes that benefit from parallel investigation, and that `dispatch_new_job` is in the tools list. Anti-delegation overrides are only appropriate for infrastructure test blueprints.
- **Agent stays in DELEGATING too long** → treat this as convergence/SLA failure, not a delegation failure. Ensure child scopes are explicit, dependencies are acyclic, and parent waits for terminal child outcomes before synthesis.
- **Poor categorization** → strengthen `examples.do`/`examples.dont` with specific cases from failed runs
- **Inconsistent output** → add structural constraints (e.g., "exactly 3-5 highlights", "include a summary section at the top")
- **Output is raw data, not readable** → rewrite invariants to request narrative prose organized by themes, not JSON or bullet lists
- **Tools not used** → make optional tools required, or add an invariant encouraging usage
- **Agent times out** → break into smaller goals, reduce scope, or add pagination guidance
- **Missing fields** → check that `outputSpec` field names match what invariants instruct the agent to produce

## Publishing

After all 4 phases pass:

```bash
# Seed to Supabase as published
yarn tsx scripts/templates/seed-from-blueprint.ts blueprints/<slug>.json \
  --status published --venture-id <uuid>

# Optionally add to a venture's dispatch schedule
yarn tsx scripts/setup-scheduled-venture.ts \
  --ventureId <uuid> \
  --entry "<label>:<templateId>:<cron>"
```
