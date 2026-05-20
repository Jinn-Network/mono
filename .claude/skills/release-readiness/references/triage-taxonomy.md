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
- Skill makes false claims about changed surface (operator hits a wall).

## DEFERRABLE

File GH issue with milestone, ship anyway, note in release notes. Includes:
- Spec-drift in unreferenced area.
- Pre-existing open issue.
- Quality-of-life concerns that don't break a documented invariant.
- Tier 1/2 flake-class failures (release-prep marked `flake-infra`).
- Skill doesn't yet cover new surface but existing surface is still accurate.
- Anything previously triaged as "next release" pattern.

## ALREADY-MET

Concern is addressed; link to evidence. Includes:
- Static checklist item that passed without finding.
- Open-ended concern that's covered by an existing test.
- Concern explicitly resolved by a commit in this window.

## Edge cases

- **BLOCKING that can't be closed (after 3 attempts):** mark BLOCKING-ESCALATED. Gap stays BLOCKING; recommendation shifts to DEFER (not BLOCK — defer means "not ready this cycle," block means "broken in a way that needs hotfix-level attention").
- **Cross-cutting clusters:** multiple deferrable findings with the same root cause should escalate one to BLOCKING with a note about the cluster.
- **Pre-existing vs introduced:** the audit only flags issues *introduced by this branch*. Pre-existing issues that the diff happens to touch don't escalate; they stay DEFERRABLE.
