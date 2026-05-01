# @jinn-examples/alternative-harness

Path 2 worked example: a Jinn restorer for `prediction.v0` running the
**seven-phase learning pipeline** (Orient → Strategize → Plan → Execute
→ Debrief → Improve → Memory) against a non-Claude-Code harness.

Demonstrates that the impl surface is genuinely harness-agnostic:
nothing here depends on `@jinn-network/client` internals or on the
in-repo `claude-code-learner` package. The package owns the
coordinator + per-phase modules + the `HarnessAdapter` contract; the
underlying agent runtime is swappable.

## What this shows

- Default-export factory shape per
  `spec/2026-05-external-restorer-impls.md` §3.2.
- `supports({ kind: 'prediction.v0', type: 'restoration' })` —
  declines evaluation intents.
- A clean `HarnessAdapter` contract (`src/harness.ts`) — one method
  (`promptForJson<T>`) plus an optional `closePhase`. Easy to wrap any
  subprocess harness around.
- Seven small phase modules under `src/phases/` matching the design
  doc. Each is a single function that takes the upstream phase
  results, calls the harness once, and returns a typed result.
- A deterministic in-process mock harness (`src/mock-harness.ts`) so
  unit + coordinator tests run offline.
- The phase sequence is enforced by `src/coordinator.ts` — the
  coordinator test asserts the order explicitly.

## Run the tests

```bash
yarn install
yarn test           # offline; all 8 tests pass
yarn build          # produces dist/
```

## Plugging in your real harness

Implement the `HarnessAdapter` interface (one method):

```ts
import type { HarnessAdapter } from '@jinn-examples/alternative-harness';

export const myHarness: HarnessAdapter = {
  name: 'pi-dev-claude-3-5',
  async promptForJson<T>({ systemPrompt, userPrompt, budgetMs, abort }) {
    // Spawn / call your harness; parse its JSON response; return.
    const res = await callMyHarness({ systemPrompt, userPrompt, budgetMs, abort });
    return JSON.parse(res.text) as T;
  },
};
```

Then construct the restorer with your factory:

```ts
import createRestorer from '@jinn-examples/alternative-harness';

const impl = createRestorer(env, { harnessFactory: () => myHarness });
```

## Phase shape reference

| Phase       | Returns                                                    |
|-------------|------------------------------------------------------------|
| orient      | `{ topics: { name, summary }[] }`                          |
| strategize  | `{ approach, successCriteria, timingPosture }`             |
| plan        | `{ steps: { id, description }[] }`                         |
| execute     | `{ stepsCompleted, stepsFailed, returnReason }`            |
| debrief     | `{ successCriteriaMet: 'yes'\|'no'\|'partial', rationale }`|
| improve     | `{ mutations: { path, description }[] }`                   |
| memory      | `{ kept, pruned }`                                         |

Each phase's `userPrompt` carries the upstream phases' results so the
harness can chain reasoning even if it does not persist conversation
state across calls.

## Spec

- `spec/2026-04-30-plug-in-surface.md` §3.3.3 — alternative-harness pattern.
- `docs/superpowers/specs/2026-04-23-default-learning-restorer-design.md` §2 — phase pipeline definition.
- `spec/2026-05-external-restorer-impls.md` §3 — loader contract.
- `spec/2026-05-executor-trust-boundary.md` §5 — manifest signing.
