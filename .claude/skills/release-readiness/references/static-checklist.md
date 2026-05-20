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

## C9 — release-evidence marker schema

**Triggers when:** diff touches `.github/workflows/npm-publish.yml` marker check.

**Where:** main (grep).

**Action:** validate any new marker keys against `client/scripts/release/release-readiness.ts` schema. If the schema isn't updated to match, flag.

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
