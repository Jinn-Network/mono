# Autonomous vs human-invoked

The two modes differ in what they're allowed to do.

## human-invoked

- Daily-driver daemons SIGTERM'd before Tier 3, restarted after.
- Tier 3 runs (real network + real Hermes spend).
- Cost budget permissive (one run per week).
- Phase 7: emits "handoff ready at <path>, see you in a new session". Session ends.
- Human reads handoff doc in a fresh session, drives the walk-through script, makes ship/no-ship decision.

## autonomous

- Daily-driver daemons NOT touched.
- Tier 3 SKIPPED entirely (autonomous can't safely manage daemon mutex).
- If Tier 3 skipped, recommendation defaults to INSUFFICIENT-EVIDENCE-FOR-SHIP; needs human-invoked re-run.
- Cost budget tighter.
- Phase 7: `gh issue create --label release-ready --title "release-readiness completed for <v>"`. Session ends. Issue sits in queue.

## When to use which

- **Autonomous:** weekend run for Monday cut. Audit + closure happen overnight; the human picks up Monday morning and runs Tier 3 themselves before deciding.
- **Human-invoked:** any time a human wants the full flow including Tier 3. Required for the final pre-publish run.

## Future cron

Captured as follow-up GH issue: "Wire release-readiness autonomous-mode to a Friday 23:00 UTC GitHub Actions schedule." When wired:
- Cron triggers a workflow that checks out `next`, runs the skill against HEAD with `--mode autonomous`.
- Workflow posts the handoff doc as a comment on the existing Monday-draft GH Release.
- Captain reads on Monday, optionally runs human-invoked for Tier 3, publishes if SHIP.
