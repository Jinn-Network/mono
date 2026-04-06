# Tests Next

Next-generation test harness with a clear three-layer pyramid:

1. **Unit** (`unit/`) – Pure Vitest specs with mocked IO
2. **Integration** (`integration/`) – Boundary tests with env controller, in-process
3. **System** (`system/`) – Full-stack scenarios with Tenderly VNets, Ponder, Control API, worker

## Structure

- `helpers/` – Shared utilities (env controller, Tenderly runner, process harness, assertions)
- `fixtures/` – Deterministic data (`.operate-test`, git templates)
- `unit/` – Pure Vitest specs with no global setup
- `integration/` – Boundary tests with mocked infrastructure
- `system/` – Real worker stack via process harness

## Prerequisites

- `.env.test` with secrets (`TENDERLY_*`, `GITHUB_TOKEN`, `TEST_GITHUB_REPO`, etc.)
- Sanitized `.operate` in `fixtures/operate-profile/`
- Node 22 and Yarn (Volta-managed)
- Git template in `fixtures/git-template/` for repo fixtures

## Key Helpers

| Helper | Purpose |
|--------|---------|
| `env-controller.ts` | Loads env, enforces `RUNTIME_ENVIRONMENT='test'` |
| `tenderly-runner.ts` | Creates/deletes VNets, funds wallets |
| `process-harness.ts` | Boots Ponder + Control API + worker |
| `git-fixture.ts` | Clones git template for clean worktree |
| `assertions.ts` | Polling for deliveries, artifacts, jobs |
| `port-utils.ts` | Finds open ports for parallel runs |
| `suite-env.ts` | Per-suite IDs, Ponder cache dirs, ports |

## Running Tests

```bash
# Run unit tests
npx vitest run --config vitest.config.next.ts --project unit-next

# Run integration tests
npx vitest run --config vitest.config.next.ts --project integration-next

# Run system tests
npx vitest run --config vitest.config.next.ts --project system-next
```
