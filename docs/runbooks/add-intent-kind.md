# Runbook: Add an in-repo intent kind

This runbook replaces the pre-manifest extension steps in [Architecture audit (j75) §5.1](../reviews/2026-04-22-architecture-audit-j75.md). For the **intent data model** (DesiredState, lifecycle), see audit **§2**.

## 1. Overview: kinds vs impls vs intents

| Concept | Role | Primary code |
|--------|------|----------------|
| **Intent kind** (`spec.kind`) | Names the typed spec shape; drives CLI `--spec-file` parsing, optional auto-generators, and operator UX metadata. | `client/src/intents/kinds/` (`SPEC_KINDS` in `index.ts`) |
| **Restorer impl** | Fulfills a restoration job for a given kind (and evaluation jobs for `type: 'evaluation'`). | `client/src/restorer/impls/*` — new impl classes are constructed in one place: [`buildRestorerImpls`](../../client/src/restorer/impls/index.ts). [`client/src/main.ts`](../../client/src/main.ts) and [`client/src/cli/intent-registry-access.ts`](../../client/src/cli/intent-registry-access.ts) are **call sites** (daemon vs `jinn intents` stub), not a second list of per-impl `new` calls. |
| **Intent** | A `DesiredState` (plus typed `window` / `spec` / `eligibility`) posted on-chain. | `client/src/types/desired-state.ts` + per-kind Zod in `client/src/types/` |

**Important:** **Parsing and testnet auto-post** for kinds is centralized in [`SPEC_KINDS`](../../client/src/intents/kinds/index.ts) and [`collectTestnetAutoIntentGenerators`](../../client/src/intents/kinds/index.ts). **Which restorer impl runs** for a kind is separate: [`RestorerImplRegistry`](../../client/src/restorer/engine/registry.ts) with operator mapping via `DEFAULT_BY_KIND` / `restorers.byKind` in [`client/src/cli/intent-registry-access.ts`](../../client/src/cli/intent-registry-access.ts). Impl *instances* are built from [`buildRestorerImpls`](../../client/src/restorer/impls/index.ts); the old audit “duplicate `new Impl()` lists in main vs CLI” gap is addressed in code, though two registry objects (daemon vs CLI) still exist by design.

## 2. Steps to add a new kind (e.g. `lending.health.v0`)

### 2.1 Typed schemas

1. Add `client/src/types/lending-health.ts` (name to match your kind): Zod schemas for the spec, eligibility, full intent, restoration manifest (`…manifest.v1`), and verdict manifest. Use [`client/src/types/prediction.ts`](../../client/src/types/prediction.ts) or [`client/src/types/portfolio.ts`](../../client/src/types/portfolio.ts) as templates.
2. Export new symbols from [`client/src/types/index.ts`](../../client/src/types/index.ts) if other modules should import them from the barrel.

### 2.2 Sentinel templates (optional)

If the kind needs CLI-time resolution (e.g. `window.startTs: 0`, or oracle sentinels like `"current+0.5%"`), add `client/src/intents/lending-health-v0-template.ts` mirroring [`client/src/intents/prediction-v0-template.ts`](../../client/src/intents/prediction-v0-template.ts). Have the kind module’s `parseSpec` call this helper.

### 2.3 Kind module + manifest registration

1. Add `client/src/intents/kinds/lending-health-v0.ts` exporting a `SpecKind` object:
   - `kind`: string literal matching `spec.kind`.
   - `parseSpec(raw, deps?)`: async; validate + resolve sentinels; return `{ window, spec, eligibility }` for merging into `DesiredState`.
   - `buildGenerator?`: optional; `(config) => IntentGenerator` wrapping a `make…Generator` factory (see [`client/src/intents/prediction-v0-auto.ts`](../../client/src/intents/prediction-v0-auto.ts)).
   - `getTestnetAutoConfig?`: optional; if you want testnet auto-posting, return a config object when `ctx.network === 'testnet'` (and gate on `ctx.env` as needed); omit or return `undefined` to skip. The daemon uses [`collectTestnetAutoIntentGenerators`](../../client/src/intents/kinds/index.ts) so **you do not edit** [`client/src/main.ts`](../../client/src/main.ts) to register a new auto-generator.
   - `ui?`: optional `{ description, category }` for future CLI surfaces.
