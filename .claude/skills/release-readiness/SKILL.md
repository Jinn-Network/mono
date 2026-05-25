# release-readiness

Meta-skill. Audits a candidate release against canon, triages identified gaps, **drives every fixable blocker to closure on a single `release/<version>` integration branch** (test-infrastructure bugs included), invokes release-prep + Tier 3 for evidence against that branch, and emits a structured handoff doc.

**It drives — it does not merely advise.** The skill is advisory on exactly one thing: the final ship/defer/block *recommendation* (humans make that call; an agent never publishes). Everything fixable, it fixes — stacked as commits on one branch the human can check out and test as a whole. The only gaps left open are the ones an agent genuinely cannot close (e.g. a CODEOWNER ratification, a design decision), and those are named explicitly in the handoff. Do **not** emit a scatter of independent PRs the human cannot test together.

**Done means SHIP-ready.** The skill's target end-state is a green, ship-ready integration branch — not "a recommendation." `DEFER` and `BLOCK` are not normal outcomes; they are admissions the skill could not finish, permitted **only** after it has provably exhausted what an agent can do (a debug subagent root-caused the blocker and it genuinely needs a human, or 3 fix attempts failed). Reaching for `DEFER` because a problem was *found* is the exact failure mode this skill exists to prevent — a found problem is a problem to **drive to closure**, not to file.

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
| Phase 2 mechanical checks (C2, C5, C6, C9, C12 — grep/AST) | main |
| Phase 2 judgmental + canon pass (C1, C3, C4, C7, C8, C10, C11) | **1 subagent** |
| Phase 3 triage (classify all gaps) | **1 subagent** |
| Phase 4 closure (fix → commit on the integration branch) | **1 subagent per gap** |
| Phase 4 review per closure commit | **1 subagent per fix** |
| Phase 5 release-prep invocation | **release-prep skill** |
| Phase 5 Tier 3 scenario | **1 subagent invoking run-tier-3** |
| Phase 5 gate-failure debug + fix (root-cause → fix → re-run) | **1 subagent per failing gate** |
| Phase 6 handoff doc drafting | **1 subagent** |
| Phase 6 SHIP/DEFER/BLOCK decision | main |
| Phase 7 terminal notification | main |

Per-run subagent count: ~6-9 fixed + N closure subagents (usually 0-3).

## Seven-phase process

```
Phase 1: Setup + preflight
  ├─ git diff lastReleasedSha..branchSha → resolve diff
  ├─ load canon: PRINCIPLES.md, SPEC.md, BRAND.md, GROWTH.md, GLOSSARY.md
  ├─ load operational memory from ~/.claude/projects/<project>/memory/
  ├─ gh issue list --label release-blocker
  └─ preflight — fail fast HERE, not 40 min into a gate run:
       • client/.env present and the gate secrets resolvable
       • substrate-verify GREEN for op-a AND op-b
       • substrate provisioned for solving/evaluating (harness creds + evaluator
         admission pool) — run the substrate doctor (gh#531)
       • `yarn build` clean → dist/ current (tier scenarios spawn dist/bin/jinn.js)
     a preflight failure is a Phase-4 fixable blocker — fix it, do not skip the gate

Phase 2: Audit
  ├─ main: mechanical checks (C2/C5/C6/C9/C12 grep + AST)
  │   C12 — release-gate-scenario soundness: new/changed gate code (test/release/**,
  │   scripts/release/**) must reference interfaces that exist. Cross-ref every
  │   fetch()/route/contract call against the real surface. (T2.2/#350 + T3.1/#526
  │   both shipped gate scenarios calling HTTP routes that never existed.)
  ├─ dispatch judgmental audit subagent with full diff + all canon + check items
  │   See references/canon-audit-prompts.md for the prompt template.
  └─ collect findings list

Phase 3: Triage
  ├─ dispatch triage subagent with all findings
  │   See references/triage-taxonomy.md for the classification rules.
  ├─ subagent classifies BLOCKING / DEFERRABLE / ALREADY-MET
  ├─ for DEFERRABLE: subagent emits gh issue create shell with labels/milestone
  └─ for BLOCKING: queue for Phase 4

Phase 4: Closure — drive every fixable blocker onto ONE integration branch
  ├─ create release/<version> off next; every fix is a commit stacked on the prior
  ├─ for each BLOCKING gap, dispatch a closure subagent; review each fix
  ├─ also fix fixable test-infrastructure blockers surfaced here or in Phase 5 —
  │   a broken release gate IS a blocker; fix it, don't just file an issue
  ├─ a gap an agent genuinely cannot close (CODEOWNER ratification, a design
  │   decision) → leave for the human, named explicitly in the handoff
  ├─ 3 failed agent attempts on a fixable gap → BLOCKING-ESCALATED (rec → DEFER)
  └─ output is ONE integration branch + ONE PR — never a scatter of PRs

Phase 5: Validate — drive every gate to GREEN (not "run and report")
  ├─ Skill release-prep --branchSha=<integration-branch-tip> --candidateVersion=<v>
  ├─ if mode === human-invoked:
  │     SIGTERM daily-driver daemons (ports 7331, 7332); restart after
  │     cd client && set -a && . ./.env && set +a && unset JINN_PASSWORD
  │     tsx scripts/release/run-tier-3.ts <candidateVersion> human-invoked
  │   else (autonomous): SKIP Tier 3 (cannot safely manage the daemon mutex)
  ├─ FOR EACH gate not green — loop until green or provably-blocked:
  │   • a gate failure is a BLOCKER, never a finding to file
  │   • a `flake-*` classification is a HYPOTHESIS, not a verdict — the
  │     classifier only regex-matches the error string. PROVE it: re-run the
  │     scenario ISOLATED. Passes → flake. Fails again → real, debug it.
  │   • dispatch a gate-failure debug subagent: root-cause against GROUND TRUTH
  │     (subgraph, on-chain, the real interfaces) BEFORE touching code; then fix
  │     on the integration branch; rebuild; re-run the gate.
  │   • a gate failure may be classified DEFERRABLE *only* with a debug-subagent
  │     root-cause report proving the cause is external / non-code. No root-cause
  │     report → it cannot be deferred. 3 failed fix attempts → BLOCKING-ESCALATED.
  └─ exit only when every gate is green, or a proven flake with a filed follow-up

Phase 6: Synthesize
  ├─ dispatch handoff-doc-drafting subagent with all inputs
  ├─ subagent returns: structured doc draft
  ├─ main: determine recommendation
  │     SHIP   if all gaps closed AND all closure code reviewed AND every gate is
  │            green OR an isolated-retry-PROVEN flake with a filed follow-up —
  │            i.e. the integration branch is genuinely ship-ready
  │     DEFER  only if a blocker is BLOCKING-ESCALATED (agent provably cannot
  │            close it) OR mode=autonomous AND Tier 3 skipped. A DEFER must name
  │            exactly what was not finished and why an agent could not finish it.
  │     BLOCK  if a gate produced a clear regression vs last release
  ├─ writeHandoffDoc(...) — see scripts/release/release-readiness.ts
  └─ appendAuditTrailEntry(...) — log/decisions/release-readiness-runs.md

Phase 7: Terminal
  ├─ human-invoked: emit "handoff at <path>; recommendation: <X>"
  └─ autonomous: gh issue create --label release-ready --title "release-readiness completed for <v>" --body "review at <path>"
```

## Reference docs

- [`references/static-checklist.md`](references/static-checklist.md) — C1-C12 detailed shape
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
