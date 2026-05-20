# testing-jinn-app multi-op extension implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `testing-jinn-app` skill at `.claude/skills/testing-jinn-app/SKILL.md` to cover multi-operator scenarios. Ships documentation (skill extension + 7 reference docs) plus minimal helper code (multi-op daemon spawn helper + handshake URL capture) that the scenario implementations in Plans C/D consume. Existing single-op recipes stay unchanged.

**Architecture:** Skill is the library; release-prep is the gate runner; release-readiness is the audit. This plan delivers the library. Reference docs describe scenarios at the level of detail Plans C/D's implementation tasks need; minimal helpers (`multi-op-daemon.ts`, `handshake-url.ts`) live in `client/test/helpers/` so Plans C/D import them. The scenario recipes (`scenario-*.md`) are the contract between Plans B (recipe writer) and Plans C/D (recipe consumer).

**Tech Stack:** Markdown for skill + reference docs. TypeScript + Vitest + `child_process` for the spawn helper. Helpers test against a real daemon spawn using a dedicated tmp HOME (no substrate dependency — uses the existing single-op `HOME=$tmpdir` pattern from the current skill).

**Dependencies:**
- **Plan A (substrate foundation)** — required for runtime of T2.x scenarios in Plans C/D, but NOT for any task in Plan B. Plan B's helpers operate on arbitrary HOME dirs and don't import substrate scripts. The scenario reference docs *describe* how to use substrate-derived workspaces, but the descriptions are static.
- **No other plans** — Plan B can be written and executed independently.

---

## File structure

**Source files (all new under `client/test/helpers/`):**

| Path | Responsibility |
|---|---|
| `client/test/helpers/handshake-url.ts` | Parse handshake URL from a daemon's stdout stream |
| `client/test/helpers/multi-op-daemon.ts` | Spawn N concurrent daemons with distinct HOMEs and ports; return handles |

**Test files:**

| Path | Covers |
|---|---|
| `client/test/helpers/handshake-url.test.ts` | URL parsing for various stdout shapes |
| `client/test/helpers/multi-op-daemon.test.ts` | Spawn lifecycle: start, ready, teardown |

**Skill files (under `.claude/skills/testing-jinn-app/`):**

| Path | New / modified | Responsibility |
|---|---|---|
| `.claude/skills/testing-jinn-app/SKILL.md` | modified | Add "Multi-operator scenarios" section + extend "Things to watch for" |
| `.claude/skills/testing-jinn-app/references/multi-op-spawn.md` | new | Bash + TypeScript spawn recipes |
| `.claude/skills/testing-jinn-app/references/multi-op-chrome-devtools.md` | new | Multi-page chrome-devtools driving pattern |
| `.claude/skills/testing-jinn-app/references/multi-op-playwright.md` | new | Playwright two-daemon test template |
| `.claude/skills/testing-jinn-app/references/scenario-spa-route-smoke.md` | new | T1.4 recipe (single-op, route smoke) |
| `.claude/skills/testing-jinn-app/references/scenario-cross-op-donation.md` | new | T2.1 recipe |
| `.claude/skills/testing-jinn-app/references/scenario-producer-evaluator.md` | new | T2.2 recipe |
| `.claude/skills/testing-jinn-app/references/scenario-multi-op-spa-flow.md` | new | T2.3 recipe |

No modifications to `client/package.json` or `playwright.config.ts` in this plan — Plans C/D do those.

---

## Task 1: Handshake URL parser

**Files:**
- Create: `client/test/helpers/handshake-url.ts`
- Test: `client/test/helpers/handshake-url.test.ts`

The daemon emits a one-time-use handshake URL on stdout/stderr at startup like `UI handshake URL: http://127.0.0.1:7332/auth?token=abc`. This helper extracts it from a stream of stdout lines.

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/helpers/handshake-url.test.ts
import { describe, it, expect } from 'vitest';
import { extractHandshakeUrl, makeHandshakeCollector } from './handshake-url';

describe('extractHandshakeUrl', () => {
  it('extracts URL from a typical daemon line', () => {
    const line = '[server] UI handshake URL: http://127.0.0.1:7332/auth/handshake?token=abc123';
    expect(extractHandshakeUrl(line)).toBe('http://127.0.0.1:7332/auth/handshake?token=abc123');
  });

  it('returns null on non-matching lines', () => {
    expect(extractHandshakeUrl('some unrelated log line')).toBeNull();
    expect(extractHandshakeUrl('')).toBeNull();
  });

  it('handles whitespace variation between label and URL', () => {
    const line = 'UI handshake URL:       http://localhost:7332/x';
    expect(extractHandshakeUrl(line)).toBe('http://localhost:7332/x');
  });

  it('does not match if URL is missing', () => {
    expect(extractHandshakeUrl('UI handshake URL:')).toBeNull();
  });
});

