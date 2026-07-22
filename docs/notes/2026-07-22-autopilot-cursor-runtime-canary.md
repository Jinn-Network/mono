# Autopilot Cursor-runtime canary (2026-07-22)

Process-wide `JINN_AUTOPILOT_RUNTIME=cursor` end-to-end proof on Autopilot v2 (`yarn autopilot --mode active`).

## Canary selection

| Preferred | Result |
| --- | --- |
| #639 (Low / test) | Eligible after triage, but reality check `fixed-direct-commit` |
| #642 / #1784 | Same / unsuitable |
| **#1557** (Low, fix distill `stop_run` dead-PID) | Used — Priority P3, Blocked on Nothing, Effort Low |

## Identities

| Role | Login |
| --- | --- |
| Implementer | `ritsukai` (`JINN_IMPL_GH_TOKEN`) |
| Reviewer | `ritsuKai2000` (`JINN_REVIEW_GH_TOKEN` / `JINN_REVIEW_BOT_LOGIN`) |
| Allowlist | `oaksprout,ritsukai,ritsuKai2000` |

## Models observed

| Phase | Model | Evidence |
| --- | --- | --- |
| Boot | reviewModel default `cursor-grok-4.5-high`, bin=`agent` | canary log header |
| Implement (Effort Low) | `composer-2.5` | `agent … --model composer-2.5 …` pid 46023 |
| Review | `cursor-grok-4.5-high` | `agent … --model cursor-grok-4.5-high …` pid 58284 |
| Merge | (lifecycle merge, no AI spawn) | `merge issue:1557/pr:1946: merged` |

## Spawn shape (Cursor)

Both coordinators used:

`agent -p --force --trust --sandbox disabled --approve-mcps --workspace <attempt> --model <id> --output-format text`

Review depth stages used `yarn stage:run` (agent `-p` roots), not Task children — see attempt `reports/stage-1-*-result.txt`.

## Artifacts

| Kind | Value |
| --- | --- |
| Issue | [#1557](https://github.com/Jinn-Network/mono/issues/1557) (CLOSED, Status **Done**) |
| PR | [#1946](https://github.com/Jinn-Network/mono/pull/1946) merged `2026-07-22T01:43:27Z` (`ea39170c…`) |
| Implement attempt | `~/.jinn-client/autopilot/attempts/v2/macbook-pro-4.local-43268-c56bc30e-b007-40bd-9b12-e1b8a807b808/implement/issue-1557-7d3f0560-34c8-43eb-ae00-2592e65142b6/` |
| Review attempt | `…/review/pr-1946-45ae7628-ac6a-4a74-83a3-1c87916cf263/` (login `ritsuKai2000`) |
| Primary log | `~/.jinn-client/autopilot/canary-logs/cursor-1557-recover-20260722T002847Z.log` |
| Capability attestation | `~/.jinn-client/autopilot/capability-attestation.json` |

## Loop evidence

1. **Boot** — `runtime=cursor`, Cursor capability preflight, caps=1, `ONLY_ISSUES=1557`.
2. **Implement** — claim spawned; worktree under attempts/; useful fix + regression test; `implementation-complete` at `57ab95077`.
3. **Review** — distinct bot `ritsuKai2000`; APPROVE + `review:approved`; stage:run code + security roots.
4. **Merge** — `merge issue:1557/pr:1946: merged.`; board Status **Done**; issue closed.
5. **No silent Claude/Hermes fallback** — log has only `runtime=cursor`.

## Operational notes (not blockers for Phase A)

- Implementer GraphQL budget is independent of the operator `gh` token. Full board snapshots burn ~4k points/cycle; remaining &lt; 500 (`DEFAULT_FLOOR`) fail-closes the cycle. Plan Autopilot around the **impl** token reset, not the operator shell.
- Detached `nohup` under the Cursor agent sandbox can be reaped; keep Autopilot attached to a long-lived shell for canaries.
- First claim on #1557 returned `partial` (no PR) before recovery re-claim spawned; recovery used `JINN_AUTOPILOT_STALE_AFTER_MS=60000` + Status Todo. Root-cause for the initial partial (likely `target-base-changed` / PR converge) is a follow-up.

## Phase A verdict

**Pass.** Cursor runtime proved implement → review → merge on one pinned Low issue with dual GitHub identities and Effort/model table behavior.

## Phase B (concurrency 7)

Started after Phase A green with:

- `JINN_AUTOPILOT_IMPLEMENTATION_CAP=7`
- `JINN_AUTOPILOT_REVIEW_CAP=3`
- `JINN_AUTOPILOT_MERGE_PREP_CAP=2`
- Explicit `JINN_AUTOPILOT_ONLY_ISSUES` (not unrestricted):  
  `639,1555,1556,1563,1564,1567,1641,1642,1643,1644,1645,1648,1684,1477,1001,1397`  
  (all already Todo + Priority + Blocked Nothing — no invented work)
- Log: `~/.jinn-client/autopilot/canary-logs/cursor-phaseB-20260722T014522Z.log` (see `/tmp/cursor-phaseb-logpath.txt`)

### Observed

| Check | Result |
| --- | --- |
| Cap env honored | Yes (`IMPLEMENTATION_CAP=7`) |
| Concurrent `agent` processes | ≤7 (peak observed **2**) |
| Stampede / wedged draft flood | No |
| GraphQL | Implementer token still the bottleneck (~4k/cycle); cycles fail-closed under floor 500 |

**Why not 7 parallel implements:** scheduling is credential-lane gated. With the dual-token pool (`ritsukai` implement-preferred + `ritsuKai2000` review), at most **two** logins can be live at once. After #1648 claimed `ritsukai`, further candidates logged `schedule issue:…: skipped (credential-lane)` until the second lane freed. Live pair observed: implement #1648 (`ritsukai`, `cursor-grok-4.5-medium`) + implement #1645 (`ritsuKai2000`). Reaching true 7-way implement concurrency needs more implementer identities (or a lane model that allows multi-attempt per login) — out of scope here.

Stale `processState: running` manifests with dead PIDs (old review/merge-prep) can also occupy lanes until cleanup; worth a follow-up if sweeps miss them.

Autopilot left running on the Phase B allowlist to continue serial/dual-lane backlog drain under Cursor.
