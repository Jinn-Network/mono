/**
 * Ponder spawn helper for Tier 2 scenario tests.
 *
 * Spawns `@jinn-network/indexer` (packages/indexer/) as a child process against a
 * caller-supplied RPC URL. Port is controlled via the `-p` CLI flag (Ponder 0.16.x
 * also accepts the `PORT` env var, but the CLI flag is more reliable through yarn's
 * script wrapper). GraphQL is served at `http://127.0.0.1:{PORT}/graphql`.
 *
 * Port control: `ponder dev -p <PORT>` (confirmed via `ponder dev --help` against
 * Ponder 0.16.6 — `-p, --port <PORT>`).
 *
 * GraphQL path: `/graphql` (default Ponder shape, confirmed in packages/indexer README).
 *
 * Ready detection: Ponder's `/health` endpoint returns 200 once the HTTP server is
 * accepting requests. Important: Ponder only starts its HTTP server AFTER the RPC
 * diagnostic passes — if the RPC URL is unreachable, the HTTP server never starts.
 * To avoid burning the full readyTimeoutMs in that case, the helper also watches the
 * process's stderr+stdout for the pattern "Received JSON-RPC error action=rpc_diagnostic"
 * (viem's retry log). After the max retry delay doubles past 4s (retry_count >= 7),
 * the RPC is definitively unreachable and the helper fails fast with a diagnostic error
 * rather than waiting for the full timeout.
 *
 * Two chains: ponder.config.ts always configures 84532 (Base Sepolia) and 11155111
 * (Sepolia). The helper requires an RPC URL for the primary chain (via chainId +
 * rpcUrl) and optionally for the secondary chain (secondaryRpcUrl); both fall back
 * to the public endpoints baked into ponder.config.ts when omitted.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';

export interface PonderHandle {
  /** Full URL to the GraphQL endpoint, e.g. `http://127.0.0.1:54321/graphql`. */
  graphqlUrl: string;
  /** TCP port the indexer is listening on. */
  port: number;
  /** The spawned child process. */
  process: ChildProcess;
  /**
   * Stop the Ponder process. Safe to call multiple times — subsequent calls
   * resolve immediately without sending additional signals.
   */
  teardown: () => Promise<void>;
}

export interface SpawnPonderOptions {
  /** RPC URL for the primary chain. */
  rpcUrl: string;
  /**
   * Chain ID of the primary chain. Used to set `PONDER_RPC_URL_<chainId>`.
   * The Jinn indexer uses 84532 (Base Sepolia) and 11155111 (Sepolia).
   */
  chainId: number;
  /**
   * RPC URL for the secondary chain (whichever of 84532/11155111 is not the
   * primary). Defaults to the public endpoint baked into ponder.config.ts when
   * omitted — fine for local/test use where the secondary chain isn't exercised.
   */
  secondaryRpcUrl?: string;
  /** TCP port to listen on. Default: random free port. */
  port?: number;
  /**
   * Absolute path to the Ponder package root. Default: resolved from this
   * helper's own location as `../../../../packages/indexer` (repo root relative).
   */
  ponderRoot?: string;
  /**
   * How long to wait for the `/health` endpoint to respond 200, in ms.
   * Default: 30_000.
   */
  readyTimeoutMs?: number;
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

/**
 * Poll Ponder's `/health` endpoint until it returns 200 or the timeout expires.
 *
 * `/health` returns 200 as soon as Ponder's HTTP server is accepting requests —
 * it does NOT wait for full historical indexing. This makes it suitable as a
 * process-startup gate for tests that want to verify configuration, GraphQL
 * introspection, or newly-mined blocks (where historical sync is irrelevant).
 *
 * Tests that need indexed data should poll `/ready` themselves after receiving
 * the PonderHandle.
 */
async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // not yet reachable
    }
    await new Promise<void>((r) => setTimeout(r, 250));
  }
  throw new Error(`Ponder at ${baseUrl}/health did not return 200 within ${timeoutMs}ms`);
}

const MAX_STARTUP_OUTPUT_CHARS = 16_384;

