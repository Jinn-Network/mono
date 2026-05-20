# Release-readiness and test-operator substrate

**Version:** v0.1
**Date:** 2026-05-19
**Authors:** Adriano Bradley, Claude Opus 4.7
**Status:** draft

## Why

The v0.1.6 cut on 2026-05-19 spent roughly three hours fighting four distinct CI gate failures (Tenderly rate-limit on public RPC fallback, a `transcript-watcher` test flake, an Anvil stake-stall, a Tenderly rate-limit on the high-quota key after multi-bootstrap saturation). None of the gates caught a real release bug. The ship decision was carried by independent evidence — a manual A3 verification on real Base Sepolia producing `verdictCode=1` on a real `sympy__sympy-27510` solve.

That pattern is structural, not incidental. The current release gates do three things wrong:

1. **They catch their own infrastructure flakes, not release bugs.** The bugs that bit v0.1.6 (Hermes provider routing #293/#298, MCP launcher path #294/#299, ghost-task class #300, eval-substrate silently broken for three weeks before fufn) were all caught by humans and agents *using the app on testnet*, not by CI gates.
2. **They re-bootstrap from scratch on every run.** Each `bootstrapBaseSepoliaForkOperator` call hammers the fork-source RPC for storage and code fetches. By the third call in one job, even the high-quota Tenderly key returns HTTP errors. This is `jinn-mono-lrey`.
3. **They don't audit the app.** Operator-app surfaces (the dashboard SPA) are what users actually see and use. The current gates verify chain mechanics and never load a page.

There's also a deeper gap: there is no codified path from "we think this is ready to ship" to "it actually is ready." The current Monday-cut flow draws a draft and asks a human to decide. The human decision is good, but it relies on memory of what changed and trust in unstated checks — both of which decay.

This spec proposes a substrate-anchored test infrastructure plus two new skills that compose into a reliable, advisory release-readiness process. The goal is to make the v0.1.6 outcome (ship-on-independent-evidence with full audit trail) the default, not the exception.

## §1 Architecture overview

Two new skills sit on a shared on-disk substrate. The existing `testing-jinn-app` skill extends to cover multi-operator scenarios.

```
                       ┌─────────────────────────────────────────┐
                       │      release-readiness  (meta-skill)    │
                       │  audit canon → triage gaps → drive      │
                       │  closure → invoke release-prep → invoke │
                       │  Tier 3 → emit handoff doc              │
                       └────────────────┬────────────────────────┘
                                        │ invokes
                                        ▼
                       ┌─────────────────────────────────────────┐
                       │      release-prep  (mechanical skill)   │
                       │  copy substrate → run Tier 1 + Tier 2   │
                       │  → emit jinn-release-evidence marker    │
                       └────────────────┬────────────────────────┘
                                        │ uses
                                        ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │   Persistent test-operator substrate                             │
   │   ~/jinn-dev/operators/op-{a,b,c-legacy}/  (gold copy)           │
   │   ~/jinn-dev/workspaces/<run-id>/op-{a,b}/  (per-run, ephemeral) │
   └──────────────────────────────────────────────────────────────────┘
                                        ▲
                                        │ uses
                       ┌─────────────────────────────────────────┐
                       │   testing-jinn-app  (existing, extended)│
                       │   spawn daemon(s) → drive via Playwright│
                       │   / chrome-devtools → assert            │
                       └─────────────────────────────────────────┘
```

### Three tiers of evidence

- **Tier 1** — single-operator mechanics on Anvil. Runs on every push to `next` (canary cadence). ~4 min budget. Catches bootstrap-reliability, harness-readiness, indexer-schema, and SPA-route regressions.
- **Tier 2** — cross-operator scenarios against substrate-derived workspaces (Anvil-fork). Runs in `release-prep`. ~15 min budget. Catches donation-handshake, producer/evaluator-loop, and multi-op SPA bugs.
- **Tier 3** — real Base Sepolia testnet, real Hermes, real verdict. Runs in `release-readiness` (human-invoked mode only). ~10 min, ~$0.10 API spend. **The only required gate for a named cut.**

### Architectural backbone

The substrate gets *copied* into a workspace at the start of each Tier 2 run. The gate never bootstraps. This single decision dissolves the failure modes that bit v0.1.6 — no Tenderly saturation, no Anvil stake-stalls, no Stage-1 timeouts under multi-bootstrap load.

### New artifacts on disk

- `~/jinn-dev/operators/op-{a,b,c-legacy}/` — gold-copy substrate (slow-changing, manually refreshed when contracts or schemas drift). **Adopted 2026-05-19 from existing fully-bootstrapped operators; details in §2.**
- `docs/release/<version>/release-prep-evidence.md` — gate output, marker-ready
- `docs/release/<version>/handoff.md` — release-readiness output, structured for human review

### Files this spec creates or modifies

| Path | New / modified | Purpose |
|---|---|---|
| `.claude/skills/testing-jinn-app/SKILL.md` | modified | Extend with multi-operator section |
| `.claude/skills/testing-jinn-app/references/*` | new | Multi-op recipes + scenario reference docs |
| `.claude/skills/release-prep/SKILL.md` | new | Mechanical gate-runner skill |
| `.claude/skills/release-prep/references/*` | new | Tier-1, Tier-2, evidence format, failure classification |
| `.claude/skills/release-readiness/SKILL.md` | new | Meta audit + triage + closure skill |
| `.claude/skills/release-readiness/references/*` | new | Static checklist, canon prompts, triage taxonomy, handoff template |
| `client/scripts/release/substrate-{adopt,copy,verify,topup}.ts` | new | Substrate lifecycle scripts |
| `client/test/release/tier-1/*.ts` | new | T1.1–T1.4 implementations |
| `client/test/release/tier-2/*.ts` | new | T2.1–T2.3 implementations |
| `client/test/release/tier-3/*.ts` | new | T3.1 implementation |
| `.github/workflows/npm-publish.yml` | modified | Replace `operator-gate` with Tier 1 scenarios |

## §2 Test-operator substrate

### Path layout

```
~/jinn-dev/
├── operators/                              # GOLD COPY — slow-changing, read-mostly
│   ├── op-a/                               # Launcher; adopted from ~/.jinn-client/
│   │   ├── manifest.json                   # identity, role, on-chain addresses
│   │   └── .jinn-client/
│   │       ├── config.json                 # apiPort=7332
│   │       ├── earning/                    # state + master keystore + launched SolverNet records
│   │       ├── keystore-password           # chmod 600
│   │       ├── disclaimer-acknowledged
│   │       ├── installed-harnesses.json
│   │       └── operator-mcp-config.json
│   ├── op-b/                               # Participant; adopted from ~/jinn-canary-test/home/.jinn-client/
│   │   ├── manifest.json
│   │   └── .jinn-client/                   # apiPort=7333
│   └── op-c-legacy/                        # Legacy-backup; adopted from ~/.jinn-testnet-acceptance/
│       ├── manifest.json
│       └── .jinn-client/                   # apiPort=7334, pre-fleet bootstrap shape
└── workspaces/                             # PER-RUN — copied from gold, torn down after
    └── <run-id>/
        ├── op-a/
        └── op-b/
```

The substrate lives outside any git checkout (survives worktree deletes). Each operator has a `manifest.json` capturing its identity, role, on-chain bindings, and the substrate-version it was generated under.

### Manifest schema

```json
{
  "substrateVersion": "1",
  "createdAt": "2026-05-19T14:47:19Z",
  "adoptedFrom": "~/.jinn-client/",
  "name": "op-a",
  "shape": "current",                       // "current" | "pre-fleet"
  "role": "launcher",                       // "launcher" | "participant" | "legacy-backup"
  "network": "base-sepolia",
  "operator": {
    "masterAddress": "0xE64bAf00...",
    "fleetAgentId": "5474",
    "fleetSafeAddress": "0x0e767E28...",
    "fleetStage": "stage1_and_2",
    "serviceId": 46,
    "serviceStep": "complete",
    "agentEoa": "0x63192d38...",
    "safeAddress": "0x0e767E28...",
    "mechAddress": "0x9c415369...",
    "stakingAddress": "0x24e34E50...",
    "identityRegistry": "0x8004A818..."
  },
  "config": {
    "apiPort": 7332,
    "rpcUrl": "https://base-sepolia.gateway.tenderly.co/...",
    "joinedSolverNets": ["bafkrei..."]
  }
}
```

### Adopted substrate (as of 2026-05-19)

The substrate exists. Adoption was performed during this spec's brainstorm and committed before writing the doc.

| Op | Source | Master | AgentId | Service | Shape | Role | apiPort |
|---|---|---|---|---|---|---|---|
| op-a | `~/.jinn-client/` | `0xE64bAf00...` | 5474 | 46 | current | launcher | 7332 |
| op-b | `~/jinn-canary-test/home/.jinn-client/` | `0x09040a87...` | 5941 | 56 | current | participant | 7333 |
| op-c-legacy | `~/.jinn-testnet-acceptance/.jinn-client/` | `0xC1494C7F...` | — | 26 | pre-fleet | legacy-backup | 7334 |

Total disk cost: 88KB across all three (no `engine/work/` cache included). Each op holds only the minimum to spawn a daemon at the right identity: config, earning state, keystores, password, and the lightweight acknowledgement files.

### Lifecycle operations

| Script | Purpose | When |
|---|---|---|
| `substrate-adopt.ts` | Copy from existing operator dirs into gold | One-time per substrate refresh |
| `substrate-copy.ts` | Per-run workspace copy from gold | Start of every Tier 2 run |
| `substrate-verify.ts` | Manifest + on-chain health check | Start of every release-prep / release-readiness run |
| `substrate-topup.ts` | Top up Tier 3 funding (ETH + USDC) | Pre-Tier-3 check |
| `substrate-snapshot.ts` | Bootstrap fresh from scratch (rare) | Deferred — only when adopt + upgrade can't recover |

### Workspace lifecycle

Each Tier 2 run gets `<run-id> = YYYY-MM-DDTHH-MM-SS-<rand4>`. `substrate-copy.ts` copies op-a and op-b into `~/jinn-dev/workspaces/<run-id>/`. Scenarios run against the workspace; gold copy is never touched. At end of run, the workspace is `rm -rf`'d. A background reaper auto-prunes workspaces older than 7 days at the start of every release-prep run.

### Tier 3 substrate use

Tier 3 (real testnet) does **not** copy. It runs daemons directly against the gold copy because the on-chain identity in the gold copy *is* the real-Base-Sepolia identity. Mutations are limited to append operations (task post, solve, verdict). Funding drains and is replenished by `substrate-topup.ts`.

### Mutual exclusion with daily-driver daemon

Substrate operators share their on-chain identity with the daily-driver operator at `~/.jinn-client/` (op-a's source) and `~/jinn-canary-test/...` (op-b's source). Running a substrate daemon on real Base Sepolia while the daily driver is also running results in two daemons fighting for the same nonce/claim/Safe. Rules:

- **Tier 3 (real testnet):** human-invoked mode SIGTERMs daily-driver daemons before Phase 5, restarts after. Autonomous mode skips Tier 3 if daily drivers running.
- **Tier 2 (Anvil-fork):** safe to run alongside daily driver. Fork is sandboxed.
- **Tier 1:** no substrate, no conflict.

Detection: `release-readiness` Phase 1 checks ports 7331/7332 on localhost.

### Refresh policy

The gold copy is regenerated when `substrate-verify` reports drift: contracts moved, schema changed, or substrate operator lost staking status. Regeneration is deliberate (manual or scripted via `substrate-snapshot`), not automatic — a fresh substrate burns testnet OLAS bond and shifts agentIds.

## §3 release-prep skill

### Skill location

```
.claude/skills/release-prep/
├── SKILL.md
└── references/
    ├── tier-1-scenarios.md
    ├── tier-2-scenarios.md
    ├── evidence-format.md
    └── failure-classification.md
```

### Input contract

```typescript
interface ReleasePrepInput {
  branchSha: string;
  candidateVersion: string;
  substrateRoot?: string;               // default: ~/jinn-dev/operators/
  scenarios?: ScenarioId[];             // optional override; default: all enabled
  outputDir?: string;                   // default: docs/release/<candidateVersion>/
  parallelism?: number;                 // default: 4
}
```

Invocable three ways: from `release-readiness` (subagent dispatch), from a human (`Skill release-prep ...`), or from a future cron. Same contract.

### Five-phase process

```
1. Preflight
   ├─ checkout branchSha into a worktree
   ├─ build the client (yarn build)
   ├─ verify substrate health
   │  └─ FAIL: emit "substrate stale, re-adopt" and stop
   └─ allocate run-id

2. Tier 1 — fan out (parallel, no substrate, ~90s wall-clock)
   ├─ subagent: T1.1 bootstrap-fresh-anvil (90s budget)
   ├─ subagent: T1.2 harness-readiness-contract (30s budget)
   ├─ subagent: T1.3 indexer-round-trip (60s budget)
   ├─ subagent: T1.4 SPA route smoke (30s budget)
   └─ collect verdicts

3. Tier 2 — fan out (parallel, substrate-derived workspaces, ~5min wall-clock)
   ├─ substrate-copy op-a + op-b into per-scenario workspaces
   ├─ subagent: T2.1 cross-operator-donation (5min budget)
   ├─ subagent: T2.2 producer-evaluator-anvil-fork (5min budget)
   ├─ subagent: T2.3 multi-op SPA flow (5min budget)
   └─ collect verdicts; tear down workspaces

4. Synthesis
   ├─ aggregate verdicts (pass / skip:<reason> / fail:<class>)
   ├─ classify each fail: real-bug | flake-infra | flake-timing | agent-crash
   ├─ write evidence doc: docs/release/<candidateVersion>/release-prep-evidence.md
   └─ emit marker block to stdout

5. Cleanup
   └─ remove worktree, reap any orphaned workspaces
```

### Subagent dispatch model

Each scenario runs as a separate subagent. Per-scenario workspace isolation (each scenario gets its own copy of the substrate) so parallel scenarios don't share daemon state. Subagent receives worktree path, scenario reference doc, workspace path, output path. Reports back a structured verdict:

```json
{
  "scenarioId": "T2.1",
  "verdict": "pass" | "skip:<reason>" | "fail:<class>",
  "wallClockMs": 312000,
  "evidencePath": "docs/release/v0.1.7/release-prep-evidence/T2.1.log",
  "failClass": null | "real-bug" | "flake-infra" | "flake-timing" | "agent-crash",
  "failNotes": "..."
}
```

### Failure classification

| Class | Detection | Action |
|---|---|---|
| substrate stale | substrate-verify before fan-out | block run, instruct re-adopt |
| scenario timeout | wall-clock budget exceeded | mark `fail:flake-timing`, save evidence |
| scenario RPC error | error message regex (HTTP / network / timeout) | retry once; mark `fail:flake-infra` if second fails |
| scenario assertion fail | non-flake error | mark `fail:real-bug`, save evidence |
| workspace teardown fails | rm error | log to reaper, don't block run |
| subagent crashes | Agent tool error | mark `fail:agent-crash`, save partial evidence |

`flake-*` and `agent-crash` verdicts pass through informationally; they don't block ship by themselves. `real-bug` blocks. `release-readiness` has final say.

### Evidence output

`docs/release/<candidateVersion>/release-prep-evidence.md` plus per-scenario log files under `release-prep-evidence/`. The summary doc embeds a marker block (extends the current `jinn-release-evidence:v1` schema) with per-scenario keys ready to paste into the GitHub Release body.

### Explicit non-goals

- Tier 3 (real testnet) — owned by release-readiness.
- Triage (blocking-vs-deferrable classification of findings) — owned by release-readiness.
- Gap closure — owned by release-readiness.
- Human handoff — owned by release-readiness.

## §4 release-readiness skill

### Skill location

```
.claude/skills/release-readiness/
├── SKILL.md
└── references/
    ├── static-checklist.md
    ├── canon-audit-prompts.md
    ├── triage-taxonomy.md
    ├── handoff-doc-template.md
    ├── tier-3-scenario.md
    └── autonomous-vs-invoked.md
```

### Input contract

```typescript
interface ReleaseReadinessInput {
  candidateVersion: string;
  branchSha: string;
  lastReleasedSha?: string;             // diff anchor; defaults to v<prev> tag
  mode: "human-invoked" | "autonomous";
  substrateRoot?: string;
  outputDir?: string;
  forceShip?: boolean;                  // emergency override, logged in handoff
}
```

### Subagent-first design principle

Main agent is a thin coordinator. Anything requiring non-trivial context (canon doc, code section, PR diff, daemon log) runs as a subagent. Main agent only sees structured verdicts. Per-run subagent count: ~6-9 fixed plus one per blocking gap. Main agent's working context stays ~50K tokens regardless of release size.

| Operation | Where | Why |
|---|---|---|
| Phase 1 setup (git diff, gh issue queries, substrate-verify) | main | Pure command output |
| Phase 2 mechanical checks (C2, C5, C6, C9 — grep/AST) | main | No context loading |
| Phase 2 judgmental + canon pass (C1, C3, C4, C7, C8, C10, C11 + all canon docs) | **1 subagent** | Cross-cutting findings benefit from unified reasoning |
| Phase 3 triage (classify all gaps) | **1 subagent** | Relative priority across gaps requires unified view |
| Phase 4 closure (fix + PR) | **1 subagent per gap** | Inherently independent work |
| Phase 4 PR review per closure | **1 subagent per PR** | Loads PR diff |
| Phase 5 release-prep | **subagent (the skill itself)** | Already its own skill |
| Phase 5 Tier 3 scenario | **1 subagent** | Long-running |
| Phase 6 handoff doc drafting | **1 subagent** | Composes output |
| Phase 6 SHIP/DEFER/BLOCK decision | main | Terminal judgment stays in main |
| Phase 7 terminal | main | One-shot notification |

### Seven-phase process

```
Phase 1: Setup
  ├─ resolve diff: git log lastReleasedSha..branchSha
  ├─ load canon: PRINCIPLES.md, SPEC.md, BRAND.md, GROWTH.md, GLOSSARY.md
  ├─ load operational memory (file-based memory directory)
  ├─ query open release-blocker issues: gh issue list --label release-blocker
  └─ verify substrate health

Phase 2: Audit
  ├─ main runs mechanical checks: C2 / C5 / C6 / C9 (grep/AST)
  ├─ dispatch judgmental audit subagent (full diff + all canon + check items)
  └─ collect unified findings list

Phase 3: Triage
  ├─ dispatch triage subagent
  ├─ subagent classifies each gap; surfaces cross-cutting concerns
  ├─ ALREADY-MET: link to evidence
  ├─ DEFERRABLE: emit gh issue create shell with proposed labels/milestone
  └─ BLOCKING: queue for Phase 4

Phase 4: Closure (skipped if no BLOCKING)
  ├─ For each BLOCKING gap, dispatch closure subagent in parallel
  ├─ Subagent reports: PR URL or escalate=true with reason
  ├─ For each PR: dispatch PR-review subagent
  ├─ Main: cross-account merge via dual-account flow if approved
  └─ After 3 failed close attempts on same gap: BLOCKING-ESCALATED
       gap remains BLOCKING; recommendation shifts to DEFER

Phase 5: Validate
  ├─ Invoke release-prep skill with branchSha
  ├─ Invoke Tier 3 scenario subagent
  └─ Aggregate

Phase 6: Synthesize
  ├─ Dispatch handoff-doc-drafting subagent
  ├─ Main determines recommendation:
  │    SHIP   if all BLOCKING closed AND Tier 3 passed
  │    DEFER  if BLOCKING escalated OR Tier 3 failed AND independent evidence weak
  │    BLOCK  if Tier 3 produced a clear regression
  ├─ Write final handoff to docs/release/<candidateVersion>/handoff.md
  ├─ Emit final marker block
  └─ Append one-line entry to log/decisions/release-readiness-runs.md

Phase 7: Terminal
  ├─ human-invoked: emit "handoff at <path>; recommendation: SHIP/DEFER/BLOCK"
  └─ autonomous: gh issue create --label release-ready ...
```

### Static checklist (C1-C11)

| # | Concern | Triggers when… | Where it runs |
|---|---|---|---|
| C1 | operator-app-principle | diff touches `client/src/dashboard/` or operator-facing copy | judgmental subagent |
| C2 | bootstrap-phase change | diff touches `client/src/earning/bootstrap.ts` | main (grep) |
| C3 | per-harness readiness | new harness or auth flow change | judgmental subagent |
| C4 | eval admission / verdict recheck | diff touches eval admission or substrate hashing | judgmental subagent |
| C5 | task admission filter | diff touches floor / DiscoveryAPI filter / claim eligibility | main (grep) |
| C6 | canon doc movement | diff touches PRINCIPLES.md / SPEC.md / BRAND.md / GROWTH.md / GLOSSARY.md | main (grep) |
| C7 | memory invariant violation | diff contradicts stored memory file | judgmental subagent |
| C8 | wiring-seam coverage | value computed in 2+ modules without single-source helper | judgmental subagent |
| C9 | release-evidence marker schema | diff touches `.github/workflows/npm-publish.yml` marker check | main (grep) |
| C10 | spec freshness | spec referenced in code no longer matches code | judgmental subagent |
| C11 | skill currency | diff touches operator-facing UI / CLI verbs / public surfaces | judgmental subagent |

C11 is the recursion that keeps the system honest. Every release sweeps `.claude/skills/*/SKILL.md` against the diff. Drift is BLOCKING if the skill makes false claims about changed surface (operator hits a wall), DEFERRABLE otherwise.

### Triage taxonomy

**BLOCKING:** PRINCIPLES.md violation introduced by branch, operator-app-principle violation in new UI copy, canon doc moved without ratification, bootstrap/auth/eval substrate regression, wiring-seam drift introduced, Tier 3 regression, skill makes false claims about changed surface.

**DEFERRABLE:** Spec-drift in unreferenced area, pre-existing open issue, quality-of-life concerns, Tier 1/2 flake-class failures, skill doesn't yet cover new surface but existing surface accurate, anything previously triaged as "next release."

**ALREADY-MET:** Static check passed without finding, concern covered by existing test/spec, concern resolved by a commit in window.

### Closure flow

For each BLOCKING gap, dispatch subagent: "investigate, propose fix, implement on a worktree branch off `next`, add regression test, push, file PR." Main agent reads PR-review subagent's report and cross-account approves. Three escalations on same gap shifts recommendation to DEFER.

Cross-account flow: closure subagent pushes as `ritsuKai2000`; main agent does cross-account approve via `ritsukai`. Author can't self-approve in GitHub.

**All issue tracking uses `gh issue` with structured labels and milestones. bd is not used in this skill.**

### Tier 3 scenario

The load-bearing real-testnet evidence — codified A3 verification.

Pre-conditions: daily-driver daemons SIGTERM'd, substrate-topup verified, API key available.

Execution: spawn op-a + op-b daemons from gold substrate, op-a posts a small SWE-rebench v2 task, op-a claims and solves via real Hermes (real OpenRouter API, ~$0.05-$0.10), op-a delivers, op-b claims verdict request, runs real evaluator Docker image, scores, asserts verdictCode matches expected.

Output: tx hashes, IPFS CIDs, wall-clock time, cost, verdict, evidence path under `docs/release/<version>/tier-3-evidence/`.

Budgets: 10 min hard wall-clock, $0.25 API + 0.001 ETH cost cap.

Failure modes: daemon won't start → BLOCK with stderr; task post fails → BLOCK; solve times out → flake first attempt, BLOCK on second; verdict mismatches → REAL REGRESSION (recommendation = BLOCK).

### Handoff doc structure

```
# Release-readiness handoff — v0.1.7
Generated: <timestamp>
Branch SHA: <sha>
Mode: human-invoked | autonomous
Audited against last released: v0.1.6 @ <sha>
Run-id: <run-id>

## Recommendation: SHIP / DEFER / BLOCK
[reasoning]

## Diff under audit
[PRs in window, LOC, surfaces touched]

## Gap log
### Blocking — CLOSED
### Deferrable — FILED (GitHub issues with milestones)
### Already met

## release-prep evidence
[embedded marker block]

## Tier 3 evidence
[scenario, harness, verdict, tx hashes, IPFS CIDs, cost, wall-clock]

## Walk-through script for human pass
[diff-derived must-checks by surface]

## Open questions for human

## Independent evidence
[any out-of-band signal]

## Marker block (final)
[extends jinn-release-evidence:v1 with tier-3-* and release-readiness-* keys]
```

### Marker schema extension

The current `jinn-release-evidence:v1` marker gains new keys:

- `tier-1-bootstrap=passed|skipped:#<issue>|failed`
- `tier-1-harness-readiness=...`
- `tier-1-indexer-roundtrip=...`
- `tier-1-spa-route-smoke=...`
- `tier-2-cross-op-donation=...`
- `tier-2-producer-evaluator=...`
- `tier-2-multi-op-spa-flow=...`
- `tier-3-producer-evaluator-real=...`
- `release-readiness-recommendation=SHIP|DEFER|BLOCK`
- `release-readiness-handoff=docs/release/v0.1.7/handoff.md`
- `release-readiness-run=<run-id>`

The current keys (`release-client-prepare`, `donation-consumption`, `app-first-testnet-acceptance`) are superseded by the per-scenario keys. Migration is one workflow edit + one decision-log entry.

### GitHub labels

Three new labels needed on the repo:
- `release-readiness` — issues filed by the skill (informational, tracks runs)
- `release-blocker` — gaps blocking the current cut
- `skill-drift` — C11 findings on SKILL.md outdatedness

GitHub Milestones (`v0.1.8`, `v0.1.9`, etc.) supply target-release semantics for deferrable gaps.

### Autonomous vs human-invoked

**Human-invoked mode:** Daily-driver daemons SIGTERM'd before Tier 3, restarted after. Tier 3 runs. Cost budget permissive. Phase 7 ends with "handoff ready at `<path>`."

**Autonomous mode:** Daily-driver daemons not touched. Tier 3 SKIPPED if daily drivers running. If skipped, recommendation is `INSUFFICIENT-EVIDENCE-FOR-SHIP; needs human-invoked re-run`. Cost budget tighter. Phase 7 ends with a GitHub issue.

### Integration with existing release cadence

Current state (no cron yet):

```
Friday evening (manual):
  human invokes: Skill release-readiness --candidateVersion v0.1.7 --mode autonomous
  skill runs over weekend (audit + closure + release-prep; Tier 3 SKIPPED)
  Saturday/Sunday: GH issue filed when complete
  handoff doc lands at docs/release/v0.1.7/handoff.md

Monday morning:
  human reads handoff
  if all looks good: re-invoke with --mode human-invoked for Tier 3
  Tier 3 runs (~10 min)
  handoff doc updates with verdict
  human decides SHIP/DEFER/BLOCK
  human publishes (or doesn't)
```

Future (cron, follow-up GH issue):

```
Friday 23:00 UTC: GH Actions cron fires autonomous mode
  workflow runs the skill against next HEAD
  posts handoff doc as a comment on the existing Monday-draft GH Release
Monday: human picks up, runs human-invoked for Tier 3, decides
```

### Explicit non-goals

- Publishing the release (always advisory)
- Modifying canon docs unilaterally
- Re-running release-prep gates when they already ran against the same SHA
- Killing operator daemons in autonomous mode
- Running Tier 3 in autonomous mode
- Using bd (all issue tracking via `gh issue`)

## §5 testing-jinn-app extension

The existing skill at `.claude/skills/testing-jinn-app/SKILL.md` covers single-operator dashboard testing. It stays unchanged for those use cases. This section adds a multi-operator section and reference docs.

### New section in SKILL.md: "Multi-operator scenarios"

Covers the substrate-anchored spawn pattern, port management, chrome-devtools multi-page driving, Playwright multi-op test templates.

### New reference docs

```
.claude/skills/testing-jinn-app/references/
├── multi-op-spawn.md
├── multi-op-chrome-devtools.md
├── multi-op-playwright.md
├── scenario-cross-op-donation.md            # T2.1 recipe
├── scenario-producer-evaluator.md           # T2.2 recipe
├── scenario-spa-route-smoke.md              # T1.4 recipe
└── scenario-multi-op-spa-flow.md            # T2.3 recipe
```

### Multi-operator spawn pattern

Substrate-derived workspaces, distinct ports per op (7332/7333/7334), per-daemon handshake URL capture, trap-based teardown.

### Failure modes added to "Things to watch for"

- Cross-operator visibility lag (op-b sees op-a's actions only after indexer catch-up)
- Identity collisions (two daemons with same HOME = same on-chain identity = nonce conflict)
- Workspace bleed (workspaces auto-pruned at 7 days; don't assume persistence between runs)
- Substrate staleness (run substrate-verify before any multi-op session)
- RPC saturation under concurrent load (one shared Tenderly key; add jittered delays in RPC-heavy multi-op scenarios)

### What stays unchanged

Single-op manual smoke (chrome-devtools), single-op Playwright E2E (route-mocked), "rebuild before test," `/v1/bootstrap` readiness wait, handshake-URL-per-spawn, mocking taxonomy.

### Relationship to release-prep and release-readiness

```
testing-jinn-app          provides the building blocks (recipes)
       │
       │ scenarios consumed by
       ▼
release-prep              runs scenarios as gates, emits marker
       │
       │ marker consumed by
       ▼
release-readiness         audits, triages, runs Tier 3, hands off
```

testing-jinn-app is the **library**. release-prep is the **gate runner**. release-readiness is the **audit + decision skill**. Scenarios are written once in testing-jinn-app and consumed by release-prep — no duplication.

## §6 Scenario inventory (consolidated)

| ID | Tier | Name | Substrate | Lives in | Catches | Wall-clock |
|---|---|---|---|---|---|---|
| T1.1 | 1 | bootstrap-fresh-anvil | no | `client/test/release/tier-1/T1.1.ts` | u34i / h74p / k1ng bootstrap reliability | 90s |
| T1.2 | 1 | harness-readiness-contract | no | `client/test/release/tier-1/T1.2.ts` | vh74 per-harness auth regressions | 30s |
| T1.3 | 1 | indexer-round-trip | no | `client/test/release/tier-1/T1.3.ts` | fufn eval-substrate, indexer schema drift | 60s |
| T1.4 | 1 | SPA route smoke | no | `client/test/dashboard/release-prep/spa-route-smoke.e2e.test.ts` | broken routes, missing mocks, JS errors | 30s |
| T2.1 | 2 | cross-operator-donation | yes | `client/test/release/tier-2/T2.1.ts` | x402 + ERC-8128 handshake regressions | 5m |
| T2.2 | 2 | producer-evaluator-anvil-fork | yes | `client/test/release/tier-2/T2.2.ts` | claim → solve → deliver → evaluate loop | 5m |
| T2.3 | 2 | multi-op SPA flow | yes | `client/test/dashboard/multi-op/launcher-join-flow.e2e.test.ts` | cross-op UI bugs invisible under mocks | 5m |
| T3.1 | 3 | producer-evaluator real-testnet | yes (gold, no copy) | `client/test/release/tier-3/T3.1.ts` | load-bearing real-network verdict | 10m |

**Budget vs expected wall-clock.** Scenarios within a tier run in parallel (each in its own subagent + workspace), so wall-clock for a tier is the *max* of its scenarios, not the sum. Budget is the cap (timeout) per scenario.

- Tier 1 — budget per scenario: 90s; tier wall-clock (parallel max): ~90s
- Tier 2 — budget per scenario: 5min; tier wall-clock (parallel max): ~5min
- Tier 3 — single scenario, sequential: ~10min

release-prep wall-clock (Tier 1 + Tier 2 parallel) ≈ 6-7 min. release-readiness end-to-end (release-prep + Tier 3 + audit + closure for a clean release) ≈ 25-35 min.

## §7 Lifecycle, error handling, edge cases

### Substrate funding maintenance (Tier 3)

| Resource | Per op | Top-up trigger | Source |
|---|---|---|---|
| ETH | 0.005 | < 0.002 | Base Sepolia faucet / release-bot wallet |
| USDC | 1.00 | < 0.10 | manual seed, then x402 cycles |
| OLAS bond | constant | never drains | staked once at substrate creation |

`substrate-topup.ts` runs at start of Tier 3. If balances below threshold, attempts faucet drip; if drained, blocks with operator-app-principle-style escalation.

### Recovery from interrupted runs

No resume. If interrupted, restart from Phase 1. Phases 1-3 are cheap (~5 min). Phase 4 PRs left mid-air can be picked up manually; agent re-audits. Phase 5 is idempotent. Phase 6/7 is a function of inputs.

### API key budget for Tier 3

Per-run cost ~$0.05-$0.10. Weekly cadence ~$0.40-$0.80 / month autonomous + ~$0.20-$0.40 human-invoked. Per-run cap: $0.25 in Tier 3 scenario; abort if exceeded.

### Workspace garbage collection

Trap-handler teardown at end of every run. Background reaper auto-deletes workspaces older than 7 days at start of every release-prep run. Workspaces tagged with `.created-by` for orphan detection.

### Skill-self-update recursion

When release-readiness audits a diff touching its own SKILL.md or references, C11 fires. The skill audits itself. Closure flow dispatches subagent to update the SKILL.md in the same PR.

### Cron not yet wired

Captured as follow-up GitHub issue: "Wire release-readiness autonomous-mode to a Friday 23:00 UTC GitHub Actions schedule." Until that lands, weekend invocation is manual.

## §8 Testing the meta-system

### Unit-ish tests for the skill's own functions

- `client/test/release-skill/audit.test.ts` — known diff + canon corpus, assert findings match expected.
- `client/test/release-skill/triage.test.ts` — known findings, assert classifications.
- `client/test/release-skill/handoff-doc.test.ts` — known inputs, assert doc structure.

### Mock canon + diff fixtures

`client/test/release-skill/fixtures/` — one fixture per checklist item plus cross-cutting cases.

### Smoke run against known-good release

Retrospectively run the skill against `v0.1.6`. Expected: recommendation = SHIP, deferrable gaps match what we actually filed (#320, etc.). Catches regressions in the skill itself.

### What's hard to test

The judgmental subagent's reasoning. Fixtures assert *structure* (right number of findings, right severity buckets), not specific reasoning text. Regression-on-known-good catches signal degradation.

## §9 Open questions and acknowledged limitations

### Open questions (resolve in implementation or later)

1. **PRINCIPLES.md vs memory conflict resolution.** PRINCIPLES.md is privileged canon; memory is operational guidance below. Edge cases will emerge.
2. **What counts as "blocking" for skill-drift.** Clear cases at the extremes; middle ground needs judgment captured in `references/triage-taxonomy.md`.
3. **How long to keep handoff docs.** Forever, probably. Archive policy deferred until volume justifies.
4. **Migration path for older releases.** No retroactive migration; forward only.
5. **Hotfix flow integration.** Tentative: hotfixes skip release-readiness; post-incident GH issue files "audit this hotfix against canon retroactively."

### Acknowledged limitations

- Auto-trigger via cron not wired in v1 (follow-up GH issue).
- One shared Tenderly RPC key (jinn-mono-lrey tracks fix).
- Tier 3 cost accumulates ~$0.40-$0.80 / month.
- engine/work/ cleanup unresolved (#320).
- Substrate can drift silently between runs (`substrate-verify` catches at start).
- No concurrent release-candidate support in v1.

### What's *not* an acknowledged limitation

- Subagent reasoning fidelity — property of underlying tools; §8 catches signal degradation.
- "Gate caught a flake" failure mode — addressed by failure classification.
- "Ship without Tier 3 evidence" emergency case — handled by `forceShip` with audit log.

## Implementation notes

### Out of scope for this spec

- Cron wiring for autonomous-mode auto-trigger (separate GH issue).
- jinn-mono-lrey architectural fix (separate work).
- Engine/work/ cleanup #320 (separate work).
- Multi-version-in-flight support (defer until needed).
- Mainnet release-readiness flow (v0.1.x is testnet only; mainnet has different evidence requirements).

### Build sequence

A `writing-plans`-produced plan will sequence the implementation. Rough ordering by dependency:

1. Substrate lifecycle scripts (`substrate-adopt`, `substrate-copy`, `substrate-verify`, `substrate-topup`) — foundation for everything else.
2. testing-jinn-app extension (multi-op recipes, scenario reference docs) — building blocks release-prep consumes.
3. Tier 1 + Tier 2 scenario implementations (T1.1–T1.4, T2.1–T2.3).
4. release-prep skill + its SKILL.md and references.
5. Tier 3 scenario (T3.1).
6. release-readiness skill + its SKILL.md and references.
7. Workflow migration (`.github/workflows/npm-publish.yml` Tier 1 integration, marker schema extension).
8. Smoke run against v0.1.6 retrospectively.
9. First production use on v0.1.7.

Substrate adoption itself (the on-disk artifacts) was performed during this spec's brainstorm and is committed before doc finalization. See §2 inventory table.

## References

- `log/decisions/2026-05-19-v0.1.6-stewardship.md` — the v0.1.6 stewardship log that produced the empirical evidence motivating this design.
- `PRINCIPLES.md` — canon source of truth audited by release-readiness.
- `docs/engineering/handbook.md` §Cadence — two-train release cadence this skill integrates into.
- `spec/2026-04-28-canonical-docs.md` — canonical-docs policy referenced by C6.
- `docs/superpowers/specs/2026-04-24-test-architecture-design.md` — broader test architecture this spec composes with.
- GitHub issues: `jinn-mono-lrey` (RPC architecture), `#320` (engine/work cleanup), `#310` (donation-consumption), `#312`/`#313` (marker relaxation pattern), `#295`/`#296`/`#297`/`#300`/`#302`/`#304`/`#307`/`#308`/`#309` (v0.1.6 follow-ups).
