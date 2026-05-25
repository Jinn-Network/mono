# Triage taxonomy

Classification rules used by the triage subagent. The taxonomy is from spec §4.

## BLOCKING

Close before recommend SHIP. Includes:
- Direct PRINCIPLES.md violation **introduced by this branch** (not pre-existing).
- operator-app-principle violation in new UI copy.
- Canon doc moved without ratification path (Discussion + CODEOWNERS approval).
- Bootstrap / auth / eval substrate regression.
- Wiring-seam drift introduced (multiple modules computing same value, no helper).
- Tier 3 scenario regression vs last release.
- Any Tier 1/2/3 gate failure not proven a flake (see §Gate failures).
- Skill makes false claims about changed surface (operator hits a wall).

## DEFERRABLE

File GH issue with milestone, ship anyway, note in release notes. Includes:
- Spec-drift in unreferenced area.
- Pre-existing open issue.
- Quality-of-life concerns that don't break a documented invariant.
- Tier 1/2/3 gate failures **proven** a flake by isolated retry (see §Gate failures).
- Skill doesn't yet cover new surface but existing surface is still accurate.
- Anything previously triaged as "next release" pattern.

## ALREADY-MET

Concern is addressed; link to evidence. Includes:
- Static checklist item that passed without finding.
- Open-ended concern that's covered by an existing test.
- Concern explicitly resolved by a commit in this window.

## Gate failures (Tier 1 / Tier 2 / Tier 3)

A failing release gate is **BLOCKING by default** — drive it to a fix, do not file it.

- A `flake-timing` / `flake-infra` classification is a **hypothesis**, not a verdict:
  `classifyFailure` only regex-matches the error string. It must be **proven** — re-run
  the scenario isolated. Passes on an isolated retry → genuine flake. Fails again → it
  is real; dispatch a gate-failure debug subagent.
- A gate failure may be classified **DEFERRABLE only with a debug-subagent root-cause
  report** that proves the cause is genuinely external / non-code (an upstream outage, a
  competing testnet actor the gate must tolerate, etc.). No root-cause report → it cannot
  be deferred.
- 3 failed fix attempts on a real gate failure → BLOCKING-ESCALATED.
- Precedent (v2026.05.25 run): every auto-classified "flake" — T2.1/T2.3 `daemon not
  reachable`, T3.1 `flake-timing` — was a real bug (a `JINN_PASSWORD` leak, then three
  task-posting/discovery defects including a latent production bug). None were flakes.

## Edge cases

- **BLOCKING that can't be closed (after 3 attempts):** mark BLOCKING-ESCALATED. Gap stays BLOCKING; recommendation shifts to DEFER (not BLOCK — defer means "not ready this cycle," block means "broken in a way that needs hotfix-level attention").
- **Cross-cutting clusters:** multiple deferrable findings with the same root cause should escalate one to BLOCKING with a note about the cluster.
- **Pre-existing vs introduced:** the audit only flags issues *introduced by this branch*. Pre-existing issues that the diff happens to touch don't escalate; they stay DEFERRABLE.