/**
 * Watch the child process's combined stdout+stderr for Ponder's RPC diagnostic
 * retry log lines. When the retry delay doubles past 4s (retry_count >= 7, meaning
 * exponential backoff has reached 8s delay), the RPC is definitively unreachable
 * and we reject so the caller can fail fast rather than burning the full ready timeout.
 *
 * Ponder 0.16.x emits structured log lines like:
 *   WARN  Received JSON-RPC error action=rpc_diagnostic ... retry_count=7 retry_delay=8000
 * The pattern is reliable: it comes from viem's HTTP transport retry logic, which
 * doubles from 125ms up to ~8s before giving up. The first 4s delay (retry_count=7)
 * is our fast-fail signal.
 *
 * Returns a { promise, cancel } pair. The caller MUST call cancel() after the
 * Promise.race resolves to detach the data listeners — otherwise the listeners
 * accumulate across test invocations and Node emits MaxListenersExceededWarning.
 */
function watchForRpcDiagnosticFailure(child: ChildProcess): { promise: Promise<never>; cancel: () => void } {
  let cleanup = (): void => {};
  const promise = new Promise<never>((_, reject) => {
    const onData = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      // Match "retry_delay=NNNN" where NNNN >= 4000 during an rpc_diagnostic action.
      // This indicates the primary chain's RPC has failed all cheap retries.
      if (
        text.includes('action=rpc_diagnostic') &&
        /retry_delay=([4-9]\d{3,}|\d{5,})/.test(text)
      ) {
        cleanup();
        reject(
          new Error(
            'Ponder RPC diagnostic failed — the RPC URL is unreachable. ' +
            'Ponder will not start its HTTP server until the RPC is healthy.',
          ),
        );
      }
    };
    const onExit = (): void => { cleanup(); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', onExit);
    cleanup = (): void => {
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
    };
  });
  return { promise, cancel: () => cleanup() };
}

