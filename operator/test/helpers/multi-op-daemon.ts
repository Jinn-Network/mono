import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  /**
   * Absolute path to the per-daemon log file when `logDir` was supplied to
   * `spawnMultiOpDaemons`, else `null`. The log captures stdout and stderr for
   * the daemon's full lifetime (not just the bootstrap window). Callers cite
   * this path in evidence logs and error messages so an investigator can find
   * the daemon's output without spelunking the harness.
   */
  logPath: string | null;
}

export interface MultiOpHandle {
  daemons: Record<string, DaemonHandle>;
  teardown: () => Promise<void>;
}

export interface SpawnMultiOpOptions {
  ops: OpSpec[];
  /**
   * Per-daemon readiness timeout in milliseconds (default 30s). Applied
   * independently to each daemon in `ops` — the worst-case total wall time
   * for a group of N daemons is N × readyTimeoutMs, since daemons are spawned
   * and awaited sequentially.
   */
  readyTimeoutMs?: number;
  jinnBinPath?: string;         // default: dist/bin/jinn.js resolved relative to this module
  extraEnv?: NodeJS.ProcessEnv;
  /**
   * Directory to stream each spawned daemon's stdout + stderr into for its
   * full lifetime. When set, each daemon writes to
   * `${logDir}/${op.name}-daemon.log` with stdout / stderr lines prefixed
   * `[out]` / `[err]` respectively. The log file is opened on spawn and
   * flushed + closed on teardown.
   *
   * When omitted, daemons inherit the legacy behaviour: stdout/stderr are
   * captured only into a bounded in-memory tail used to surface bootstrap
   * failure causes, and `DaemonHandle.logPath` is `null`. This back-compat
   * is what existing helpers (T1.2's `multi-op-daemon.test.ts`, the
   * `tier-2-helpers.test.ts` shape) rely on.
   *
   * The directory is created with `recursive: true` if it does not exist.
   */
  logDir?: string;
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

async function waitForBootstrap(
  apiPort: number,
  timeoutMs: number,
  getExit: () => ExitInfo | null,
  getOutputTail: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/v1/bootstrap`, { method: 'GET' });
      if (res.status === 200 || res.status === 401) return;
    } catch {
      // not yet
    }
    // Fail fast if the daemon process already exited — polling the full timeout
    // against a dead process wastes the budget and hides the real cause.
    const exit = getExit();
    if (exit) {
      throw new Error(
        `daemon on port ${apiPort} exited before its API became reachable ` +
          `(code=${exit.code} signal=${exit.signal}). Daemon output tail:\n${getOutputTail()}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `daemon on port ${apiPort} did not become reachable within ${timeoutMs}ms. ` +
      `Daemon output tail:\n${getOutputTail()}`,
  );
}

