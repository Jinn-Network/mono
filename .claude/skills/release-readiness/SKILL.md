# release-readiness

Meta-skill. **Orchestration + judgment + verdict-reading** — it does not run tests on a laptop. It resolves the candidate SHA, audits it against canon (C1–C12), triages gaps, **drives every fixable blocker to closure on a single `release/<version>` integration branch** (test-infrastructure bugs included), dispatches the **environment-suite** workflow on the candidate SHA, reads the resulting SHA-bound check-runs (`hermetic-gate` + `environment-suite`), debugs any red gate, and emits a structured handoff doc.

**Two gates verify the release; this skill never re-runs them.** Per the two-gate redesign (`docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md`), validation lives in CI: the **hermetic gate** (`.github/workflows/hermetic-gate.yml`, deterministic, per-PR) proves the code is correct; the **environment suite** (`.github/workflows/environment-suite.yml`, real testnet, gates the cut) proves it works in the real world. Each posts a check-run bound to the commit SHA. release-readiness *reads* those verdicts; it does not execute the tests itself. The Tier 1/2/3 ladder is retired.

**It drives — it does not merely advise.** The skill is advisory on exactly one thing: the final ship/defer/block *recommendation* (humans make that call; an agent never publishes). Everything fixable, it fixes — stacked as commits on one branch the human can check out and test as a whole. The only gaps left open are the ones an agent genuinely cannot close (e.g. a CODEOWNER ratification, a design decision), and those are named explicitly in the handoff. Do **not** emit a scatter of independent PRs the human cannot test together.

**Done means SHIP-ready.** The skill's target end-state is a green, ship-ready integration branch — not "a recommendation." `DEFER` and `BLOCK` are not normal outcomes; they are admissions the skill could not finish, permitted **only** after it has provably exhausted what an agent can do (a debug subagent root-caused the blocker and it genuinely needs a human, or 3 fix attempts failed). Reaching for `DEFER` because a problem was *found* is the exact failure mode this skill exists to prevent — a found problem is a problem to **drive to closure**, not to file. Note: an **infra-blocked** gate (warm operator unhealthy / `CLAUDE_CODE_OAUTH_TOKEN` expired / RPC 429 after retry) is **not** a product red — it is an infrastructure problem to fix (spec §10/§11), reported distinctly, never misclassified as a product pass or fail.

Spec: `docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md` §12 (what the skills become), §7 (evidence flow), §10 (failure-loop semantics).

## When to use

