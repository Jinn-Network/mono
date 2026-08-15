# Runbook: Add an in-repo SolverType

This runbook replaces the pre-manifest extension steps in [Architecture audit (j75) §5.1](../reviews/2026-04-22-architecture-audit-j75.md). For the Task / SolverType vocabulary, see [`spec/2026-05-01-harness-pack-architecture.md`](../../spec/2026-05-01-harness-pack-architecture.md).

## 1. Overview: SolverTypes vs Harnesses vs Tasks

| Concept | Role | Primary code |
|--------|------|----------------|
| **SolverType** (`solverType`) | Names the typed Task spec shape; drives CLI `--spec-file` parsing, optional auto-generators, and operator UX metadata. | `operator/src/solver-types/` (`SOLVER_TYPES` in `index.ts`) |
| **Harness** | Solves a Task for a given SolverType and can evaluate Tasks for `role: 'evaluation'`. | `operator/src/harnesses/impls/*` — new Harness classes are constructed in one place: [`buildHarnesses`](../../client/src/harnesses/impls/index.ts). SolverNet config chooses the restoration Harness at runtime. |
| **Task** | A posted object with top-level `solverType`, plus typed `window` / `spec` / `eligibility`. | `operator/src/types/task.ts` + per-SolverType Zod in `operator/src/types/` |

**Important:** **Parsing and testnet auto-post** for SolverTypes is centralized in [`SOLVER_TYPES`](../../client/src/solver-types/index.ts) and [`collectTestnetAutoTaskGenerators`](../../client/src/solver-types/index.ts). **Which Harness runs** for a restoration Task is owned by the enabled SolverNet: `task.solverType` resolves to `solverNets.<name>`, and that SolverNet selects its Harness plus canonical/extra SolverPlugins. Evaluation Tasks still dispatch by role-aware Harness support.

## 2. Steps to add a new SolverType (e.g. `lending.health.v0`)

### 2.1 Typed schemas

1. Add `operator/src/types/lending-health.ts` (name to match your SolverType): Zod schemas for the spec, eligibility, full Task, solution manifest (`…manifest.v1`), and verdict manifest. Use [`operator/src/types/prediction.ts`](../../client/src/types/prediction.ts) or [`operator/src/types/portfolio.ts`](../../client/src/types/portfolio.ts) as templates.
2. Export new symbols from [`operator/src/types/index.ts`](../../client/src/types/index.ts) if other modules should import them from the barrel.

### 2.2 Sentinel templates (optional)

If the SolverType needs CLI-time resolution (e.g. `window.startTs: 0`, or oracle sentinels like `"current+0.5%"`), add `operator/src/solver-types/lending-health-v0-template.ts` mirroring [`operator/src/solver-types/prediction-v0-template.ts`](../../client/src/solver-types/prediction-v0-template.ts). Have the SolverType module's `parseSpec` call this helper.

### 2.3 SolverType module + manifest registration

1. Add `operator/src/solver-types/lending-health-v0.ts` exporting a `SolverTypeDefinition` object:
   - `solverType`: string literal matching the top-level Task `solverType`.
   - `parseSpec(raw, deps?)`: async; validate + resolve sentinels; return `{ window, spec, eligibility }` for merging into the Task.
   - `buildGenerator?`: optional; `(config) => TaskGenerator` wrapping a `make…Generator` factory (see [`operator/src/solver-types/prediction-v0-auto.ts`](../../client/src/solver-types/prediction-v0-auto.ts)).
   - `getTestnetAutoConfig?`: optional; if you want testnet auto-posting, return a config object when `ctx.network === 'testnet'` (and gate on `ctx.env` as needed); omit or return `undefined` to skip. The daemon uses [`collectTestnetAutoTaskGenerators`](../../client/src/solver-types/index.ts) so **you do not edit** [`operator/src/main.ts`](../../client/src/main.ts) to register a new auto-generator.
   - `ui?`: optional `{ description, category }` for future CLI surfaces.
