# release-readiness

Meta-skill. Audits a candidate release against canon, triages identified gaps, drives blocking-gap closure, invokes release-prep + Tier 3 for evidence, and emits a structured handoff doc that humans use to decide ship/defer/block. **Advisory, never blocking** — the skill produces a recommendation; humans (and future automation) make the final call.

Spec: `docs/superpowers/specs/2026-05-19-release-readiness-and-substrate-design.md` §4.

## When to use

- Manually invoked when a candidate version is in view (Friday evening / Saturday for a Monday cut).
- (Future) auto-triggered by a weekend GitHub Actions cron — separate follow-up.
- Never invoked as a subagent of release-prep; the dependency is the other way.

## Input contract

```typescript
interface ReleaseReadinessInput {
  candidateVersion: string;              // "v0.1.7"
  branchSha: string;                     // candidate SHA (usually next HEAD)
  lastReleasedSha?: string;              // diff anchor; defaults to v<prev> tag
  mode: "human-invoked" | "autonomous";
  outputDir?: string;                    // default: docs/release/<candidateVersion>/
  forceShip?: boolean;                   // emergency override, logged
}
```

## Subagent-first design

Main agent is a thin coordinator. Anything that requires loading non-trivial context (canon doc, PR diff, daemon logs) runs as a subagent. Main only sees structured verdicts.

| Operation | Where |
|---|---|
| Phase 1 setup (git diff, gh issue queries, substrate-verify) | main |
| Phase 2 mechanical checks (C2, C5, C6, C9 — grep/AST) | main |
| Phase 2 judgmental + canon pass (C1, C3, C4, C7, C8, C10, C11) | **1 subagent** |
| Phase 3 triage (classify all gaps) | **1 subagent** |
| Phase 4 closure (fix + PR) | **1 subagent per gap** |
| Phase 4 PR review per closure | **1 subagent per PR** |
| Phase 5 release-prep invocation | **release-prep skill** |
| Phase 5 Tier 3 scenario | **1 subagent invoking run-tier-3** |
| Phase 6 handoff doc drafting | **1 subagent** |
| Phase 6 SHIP/DEFER/BLOCK decision | main |
| Phase 7 terminal notification | main |

Per-run subagent count: ~6-9 fixed + N closure subagents (usually 0-3).

## Seven-phase process

```
Phase 1: Setup
  ├─ git diff lastReleasedSha..branchSha → resolve diff
  ├─ load canon: PRINCIPLES.md, SPEC.md, BRAND.md, GROWTH.md, GLOSSARY.md
  ├─ load operational memory from ~/.claude/projects/<project>/memory/
  ├─ gh issue list --label release-blocker
  └─ substrate-verify op-a op-b

Phase 2: Audit
  ├─ main: mechanical checks (C2/C5/C6/C9 grep + AST)
  ├─ dispatch judgmental audit subagent with full diff + all canon + check items
  │   See references/canon-audit-prompts.md for the prompt template.
  └─ collect findings list

Phase 3: Triage
  ├─ dispatch triage subagent with all findings
  │   See references/triage-taxonomy.md for the classification rules.
  ├─ subagent classifies BLOCKING / DEFERRABLE / ALREADY-MET
  ├─ for DEFERRABLE: subagent emits gh issue create shell with labels/milestone
  └─ for BLOCKING: queue for Phase 4

Phase 4: Closure (skip if no BLOCKING)
  ├─ for each BLOCKING gap, dispatch closure subagent in parallel
  ├─ subagent: investigate, fix on a worktree branch, push, file PR
  ├─ for each returned PR, dispatch PR-review subagent
  ├─ main: cross-account merge via dual-account flow if approved
  └─ 3 failed close attempts on same gap → BLOCKING-ESCALATED (recommendation → DEFER)

Phase 5: Validate
  ├─ Skill release-prep --branchSha=<sha> --candidateVersion=<v>
  │   reads back: marker block + per-scenario verdicts
  ├─ if mode === human-invoked:
  │     SIGTERM daily-driver daemons (ports 7331, 7332)
  │     tsx scripts/release/run-tier-3.ts <candidateVersion> human-invoked
  │     restart daily-driver daemons after
  │   else (autonomous):
  │     SKIP Tier 3 if daily-driver running; otherwise still SKIP
  │     (autonomous can't safely manage daemon mutex)
  └─ aggregate release-prep + Tier 3 verdicts

Phase 6: Synthesize
  ├─ dispatch handoff-doc-drafting subagent with all inputs
  ├─ subagent returns: structured doc draft
  ├─ main: determine recommendation
  │     SHIP   if all BLOCKING closed AND Tier 3 passed
  │     DEFER  if BLOCKING escalated OR Tier 3 failed AND independent evidence weak
  │            OR mode=autonomous AND Tier 3 skipped (INSUFFICIENT-EVIDENCE)
  │     BLOCK  if Tier 3 produced a clear regression vs last release
  ├─ writeHandoffDoc(...) — see scripts/release/release-readiness.ts
  └─ appendAuditTrailEntry(...) — log/decisions/release-readiness-runs.md

Phase 7: Terminal
  ├─ human-invoked: emit "handoff at <path>; recommendation: <X>"
  └─ autonomous: gh issue create --label release-ready --title "release-readiness completed for <v>" --body "review at <path>"
```

## Reference docs

- [`references/static-checklist.md`](references/static-checklist.md) — C1-C11 detailed shape
- [`references/canon-audit-prompts.md`](references/canon-audit-prompts.md) — subagent prompt templates
- [`references/triage-taxonomy.md`](references/triage-taxonomy.md) — classification rules
- [`references/handoff-doc-template.md`](references/handoff-doc-template.md) — output shape
- [`references/tier-3-scenario.md`](references/tier-3-scenario.md) — T3.1 contract
- [`references/autonomous-vs-invoked.md`](references/autonomous-vs-invoked.md) — mode differences

## Invocation

```bash
# Human-invoked (full flow including Tier 3 with real-network spend)
Skill release-readiness --candidateVersion v0.1.7 --mode human-invoked

# Autonomous (audit + closure + release-prep; Tier 3 SKIPPED)
Skill release-readiness --candidateVersion v0.1.7 --mode autonomous

# Emergency override (logs forceShip in handoff)
Skill release-readiness --candidateVersion v0.1.7 --mode human-invoked --forceShip
```

## What this skill deliberately does NOT do

- **Publish the release.** Always advisory.
- **Modify canon docs unilaterally.** Audit findings → GH issue, never silent rewrite.
- **Re-run release-prep gates when they already ran against this SHA.**
- **Kill operator daemons in autonomous mode.** Mutual exclusion is human-supervised.
- **Run Tier 3 in autonomous mode.** Cost/risk requires explicit consent.
- **Use bd.** All issue tracking via `gh issue`.
