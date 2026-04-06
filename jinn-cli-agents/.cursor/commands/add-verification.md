### Update verification when behavior changes
**Behavior:** When behavior changes—especially for breaking features—the verification stack is updated deliberately. Tests at the relevant layers (unit, contract/API, integration, system) describe the new behavior, and the canonical system test is amended rather than duplicated.
**Why this matters:**
- Keeps the \"Verification first\" objective actionable instead of aspirational.
- Ensures the next agent can discover canonical behavior by reading tests.
- Prevents stale coverage that silently contradicts production code.
**How to follow it:**
1. Map impact: identify which layers are affected (unit logic, API/schema, on-chain state, system flow).
2. Update or add tests at each relevant layer:
   - Unit for business rules and validation,
   - Contract/API for schema/ABI semantics and error codes,
   - Integration for module boundaries and fakes/Testcontainers,
   - System by updating the existing canonical system test (e.g., `tests-next/system/memory-system.system.test.ts`) with new assertions and pruning ones that no longer apply.
3. Document breaking changes with a clear migration note (changelog entry, `BREAKING` section, or PR description) explaining what changed and why.
4. Update fixtures and builders deliberately—prefer data builders that encode the new behavior over silently tweaking static fixtures.
5. Keep failing tests failing until the behavior is fixed, or explicitly skip with a linked tracking issue and TODO to re-enable.
6. Audit coverage for regressions.
If behavior is removed, remove corresponding tests with a note in the PR explaining why (so future archeologists understand the gap).
7. When behavior changes, update the existing canonical system test with new assertions and prune ones that no longer apply. Don’t introduce parallel system tests for the same flow; keep a single high-signal scenario up to date. This preserves the “one scenario, many assertions” principle and keeps maintenance centralized.
Also here in blueprint requirement format
**Assertion**
Every behavioral change, especially breaking ones, must update the existing verification stack—unit, contract/API, integration, and the canonical system test—so that tests describe the new behavior and obsolete assertions are removed rather than multiplied.
**Examples**
| Do | Don't |
| --- | --- |
| Update unit validators, contract/API schemas, integration fakes, and amend `tests-next/system/memory-system.system.test.ts` with new checkpoints when a feature changes | Ship code without touching existing tests, or add a second system test for the same flow while leaving the canonical test stale |
| Remove assertions that no longer apply and explain the removal in the PR notes (e.g., “featureW removed; see BREAKING.md”) | Comment out or skip failing assertions without a plan, letting the canonical test silently diverge from production behavior |
| Document breaking behavior in PR/changelog and keep failing tests failing until the underlying code is fixed | Rewrite assertions to match a regression (“update expected value to current output”) without addressing the root cause |
**Commentary**
This requirement operationalizes the “Verification first” objective: evidence must evolve alongside behavior. Updating existing tests—rather than spawning parallel, soon-to-be-stale suites—keeps a single source of truth for each flow. Amending `tests-next/system/memory-system.system.test.ts` ensures our most expensive verification artifact delivers maximum signal. Removing obsolete assertions (with explanation) prevents future agents from chasing phantom guarantees. By coupling code changes with deliberate test updates across all layers, we preserve traceability, avoid regressions, and make behavioral intent discoverable in the places engineers and agents look first.