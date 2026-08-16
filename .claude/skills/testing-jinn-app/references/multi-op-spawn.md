# Multi-op daemon spawn

How to spawn two or more `jinn` daemons concurrently for cross-operator testing. Two recipes — bash for ad-hoc use, TypeScript for automated tests.

## Source of HOMEs

Two flavors:

1. **Substrate-derived workspaces** — use Plan A's `substrate-copy.ts` to create per-run isolated copies of `op-a` / `op-b` from gold. Best for scenarios that need pre-bootstrapped identity (most T2.x scenarios).

   ```typescript
   // Path relative to the importing file. Plan A's substrate-copy lives at
   // `operator/scripts/release/substrate-copy.ts` (outside `src/`, so the `@/`
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

Use the helper at `operator/test/helpers/multi-op-daemon.ts`:

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

## Readiness timeout

`readyTimeoutMs` (default 30s) is applied **per daemon**, not per group. The
helper spawns and awaits each daemon in `ops` sequentially, so the worst-case
total wall time for a group of N daemons is `N × readyTimeoutMs`. Size the
timeout for a single daemon's bootstrap, and account for the multiplier when
setting a test's overall timeout (e.g. Vitest `testTimeout`).

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
