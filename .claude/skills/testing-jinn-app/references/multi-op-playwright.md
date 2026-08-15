# Multi-op Playwright template

For automated regression coverage of two-operator flows. Tests live under `operator/test/dashboard/multi-op/`. Pattern below mirrors the existing single-op `operator/test/dashboard/spa-config.e2e.test.ts` but with two daemons + two Playwright pages.

> **Prerequisites — not yet on the Plan B branch.**
> - **Plan A's `substrate-copy.ts`.** The templates below import `copyWorkspace`
>   from `operator/scripts/release/substrate-copy.ts`. That file is a Plan A
>   artifact and does not exist on this branch.
> - **A shared, port-aware `mockDaemonApi`.** The templates call
>   `mockDaemonApi(page, { port })` — a two-arg form. The current
>   `mockDaemonApi` is a private single-arg function inside
>   `operator/test/dashboard/spa-config.e2e.test.ts` with the port hardcoded to
>   7332. It must first be extracted to a shared module (e.g.
>   `operator/test/dashboard/helpers/mock-daemon-api.ts`) and extended to accept
>   a `port` argument. **Plan C does this extraction.** Until both land, the
>   mocked variant of these templates will not compile.

## Template

```typescript
// operator/test/dashboard/multi-op/<scenario>.e2e.test.ts
import { test, expect, type Page } from '@playwright/test';
import { spawnMultiOpDaemons, type MultiOpHandle } from '../../helpers/multi-op-daemon';
import { copyWorkspace } from '../../../scripts/release/substrate-copy';
// `mockDaemonApi` is currently a private function inside
// `operator/test/dashboard/spa-config.e2e.test.ts` (see line ~130). Before
// landing multi-op tests, Plan C/D needs to extract it to a shared module —
// e.g. `operator/test/dashboard/helpers/mock-daemon-api.ts` — and accept a
// `port` argument (the single-op version is hardcoded to 7332).
import { mockDaemonApi } from '../helpers/mock-daemon-api';

let workspace: Awaited<ReturnType<typeof copyWorkspace>>;
let daemons: MultiOpHandle;
let opAUrl: string;
let opBUrl: string;

test.beforeAll(async () => {
  workspace = await copyWorkspace({ ops: ['op-a', 'op-b'] });
  daemons = await spawnMultiOpDaemons({
    ops: [
      { name: 'op-a', home: workspace.opPaths['op-a'], apiPort: 7732 },
      { name: 'op-b', home: workspace.opPaths['op-b'], apiPort: 7733 },
    ],
    readyTimeoutMs: 30000,
  });
  opAUrl = daemons.daemons['op-a'].handshakeUrl ?? `http://127.0.0.1:7732/`;
  opBUrl = daemons.daemons['op-b'].handshakeUrl ?? `http://127.0.0.1:7733/`;
});

test.afterAll(async () => {
  await daemons?.teardown();
  await workspace?.teardown();
});

test('op-a launches SolverNet → op-b sees it within 30s', async ({ browser }) => {
  // Create two isolated contexts — separate cookies, separate state per op
  const opACtx = await browser.newContext();
  const opBCtx = await browser.newContext();
  const opAPage = await opACtx.newPage();
  const opBPage = await opBCtx.newPage();

  // Optional: mock daemon API per page (matches the single-op pattern)
  await mockDaemonApi(opAPage, { port: 7732 });
  await mockDaemonApi(opBPage, { port: 7733 });

  await opAPage.goto(opAUrl);
  await opBPage.goto(opBUrl);

  // Drive op-a (Launcher Create wizard)
  await opAPage.getByRole('link', { name: /launcher/i }).click();
  await opAPage.getByRole('button', { name: /create solvernet/i }).click();
  // ... wizard steps ...
  await opAPage.getByRole('button', { name: /launch/i }).click();
  await expect(opAPage.getByText(/launched/i)).toBeVisible({ timeout: 60000 });

  // Verify op-b sees the new SolverNet within 30s of launch
  await opBPage.goto(opBUrl + '/operator/join');
  await expect(opBPage.getByText(/new-solvernet-name/i)).toBeVisible({ timeout: 30000 });

  await opACtx.close();
  await opBCtx.close();
});
```

## Two pages, two contexts

Use **separate Playwright `BrowserContext`** instances per operator. Each context has its own cookies, localStorage, and session. If you reuse one context with two pages, the second page's auth state will collide with the first.

```typescript
const opACtx = await browser.newContext();
const opAPage = await opACtx.newPage();