export async function spawnPonderIndexer(opts: SpawnPonderOptions): Promise<PonderHandle> {
  const port = opts.port ?? (await pickFreePort());
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;

  // Anchor ponderRoot relative to this file's own location so the helper works
  // regardless of what directory the test runner is invoked from.
  // This file is at: client/test/_support/indexer/ponder.ts
  // Repo root is:    ../../../../  (four levels up)
  // packages/indexer is: ../../../../packages/indexer
  const defaultPonderRoot = path.resolve(
    // import.meta.dirname is available in Node 20+ / ESM
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — import.meta.dirname is defined in ESM Node 20+
    import.meta.dirname as string,
    '../../../../packages/indexer',
  );
  const ponderRoot = opts.ponderRoot ?? defaultPonderRoot;

  // Determine the secondary chain ID so we can set its RPC URL env var.
  // The Jinn indexer always configures both 84532 and 11155111.
  const knownChainIds: [84532, 11155111] = [84532, 11155111];
  const secondaryChainId = knownChainIds.find((id) => id !== opts.chainId);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Primary chain RPC.
    [`PONDER_RPC_URL_${opts.chainId}`]: opts.rpcUrl,
    // Disable envelope IPFS enrichment — speeds up startup for tests that don't
    // need the enriched fields (harness/mode/plugin/model facets, freeze integrity).
    JINN_INDEXER_ENRICH_ENVELOPES: 'false',
  };

  // Secondary chain: use caller-supplied URL if provided, otherwise inherit
  // whatever is already in the environment (the public default from the config
  // is hardcoded in ponder.config.ts so Ponder won't error even if unset).
  if (opts.secondaryRpcUrl !== undefined && secondaryChainId !== undefined) {
    env[`PONDER_RPC_URL_${secondaryChainId}`] = opts.secondaryRpcUrl;
  }

  // Start each spawn from a CLEAN pglite database. Ponder persists its index to
  // <ponderRoot>/.ponder; a previous run that was SIGKILLed (e.g. a test timeout)
  // leaves that dir locked/stale, and the next `ponder dev` then hangs before its
  // HTTP server comes up — a /health timeout that looks like a Ponder bug but is
  // really a poisoned db. Tests want a fresh index per run anyway, so remove it.
  // (Callers must run Ponder spawns sequentially — these tests do; see the
  // hermetic gate's --no-file-parallelism.)
  rmSync(path.join(ponderRoot, '.ponder'), { recursive: true, force: true });

  // Use '--disable-ui' to get structured log output (no ANSI escape sequences)
  // and '-p PORT' to set the HTTP port.
  // Note: 'ponder dev --help' confirms: -p, --port <PORT>  Port for the web server.
  const child = spawn('yarn', ['dev', '--disable-ui', '-p', String(port)], {
    cwd: ponderRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Keep a bounded tail of startup output. The child normally stays quiet in the
  // test log, but a cold Linux runner can spend materially longer compiling than
  // a warm developer checkout. If readiness fails, surface enough output to
  // distinguish compilation, RPC, database, and port failures. Redact configured
  // RPC URLs because production callers may include credentials in them.
  let startupOutput = '';
  const captureStartupOutput = (stream: 'stdout' | 'stderr') =>
    (chunk: Buffer | string): void => {
      startupOutput += `[${stream}] ${chunk.toString()}`;
      if (startupOutput.length > MAX_STARTUP_OUTPUT_CHARS) {
        startupOutput = startupOutput.slice(-MAX_STARTUP_OUTPUT_CHARS);
      }
    };
  const captureStdout = captureStartupOutput('stdout');
  const captureStderr = captureStartupOutput('stderr');
  child.stdout?.on('data', captureStdout);
  child.stderr?.on('data', captureStderr);

  const detachStartupCapture = (): void => {
    child.stdout?.off('data', captureStdout);
    child.stderr?.off('data', captureStderr);
  };

  const redactedStartupOutput = (): string => {
    let output = startupOutput.trim();
    for (const url of [opts.rpcUrl, opts.secondaryRpcUrl]) {
      if (url) output = output.split(url).join('<rpc-url>');
    }
    return output || '<no subprocess output captured>';
  };

  const baseUrl = `http://127.0.0.1:${port}`;
  const graphqlUrl = `${baseUrl}/graphql`;

  // Track whether the child has exited. `child.killed` is set synchronously when
  // kill() is called — before the OS reaps the process — so it cannot be used as
  // a "has the process actually gone?" guard for the SIGKILL fallback.
  let exited = false;
  child.once('exit', () => { exited = true; });

  // Terminate the child: SIGTERM, a grace period to flush, then SIGKILL if it
  // is still alive. Used by both the spawn-failure path and teardown.
  const terminateChild = async (graceMs: number): Promise<void> => {
    if (exited) return;
    try { child.kill('SIGTERM'); } catch {}
    await new Promise<void>((r) => setTimeout(r, graceMs));
    if (!exited) { try { child.kill('SIGKILL'); } catch {} }
  };

  // Race readiness against three failure conditions:
  // 1. Process exits unexpectedly (binary missing, immediate crash)
  // 2. RPC diagnostic fails after retries (RPC unreachable; fast-fail before timeout)
  // 3. Health check times out (shouldn't happen if 1 and 2 are caught, but acts as backstop)
  const exitPromise = new Promise<never>((_, reject) => {
    child.once('error', (err) =>
      reject(new Error(`Ponder process failed to spawn: ${err.message}`)),
    );
    child.once('exit', (code, signal) =>
      reject(
        new Error(
          `Ponder process exited before becoming healthy (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        ),
      ),
    );
  });

  const rpcWatcher = watchForRpcDiagnosticFailure(child);
  const healthyPromise = waitForHealth(baseUrl, readyTimeoutMs);

  try {
    await Promise.race([healthyPromise, exitPromise, rpcWatcher.promise]);
  } catch (err) {
    // Always detach RPC watcher listeners before throwing.
    rpcWatcher.cancel();
    await terminateChild(200);
    detachStartupCapture();
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message}\nPonder startup output (tail):\n${redactedStartupOutput()}`);
  }
  // Detach RPC watcher listeners on the happy path so they don't accumulate.
  rpcWatcher.cancel();
  detachStartupCapture();

  let torn = false;
  return {
    graphqlUrl,
    port,
    process: child,
    teardown: async (): Promise<void> => {
      if (torn) return;
      torn = true;
      await terminateChild(300);
    },
  };
}