2. Register it in [`client/src/intents/kinds/index.ts`](../../client/src/intents/kinds/index.ts) on `SPEC_KINDS`.

**Minimum touch for wiring:** one new file under `intents/kinds/` plus an entry in `intents/kinds/index.ts`. You still need the **types** file (and any template/auto helpers) for a real kind.

### 2.4 Restorer + evaluator impls

Ship at least one `RestorerImpl` under `client/src/restorer/impls/<your-impl>/` with `supports({ kind, type })` narrowing to your kind.

**Registration (single construction site):** add your class to the ordered list in [`client/src/restorer/impls/index.ts`](../../client/src/restorer/impls/index.ts) inside `buildRestorerImpls`. The production daemon and the `jinn intents` CLI both call `buildRestorerImpls` with different [`RestorerEnv`](../../client/src/restorer/impls/index.ts) (live keys vs `stub: true`); you should **not** hand-register the same impl in two places.

Set operator defaults via `DEFAULT_BY_KIND` / `DEFAULT_DISABLED_IMPLS` in [`client/src/cli/intent-registry-access.ts`](../../client/src/cli/intent-registry-access.ts) as needed. Add an **evaluator** impl with `supports({ type: 'evaluation' })` or deliveries cannot be verified for rewards. See audit **§5.2**.

### 2.5 Fixtures and CLI

- Add `client/fixtures/<kind>-intent.example.json` for operators and tests.
- `jinn submit-intent --spec-file` dispatches through `SPEC_KINDS`; unknown `spec.kind` errors list `known kinds:` from the manifest.

### 2.6 Tests

- **Parse:** unit-test `SPEC_KINDS['your.kind'].parseSpec` (round-trip, invalid input, unknown-kind is already covered globally).
- **Auto-gen:** if `buildGenerator` exists, test the factory (see [`client/test/intents/prediction-v0-auto.test.ts`](../../client/test/intents/prediction-v0-auto.test.ts)).
- **Impl:** `client/test/…` for the restorer/evaluator (audit §5.2 step 7 pattern).

## 3. Worked examples (in-repo precedents)

Use `git log -1 -- <path>` for the latest commit touching each area.

| Kind | Types + manifest wiring | Restorer / trader | Baseline / evaluator |
|------|-------------------------|-------------------|----------------------|
| `portfolio.v0` | [`client/src/types/portfolio.ts`](../../client/src/types/portfolio.ts), [`client/src/intents/kinds/portfolio-v0.ts`](../../client/src/intents/kinds/portfolio-v0.ts) | [`client/src/restorer/impls/claude-mcp-hyperliquid/`](../../client/src/restorer/impls/claude-mcp-hyperliquid/) | [`portfolio-v0-evaluator/`](../../client/src/restorer/impls/portfolio-v0-evaluator/) |
| `prediction.apy.v0` | [`client/src/types/prediction-apy.ts`](../../client/src/types/prediction-apy.ts), [`prediction-apy-v0.ts`](../../client/src/intents/kinds/prediction-apy-v0.ts) | [`prediction-apy-v0-baseline/`](../../client/src/restorer/impls/prediction-apy-v0-baseline/), [`claude-mcp-prediction-apy/`](../../client/src/restorer/impls/claude-mcp-prediction-apy/) | [`prediction-apy-v0-evaluator/`](../../client/src/restorer/impls/prediction-apy-v0-evaluator/) |

Example SHAs from this worktree (replace with your branch’s `git log` as needed):

- Portfolio / Hyperliquid trader touch: `466a467ade6f7433d92236a921408f61d1b3e045`
- Prediction APY baseline touch: `21802429ec3e2a0c34bfb9cd375be134171fb006`

## 4. Out of scope: third-party plug-in impls

Loading `RestorerImpl` from npm or dynamic `import()` is **not** supported today. Track `jinn-mono-7zz` and `jinn-mono-y6w` and audit **§5.3**.

## 5. Future hook (not implemented)

Per-kind doctor checks (e.g. portfolio HL preflight) may eventually hang off the manifest; today [`client/src/cli/commands/doctor.ts`](../../client/src/cli/commands/doctor.ts) still branches on configured desired states.