const opBCtx = await browser.newContext();
const opBPage = await opBCtx.newPage();
```

## Mock vs real daemon

Two modes, choose per scenario:

### Mocked (T1.4 SPA route smoke, T2.3 multi-op SPA flow lite variant)

Each Playwright page gets its own `mockDaemonApi(page, { port })` call. Reuses the existing single-op mock helper — **but only once it is extracted to a shared, port-aware module (Plan C); see the Prerequisites note at the top.** Fast, deterministic, doesn't need real daemons running — but doesn't catch bugs that only surface with real daemon state.

### Real (T2.1, T2.2, T2.3 full variant)

No `mockDaemonApi` call. Pages talk to the real daemons started by `spawnMultiOpDaemons`. Slower, requires substrate, exercises real RPC + indexer integration. Catches real integration bugs.

## Helper conventions

For tests that recur, lift the daemon spawn into a fixture file under `operator/test/dashboard/multi-op/fixtures/`. Example:

```typescript
// fixtures/two-substrate-ops.ts
import { test as base } from '@playwright/test';
import { spawnMultiOpDaemons, type MultiOpHandle } from '../../../helpers/multi-op-daemon';
import { copyWorkspace } from '../../../../scripts/release/substrate-copy';

export const test = base.extend<{ daemons: MultiOpHandle; opAUrl: string; opBUrl: string }>({
  daemons: async ({}, use) => {
    const workspace = await copyWorkspace({ ops: ['op-a', 'op-b'] });
    const daemons = await spawnMultiOpDaemons({
      ops: [
        { name: 'op-a', home: workspace.opPaths['op-a'], apiPort: 7732 },
        { name: 'op-b', home: workspace.opPaths['op-b'], apiPort: 7733 },
      ],
    });
    try {
      await use(daemons);
    } finally {
      await daemons.teardown();
      await workspace.teardown();
    }
  },
  opAUrl: async ({ daemons }, use) => {
    await use(daemons.daemons['op-a'].handshakeUrl ?? 'http://127.0.0.1:7732/');
  },
  opBUrl: async ({ daemons }, use) => {
    await use(daemons.daemons['op-b'].handshakeUrl ?? 'http://127.0.0.1:7733/');
  },
});
```

## Common failure modes

| Failure | Likely cause | Fix |
|---|---|---|
| op-b sees stale op-a state | indexer hasn't caught up | use `expect(...).toBeVisible({ timeout: 30000 })`, not `await page.waitForSelector(...)` |
| Auth/cookie collision | reused single context for two operators | always two `browser.newContext()` calls |
| Daemon spawn timeout | dist/bin/jinn.js missing or stale | `yarn build` before running |
| Tests pass locally, flake in CI | RPC saturation or test parallelism | run multi-op tests with `workers: 1` for now (see jinn-mono-lrey) |
| `mockDaemonApi` doesn't intercept | wrong port arg | helper takes port; verify the page's daemon URL matches |

## Running the tests

Single multi-op file:
```bash
cd operator && yarn build && yarn playwright test --config=playwright.config.ts test/dashboard/multi-op/<scenario>.e2e.test.ts
```

All multi-op:
```bash
cd operator && yarn build && yarn playwright test --config=playwright.config.ts test/dashboard/multi-op/
```

Sequential (avoid RPC saturation):
```bash
cd operator && yarn playwright test --config=playwright.config.ts --workers=1 test/dashboard/multi-op/
```