- Manually invoked when a candidate version is in view (Friday evening / Saturday for a Monday cut) — this is the authoritative env-suite run on the candidate SHA (spec §8).
- (Future) auto-triggered by a weekend GitHub Actions cron — separate follow-up.
- It dispatches `environment-suite.yml` and reads check-runs; it does not invoke `release-prep` (whose mechanical run-role is retired — see that skill's superseded note).

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
| Phase 5 dispatch + poll the two check-runs | main |
| Phase 5 gate-failure debug + fix (root-cause → fix → re-dispatch) | **1 subagent per failing gate** |
| Phase 6 handoff doc drafting | **1 subagent** |
| Phase 6 SHIP/DEFER/BLOCK decision | main |
| Phase 7 terminal notification | main |

Per-run subagent count: ~4-6 fixed + N closure subagents (usually 0-3) + 1 debug subagent per red gate (usually 0-1). The Phase-5 dispatch/poll is main-driven, not a subagent.

## Seven-phase process

```
Phase 1: Setup + preflight
  ├─ resolve candidate SHA (usually next HEAD); record it — the gates bind to it
  ├─ git diff lastReleasedSha..branchSha → resolve diff
  ├─ load canon: PRINCIPLES.md, SPEC.md, BRAND.md, GROWTH.md, GLOSSARY.md
  ├─ load operational memory from ~/.claude/projects/<project>/memory/
  ├─ gh issue list --label release-blocker
  └─ preflight — fail fast HERE, before dispatching the env workflow:
       • the candidate SHA is pushed to a ref CI can see (next / release/<v>)
       • the hermetic-gate check-run is already present-and-green on the SHA
         (it runs per-PR/push — if it is missing or red, that is the first gate
         to drive, no point dispatching the env suite yet)
     the env-suite secrets + warm operator live in CI's testnet-gate Environment,
     not on this machine — there is no laptop .env/substrate to preflight anymore

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

Phase 5: Validate — read two SHA-bound check-runs; drive any red to GREEN
  ├─ the candidate SHA is the integration-branch tip (push release/<v> first if
  │   Phase 4 added commits — a new SHA rebinds the gates, by design)
  ├─ hermetic-gate: confirm it is present-and-green ON THE CANDIDATE SHA. It runs
  │   per-PR/push, so it should already exist; if missing/red, drive it first.
  ├─ environment-suite: workflow_dispatch .github/workflows/environment-suite.yml
  │   on the EXACT candidate SHA — this is the authoritative readiness run (spec
  │   §8). Then POLL for the `environment-suite` check-run on that SHA:
  │     gh run watch <id>  /  gh api .../commits/<sha>/check-runs
  │   It executes no laptop tests — the warm operator + secrets live in CI's
  │   testnet-gate Environment (spec §9/§11).
  ├─ FOR EACH check-run not green — loop until green or provably-blocked:
  │   • a product-red is a BLOCKER, never a finding to file
  │   • classify the verdict's failClass first (the verdict JSON carries it):
  │       – infra-blocked (warm operator unhealthy, OAuth expired, RPC 429 after
  │         retry, agent-transport error) → NOT a product red (spec §10/§11).
  │         Retry once; if persistent it blocks the cut as an INFRA problem to fix
  │         in the harness / warm operator — escalate to the warm-operator owner,
  │         never silently pass or fail it as product.
  │       – agent-answer-quality → hard only where ground truth exists; else soft.
  │         A flaky LLM never blocks.
  │       – product-red → debug it.
  │   • a `flake` classification is a HYPOTHESIS, not a verdict — PROVE it by
  │     isolated re-dispatch on the same SHA. Green → flake. Red again → real.
  │   • dispatch a gate-failure debug subagent: root-cause against GROUND TRUTH
  │     (indexer, on-chain, the real interfaces) BEFORE touching code; then fix on
  │     release/<v>; push (new SHA) and re-dispatch the env suite on the new SHA.
  │   • a product-red may be classified DEFERRABLE *only* with a debug-subagent
  │     root-cause report proving the cause is external / non-code. No root-cause
  │     report → it cannot be deferred. 3 failed fix attempts → BLOCKING-ESCALATED.
  └─ exit only when BOTH check-runs are green-for-the-candidate-SHA, or a proven
     flake with a filed follow-up, or a distinctly-reported infra-blocked stop

Phase 6: Synthesize
  ├─ dispatch handoff-doc-drafting subagent with all inputs
  ├─ subagent returns: structured doc draft
  ├─ main: determine recommendation
  │     SHIP   if all gaps closed AND all closure code reviewed AND BOTH
  │            check-runs (hermetic-gate + environment-suite) are
  │            green-for-the-candidate-SHA AND closure reviewed — i.e. the
  │            integration branch is genuinely ship-ready (spec §12). A
  │            check-run on a stale SHA does NOT count; the SHA must match.
  │     DEFER  only if a blocker is BLOCKING-ESCALATED (agent provably cannot
  │            close it) OR a persistent infra-blocked stop the warm-operator
  │            owner must resolve. A DEFER must name exactly what was not finished
  │            and why an agent could not finish it (and, for infra-blocked, who
  │            owns the fix).
  │     BLOCK  if a check-run produced a clear product regression vs last release
  ├─ writeHandoffDoc(...) — see scripts/release/release-readiness.ts. The handoff
  │   may include the human-readable marker artifact, but the marker is NOT the
  │   gate — the two SHA-bound check-runs are (spec §7). The publish guard
  │   (npm-publish.yml) queries them; nobody hand-types the verdict.
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
- [`references/tier-3-scenario.md`](references/tier-3-scenario.md) — historical Tier-3 contract; the real-world coverage it described now lives in `.github/workflows/environment-suite.yml` (spec §3.2/§6)
- [`references/autonomous-vs-invoked.md`](references/autonomous-vs-invoked.md) — mode differences

## Invocation

```bash
# Human-invoked (audit + closure; dispatches environment-suite.yml on the SHA,
# reads the two check-runs, debugs any red, synthesizes a recommendation)
Skill release-readiness --candidateVersion v0.1.7 --mode human-invoked

# Autonomous (same flow; the real-world suite runs in CI either way, so no
# laptop daemon mutex to manage — see references/autonomous-vs-invoked.md)
Skill release-readiness --candidateVersion v0.1.7 --mode autonomous

# Emergency override (logs forceShip in handoff)
Skill release-readiness --candidateVersion v0.1.7 --mode human-invoked --forceShip
```

## What this skill deliberately does NOT do

- **Publish the release.** Always advisory.
- **Modify canon docs unilaterally.** Audit findings → GH issue, never silent rewrite.
- **Run any test on a laptop.** Validation is two CI check-runs (hermetic-gate + environment-suite); this skill dispatches the env workflow and reads verdicts, it does not execute tests itself (spec §7/§12).
- **Re-run a gate that is already green-for-the-candidate-SHA.** Verify, don't re-run.
- **Hand-type the evidence marker.** The verdict is the projection of two SHA-bound check-runs; the marker is at most a human-readable artifact in the handoff.
- **Block on infra-blocked.** Warm-operator / OAuth / RPC-429 failures are reported distinctly and routed to the warm-operator owner, never misclassified as a product red (spec §10/§11).
- **Track issues on GitHub.** All issue tracking via `gh issue`.
