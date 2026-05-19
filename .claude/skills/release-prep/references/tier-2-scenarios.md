# Tier 2 scenarios

**Status:** Placeholder. Implementations land in Plan D.

Tier 2 scenarios run cross-operator against substrate-derived workspaces. The contracts (what each scenario asserts) are in `testing-jinn-app` reference docs:

- T2.1 — cross-operator-donation: [`testing-jinn-app/references/scenario-cross-op-donation.md`](../../testing-jinn-app/references/scenario-cross-op-donation.md)
- T2.2 — producer-evaluator-anvil-fork: [`testing-jinn-app/references/scenario-producer-evaluator.md`](../../testing-jinn-app/references/scenario-producer-evaluator.md)
- T2.3 — multi-op-spa-flow: [`testing-jinn-app/references/scenario-multi-op-spa-flow.md`](../../testing-jinn-app/references/scenario-multi-op-spa-flow.md)

When Plan D lands:
- Implementations at `client/test/release/tier-2/T2.1.ts`, `T2.2.ts`, `T2.3.ts` (plus the Playwright one at `client/test/dashboard/multi-op/launcher-join-flow.e2e.test.ts`)
- Orchestrator at `client/scripts/release/run-tier-2.ts`
- This placeholder doc expanded with the same depth as `tier-1-scenarios.md`
- release-prep SKILL.md's Tier 2 table populated with wall-clock budgets

Plan D depends on Plan A (substrate), Plan B (helpers), and Plan C (release-prep skill scaffolding from this plan).