describe('makeHandshakeCollector', () => {
  it('resolves when URL appears in a chunk', async () => {
    const collector = makeHandshakeCollector(5000);
    collector.feed('startup line\n');
    collector.feed('UI handshake URL: http://127.0.0.1:7332/auth?t=xyz\n');
    const url = await collector.promise;
    expect(url).toBe('http://127.0.0.1:7332/auth?t=xyz');
  });

  it('handles URL split across two feed calls', async () => {
    const collector = makeHandshakeCollector(5000);
    collector.feed('UI handshake URL: http://12');
    collector.feed('7.0.0.1:7332/auth?t=split\n');
    const url = await collector.promise;
    expect(url).toBe('http://127.0.0.1:7332/auth?t=split');
  });

  it('rejects after timeout if URL never arrives', async () => {
    const collector = makeHandshakeCollector(50);
    collector.feed('only unrelated lines\n');
    await expect(collector.promise).rejects.toThrow(/timed out/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && yarn vitest run test/helpers/handshake-url.test.ts`
Expected: FAIL with `Cannot find module './handshake-url'`

- [ ] **Step 3: Implement handshake-url.ts**

```typescript
// client/test/helpers/handshake-url.ts

const HANDSHAKE_RE = /UI handshake URL:\s+(\S+)/;

export function extractHandshakeUrl(line: string): string | null {
  const m = line.match(HANDSHAKE_RE);
  return m ? m[1] : null;
}

export interface HandshakeCollector {
  feed: (chunk: string) => void;
  promise: Promise<string>;
}

export function makeHandshakeCollector(timeoutMs: number): HandshakeCollector {
  let buffer = '';
  let resolve!: (url: string) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = setTimeout(() => {
    reject(new Error(`handshake URL collector timed out after ${timeoutMs}ms; buffered: ${buffer.slice(0, 200)}`));
  }, timeoutMs);
  return {
    feed(chunk: string) {
      buffer += chunk;
      // Split on newlines so the regex doesn't match a partial URL that's
      // been buffered across two chunk arrivals (e.g. `http://12` then
      // `7.0.0.1:7332/...`). Only check complete (newline-terminated) lines.
      const lines = buffer.split(/\r?\n/);
      const completeLines = lines.slice(0, -1);
      for (const line of completeLines) {
        const url = extractHandshakeUrl(line);
        if (url) {
          clearTimeout(timer);
          resolve(url);
          return;
        }
      }
    },
    promise,
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd client && yarn vitest run test/helpers/handshake-url.test.ts`
Expected: PASS, 7 tests passing

- [ ] **Step 5: Commit**

```bash
git add client/test/helpers/handshake-url.ts client/test/helpers/handshake-url.test.ts
git commit -m "test(helpers): add handshake URL parser for daemon spawn helpers"
```

---

## Task 2: Multi-op daemon spawn helper

**Files:**
- Create: `client/test/helpers/multi-op-daemon.ts`
- Test: `client/test/helpers/multi-op-daemon.test.ts`

The helper spawns N daemon processes, each with its own HOME (substrate-derived or fresh tmp) and apiPort. Returns handles that include the handshake URL and a teardown function.

- [ ] **Step 1: Write the failing test**

```typescript
// client/test/helpers/multi-op-daemon.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnMultiOpDaemons, type MultiOpHandle } from './multi-op-daemon';

describe('spawnMultiOpDaemons', () => {
  let tmpRoot: string;
  let opAHome: string;
  let opBHome: string;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-op-helper-'));
    opAHome = path.join(tmpRoot, 'op-a');
    opBHome = path.join(tmpRoot, 'op-b');
    await fs.mkdir(path.join(opAHome, '.jinn-client'), { recursive: true });
    await fs.mkdir(path.join(opBHome, '.jinn-client'), { recursive: true });
    // Seed minimal config so the daemon doesn't error out on missing fields.
    // (Real tests will use substrate-copy workspaces; this test just exercises the helper.)
    const minimalCfg = (port: number) => JSON.stringify({
      network: 'testnet',
      apiPort: port,
      rpcUrl: 'https://base-sepolia.example/dummy',
      pollIntervalMs: 5000,
    });
    await fs.writeFile(path.join(opAHome, '.jinn-client', 'config.json'), minimalCfg(7732));
    await fs.writeFile(path.join(opBHome, '.jinn-client', 'config.json'), minimalCfg(7733));
  });

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('spawns N daemons with distinct ports and returns handles', async () => {
    // NOTE: this test requires `yarn build` has been run (dist/bin/jinn.js exists).
    // If dist is missing, it should skip rather than fail.
    const distPath = path.resolve(__dirname, '..', '..', 'dist', 'bin', 'jinn.js');
    try { await fs.access(distPath); } catch {
      // dist not built; skip
      return;
    }

    let handle: MultiOpHandle | undefined;
    try {
      handle = await spawnMultiOpDaemons({
        ops: [
          { name: 'op-a', home: opAHome, apiPort: 7732 },
          { name: 'op-b', home: opBHome, apiPort: 7733 },
        ],
        readyTimeoutMs: 30000,
      });
      expect(Object.keys(handle.daemons).sort()).toEqual(['op-a', 'op-b']);
      // handshakeUrl may be present only if the daemon emits it; bootstrap-incomplete daemons may not.
      // The contract: each daemon has a pid and an apiPort.
      expect(handle.daemons['op-a'].apiPort).toBe(7732);
      expect(handle.daemons['op-b'].apiPort).toBe(7733);
      expect(handle.daemons['op-a'].pid).toBeGreaterThan(0);
      expect(handle.daemons['op-b'].pid).toBeGreaterThan(0);
    } finally {
      if (handle) await handle.teardown();
    }
  }, 60000);

  it('teardown is idempotent', async () => {
    const distPath = path.resolve(__dirname, '..', '..', 'dist', 'bin', 'jinn.js');
    try { await fs.access(distPath); } catch { return; }

    const handle = await spawnMultiOpDaemons({
      ops: [{ name: 'op-a', home: opAHome, apiPort: 7734 }],
      readyTimeoutMs: 30000,
    });
    await handle.teardown();
    await expect(handle.teardown()).resolves.toBeUndefined();
  }, 60000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd client && yarn vitest run test/helpers/multi-op-daemon.test.ts`
Expected: FAIL with `Cannot find module './multi-op-daemon'`

- [ ] **Step 3: Implement multi-op-daemon.ts**

```typescript
// client/test/helpers/multi-op-daemon.ts
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { makeHandshakeCollector } from './handshake-url';

export interface OpSpec {
  name: string;
  home: string;                 // HOME directory containing .jinn-client/
  apiPort: number;
}

export interface DaemonHandle {
  name: string;
  pid: number;
  apiPort: number;
  handshakeUrl: string | null;  // null if not emitted within readyTimeoutMs
  process: ChildProcess;
}

export interface MultiOpHandle {
  daemons: Record<string, DaemonHandle>;
  teardown: () => Promise<void>;
}

export interface SpawnMultiOpOptions {
  ops: OpSpec[];
  readyTimeoutMs?: number;      // default 30s
  jinnBinPath?: string;         // default: resolve from cwd / dist/bin/jinn.js
  extraEnv?: NodeJS.ProcessEnv;
}

async function waitForBootstrap(apiPort: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/v1/bootstrap`, { method: 'GET' });
      if (res.status === 200 || res.status === 401) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`daemon on port ${apiPort} did not become reachable within ${timeoutMs}ms`);
}

export async function spawnMultiOpDaemons(opts: SpawnMultiOpOptions): Promise<MultiOpHandle> {
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30000;
  const jinnBin = opts.jinnBinPath ?? path.resolve(process.cwd(), 'dist', 'bin', 'jinn.js');

  const daemons: Record<string, DaemonHandle> = {};
  const processes: ChildProcess[] = [];

  async function killAll(): Promise<void> {
    for (const proc of processes) {
      if (!proc.killed && proc.pid) {
        try { proc.kill('SIGTERM'); } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, 200));
    for (const proc of processes) {
      if (!proc.killed && proc.pid) {
        try { proc.kill('SIGKILL'); } catch {}
      }
    }
  }

  // When the test seed config has an unreachable rpcUrl (e.g. a dummy hostname
  // used in beforeAll setup), JINN_RPC_URL overrides config so the daemon's
  // RPC preflight can pass. config.ts gives JINN_RPC_URL unconditional precedence
  // over BASE_RPC_URL and BASE_SEPOLIA_RPC_URL, so the helper must consult any
  // RPC URL the caller put in extraEnv (e.g. an Anvil fork URL) and surface it
  // through JINN_RPC_URL — otherwise extraEnv.BASE_RPC_URL would be silently
  // overridden by the host fallback. Resolution order: extraEnv.JINN_RPC_URL,
  // extraEnv.BASE_RPC_URL, host JINN_RPC_URL, host BASE_SEPOLIA_RPC_URL, then
  // the public Tenderly gateway (matches config.ts:986).
  const fallbackRpcUrl =
    opts.extraEnv?.['JINN_RPC_URL'] ??
    opts.extraEnv?.['BASE_RPC_URL'] ??
    process.env['JINN_RPC_URL'] ??
    process.env['BASE_SEPOLIA_RPC_URL'] ??
    'https://base-sepolia.gateway.tenderly.co/75tyLMQuD8EHpXxMwINIKu';

  try {
    for (const op of opts.ops) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        JINN_RPC_URL: fallbackRpcUrl,
        ...opts.extraEnv,
        HOME: op.home,
        JINN_API_PORT: op.apiPort.toString(),
      };
      const proc = spawn('node', [jinnBin, 'run', '--no-ui'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      processes.push(proc);

      const collector = makeHandshakeCollector(readyTimeoutMs);
      proc.stdout?.on('data', (chunk) => collector.feed(chunk.toString()));
      proc.stderr?.on('data', (chunk) => collector.feed(chunk.toString()));

      // Wait for bootstrap to be reachable
      await waitForBootstrap(op.apiPort, readyTimeoutMs);

      // Best-effort handshake URL capture (may not emit if daemon is in non-running mode)
      let handshakeUrl: string | null = null;
      try {
        handshakeUrl = await Promise.race([
          collector.promise,
          new Promise<string>((_, rej) => setTimeout(() => rej(new Error('handshake not emitted')), 2000)),
        ]);
      } catch {
        handshakeUrl = null;
      }

      daemons[op.name] = {
        name: op.name,
        pid: proc.pid ?? -1,
        apiPort: op.apiPort,
        handshakeUrl,
        process: proc,
      };
    }
  } catch (err) {
    await killAll();
    throw err;
  }

  let torn = false;
  return {
    daemons,
    teardown: async () => {
      if (torn) return;
      torn = true;
      await killAll();
    },
  };
}
```

- [ ] **Step 4: Build the client and run the test**

Run: `cd client && yarn build && yarn vitest run test/helpers/multi-op-daemon.test.ts`
Expected: PASS, 2 tests passing (or skipping if `dist/bin/jinn.js` somehow missing after build)

- [ ] **Step 5: Commit**

```bash
git add client/test/helpers/multi-op-daemon.ts client/test/helpers/multi-op-daemon.test.ts
git commit -m "test(helpers): add multi-op daemon spawn helper"
```

---

## Task 3: Update testing-jinn-app SKILL.md — multi-operator section header

**Files:**
- Modify: `.claude/skills/testing-jinn-app/SKILL.md`

Add a new top-level section to the existing SKILL.md, immediately after the "Automated E2E (Playwright)" section. Existing single-op recipes stay unchanged.

- [ ] **Step 1: Read the current SKILL.md to find the insertion point**

Run: `cat .claude/skills/testing-jinn-app/SKILL.md | grep -n "^## " | head -20`
Expected output: section headers with line numbers. Find the section just before "Quick reference" (the manual smoke + Playwright recipes end before that summary section).

- [ ] **Step 2: Insert the multi-operator section**

Open `.claude/skills/testing-jinn-app/SKILL.md` and insert the following new section AFTER the "Automated E2E (Playwright)" section and BEFORE "Quick reference":

```markdown
## Multi-operator scenarios

The single-op recipes above (manual smoke, automated E2E) cover testing one operator in isolation. Multi-operator scenarios — where two daemons interact via the chain and via the operator app — require additional infrastructure that this section documents. Reference docs in `references/` cover each pattern in detail.

Spawn pattern: two (or more) daemons run concurrently against distinct HOMEs (substrate-derived workspaces from Plan A's `substrate-copy`, or fresh tmp HOMEs for clean-state E2Es). Each daemon gets a distinct `JINN_API_PORT`. Helpers in `client/test/helpers/multi-op-daemon.ts` wrap the spawn + teardown lifecycle.

Three method-pattern reference docs cover the mechanics:

- [`references/multi-op-spawn.md`](references/multi-op-spawn.md) — bash + TypeScript spawn recipes; port management; teardown.
- [`references/multi-op-chrome-devtools.md`](references/multi-op-chrome-devtools.md) — multi-page chrome-devtools driving for cross-op manual smoke.
- [`references/multi-op-playwright.md`](references/multi-op-playwright.md) — Playwright template for two-daemon automated tests.

Four scenario reference docs are the contracts release-prep's gate runner consumes. Each describes one scenario at the level of detail an implementer needs:

- [`references/scenario-spa-route-smoke.md`](references/scenario-spa-route-smoke.md) — T1.4: load every SPA route against a mocked daemon, assert clean.
- [`references/scenario-cross-op-donation.md`](references/scenario-cross-op-donation.md) — T2.1: op-a produces corpus artifact, op-b consumes via x402.
- [`references/scenario-producer-evaluator.md`](references/scenario-producer-evaluator.md) — T2.2: op-a solves task on Anvil-fork, op-b evaluates.
- [`references/scenario-multi-op-spa-flow.md`](references/scenario-multi-op-spa-flow.md) — T2.3: op-a launches SolverNet via SPA, op-b joins via SPA, both observe each other.

### Things to watch for (multi-op specific)

In addition to the single-op concerns listed earlier:

- **Cross-operator visibility lag** — op-b sees op-a's actions only after the indexer has caught up (~2 indexer-poll-intervals). Wait, don't assume instant.
- **Identity collisions** — spawning two daemons with the same HOME means both fight for the same agentId/Safe/nonce. Always verify *both* apiPort AND source HOME directory are distinct before spawning.
- **Workspace bleed** — substrate-derived workspaces under `~/jinn-dev/workspaces/` are auto-pruned at 7 days by `substrate-reap`. Don't leave a workspace assumed to be there between test runs; either own its lifecycle or use a fresh one each test.
- **Substrate staleness** — if `substrate-verify` reports drift, all multi-op scenarios using substrate workspaces will fail in non-obvious ways. Run verify before any multi-op session.
- **RPC saturation under concurrent load** — substrate ops currently share one Tenderly key (per spec §2). If both daemons hammer the RPC simultaneously, expect HTTP 429. Tracked as `jinn-mono-lrey`; for now, add jittered delays in scenarios where both daemons are RPC-active.
```

Save the file.

- [ ] **Step 3: Sanity-check the insertion**

Run: `grep -A 2 "## Multi-operator scenarios" .claude/skills/testing-jinn-app/SKILL.md | head -5`
Expected output: the section header and its intro line.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/testing-jinn-app/SKILL.md
git commit -m "docs(testing-jinn-app): add multi-operator scenarios section"
```

---

## Task 4: Reference doc — multi-op-spawn.md

**Files:**
- Create: `.claude/skills/testing-jinn-app/references/multi-op-spawn.md`

- [ ] **Step 1: Create the reference doc**

Save the following as `.claude/skills/testing-jinn-app/references/multi-op-spawn.md`:

```markdown
# Multi-op daemon spawn

How to spawn two or more `jinn` daemons concurrently for cross-operator testing. Two recipes — bash for ad-hoc use, TypeScript for automated tests.

## Source of HOMEs

Two flavors:

1. **Substrate-derived workspaces** — use Plan A's `substrate-copy.ts` to create per-run isolated copies of `op-a` / `op-b` from gold. Best for scenarios that need pre-bootstrapped identity (most T2.x scenarios).

   ```typescript
   // Path relative to the importing file. Plan A's substrate-copy lives at
   // `client/scripts/release/substrate-copy.ts` (outside `src/`, so the `@/`
   // alias does NOT reach it — use a relative path).
   import { copyWorkspace } from '../../scripts/release/substrate-copy';

   const handle = await copyWorkspace({ ops: ['op-a', 'op-b'] });
   // handle.opPaths['op-a'] → '/Users/.../jinn-dev/workspaces/<run-id>/op-a/'
   // teardown via handle.teardown() at end of test
   ```

2. **Fresh tmp HOMEs** — for clean-state E2E tests that don't need an existing identity (e.g. fresh-bootstrap scenarios). Each daemon gets its own `HOME=$tmpdir`.

   ```typescript
   const opAHome = await fs.mkdtemp(path.join(os.tmpdir(), 'fresh-op-a-'));
   const opBHome = await fs.mkdtemp(path.join(os.tmpdir(), 'fresh-op-b-'));
   // (Seed minimal config under <home>/.jinn-client/config.json as needed)
   ```

## Bash recipe (ad-hoc)

```bash
# Set up substrate workspace
RUN_ID="$(date -u +%Y-%m-%dT%H-%M-%S)-$RANDOM"
yarn substrate:copy op-a op-b
# (parse runId from stdout; or skip and use fixed paths in dev)

# Spawn op-a (apiPort 7332, persistent identity from substrate)
HOME=~/jinn-dev/workspaces/$RUN_ID/op-a JINN_API_PORT=7332 \
  node dist/bin/jinn.js run --no-ui > /tmp/op-a.log 2>&1 &
OP_A_PID=$!

# Spawn op-b (apiPort 7333)
HOME=~/jinn-dev/workspaces/$RUN_ID/op-b JINN_API_PORT=7333 \
  node dist/bin/jinn.js run --no-ui > /tmp/op-b.log 2>&1 &
OP_B_PID=$!

# Wait for both /v1/bootstrap to be reachable
for port in 7332 7333; do
  until curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$port/v1/bootstrap | grep -qE "200|401"; do
    sleep 0.25
  done
done

# Capture handshake URLs from logs
OP_A_URL="$(grep -m1 'UI handshake URL:' /tmp/op-a.log | sed 's/.*UI handshake URL:\s*//')"
OP_B_URL="$(grep -m1 'UI handshake URL:' /tmp/op-b.log | sed 's/.*UI handshake URL:\s*//')"

echo "op-a: $OP_A_URL"
echo "op-b: $OP_B_URL"

# Teardown
trap "kill $OP_A_PID $OP_B_PID 2>/dev/null; rm -rf ~/jinn-dev/workspaces/$RUN_ID" EXIT
```

## TypeScript recipe (automated tests)

Use the helper at `client/test/helpers/multi-op-daemon.ts`:

```typescript
import { spawnMultiOpDaemons, type MultiOpHandle } from '../helpers/multi-op-daemon';
import { copyWorkspace } from '../../scripts/release/substrate-copy';

let workspace: Awaited<ReturnType<typeof copyWorkspace>>;
let daemons: MultiOpHandle;

beforeAll(async () => {
  workspace = await copyWorkspace({ ops: ['op-a', 'op-b'] });
  daemons = await spawnMultiOpDaemons({
    ops: [
      { name: 'op-a', home: workspace.opPaths['op-a'], apiPort: 7732 },
      { name: 'op-b', home: workspace.opPaths['op-b'], apiPort: 7733 },
    ],
    readyTimeoutMs: 30000,
  });
});

afterAll(async () => {
  await daemons.teardown();
  await workspace.teardown();
});

it('does cross-op thing', async () => {
  // daemons.daemons['op-a'].apiPort, .handshakeUrl, etc.
});
```

## Port selection

Substrate ops are pre-configured with apiPorts (op-a=7332, op-b=7333, op-c-legacy=7334). For tests that need different ports (e.g. avoiding collision with the daily-driver daemon at 7332), override via the `apiPort` option in the helper. The helper passes it as `JINN_API_PORT` env var; the daemon's config-resolution prefers env over config file.

For parallel test files (separate Vitest workers), pick non-overlapping port ranges (e.g. 7332-7333 for one file, 7732-7733 for another).

## Teardown contract

- `daemons.teardown()` sends SIGTERM to all spawned processes, waits 200ms, then SIGKILL if still alive.
- `daemons.teardown()` is idempotent — safe to call multiple times.
- Use a `try { ... } finally { await daemons.teardown(); }` pattern in tests. Don't rely on `afterAll` alone — if `beforeAll` partially succeeded (op-a started, op-b failed), the partial spawn must still be cleaned up.

## Common failure modes

| Failure | Likely cause | Fix |
|---|---|---|
| `daemon on port X did not become reachable within Yms` | port collision with another process | check `lsof -i :X` |
| `daemon on port X did not become reachable within Yms` | misconfigured HOME (config.json absent or malformed) | verify HOME/.jinn-client/config.json exists |
| handshake URL is null | daemon never reached "running" mode (bootstrap incomplete in HOME) | substrate-verify the HOME; or use substrate-derived HOME |
| teardown hangs | child process refusing SIGTERM | helper escalates to SIGKILL after 200ms; if test still hangs, increase the wait |
```

- [ ] **Step 2: Verify file readable**

Run: `head -15 .claude/skills/testing-jinn-app/references/multi-op-spawn.md`
Expected: first ~15 lines of the doc.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/testing-jinn-app/references/multi-op-spawn.md
git commit -m "docs(testing-jinn-app): add multi-op-spawn reference"
```

---

## Task 5: Reference doc — multi-op-chrome-devtools.md

**Files:**
- Create: `.claude/skills/testing-jinn-app/references/multi-op-chrome-devtools.md`

- [ ] **Step 1: Create the reference doc**

Save the following as `.claude/skills/testing-jinn-app/references/multi-op-chrome-devtools.md`:

```markdown
# Multi-op chrome-devtools driving

For manual smoke tests where you drive two operator apps side by side. Uses the `chrome-devtools` MCP server's multi-page support.

## Prereqs

- Both daemons spawned (see [multi-op-spawn.md](multi-op-spawn.md)). Capture both handshake URLs.
- `chrome-devtools` MCP loaded in your session. Verify with `ToolSearch query="chrome devtools navigate"` — if `mcp__chrome-devtools__new_page` and `mcp__chrome-devtools__select_page` don't surface, this MCP isn't loaded and the recipe below won't work; fall back to manual two-browser-window driving.

## Recipe

```typescript
// 1. Open a page per operator
const opAPage = await mcp__chrome_devtools__new_page({ url: opAHandshakeUrl });
const opBPage = await mcp__chrome_devtools__new_page({ url: opBHandshakeUrl });

// 2. Drive op-a — explicitly select before each action
await mcp__chrome_devtools__select_page({ pageId: opAPage });
await mcp__chrome_devtools__click({ selector: 'button:has-text("Create SolverNet")' });
// ... wizard steps ...

// 3. Drive op-b — explicitly select again
await mcp__chrome_devtools__select_page({ pageId: opBPage });
await mcp__chrome_devtools__navigate_page({ url: opBHandshakeUrl + '/operator/join' });
await mcp__chrome_devtools__take_screenshot({});

// 4. Cross-verify: switch back to op-a and check op-a sees op-b's action
await mcp__chrome_devtools__select_page({ pageId: opAPage });
await mcp__chrome_devtools__navigate_page({ url: opAHandshakeUrl + '/launcher/launched/<id>' });
```

## Critical rule: always select before acting

chrome-devtools MCP maintains an "active page" pointer. Every click / type / navigate operates on the currently-selected page. If you fan out across two pages without explicit `select_page` calls, you'll drive whichever happened to be selected last — often the wrong one.

**Pattern:**
```typescript
async function driveOnPage(pageId: string, action: () => Promise<void>): Promise<void> {
  await mcp__chrome_devtools__select_page({ pageId });
  await action();
}
```

Wrap every cross-page operation in this pattern.

## Cross-op visibility lag

When op-a performs an action that op-b should see (e.g. op-a launches a SolverNet, op-b should see it in the catalog), there's a delay equal to:

- One indexer poll interval (~5 sec for the Ponder indexer at default config)
- Plus one SPA poll interval (~1.5 sec for useQuery defaults)

**Don't assert op-b's view immediately after op-a's action.** Wait at least 10 seconds for indexer + SPA polls. Use `wait_for` with the expected DOM state, not a fixed sleep:

```typescript
await mcp__chrome_devtools__select_page({ pageId: opBPage });
await mcp__chrome_devtools__wait_for({
  text: 'my-new-solvernet',
  timeout: 30000,                  // generous; indexer can lag
});
```

## Screenshot conventions

When reporting a multi-op smoke result, take screenshots of both pages at each critical state, named consistently:

```typescript
await mcp__chrome_devtools__select_page({ pageId: opAPage });
await mcp__chrome_devtools__take_screenshot({ name: '01-op-a-after-create' });

await mcp__chrome_devtools__select_page({ pageId: opBPage });
await mcp__chrome_devtools__take_screenshot({ name: '02-op-b-catalog-shows-new' });
```

Screenshot pairs at each step make cross-op state comparison readable.

## Common failure modes

| Failure | Likely cause | Fix |
|---|---|---|
| Action happens on wrong page | forgot to `select_page` before action | wrap in `driveOnPage` helper |
| op-b doesn't see op-a's change | not waiting for indexer/SPA poll | use `wait_for` with expected text, not sleep |
| Stale screenshot | took screenshot before page actually updated | wait for the indicator DOM change first |
| MCP not loaded | session doesn't have chrome-devtools MCP | check `ToolSearch query="chrome devtools navigate"`; fall back to Playwright recipe |
```

- [ ] **Step 2: Verify file readable**

Run: `head -10 .claude/skills/testing-jinn-app/references/multi-op-chrome-devtools.md`
Expected: first ~10 lines of the doc.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/testing-jinn-app/references/multi-op-chrome-devtools.md
git commit -m "docs(testing-jinn-app): add multi-op chrome-devtools reference"
```

---

## Task 6: Reference doc — multi-op-playwright.md

**Files:**
- Create: `.claude/skills/testing-jinn-app/references/multi-op-playwright.md`

- [ ] **Step 1: Create the reference doc**

Save the following as `.claude/skills/testing-jinn-app/references/multi-op-playwright.md`:

```markdown
# Multi-op Playwright template

For automated regression coverage of two-operator flows. Tests live under `client/test/dashboard/multi-op/`. Pattern below mirrors the existing single-op `client/test/dashboard/spa-config.e2e.test.ts` but with two daemons + two Playwright pages.

## Template

```typescript
// client/test/dashboard/multi-op/<scenario>.e2e.test.ts
import { test, expect, type Page } from '@playwright/test';
import { spawnMultiOpDaemons, type MultiOpHandle } from '../../helpers/multi-op-daemon';
import { copyWorkspace } from '../../../scripts/release/substrate-copy';
// `mockDaemonApi` is currently a private function inside
// `client/test/dashboard/spa-config.e2e.test.ts` (line ~130). Before
// landing multi-op tests, Plan C/D needs to extract it to a shared module —
// e.g. `client/test/dashboard/helpers/mock-daemon-api.ts` — and accept a
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

Each Playwright page gets its own `mockDaemonApi(page, { port })` call. Reuses the existing single-op mock helper. Fast, deterministic, doesn't need real daemons running — but doesn't catch bugs that only surface with real daemon state.

### Real (T2.1, T2.2, T2.3 full variant)

No `mockDaemonApi` call. Pages talk to the real daemons started by `spawnMultiOpDaemons`. Slower, requires substrate, exercises real RPC + indexer integration. Catches real integration bugs.

## Helper conventions

For tests that recur, lift the daemon spawn into a fixture file under `client/test/dashboard/multi-op/fixtures/`. Example:

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
cd client && yarn build && yarn playwright test --config=playwright.config.ts test/dashboard/multi-op/<scenario>.e2e.test.ts
```

All multi-op:
```bash
cd client && yarn build && yarn playwright test --config=playwright.config.ts test/dashboard/multi-op/
```

Sequential (avoid RPC saturation):
```bash
cd client && yarn playwright test --config=playwright.config.ts --workers=1 test/dashboard/multi-op/
```
```

- [ ] **Step 2: Verify file readable**

Run: `head -10 .claude/skills/testing-jinn-app/references/multi-op-playwright.md`
Expected: first ~10 lines.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/testing-jinn-app/references/multi-op-playwright.md
git commit -m "docs(testing-jinn-app): add multi-op Playwright template reference"
```

---

## Task 7: Scenario doc — scenario-spa-route-smoke.md (T1.4)

**Files:**
- Create: `.claude/skills/testing-jinn-app/references/scenario-spa-route-smoke.md`

- [ ] **Step 1: Create the doc**

Save the following as `.claude/skills/testing-jinn-app/references/scenario-spa-route-smoke.md`:

```markdown
# Scenario T1.4 — SPA route smoke

**Tier:** 1 (single-op, route-mocked, runs on every push)
**Wall-clock budget:** 30s
**Catches:** broken routes, missing endpoint mocks, JS errors introduced by new SPA code, React error boundary firings.

## Goal

Load every SPA route against a mocked daemon API. For each route, assert:
1. No JS error in `page.on('pageerror', ...)`.
2. No React error boundary visible (no `[data-error-boundary]` element).
3. No "endpoint not mocked" console error from missing route intercepts.
4. The page renders past the initial spinner (some recognizable DOM element appears within 5s).

## Implementation location

`client/test/dashboard/release-prep/spa-route-smoke.e2e.test.ts`

## Inputs

- Routes list: extracted from `client/src/dashboard/spa/src/App.tsx` (the React Router config). The test imports the route table from a single source of truth.
- Mocked daemon API: reuses the existing `mockDaemonApi(page)` helper from single-op tests (e.g. `client/test/dashboard/spa-config.e2e.test.ts`).

## Setup

```typescript
import { test, expect, type Page } from '@playwright/test';
// `mockDaemonApi` is currently private inside `client/test/dashboard/spa-config.e2e.test.ts`.
// Plan C/D should extract it to a shared module before this test can import.
import { mockDaemonApi } from '../helpers/mock-daemon-api';
import { ROUTES } from '../../../src/dashboard/spa/src/routes';   // exported list of route paths

let consoleErrors: string[] = [];
let pageErrors: Error[] = [];

test.beforeEach(async ({ page }) => {
  consoleErrors = [];
  pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err));
  await mockDaemonApi(page);
});

for (const route of ROUTES) {
  test(`SPA renders clean at ${route}`, async ({ page }) => {
    await page.goto(`http://127.0.0.1:7332${route}`);
    await page.waitForSelector('main, [data-page-loaded], [data-app-shell]', { timeout: 5000 });
    expect(pageErrors).toHaveLength(0);
    expect(consoleErrors.filter((e) => !e.includes('expected harmless pattern'))).toHaveLength(0);
    await expect(page.locator('[data-error-boundary]')).toHaveCount(0);
  });
}
```

## Routes to cover (initial)

Derived from the existing SPA routes; the actual implementation should import a shared `ROUTES` constant rather than hardcoding here:

- `/` (root → overview redirect)
- `/overview`
- `/configuration`
- `/configuration#network`
- `/configuration#security`
- `/launcher`
- `/launcher/create`
- `/launcher/launched/:placeholder-id`  (with a known mock id)
- `/operator/join/:placeholder-cid` (with a known mock cid)
- `/network`
- `/build`

The test parameterizes over this list; one test per route.

## Failure semantics

- `pageerror` array non-empty → fail with the captured error stack
- React error boundary visible → fail with the boundary's text content (helps debugging)
- Console errors non-empty (after filtering known harmless patterns) → fail with all error messages
- Route doesn't reach the "rendered" sentinel within 5s → fail with "route did not render"

The "known harmless" filter list lives in the test file (e.g. ResizeObserver loop warnings). It starts empty and gets entries added when needed, each with a comment explaining why.

## What this scenario does NOT catch

- Real-daemon behavior (uses mocks)
- Cross-operator state synchronization
- Integration bugs between SPA and real daemon API
- Visual regressions (no screenshot comparison)

These belong in T2.x (cross-op) and Tier 3 (real testnet) scenarios.

## Wall-clock

~30 seconds total: ~3 seconds per route × ~11 routes. Runs in parallel within Playwright's default worker count.

## Dependencies

- The SPA must export a `ROUTES` constant from a single module so this test parameterizes correctly. If `ROUTES` doesn't exist yet, Plan C/D's implementation should add it (small refactor — extract route table from App.tsx).
- `mockDaemonApi` helper — currently a private function inside `client/test/dashboard/spa-config.e2e.test.ts:~130` (single-arg, hardcoded port 7332). Plan C/D should extract it to a shared module (e.g. `client/test/dashboard/helpers/mock-daemon-api.ts`) before the multi-op tests can import it.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/testing-jinn-app/references/scenario-spa-route-smoke.md
git commit -m "docs(testing-jinn-app): add T1.4 SPA route smoke scenario reference"
```

---

## Task 8: Scenario doc — scenario-cross-op-donation.md (T2.1)

**Files:**
- Create: `.claude/skills/testing-jinn-app/references/scenario-cross-op-donation.md`

- [ ] **Step 1: Create the doc**

Save the following as `.claude/skills/testing-jinn-app/references/scenario-cross-op-donation.md`:

```markdown
# Scenario T2.1 — Cross-operator donation

**Tier:** 2 (substrate-derived workspace, runs in release-prep)
**Wall-clock budget:** 5 minutes
**Catches:** x402 + ERC-8128 handshake regressions, corpus indexer attribution bugs, payment-gated artifact access bugs.

## Goal

op-a produces a corpus artifact, indexer picks it up, op-b queries Discovery API for the artifact, op-b pays x402 USDC, op-b retrieves the artifact, signature + payload validate end-to-end.

This is the gate that should have caught the #310 silent breakage (donation-consumption gate was passing because Op A wasn't producing, so consumption couldn't verify).

## Implementation location

`client/test/release/tier-2/T2.1-cross-op-donation.ts`

## Setup

- substrate workspace via `copyWorkspace({ ops: ['op-a', 'op-b'] })`
- both daemons spawned with substrate-derived HOMEs, distinct apiPorts (7732, 7733)
- Anvil-fork RPC (forks Base Sepolia); both daemons' configs point at this fork URL
- op-a config: `solverNets.<name>.roles = ['solving']` for the chosen SolverNet
- op-b config: joined to the same SolverNet via `joinedSolverNets[<manifestCid>]`

## Steps

```typescript
// 1. Spawn daemons + workspace (see multi-op-playwright.md template)
const workspace = await copyWorkspace({ ops: ['op-a', 'op-b'] });
const daemons = await spawnMultiOpDaemons({
  ops: [
    { name: 'op-a', home: workspace.opPaths['op-a'], apiPort: 7732 },
    { name: 'op-b', home: workspace.opPaths['op-b'], apiPort: 7733 },
  ],
});

// 2. op-a produces a corpus artifact
//    Either: trigger via daemon API (POST /v1/corpus/produce) or wait for natural production tick
const opARes = await fetch(`http://127.0.0.1:7732/v1/corpus/produce`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ solverNetManifestCid: KNOWN_MANIFEST_CID, payload: SAMPLE_PAYLOAD }),
});
const { artifactCid } = await opARes.json();

// 3. Wait for indexer to pick it up (poll Discovery API)
const indexedCid = await waitFor(async () => {
  const res = await fetch(`http://127.0.0.1:7733/v1/discovery/corpus?cid=${artifactCid}`);
  if (!res.ok) return null;
  const body = await res.json();
  return body.cid === artifactCid ? body : null;
}, { timeoutMs: 60000, intervalMs: 2000 });
expect(indexedCid).toBeTruthy();

// 4. op-b queries Discovery API for the artifact (no payment yet — gated)
const previewRes = await fetch(`http://127.0.0.1:7733/v1/corpus/${artifactCid}`);
expect(previewRes.status).toBe(402);   // Payment required

// 5. op-b initiates x402 payment
const paymentRes = await fetch(`http://127.0.0.1:7733/v1/corpus/${artifactCid}/pay`, {
  method: 'POST',
});
const { paymentTx } = await paymentRes.json();
expect(paymentTx).toMatch(/^0x[a-fA-F0-9]{64}$/);

// 6. op-b retrieves the artifact (with payment proof)
const retrievedRes = await fetch(`http://127.0.0.1:7733/v1/corpus/${artifactCid}`, {
  headers: { 'x-x402-payment': paymentTx },
});
expect(retrievedRes.status).toBe(200);
const retrieved = await retrievedRes.json();
expect(retrieved.payload).toEqual(SAMPLE_PAYLOAD);

// 7. Verify the ERC-8128 signature on the artifact
const sigValid = await verifyErc8128Signature(retrieved);
expect(sigValid).toBe(true);

// 8. Cleanup
await daemons.teardown();
await workspace.teardown();
```

## Assertions (summary)

| # | Assertion | Why |
|---|---|---|
| A1 | op-a produces an artifact with a valid CID | producer side works |
| A2 | indexer attributes the artifact to op-a within 60s | indexer cross-op visibility |
| A3 | op-b's unpaid query returns 402 | gating works |
| A4 | op-b's payment tx is mined | x402 payment side works |
| A5 | op-b's paid retrieval returns 200 + correct payload | gating releases after payment |
| A6 | ERC-8128 signature on retrieved artifact validates | end-to-end provenance |

## Failure modes

| Failure | Class | Triage |
|---|---|---|
| op-a never produces artifact | real-bug | BLOCKING — producer side broken |
| indexer never sees artifact within 60s | flake-timing first attempt; real-bug on second | retry; if persistent, blocking |
| op-b's preview returns 200 (no gate) | real-bug | BLOCKING — gate bypass |
| Payment tx fails | flake-infra or real-bug | retry; if persistent, check x402 contract |
| Paid retrieval returns 402 | real-bug | BLOCKING — payment not honored |
| Signature mismatch | real-bug | BLOCKING — provenance broken |
| RPC saturation mid-test | flake-infra | retry once with jittered delay |

## Wall-clock

~5 minutes:
- 30s daemon spawn
- 60s artifact production + indexer
- 60s payment + retrieval
- 30s signature verification
- ~30s setup/teardown overhead

## Dependencies

- Substrate workspace via Plan A's `substrate-copy`
- Daemon HTTP API endpoints: `/v1/corpus/produce`, `/v1/corpus/:cid`, `/v1/corpus/:cid/pay`, `/v1/discovery/corpus` (these mostly exist in v0.1.6; verify shape at implementation time)
- Anvil-fork-of-Base-Sepolia RPC (existing pattern in client/test/e2e/)
- KNOWN_MANIFEST_CID — the substrate-pinned SolverNet manifest that both ops are joined to (read from op-a's manifest.json or config.json)
- Existing helper: `verifyErc8128Signature` (or implement inline using the existing ERC-8128 module)

## What this scenario does NOT catch

- Real-network token economics (use Tier 3 for that)
- Indexer behavior under high write load (this scenario is one writer, one reader)
- Cross-chain donation scenarios
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/testing-jinn-app/references/scenario-cross-op-donation.md
git commit -m "docs(testing-jinn-app): add T2.1 cross-op donation scenario reference"
```

---

## Task 9: Scenario doc — scenario-producer-evaluator.md (T2.2)

**Files:**
- Create: `.claude/skills/testing-jinn-app/references/scenario-producer-evaluator.md`

- [ ] **Step 1: Create the doc**

Save the following as `.claude/skills/testing-jinn-app/references/scenario-producer-evaluator.md`:

```markdown
# Scenario T2.2 — Producer/evaluator (Anvil-fork)

**Tier:** 2 (substrate-derived workspace, Anvil-fork, runs in release-prep)
**Wall-clock budget:** 5 minutes
**Catches:** claim → solve → deliver → evaluate loop regressions; activity-counter increments; verdict pipeline end-to-end mechanically.

## Goal

op-a posts a known-solvable SWE-rebench v2 task, claims it, solves it via a *stubbed harness* (deterministic cached solution), delivers; op-b claims the verdict request, evaluates via real evaluator Docker image, posts verdict. Assert verdictCode matches expected.

This is the Anvil-fork mechanical counterpart to Tier 3's real-testnet variant. Same loop, but stubbed harness (no real OpenRouter spend) and forked chain.

## Implementation location

`client/test/release/tier-2/T2.2-producer-evaluator-fork.ts`

## Setup

- substrate workspace via `copyWorkspace({ ops: ['op-a', 'op-b'] })`
- Anvil fork of Base Sepolia at the substrate's last-known-good block; impersonate proxy owner; upgrade JinnRouter to V3 inline (existing pattern in `client/test/e2e/task-first-helpers.ts`)
- op-a config: `roles: ['solving']` for swe-rebench-v2 SolverNet
- op-b config: `roles: ['evaluating']` for same SolverNet
- Harness stub: register a fake harness that returns a canned solution for the known-instance task (so no real OpenRouter call happens)

## Steps

```typescript
import { spawnAnvilFork } from '../_support/chain/anvil';   // base-fork helper
import { baseSepolia } from 'viem/chains';

const workspace = await copyWorkspace({ ops: ['op-a', 'op-b'] });
const anvil = await spawnAnvilFork({
  forkUrl: process.env['BASE_SEPOLIA_RPC_URL']!,
  chain: baseSepolia,
  silent: true,
});
const daemons = await spawnMultiOpDaemons({
  ops: [
    { name: 'op-a', home: workspace.opPaths['op-a'], apiPort: 7732 },
    { name: 'op-b', home: workspace.opPaths['op-b'], apiPort: 7733 },
  ],
  // JINN_RPC_URL — not BASE_RPC_URL — because config.ts gives JINN_RPC_URL
  // unconditional precedence; the spawn helper surfaces extraEnv RPC keys
  // through JINN_RPC_URL so this works either way, but using JINN_RPC_URL
  // here makes the precedence explicit.
  extraEnv: { JINN_RPC_URL: anvil.rpcUrl, JINN_HARNESS_STUB_INSTANCE: KNOWN_INSTANCE_ID },
});

// 1. op-a posts a known-solvable task
const postRes = await fetch(`http://127.0.0.1:7732/v1/tasks`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    solverType: 'swe-rebench-v2.v1',
    spec: { instanceId: KNOWN_INSTANCE_ID, repo: KNOWN_REPO, commit: KNOWN_COMMIT },
  }),
});
const { taskId, requestId } = await postRes.json();

// 2. Wait for op-a to claim + solve + deliver (auto via solving role)
const delivered = await waitFor(async () => {
  const res = await fetch(`http://127.0.0.1:7732/v1/tasks/${taskId}`);
  const body = await res.json();
  return body.state === 'DELIVERED' ? body : null;
}, { timeoutMs: 90000, intervalMs: 2000 });
expect(delivered.deliveryTxHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

// 3. Wait for op-b to claim verdict request + run evaluator + post verdict
const verdict = await waitFor(async () => {
  const res = await fetch(`http://127.0.0.1:7733/v1/verdicts?taskId=${taskId}`);
  const body = await res.json();
  return body.verdicts?.length > 0 ? body.verdicts[0] : null;
}, { timeoutMs: 120000, intervalMs: 2000 });

// 4. Assertions
expect(verdict.verdictCode).toBe(KNOWN_EXPECTED_VERDICT);   // 1 if patch applies + tests pass
expect(verdict.verdictTxHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

// 5. Activity counters incremented
const opAActivity = await fetch(`http://127.0.0.1:7732/v1/activity`).then(r => r.json());
expect(opAActivity.deliveriesCount).toBeGreaterThan(0);
const opBActivity = await fetch(`http://127.0.0.1:7733/v1/activity`).then(r => r.json());
expect(opBActivity.verdictsCount).toBeGreaterThan(0);

// 6. Cleanup
await daemons.teardown();
await anvil.teardown();
await workspace.teardown();
```

## Assertions (summary)

| # | Assertion | Why |
|---|---|---|
| A1 | Task post returns valid taskId + requestId | task admission works |
| A2 | op-a delivers within 90s | producer side: claim + stubbed solve + deliver loop closes |
| A3 | delivery has a valid tx hash | on-chain delivery succeeded |
| A4 | op-b posts verdict within 120s of delivery | evaluator side: claim + eval + verdict loop closes |
| A5 | verdictCode matches KNOWN_EXPECTED_VERDICT | substrate recheck + scoring is correct |
| A6 | op-a deliveriesCount incremented | activity-counter accounting works |
| A7 | op-b verdictsCount incremented | activity-counter accounting works |

## Stubbed harness

Activated via `JINN_HARNESS_STUB_INSTANCE=<instance-id>` env var. The stub:
- Pattern-matches on instance ID; only stubs the one we're testing.
- Returns a canned patch from `client/test/release/tier-2/fixtures/<instance-id>.patch`.
- Logs that it stubbed (so a real-harness-still-invoked regression would show absent stub logs).

This avoids the ~$0.10 API call per run while exercising the rest of the loop.

## Failure modes

| Failure | Class | Triage |
|---|---|---|
| Task post returns 4xx | real-bug | BLOCKING — admission gate broken |
| op-a never delivers within 90s | could be: harness stub not picked up; daemon misconfig; chain stall | inspect logs; flake on first, real-bug on retry |
| Delivery tx revert | real-bug | BLOCKING — JinnRouter regression |
| op-b never picks up verdict request | real-bug | BLOCKING — evaluator role inactive |
| Evaluator Docker fails to run | flake-infra (Docker daemon) or real-bug (image broken) | check `docker ps`; retry |
| verdictCode mismatches expected | real-bug | BLOCKING — substrate/scoring regression |
| Activity counter not incremented | real-bug | BLOCKING — accounting regression |

## Wall-clock

~5 minutes:
- 30s daemon spawn + Anvil fork
- 90s producer loop
- 120s evaluator loop
- 30s setup/teardown

## Dependencies

- Substrate workspace from Plan A
- Existing `spawnAnvilFork` helper at `client/test/_support/chain/anvil.ts`. Pass `forkUrl: BASE_SEPOLIA_RPC_URL` and `chain: baseSepolia` for a Base Sepolia fork (no convenience wrapper today). Teardown via `harness.teardown()`. The full Task-First fork runner at `client/test/e2e/task-first-helpers.ts` (`runBaseSepoliaForkTaskFirstFullLoop`) shows the JinnRouter V3 fork-upgrade pattern.
- Existing JinnRouter V3 fork-upgrade pattern (in `client/test/e2e/task-first-helpers.ts`)
- Stubbed harness registration mechanism — to be added or extended in Plan C/D if not present
- KNOWN_INSTANCE_ID, KNOWN_REPO, KNOWN_COMMIT, KNOWN_EXPECTED_VERDICT — fixture constants for a known-solvable SWE-rebench instance (existing pattern in `client/test/release/tier-2/fixtures/`)

## What this scenario does NOT catch

- Real OpenRouter API behavior (Tier 3 covers that)
- Real RPC behavior under load (this uses Anvil; Tier 3 uses real testnet)
- Cross-chain verdict flows
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/testing-jinn-app/references/scenario-producer-evaluator.md
git commit -m "docs(testing-jinn-app): add T2.2 producer/evaluator Anvil-fork scenario reference"
```

---

## Task 10: Scenario doc — scenario-multi-op-spa-flow.md (T2.3)

**Files:**
- Create: `.claude/skills/testing-jinn-app/references/scenario-multi-op-spa-flow.md`

- [ ] **Step 1: Create the doc**

Save the following as `.claude/skills/testing-jinn-app/references/scenario-multi-op-spa-flow.md`:

```markdown
# Scenario T2.3 — Multi-op SPA flow

**Tier:** 2 (substrate-derived workspace, Anvil-fork, runs in release-prep)
**Wall-clock budget:** 5 minutes
**Catches:** cross-op UI flows that pass with mocks but break with real daemons; SPA-side state synchronization; Launcher → Operator catalog visibility.

## Goal

op-a launches a SolverNet via the SPA Launcher Create wizard. op-b sees it appear in the Operator catalog. op-b joins via the SPA. op-a's launched-SolverNet dashboard shows op-b's join.

This catches a class of bug invisible to single-op tests and to mocked multi-op tests: real-daemon state propagation through the SPA.

## Implementation location

`client/test/dashboard/multi-op/launcher-join-flow.e2e.test.ts`

## Setup

- substrate workspace via `copyWorkspace({ ops: ['op-a', 'op-b'] })`
- both daemons spawned via `spawnMultiOpDaemons` against Anvil-fork RPC
- Playwright with two contexts (one per operator) — see [multi-op-playwright.md](multi-op-playwright.md)

## Steps

```typescript
import { test, expect } from '@playwright/test';
import { baseSepolia } from 'viem/chains';
import { spawnMultiOpDaemons } from '../../helpers/multi-op-daemon';
import { copyWorkspace } from '../../../scripts/release/substrate-copy';
import { spawnAnvilFork } from '../../_support/chain/anvil';

let workspace, daemons, anvil, opAUrl, opBUrl;

test.beforeAll(async () => {
  workspace = await copyWorkspace({ ops: ['op-a', 'op-b'] });
  anvil = await spawnAnvilFork({
    forkUrl: process.env['BASE_SEPOLIA_RPC_URL']!,
    chain: baseSepolia,
    silent: true,
  });
  daemons = await spawnMultiOpDaemons({
    ops: [
      { name: 'op-a', home: workspace.opPaths['op-a'], apiPort: 7732 },
      { name: 'op-b', home: workspace.opPaths['op-b'], apiPort: 7733 },
    ],
    // JINN_RPC_URL — config.ts gives it unconditional precedence over BASE_RPC_URL.
    extraEnv: { JINN_RPC_URL: anvil.rpcUrl },
  });
  opAUrl = daemons.daemons['op-a'].handshakeUrl ?? `http://127.0.0.1:7732/`;
  opBUrl = daemons.daemons['op-b'].handshakeUrl ?? `http://127.0.0.1:7733/`;
});

test.afterAll(async () => {
  await daemons?.teardown();
  await anvil?.teardown();
  await workspace?.teardown();
});

test('op-a launches → op-b sees → op-b joins → op-a sees join', async ({ browser }) => {
  const opACtx = await browser.newContext();
  const opBCtx = await browser.newContext();
  const opAPage = await opACtx.newPage();
  const opBPage = await opBCtx.newPage();

  // === op-a: Launcher Create wizard ===
  await opAPage.goto(opAUrl);
  await opAPage.getByRole('link', { name: /launcher/i }).click();
  await opAPage.getByRole('button', { name: /create solvernet/i }).click();

  // Step 1: Define
  const solverNetName = `t23-test-${Date.now()}`;
  await opAPage.getByLabel(/name/i).fill(solverNetName);
  await opAPage.getByLabel(/description/i).fill('T2.3 e2e test SolverNet');
  await opAPage.getByRole('button', { name: /next/i }).click();

  // Step 2: Review Contract
  await opAPage.getByRole('button', { name: /next/i }).click();

  // Step 3: Configure Generator
  await opAPage.getByLabel(/cadence/i).fill('60000');   // 60s
  await opAPage.getByRole('button', { name: /next/i }).click();

  // Step 4: Configure Pricing
  await opAPage.getByLabel(/price/i).fill('100');
  await opAPage.getByRole('button', { name: /next/i }).click();

  // Step 5: Review and Launch
  await opAPage.getByRole('button', { name: /launch/i }).click();

  // Wait for launch state machine to reach 'launched'
  await expect(opAPage.getByText(/launched/i)).toBeVisible({ timeout: 120000 });
  const manifestCid = await opAPage.getByTestId('manifest-cid').textContent();
  expect(manifestCid).toMatch(/^bafkrei/);

  // === op-b: Operator catalog sees op-a's SolverNet ===
  await opBPage.goto(opBUrl);
  await opBPage.getByRole('link', { name: /operator/i }).click();
  await opBPage.getByRole('button', { name: /browse catalog/i }).click();
  await expect(opBPage.getByText(solverNetName)).toBeVisible({ timeout: 30000 });

  // === op-b joins via SPA ===
  await opBPage.getByText(solverNetName).click();
  await opBPage.getByRole('button', { name: /join/i }).click();
  // Restart banner should appear (operator.join writes config; daemon doesn't hot-reload SolverNet config)
  await expect(opBPage.getByText(/restart required/i)).toBeVisible({ timeout: 10000 });

  // === op-a's launched dashboard reflects op-b's join ===
  await opAPage.goto(opAUrl + '/launcher/launched');
  await opAPage.getByText(solverNetName).click();
  // Operator join is on-chain; SPA should poll and reflect within 30s
  await expect(opAPage.getByText(/1 operator joined/i)).toBeVisible({ timeout: 30000 });

  await opACtx.close();
  await opBCtx.close();
});
```

## Assertions (summary)

| # | Assertion | Why |
|---|---|---|
| A1 | op-a wizard launch reaches `launched` state within 120s | Launcher state machine end-to-end |
| A2 | manifest CID matches `bafkrei...` shape | pinning + on-chain registry write succeeded |
| A3 | op-b's catalog shows the new SolverNet within 30s | global registry indexing works |
| A4 | op-b's join writes operator-side config | operator.join RPC + restart banner |
| A5 | op-a's launched dashboard shows "1 operator joined" within 30s | cross-op SPA polling correctness |

## Failure modes

| Failure | Class | Triage |
|---|---|---|
| Wizard wizard step doesn't advance | real-bug | BLOCKING — wizard UI regression |
| Launch state machine times out before `launched` | could be: pinning hang, broadcast fail, indexer fail | inspect launch-progress record; flake on first |
| op-b's catalog doesn't show within 30s | indexer slow OR catalog query broken | check Discovery API directly; if working, SPA-side bug |
| op-b's join doesn't write config | real-bug | BLOCKING — operator.join broken |
| Restart banner missing | real-bug | BLOCKING — restart semantics regression |
| op-a's "1 operator joined" never appears | could be: on-chain operator-join missed, indexer lag, SPA polling broken | check on-chain first, then indexer, then SPA |

## Wall-clock

~5 minutes:
- 30s daemon spawn + Anvil fork
- 120s op-a launch
- 30s op-b catalog lookup
- 60s op-b join + restart banner
- 30s op-a sees join
- 30s setup/teardown

## Dependencies

- Substrate workspace from Plan A
- `spawnAnvilFork` helper at `client/test/_support/chain/anvil.ts` (pass `forkUrl: BASE_SEPOLIA_RPC_URL` + `chain: baseSepolia` for a Base Sepolia fork)
- The SPA Launcher Create wizard's data-testid attributes (`manifest-cid` etc.) — may need to be added to the SPA in Plan C/D if missing
- The Operator catalog page at `/operator/...` (existing in v0.1.6)
- The launched-SolverNet dashboard at `/launcher/launched/:id` (existing in v0.1.6)

## What this scenario does NOT catch

- UX paper cuts (Tier 3 manual walkthrough covers these)
- Real-network economics
- Visual regressions
- Operator's actual claim/solve flow (T2.2 covers that)
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/testing-jinn-app/references/scenario-multi-op-spa-flow.md
git commit -m "docs(testing-jinn-app): add T2.3 multi-op SPA flow scenario reference"
```

---

## Task 11: Final SKILL.md polish — Quick reference table update

**Files:**
- Modify: `.claude/skills/testing-jinn-app/SKILL.md`

The existing skill has a "Quick reference" table near the bottom. Extend it with multi-op entries.

- [ ] **Step 1: Read the current Quick reference table**

Run: `awk '/## Quick reference/,/## Common mistakes/' .claude/skills/testing-jinn-app/SKILL.md`
Expected output: the table.

- [ ] **Step 2: Extend the table**

Open `.claude/skills/testing-jinn-app/SKILL.md`. Find the existing Quick reference table:

```markdown
| Goal | Approach |
|------|----------|
| Spot a UX/layout bug | Manual + chrome-devtools, take screenshots |
| Reproduce a reported issue | Manual + chrome-devtools, follow user's exact path |
| Add regression coverage | Playwright E2E with `page.route` mocks |
| Verify hash deep-links | Navigate to `/configuration#network` etc. |
| Test against real chain state | Reuse a bootstrapped HOME, no mocks |
| Test pure SPA wiring | Fresh HOME + mock all `/v1/*` endpoints |
```

Add these rows below the existing ones (before the next section):

```markdown
| Spot a cross-op visibility bug | Multi-op chrome-devtools — drive two pages, [`references/multi-op-chrome-devtools.md`](references/multi-op-chrome-devtools.md) |
| Add cross-op regression coverage | Multi-op Playwright — [`references/multi-op-playwright.md`](references/multi-op-playwright.md) |
| Test SPA route surface (T1.4) | [`references/scenario-spa-route-smoke.md`](references/scenario-spa-route-smoke.md) |
| Test cross-op donation (T2.1) | [`references/scenario-cross-op-donation.md`](references/scenario-cross-op-donation.md) |
| Test producer/evaluator on Anvil-fork (T2.2) | [`references/scenario-producer-evaluator.md`](references/scenario-producer-evaluator.md) |
| Test multi-op SPA flow (T2.3) | [`references/scenario-multi-op-spa-flow.md`](references/scenario-multi-op-spa-flow.md) |
```

Save the file.

- [ ] **Step 3: Sanity check**

Run: `grep -c "T2\." .claude/skills/testing-jinn-app/SKILL.md`
Expected: at least 5 (the new table rows + the references section).

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/testing-jinn-app/SKILL.md
git commit -m "docs(testing-jinn-app): extend Quick reference table with multi-op scenarios"
```

---

## Task 12: README cross-reference + final verification

**Files:**
- None modified. This task is a final verification gate.

- [ ] **Step 1: Verify all reference docs exist**

Run:
```bash
ls .claude/skills/testing-jinn-app/references/
```

Expected output (alphabetical):
```
multi-op-chrome-devtools.md
multi-op-playwright.md
multi-op-spawn.md
scenario-cross-op-donation.md
scenario-multi-op-spa-flow.md
scenario-producer-evaluator.md
scenario-spa-route-smoke.md
```

(7 files)

- [ ] **Step 2: Verify SKILL.md has the multi-op section**

Run: `grep -c "Multi-operator scenarios" .claude/skills/testing-jinn-app/SKILL.md`
Expected: at least 1 occurrence.

- [ ] **Step 3: Verify helper files exist with tests**

Run:
```bash
ls client/test/helpers/multi-op-daemon.ts client/test/helpers/multi-op-daemon.test.ts client/test/helpers/handshake-url.ts client/test/helpers/handshake-url.test.ts
```

Expected: all four files present.

- [ ] **Step 4: Run all helper tests**

Run: `cd client && yarn vitest run test/helpers/handshake-url.test.ts test/helpers/multi-op-daemon.test.ts`
Expected: all tests pass (multi-op-daemon tests may auto-skip if dist is missing — that's fine for this verification step).

- [ ] **Step 5: Verify cross-references in SKILL.md actually resolve**

Run:
```bash
grep -oE 'references/[a-z-]+\.md' .claude/skills/testing-jinn-app/SKILL.md | sort -u | while read ref; do
  if [ -f ".claude/skills/testing-jinn-app/$ref" ]; then
    echo "OK   $ref"
  else
    echo "MISS $ref"
  fi
done
```

Expected: every line `OK <ref>`, no `MISS`.

- [ ] **Step 6: Final commit (no-op if nothing to add)**

If any verification step revealed a missing/broken reference, fix inline and commit. Otherwise this task is a validation gate with no commit required.

---

## Self-review

### Spec coverage

| Spec requirement | Covered by | Status |
|---|---|---|
| §5 SKILL.md multi-op section | Task 3 + Task 11 | ✓ |
| §5 multi-op-spawn reference | Task 4 | ✓ |
| §5 multi-op-chrome-devtools reference | Task 5 | ✓ |
| §5 multi-op-playwright reference | Task 6 | ✓ |
| §5 scenario-spa-route-smoke (T1.4) | Task 7 | ✓ |
| §5 scenario-cross-op-donation (T2.1) | Task 8 | ✓ |
| §5 scenario-producer-evaluator (T2.2) | Task 9 | ✓ |
| §5 scenario-multi-op-spa-flow (T2.3) | Task 10 | ✓ |
| §5 "Things to watch for" multi-op entries | Task 3 (embedded in SKILL.md section) | ✓ |
| §5 minimal helper code (handshake URL + multi-op-daemon) | Tasks 1, 2 | ✓ |

### Placeholder scan

No "TBD" / "TODO" / "fill in details" in any task. Each task contains complete file content or complete code blocks. References to "Plan A's substrate-copy" and "Plan C/D's implementation" are intentional cross-plan references, not placeholders — the imports resolve once Plan A lands; the scenario recipes are intentionally consumed by Plans C/D.

### Type consistency

- `MultiOpHandle`, `DaemonHandle`, `OpSpec`, `SpawnMultiOpOptions` signatures consistent between Task 2 implementation and Task 6 multi-op-playwright reference doc.
- `extractHandshakeUrl`, `makeHandshakeCollector` API consistent between Task 1 implementation and Task 2 consumer.
- `copyWorkspace` reference (from Plan A) consistent across Tasks 6, 8, 9, 10 — signature matches Plan A's substrate-copy.

### Cross-plan contract check

This plan promises Plans C/D the following inputs:
- `client/test/helpers/multi-op-daemon.ts` exports `spawnMultiOpDaemons(opts): Promise<MultiOpHandle>` (Task 2 delivers)
- `client/test/helpers/handshake-url.ts` exports `extractHandshakeUrl`, `makeHandshakeCollector` (Task 1 delivers)
- Seven reference docs at known paths (Tasks 3-10 deliver)

Plans C/D's tasks should import these by exact path and consume the reference docs by reading them as authoritative scenario specs.

### Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-testing-jinn-app-multi-op-plan.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks. Uses `superpowers:subagent-driven-development`. This plan is mostly doc-writing; subagent dispatch is fast and parallelizes well.

2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Plan B has no runtime dependency on Plan A (the imports resolve once Plan A lands; the writing can happen in parallel). Plan A is currently being implemented by a separate background `claude` session — Plan B can be implemented in parallel by a different session, or sequentially after Plan A lands.

Which approach?
