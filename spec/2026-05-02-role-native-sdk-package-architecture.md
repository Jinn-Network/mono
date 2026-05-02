# Single SDK and role-oriented developer surfaces

- **Date:** 2026-05-02
- **Author:** Codex (drafted on `codex/solvernet-sdk-helpers`; Captain ritsukai)
- **Status:** Proposal
- **Version:** 0.2
- **Bead:** `jinn-mono-glrl`

## 1. Summary

Jinn should use one lightweight SDK package and one batteries-included runtime
package:

- `@jinn-network/sdk` — build, validate, describe, and prepare.
- `@jinn-network/client` — run, store, post, claim, sign, submit, and watch.

The SDK is organized by subpaths instead of separate launcher/builder/operator
packages. This keeps the package graph simple while still making the role
surfaces legible.

## 2. SDK Subpaths

- `@jinn-network/sdk/harness`
  - `Harness`, `HarnessContext`, `ExternalHarnessEnv`
  - scoped capability handles
  - signed Harness manifest types

- `@jinn-network/sdk/solvernets`
  - `SolverNetContract`
  - contract registry lookup
  - Task / Solution / Verdict validation helpers
  - generic typed output builders

- `@jinn-network/sdk/solvernets/prediction-v1`
  - first-party Prediction v1 schemas and typed payloads
  - Prediction v1 validation and output helpers
  - deterministic Task construction and Brier helpers as they are added

- `@jinn-network/sdk/plugins`
  - SolverPlugin manifest types
  - SolverPlugin manifest validation helpers

The SDK root remains minimal and generic. First-party SolverNets such as
`prediction.v1` are available through SolverNet subpaths, not root exports.

## 3. Contributor Paths

Builders have two complementary contribution paths:

- **SolverPlugin:** a normal AI tooling plugin or extension. It may ship
  Claude/Gemini manifests, MCP servers, skills, prompts, docs, and optional
  `jinn.supports`. It helps Harnesses but does not execute Tasks directly.
- **Harness package:** a signed executable package with `jinn.manifest.json`,
  a default Harness factory, and `run(ctx)`.

Hybrid packages are allowed, but the client loads the plugin and Harness sides
through their explicit manifests. Plugins do not become canonical SolverNet
authority and do not become a second execution boundary.

## 4. Runtime Boundary

The client owns all stateful runtime behavior:

- daemon and CLI
- wallet / Safe / earning bootstrap
- Task posting and local post locks
- TaskCoordinator / JinnRouter / Mech calls
- claim, execution, delivery, and watcher loops
- corpus envelope assembly, signing, storage, and submission
- plugin and Harness installation
- operator-facing dashboard/API

Task creation is launcher-owned for now. A launcher defines and funds a
SolverNet, then runs deterministic Task creation through client runtime
machinery. Open creators are out of scope.

Within the client runtime, creator, solver, and evaluator are configurable role
modes:

- Creator mode posts deterministic Tasks for a launched SolverNet.
- Solver mode claims Tasks, runs Harnesses, and submits Solutions.
- Evaluator mode runs deterministic evaluation Harnesses and publishes Verdicts.

## 5. Acceptance Criteria

- `@jinn-network/sdk` exposes the root and subpaths listed above.
- The draft Harness-only SDK package is removed; no compatibility package is kept.
- Harness templates and examples depend on `@jinn-network/sdk` and import
  Harness types from `@jinn-network/sdk/harness`.
- SolverNet and Prediction v1 helpers import from `@jinn-network/sdk/solvernets`
  and `@jinn-network/sdk/solvernets/prediction-v1`.
- SolverPlugins remain normal AI tooling plugins, not executable Jinn units.
- `@jinn-network/client` remains the batteries-included runtime package.
