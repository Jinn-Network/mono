# Triage taxonomy

Classification rules used by the triage subagent. The taxonomy is from spec §4.

## BLOCKING

Close before recommend SHIP. Includes:
- Direct PRINCIPLES.md violation **introduced by this branch** (not pre-existing).
- operator-app-principle violation in new UI copy.
- Canon doc moved without ratification path (Discussion + CODEOWNERS approval).
- Bootstrap / auth / eval substrate regression.
- Wiring-seam drift introduced (multiple modules computing same value, no helper).
- `environment-suite` scenario regression vs last release.
- Any `hermetic-gate` / `environment-suite` verdict that is **product-red** and
  not proven a flake (see §Gate failures).
- Skill makes false claims about changed surface (operator hits a wall).

## DEFERRABLE

File GH issue with milestone, ship anyway, note in release notes. Includes:
- Spec-drift in unreferenced area.
- Pre-existing open issue.
- Quality-of-life concerns that don't break a documented invariant.
- `hermetic-gate` / `environment-suite` failures classed `infra-blocked`, or
  **proven** a flake by isolated retry (see §Gate failures).
- Skill doesn't yet cover new surface but existing surface is still accurate.
- Anything previously triaged as "next release" pattern.

## ALREADY-MET

Concern is addressed; link to evidence. Includes:
- Static checklist item that passed without finding.
- Open-ended concern that's covered by an existing test.
- Concern explicitly resolved by a commit in this window.

## Gate failures (hermetic-gate / environment-suite)

The two gates (spec/2026-05-31 §3, #923) post SHA-bound check-runs. Their verdicts
classify into the three §10 outcomes — triage each differently:

- **product-red** — a real code regression. **BLOCKING by default** — drive it to a
  fix on the `release/<v>` branch, do not file it. A `hermetic-gate` red is *always*
  product-red (the gate is deterministic, zero external deps — it cannot flake for
  infra reasons).
- **infra-blocked** — the warm operator is unhealthy / under-funded, the
  `CLAUDE_CODE_OAUTH_TOKEN` expired, RPC 429 after retry, or an agent-transport error
  (env suite only). This is **NOT a product regression**: it is reported distinctly
  (a `neutral` env-suite verdict), retried once, and if persistent blocks the cut as
  an **infra** problem to fix in the harness/operator — never silently a pass or a
  product fail. "The dashboard says infra → go fix the operator," not "blocked for
  days, was it the product?"
- **agent-answer-quality** — a flaky/wrong LLM answer. Hard-asserted **only** where the
  task has known ground truth; otherwise a **soft** signal that lives in the verdict
  notes and **never blocks** the cut.

Discipline that survives the redesign:
- An `infra-blocked` / flake classification is a **hypothesis**, not a verdict — a
  proven cause, not an assumption. Prove it: re-run the scenario isolated. Passes on
  an isolated retry → genuine flake/infra. Fails again → it is real; dispatch a
  gate-failure debug subagent. (`environment-suite`'s `classifyFailure` only regex-
  matches the error string; the `hermetic-gate` has no infra to blame.)
- A failure may be classified **DEFERRABLE only with a debug-subagent root-cause
  report** proving the cause is genuinely external / non-code. No root-cause → it
  cannot be deferred.
- 3 failed fix attempts on a real (product-red) failure → BLOCKING-ESCALATED.
- Precedent (v2026.05.25 run, under the retired Tier ladder): every auto-classified
  "flake" — the then-T2.1/T2.3 `daemon not reachable`, T3.1 `flake-timing` — was a
  real bug (a `JINN_PASSWORD` leak, then three task-posting/discovery defects
  including a latent production bug). None were flakes. The two-gate split exists
  precisely to make this misclassification impossible: deterministic reds (hermetic)
  cannot be infra, and real-world infra (env suite) is a distinct, named outcome.

## Edge cases

- **BLOCKING that can't be closed (after 3 attempts):** mark BLOCKING-ESCALATED. Gap stays BLOCKING; recommendation shifts to DEFER (not BLOCK — defer means "not ready this cycle," block means "broken in a way that needs hotfix-level attention").
- **Cross-cutting clusters:** multiple deferrable findings with the same root cause should escalate one to BLOCKING with a note about the cluster.
- **Pre-existing vs introduced:** the audit only flags issues *introduced by this branch*. Pre-existing issues that the diff happens to touch don't escalate; they stay DEFERRABLE.
