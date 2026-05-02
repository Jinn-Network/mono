# Testing — standard operating procedure

This runbook is the canonical guide for writing tests in the Jinn monorepo.
Design rationale lives in `docs/superpowers/specs/2026-04-24-test-architecture-design.md`.

## The pyramid

Four tiers. Most tests belong in the **integration** tier.

1. **Unit** — pure logic, no I/O, no DI needed. Examples: `canonical-json.test.ts`,
   zod schema validators, pure helpers.
2. **Integration** — orchestration; real target module against **fake** external
   boundaries from `test/_support/`. This is the default tier for CLI commands,
   engine state-machine logic, API builders, harnesses, and daemon loops.
3. **E2E** — real anvil fork, real IPFS, real or mocked Claude. One file per
   protocol scenario in `client/test/e2e/`.
4. **Manual acceptance** — `yarn release:testnet-acceptance`. Out of scope for
   this runbook.

## Which tier does my test belong in?

- Pure function with no external dependencies → **unit**
- CLI command, HTTP builder, state machine, bootstrap flow → **integration**
- Full protocol scenario against real EVM → **e2e**

## Where does the file go?

Tests mirror `src/`:
- `client/src/cli/commands/doctor.ts` → `client/test/cli/commands/doctor.test.ts`

When a single test file grows past ~400 LOC, split by aspect:
- `test/cli/commands/foo/a.test.ts`, `test/cli/commands/foo/b.test.ts`

E2E scripts live in `client/test/e2e/<scenario>.ts` and are invoked via
`yarn e2e`, `yarn e2e-prediction-apy-v0`, etc. — not vitest.

## What do I mock?

**Default: nothing.** Wire a fake from `test/_support/`:

| Boundary | Fake |
|---|---|
| Claude subprocess | `createFakeClaudeRunner()` from `@test/claude.js` |
| Chain RPC (integration) | `spawnAnvilFork()` from `@test/chain/anvil.js` |
| IPFS | `createFakeIPFS()` from `@test/ipfs.js` |
| Time | `new FakeClock()` from `@test/time.js` |
| SQLite store | `withTempStore(fn)` from `@test/store.js` |
| `process.exit` | `makeCommandCtx()` from `@test/cli.js` captures it |

Only boundaries are legitimate targets for `vi.mock`. Every `vi.mock` call
requires a `// MOCK_JUSTIFICATION:` comment on the preceding line.

**Bad** — mocks an internal module:
```ts
vi.mock('../../src/config.js', () => ({ loadConfig: () => ({ ... }) }));
```

**Good** — inject the dep instead:
```ts
const cmd = createDoctorCommand({ loadConfig: () => ({ ... }), /* … */ });
```

**Legit vi.mock** — external boundary, DI infeasible:
```ts
// MOCK_JUSTIFICATION: child_process.spawn is a leaf syscall; cannot DI without a shim module we don't own.
vi.mock('node:child_process', () => ({ /* … */ }));
```

## Skeletons

### Unit test

```ts
import { describe, it, expect } from 'vitest';
import { canonicalizeJson } from '@/lib/canonical-json.js';

describe('canonicalizeJson', () => {
  it('sorts keys recursively', () => {
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
```

### Integration test — CLI command

```ts
import { describe, it, expect } from 'vitest';
import { createDoctorCommand } from '@/cli/commands/doctor.js';
import { runCommand } from '@test/cli.js';

describe('doctor command', () => {
  it('emits ok envelope on green path', async () => {
    const cmd = createDoctorCommand({
      loadConfig: () => ({ /* fake config */ } as any),
      checkRpcNetwork: async () => ({ ok: true, /* … */ }),
      /* other deps */
    });
    const { envelopes } = await runCommand(cmd);
    expect((envelopes[0] as { ok: boolean }).ok).toBe(true);
  });
});
```

### Integration test — engine / state machine

```ts
import { describe, it, expect } from 'vitest';
import { withTempStore } from '@test/store.js';
import { makeTaskInput, createStateMachineSpy } from '@test/engine.js';

describe('engine lifecycle', () => {
  it('transitions DISCOVERED → claim', async () => {
    await withTempStore(async (store) => {
      const { engine, calls } = createStateMachineSpy({
        store,
        onClaim: async () => { /* success */ },
      });
      const task = engine.testPersistence.insertDiscovered(makeTaskInput());
      await engine.claim(task);
      expect(calls).toContain('claim');
    });
  });
});
```

### E2E

```ts
import { spawnAnvilFork } from '../_support/chain/anvil.js';
import { fundAddressWithOLAS } from '../_support/chain/olas-funding.js';

const chain = await spawnAnvilFork({ silent: true });
try {
  await fundAddressWithOLAS(chain, someSafeAddress, 5000n * 10n ** 18n);
  // … drive the scenario via real CLI subprocesses, viem clients, etc.
} finally {
  await chain.teardown();
}
```

## How do I run tests?

| Command | Scope | Target time |
|---|---|---|
| `yarn test` | vitest (unit + integration) | < 15 s |
| `yarn test:watch` | vitest in watch mode | — |
| `yarn e2e` | one e2e scenario (validate) | < 2 min |
| `yarn e2e-prediction-apy-v0` | prediction-apy e2e | < 2 min |
| `yarn e2e:prediction` | prediction-v0 e2e (compiles contracts first) | < 3 min |
| `yarn staking` | staking bootstrap e2e | < 2 min |
| `yarn stolas` | stolas bootstrap e2e | < 2 min |

## Troubleshooting (client)

### `better-sqlite3` NODE_MODULE_VERSION mismatch

If `yarn test` fails loading SQLite with an ABI mismatch (built for a different Node than the one running), reinstall native deps against the active runtime:

```bash
cd client
corepack enable   # pin Yarn via packageManager
rm -rf node_modules
yarn install
```

Use **Node 22** where possible (`engines` in `client/package.json`). CI should match that major version.

## CI gates

- Every PR: `yarn typecheck` + `yarn test`.
- Nightly / release: all `yarn e2e*` scenarios serially.
- E2E tests use `allocateAnvilPort()` so parallelism is safe when we add it.

## Adding a new helper to `test/_support/`

1. Write the helper's own unit test under `test/_support/<name>.test.ts`.
2. Implement the helper. Prefer pure TS; lean on existing node APIs for I/O.
3. Document the helper's public API in a comment at the top of the file.
4. Migrate one existing test to use it, as proof that the API fits.

## Migration policy

Existing tests stay as-is until someone touches them. When a PR modifies
`src/foo/bar.ts`, the tests for that file migrate to the new shape in the same PR.
No big-bang refactor. New tests always use the new shape.
