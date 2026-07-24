# Autonomous vs human-invoked

> **Refreshed for the two-gate world.** The old distinction here was laptop-centric: human-invoked ran Tier 3 on the laptop (SIGTERM the daily-driver daemons, spend real Hermes budget), autonomous skipped it because it "couldn't manage the daemon mutex." That world is gone. Validation is now two **CI** check-runs — `hermetic-gate` (per-PR/push) and `environment-suite` (real testnet, dispatched on the candidate SHA) — both run in CI in **either** mode (two-gate redesign, [`docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md`](../../../../docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md)). There is no laptop test run and no daemon mutex to manage. The modes now differ only in **how the run is triggered and how the result is delivered**, not in what gets validated.

The two modes read the **same** two SHA-bound check-runs and reach the same SHIP/DEFER/BLOCK on the same evidence.

## human-invoked

- Triggered by a human when a candidate version is in view (Friday evening / Saturday for a Monday cut).
- Audits + drives fixable blockers onto the `release/<version>` integration branch, dispatches `environment-suite.yml` on the candidate SHA, reads both check-runs, debugs any red.
- Phase 7: emits "handoff ready at `<path>`; recommendation: `<X>`" in-session.

## autonomous

- Same flow; intended for an unattended weekend run (see Future cron).
- Because the real-world suite runs in CI, autonomous is **not** evidence-starved — it reads the same `environment-suite` check-run a human would. It no longer defaults to INSUFFICIENT-EVIDENCE-FOR-SHIP.
- Phase 7: `gh issue create --label release-ready --title "release-readiness completed for <v>" --body "review at <path>"`. The issue sits in the queue for the human to action.

## When to use which

- **Autonomous:** unattended weekend run for a Monday cut. Audit + closure + the env-suite dispatch happen without a human; the human picks up the handoff Monday morning and makes the ship/no-ship call (an agent never publishes).
- **Human-invoked:** any time a human is driving the run directly. Required immediately before publish so the human owns the final recommendation.

## Future cron

Captured as a follow-up GH issue: "Wire release-readiness autonomous-mode to a Friday 23:00 UTC GitHub Actions schedule." When wired:
- Cron triggers a workflow that checks out `next`, runs the skill against HEAD with `--mode autonomous`.
- Workflow posts the handoff doc as a comment on the existing Monday-draft GH Release.
- Captain reads on Monday and publishes if SHIP (an agent never publishes).