2. Register it in [`operator/src/solver-types/index.ts`](../../client/src/solver-types/index.ts) on `SOLVER_TYPES`.

**Minimum touch for wiring:** one new file under `solver-types/` plus an entry in `solver-types/index.ts`. You still need the **types** file (and any template/auto helpers) for a real SolverType.

### 2.4 Harness + evaluation Harnesses

Ship at least one `Harness` under `operator/src/harnesses/impls/<your-impl>/` with `supports({ solverType, role })` narrowing to your SolverType.

**Registration (single construction site):** add your class to the ordered list in [`operator/src/harnesses/impls/index.ts`](../../client/src/harnesses/impls/index.ts) inside `buildHarnesses`. The production daemon and Harness CLI surfaces both call `buildHarnesses` with different [`HarnessEnv`](../../client/src/harnesses/impls/index.ts) (live keys vs `stub: true`); you should **not** hand-register the same Harness in two places.

Set operator defaults through `solverNets.<name>.harness` in config or the `jinn solver-nets set-harness` command. Add an **evaluator** Harness with `supports({ role: 'evaluation' })` or deliveries cannot be verified for rewards. See audit **§5.2**.

### 2.5 Fixtures and CLI

- Add `operator/fixtures/<solverType>-task.example.json` for operators and tests.
- `jinn tasks submit --spec-file` dispatches through `SOLVER_TYPES`; unknown `solverType` errors list known SolverTypes from the manifest.

### 2.6 Tests

- **Parse:** unit-test `SOLVER_TYPES['your.solverType'].parseSpec` (round-trip, invalid input, unknown SolverType is already covered globally).
- **Auto-gen:** if `buildGenerator` exists, test the factory (see [`operator/test/tasks/prediction-v0-auto.test.ts`](../../client/test/tasks/prediction-v0-auto.test.ts)).
- **Harness:** `operator/test/…` for the solver/evaluator (audit §5.2 step 7 pattern).

## 3. Worked examples (in-repo precedents)

Use `git log -1 -- <path>` for the latest commit touching each area.

| SolverType | Types + manifest wiring | Harness / trader | Baseline / evaluator |
|------|-------------------------|-------------------|----------------------|
| `portfolio.v0` | [`operator/src/types/portfolio.ts`](../../client/src/types/portfolio.ts), [`operator/src/solver-types/portfolio-v0.ts`](../../client/src/solver-types/portfolio-v0.ts) | [`operator/src/harnesses/impls/claude-mcp-hyperliquid/`](../../client/src/harnesses/impls/claude-mcp-hyperliquid/) | [`portfolio-v0-evaluator/`](../../client/src/harnesses/impls/portfolio-v0-evaluator/) |
| `prediction.apy.v0` | [`operator/src/types/prediction-apy.ts`](../../client/src/types/prediction-apy.ts), [`prediction-apy-v0.ts`](../../client/src/solver-types/prediction-apy-v0.ts) | [`prediction-apy-v0-baseline/`](../../client/src/harnesses/impls/prediction-apy-v0-baseline/), [`claude-mcp-prediction-apy/`](../../client/src/harnesses/impls/claude-mcp-prediction-apy/) | [`prediction-apy-v0-evaluator/`](../../client/src/harnesses/impls/prediction-apy-v0-evaluator/) |

Example SHAs from this worktree (replace with your branch’s `git log` as needed):

- Portfolio / Hyperliquid trader touch: `466a467ade6f7433d92236a921408f61d1b3e045`
- Prediction APY baseline touch: `21802429ec3e2a0c34bfb9cd375be134171fb006`

## 4. Out of scope: third-party Harness packages

Loading a third-party Harness from npm or dynamic `import()` is **not** supported today. Track `spec/2026-05-01-harness-pack-architecture.md` for the SolverPlugin and Harness package path.

## 5. Future hook (not implemented)

Per-SolverType doctor checks (e.g. portfolio HL preflight) may eventually hang off the manifest; today [`operator/src/cli/commands/doctor.ts`](../../client/src/cli/commands/doctor.ts) still branches on configured Tasks.
