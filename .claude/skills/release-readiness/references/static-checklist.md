# Static checklist (C1-C11)

Mechanical checks that fire deterministically against the diff. Each item is either grep/AST-based (runs in main) or judgmental (dispatched to the judgmental audit subagent).

## C1 — operator-app-principle

**Triggers when:** diff touches `client/src/dashboard/` or operator-facing copy.

**Where:** judgmental subagent.

**The principle (from memory `operator-app-principle-oak-reiterated-2026-05-18`):** after the first `jinn run`, the operator should never have to leave the app. Any new error message instructing CLI re-runs is a violation.

**Subagent looks for:** new strings in the diff matching `(rerun|run again|jinn run)` in user-facing text, especially in panel components.

## C2 — bootstrap-phase change

**Triggers when:** diff touches `client/src/earning/bootstrap.ts` or phase definitions.

**Where:** main (grep).

**Why:** u34i / h74p / k1ng / 3nc5 all regressed bootstrap; high regression risk.

## C3 — per-harness readiness

**Triggers when:** new harness implementation added, or readiness flow changed.

**Where:** judgmental subagent.

**Subagent looks for:** any new file in `client/src/harnesses/impls/` that lacks an `isReady()` implementation; or changes to `client/src/api/server.ts` `/v1/harnesses/*` routes.

## C4 — eval admission / verdict recheck

**Triggers when:** diff touches eval admission or substrate hashing (`client/src/eval/admission/`, `client/src/eval/substrate-hash/`).

**Where:** judgmental subagent.

**Subagent looks for:** changes that could weaken the verdict-time recheck (e.g. removed assertions, conditional skips of the hash check).

## C5 — task admission filter

**Triggers when:** diff touches floor logic, DiscoveryAPI filter, or claim eligibility.

**Where:** main (grep for known floor constants + filter call sites).

**Why:** #300 ghost-task class — floor drift introduces silent non-claimability or worse, silent re-emergence.

## C6 — canon doc movement

**Triggers when:** any line of PRINCIPLES.md / SPEC.md / BRAND.md / GROWTH.md / GLOSSARY.md changes.

**Where:** main (grep).

**Action:** flag as concern. Canonical-docs policy requires Discussion + CODEOWNERS approval; the audit subagent verifies this was followed.

## C7 — memory invariant violation

**Triggers when:** any diff that contradicts a stored memory file.

**Where:** judgmental subagent.

**Subagent reads:** all memory files under `~/.claude/projects/<project>/memory/`. For each memory whose body describes an invariant or rule, checks the diff for direct violation.

## C8 — wiring-seam coverage

**Triggers when:** any value computed in 2+ modules without a single-source-of-truth helper.

**Where:** judgmental subagent (AST + reasoning).

**Why:** u34i lesson — module-isolated unit tests miss cross-module invariant drift.

## C9 — publish-guard check-run contract

**Triggers when:** diff touches `.github/workflows/npm-publish.yml` publish guard, `.github/workflows/hermetic-gate.yml`, `.github/workflows/environment-suite.yml`, or `client/scripts/release/post-check-run-verdict.mjs`.

**Where:** main (grep).

**Why:** Per the two-gate redesign (`docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md` §7), the publish guard no longer parses a hand-typed `jinn-release-evidence:v1` marker — it queries two **SHA-bound check-runs**, `hermetic-gate` and `environment-suite`, and re-runs nothing. The marker is at most a human-readable diagnostic artifact, not the gate.

**Action:** verify the contract holds end-to-end —

- The publish guard queries exactly the two contexts `hermetic-gate` **and** `environment-suite` (no other names), bound to the release SHA, and requires both `success`. It must NOT re-run any test or parse a marker.
- The `environment-suite` requirement may be waived ONLY via the transitional repo variable `JINN_ENVIRONMENT_SUITE_WAIVED == 'true'`, and the waiver must be logged loudly. `hermetic-gate` is never waivable.
- The two workflows post their verdicts through the single shared poster `client/scripts/release/post-check-run-verdict.mjs` with the locked verdict-JSON shape (`{ context, headSha, conclusion, scenarios[], summary }`) and the exact context names above.

Any drift — a third context name, a re-introduced marker parse, a re-run step, a waiver that isn't gated on the repo variable, or a poster bypass — is a finding.

## C10 — spec freshness

**Triggers when:** a spec under `spec/` referenced by code no longer matches the code.

**Where:** judgmental subagent.

**Subagent reads:** each referenced spec + the code section that references it. Reports drift.

## C11 — skill currency

**Triggers when:** diff touches operator-facing UI, CLI verbs, public skill-relevant surfaces.

**Where:** judgmental subagent.

**Subagent reads:** every `.claude/skills/*/SKILL.md` and the diff. Reports:
- Skills that make false claims about changed surfaces (BLOCKING)
- Skills that don't yet cover new surfaces but existing surfaces are still accurate (DEFERRABLE)

This is the recursion that keeps the system honest. Every release sweeps the skills.

## C12 — release-gate-scenario soundness

**Triggers when:** the diff adds or changes release-gate code under `client/test/release/**`
or `client/scripts/release/**` (Tier 1/2/3 scenarios, orchestrators, helpers).

**Where:** main (grep/AST) — semi-mechanical cross-reference.

**Why:** Release-gate scenarios have twice shipped broken because they were authored
against an *imagined* interface rather than the real one. T2.2 assumed an HTTP task
control plane (`POST /v1/tasks`, `GET /v1/verdicts`) — none of it existed (issue #350,
rewritten). T3.1 shipped the identical bug and never passed (#526). The Phase 2 audit
had both in its diff and did not catch them: the C1-C11 checks target the *product*
against canon, not the soundness of the *gate infrastructure* itself.

**Check:** for each new/changed gate scenario, cross-reference every external interface
it calls — `fetch()` URLs against the actual route table in `client/src/api/server.ts`;
contract calls against deployed ABIs; CLI invocations against real commands. Any
reference to an interface that does not exist is a finding.

- Gate scenario calls a non-existent interface → **BLOCKING** (the gate cannot pass;
  fix the scenario on the integration branch — a broken gate is a blocker, not an issue).
- Gate scenario is sound but its budget/assumptions look stale → **DEFERRABLE**.

This is the audit catching, cheaply and early, the class of bug that otherwise only
surfaces when Phase 5 burns a real-network run on it.