export async function spawnMultiOpDaemons(opts: SpawnMultiOpOptions): Promise<MultiOpHandle> {
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30000;
  // Resolve the built binary relative to this module rather than process.cwd(),
  // which is unstable across test runners and invocation directories.
  const jinnBin =
    opts.jinnBinPath ?? fileURLToPath(new URL('../../dist/bin/jinn.js', import.meta.url));

  const daemons: Record<string, DaemonHandle> = {};
  const processes: ChildProcess[] = [];
  // One log stream per daemon when logDir is set. Closed in killAll() so the
  // teardown path flushes pending writes before the file descriptor goes away.
  const logStreams: WriteStream[] = [];

  // Pre-create the log directory once so per-spawn code does not race on it.
  if (opts.logDir) {
    mkdirSync(opts.logDir, { recursive: true });
  }

  async function killAll(): Promise<void> {
    const signal = (sig: NodeJS.Signals) => {
      for (const proc of processes) {
        if (!proc.killed && proc.pid) {
          try { proc.kill(sig); } catch {}
        }
      }
    };
    signal('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    signal('SIGKILL');
    // Close the per-daemon log streams after the child processes have been
    // signalled. `.end()` flushes any buffered writes and emits 'finish' once
    // the FD is closed; await all of them so the caller's teardown does not
    // race with pending log lines (matters in tests that immediately read the
    // log file after teardown).
    await Promise.all(
      logStreams.map(
        (stream) =>
          new Promise<void>((resolve) => {
            if (stream.closed || stream.destroyed) {
              resolve();
              return;
            }
            stream.end(() => resolve());
          }),
      ),
    );
    logStreams.length = 0;
  }

  // config.ts gives JINN_RPC_URL unconditional precedence over BASE_RPC_URL,
  // so any RPC URL the caller passed in extraEnv must be surfaced through it.
  // Resolution order: extraEnv JINN/BASE RPC URL, host JINN/BASE_SEPOLIA RPC
  // URL, then the publicnode default (matches config.ts; see #554).
  const fallbackRpcUrl =
    opts.extraEnv?.['JINN_RPC_URL'] ??
    opts.extraEnv?.['BASE_RPC_URL'] ??
    process.env['JINN_RPC_URL'] ??
    process.env['BASE_SEPOLIA_RPC_URL'] ??
    'https://base-sepolia-rpc.publicnode.com';

  try {
    for (const op of opts.ops) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        JINN_RPC_URL: fallbackRpcUrl,
        ...opts.extraEnv,
        HOME: op.home,
        JINN_API_PORT: op.apiPort.toString(),
      };
      // Substrate operators each carry their own .jinn-client/keystore-password
      // file. An inherited JINN_PASSWORD (e.g. from a developer's shell, or from
      // a sourced operator/.env) overrides that file, fails keystore decryption,
      // and crashes the daemon with exitCode 50 before its API binds — surfacing
      // only as a misleading "did not become reachable" failure. Always strip it
      // so each spawned daemon uses its substrate's own password file.
      delete env['JINN_PASSWORD'];

      const proc = spawn('node', [jinnBin, 'run', '--no-ui'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      processes.push(proc);

      // Per-daemon log file (lifetime-spanning). Opened in append mode so a
      // restart against the same logDir does not clobber prior runs; the
      // tier-N callers always derive logDir from a per-run evidence dir, so in
      // practice the file is fresh anyway.
      let logPath: string | null = null;
      let logStream: WriteStream | null = null;
      if (opts.logDir) {
        logPath = path.join(opts.logDir, `${op.name}-daemon.log`);
        logStream = createWriteStream(logPath, { flags: 'a' });
        // Swallow write-after-end errors: after SIGKILL the child's stdio
        // pipes can still drain into Node's event loop, hitting `.write()` on
        // an already-ended stream. With Node ≥18's `autoDestroy: true` that
        // surfaces as an unhandled `'error'` event and crashes the test
        // process. The no-op listener is harmless because the underlying log
        // file is already closed (any dropped chunks are post-SIGKILL noise).
        logStream.on('error', () => { /* see comment above */ });
        logStreams.push(logStream);
        // Header so a grep on the log file makes clear which spawn it belongs
        // to. Wall-clock time + the daemon name + the binary + the api port
        // are the minimum useful identifiers.
        logStream.write(
          `=== ${new Date().toISOString()} ${op.name} daemon spawn (jinnBin=${jinnBin} apiPort=${op.apiPort}) ===\n`,
        );
      }

      // Capture the daemon's own output. Without this, a spawn that crashes
      // before its API binds surfaces only as "did not become reachable" with
      // no cause; the bounded tail is surfaced in the waitForBootstrap error.
      let outputTail = '';
      const appendOutput = (chunk: Buffer | string) => {
        outputTail = (outputTail + chunk.toString()).slice(-4000);
      };
      // Per-stream line prefixer for the lifetime log. Chunk boundaries in
      // Node's `data` events do not respect line boundaries — a single chunk
      // can deliver multiple lines, half of a line, or a trailing partial.
      // The naive `text.replace(/^/gm, ...)` approach prefixes the EMPTY
      // line that follows a trailing `\n` too, which then concatenates with
      // the next chunk's first line and produces double-prefixed output
      // (`[err] [out] line` etc.). The line-buffer keeps prefix application
      // exactly-once per source line, even across chunk boundaries.
      const makeLinePrefixer = (source: 'out' | 'err') => {
        let carry = '';
        const write = (chunk: Buffer | string): void => {
          if (!logStream) return;
          const text = carry + chunk.toString();
          const lines = text.split('\n');
          // Last element is either '' (terminal newline) or the next partial
          // line — keep it so its prefix lands only when the rest arrives.
          carry = lines.pop() ?? '';
          if (lines.length === 0) return;
          logStream.write(
            lines.map((l) => `[${source}] ${l}\n`).join(''),
          );
        };
        // Flush any trailing partial line (one without a terminating \n) so a
        // daemon killed mid-write still has its final log line preserved.
        const flush = (): void => {
          if (!logStream || carry.length === 0) return;
          logStream.write(`[${source}] ${carry}\n`);
          carry = '';
        };
        return { write, flush };
      };
      const stdoutPrefixer = makeLinePrefixer('out');
      const stderrPrefixer = makeLinePrefixer('err');
      const writeStdoutToLog = stdoutPrefixer.write;
      const writeStderrToLog = stderrPrefixer.write;
      let exitInfo: ExitInfo | null = null;
      proc.once('exit', (code, signal) => {
        exitInfo = { code, signal };
        if (logStream) {
          // Flush any partial last lines BEFORE the exit footer so the order
          // of events in the log matches the order they actually occurred.
          stdoutPrefixer.flush();
          stderrPrefixer.flush();
          logStream.write(
            `\n=== ${new Date().toISOString()} ${op.name} daemon exit (code=${code} signal=${signal}) ===\n`,
          );
        }
      });

      const collector = makeHandshakeCollector(readyTimeoutMs);
      const onStdout = (chunk: Buffer | string) => {
        appendOutput(chunk);
        writeStdoutToLog(chunk);
        collector.feed(chunk.toString());
      };
      const onStderr = (chunk: Buffer | string) => {
        appendOutput(chunk);
        writeStderrToLog(chunk);
        collector.feed(chunk.toString());
      };
      proc.stdout?.on('data', onStdout);
      proc.stderr?.on('data', onStderr);
      // After the handshake collector settles its detach-handshake-listeners
      // hook removes onStdout/onStderr from the streams, which would stop the
      // log file from receiving any further output. Re-attach a thin
      // log-only listener so the file keeps tracking the daemon's stdio for
      // its full lifetime.
      const onStdoutLogOnly = (chunk: Buffer | string) => writeStdoutToLog(chunk);
      const onStderrLogOnly = (chunk: Buffer | string) => writeStderrToLog(chunk);
      // Detach the handshake listeners once the collector settles, so they do
      // not stay attached for the child's lifetime (MaxListenersExceededWarning
      // risk across many daemons + no-op feed() churn). When a log file is
      // configured, swap in cheap log-only listeners that keep the lifetime
      // log up to date without re-running the handshake collector.
      //
      // Idempotent — both the `collector.promise.then` hook and the `finally`
      // block after `waitForBootstrap` call this, and the swap-in must not
      // double-register the log-only listeners on the second call.
      let handshakeListenersDetached = false;
      const detachHandshakeListeners = () => {
        if (handshakeListenersDetached) return;
        handshakeListenersDetached = true;
        proc.stdout?.off('data', onStdout);
        proc.stderr?.off('data', onStderr);
        if (logStream) {
          proc.stdout?.on('data', onStdoutLogOnly);
          proc.stderr?.on('data', onStderrLogOnly);
        }
      };
      // Wait for bootstrap to be reachable before detaching the full stdout /
      // stderr listeners. The handshake URL can appear before bootstrap
      // completes; if the daemon then exits, the bounded error tail still needs
      // the fatal envelope that follows the handshake line.
      await waitForBootstrap(
        op.apiPort,
        readyTimeoutMs,
        () => exitInfo,
        () => outputTail,
      );

      // Best-effort handshake URL capture (may not emit if daemon is in non-running mode)
      let handshakeUrl: string | null = null;
      try {
        handshakeUrl = await Promise.race([
          collector.promise,
          new Promise<string>((_, rej) => setTimeout(() => rej(new Error('handshake not emitted')), 2000)),
        ]);
      } catch {
        handshakeUrl = null;
      } finally {
        // If the 2s race lost, collector.promise may still be pending; dispose
        // it so its timeout clears and detach the listeners now.
        collector.dispose();
        detachHandshakeListeners();
      }

      daemons[op.name] = {
        name: op.name,
        pid: proc.pid ?? -1,
        apiPort: op.apiPort,
        handshakeUrl,
        process: proc,
        logPath,
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
