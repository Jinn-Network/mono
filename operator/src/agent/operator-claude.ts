/**
 * Operator-facing Claude Code subprocess.
 *
 * Distinct from the per-restoration claude subprocess (operator/src/runner/claude.ts).
 * This one is a long-lived session attached to the operator panel via WebSocket.
 *
 * Requires node-pty for a real TTY (colors, cursor, ^C, claude's interactive
 * mode). If node-pty fails to load or spawn — typically a prebuilt-binary ABI
 * mismatch with the host Node version — we throw a `OperatorClaudeSpawnError`
 * with diagnostic detail rather than fall back to a plain pipe spawn. Claude
 * detects pipe stdin and exits immediately with a "no stdin data" error,
 * producing broken-looking UX. Better to surface the install issue clearly so
 * the operator can `npm rebuild node-pty` (which the client's postinstall
 * hook does automatically on a normal install).
 *
 * Pre-flight: we mark claude's first-run wizard as already-completed so the
 * embedded session doesn't drop the operator into a theme picker / "let's
 * get started" flow they don't need. Claude persists onboarding state in
 * ~/.claude.json. If the file is missing (fresh operator) we write a minimal
 * stub with hasCompletedOnboarding:true. If the file already exists (returning
 * operator who has used claude before) we leave it alone — the operator's
 * actual settings are theirs.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OperatorClaudeConfig {
  claudePath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** When true, spawn with --enable-auto-mode (Claude Code v2.1.83+). */
  autoMode: boolean;
  /** MCP config path so the embedded session reaches the operator MCP server. */
  mcpConfigPath?: string;
}

export interface OperatorClaude {
  write(data: string): void;
  resize?(cols: number, rows: number): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

export class OperatorClaudeSpawnError extends Error {
  constructor(
    message: string,
    public readonly remediation: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'OperatorClaudeSpawnError';
  }
}

/**
 * Pre-mark claude's first-run wizard as complete when the operator's claude
 * config doesn't exist yet. Claude reads ~/.claude.json on startup; setting
 * hasCompletedOnboarding:true skips the theme picker / "let's get started"
 * wizard. If the file exists we don't touch it — the operator's own
 * preferences are authoritative.
 *
 * Important: claude runs a migration step on a file it considers stale. If
 * migrationVersion is missing or older than the current schema, claude
 * rewrites the file from scratch and our hasCompletedOnboarding gets dropped.
 * The stub below sets migrationVersion to 13 (the current value at the time
 * of writing) plus the per-model migration markers, which prevents the
 * migration from firing and preserves our flags.
 */
function ensureClaudeOnboarded(): void {
  const home = process.env['HOME'] ?? homedir();
  const claudeJsonPath = join(home, '.claude.json');
  if (existsSync(claudeJsonPath)) return;
  try {
    mkdirSync(dirname(claudeJsonPath), { recursive: true });
    const stub = {
      migrationVersion: 13,
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '999.999.999',
      firstStartTime: new Date().toISOString(),
      opusProMigrationComplete: true,
      sonnet1m45MigrationComplete: true,
      sonnet45MigrationComplete: true,
      opus45MigrationComplete: true,
      thinkingMigrationComplete: true,
      seenNotifications: {},
    };
    writeFileSync(claudeJsonPath, JSON.stringify(stub, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // Non-fatal — claude will just show its first-run wizard. Don't crash
    // the agent panel over a config-write failure.
  }
}

function findNodePtyFixScript(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'scripts', 'fix-node-pty.mjs'),
    join(here, '..', '..', 'scripts', 'fix-node-pty.mjs'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function runNodePtyRepair(): string | null {
  // Sync spawnSync is acceptable here (#778, #398, #778-followup): this is on
  // the operator-agent WebSocket spawn path, not a daemon-hot-path readiness
  // probe. It runs at most once per agent-panel session when the initial
  // spawnPty() throws an ABI/ENOENT error, gated by an outer 15s timeout, and
  // the agent panel is awaited by a human-driven action — blocking the WS
  // handler for a few hundred ms while node-pty rebuilds is acceptable. The
  // wedge classes fixed in #778 and the #778 follow-up were per-task /
  // per-tick spawns on the daemon main thread.
  const script = findNodePtyFixScript();
  if (!script) return 'node-pty repair script was not found in this install.';
  const result = spawnSync(process.execPath, [script, '--verify'], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 15000,
  });
  if (result.status === 0) return null;
  const detail = (result.stderr || result.stdout || `exit status ${result.status ?? 'unknown'}`).trim();
  return detail || 'node-pty repair did not complete successfully.';
}

export async function spawnOperatorClaude(cfg: OperatorClaudeConfig): Promise<OperatorClaude> {
  ensureClaudeOnboarded();

  const args: string[] = [];
  if (cfg.autoMode) args.push('--enable-auto-mode');
  if (cfg.mcpConfigPath) args.push('--mcp-config', cfg.mcpConfigPath);

  let ptyModule: typeof import('node-pty');
  try {
    ptyModule = await import('node-pty');
  } catch (err) {
    throw new OperatorClaudeSpawnError(
      `Failed to load node-pty: ${err instanceof Error ? err.message : String(err)}`,
      'Run `npm rebuild node-pty` in the jinn-client install directory and restart the daemon.',
      err,
    );
  }

  const spawnPty = (): OperatorClaude => {
    // Pass through the env vars that get claude's TUI rendering right. Without
    // COLORTERM + FORCE_COLOR, claude falls back to a degraded glyph set that
    // renders as solid blocks instead of box-drawing chars in xterm.js.
    // Pattern from siteboon/claudecodeui's shell-websocket bridge.
    const pty = ptyModule.spawn(cfg.claudePath, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: cfg.cwd,
      env: {
        ...process.env,
        ...cfg.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        FORCE_COLOR: '3',
      } as { [key: string]: string },
    });
    const dataHandlers: Array<(chunk: string) => void> = [];
    const exitHandlers: Array<(code: number | null) => void> = [];
    pty.onData((d) => dataHandlers.forEach((h) => h(d)));
    pty.onExit(({ exitCode }) => exitHandlers.forEach((h) => h(exitCode ?? null)));
    return {
      write: (d) => pty.write(d),
      resize: (c, r) => pty.resize(c, r),
      onData: (cb) => { dataHandlers.push(cb); },
      onExit: (cb) => { exitHandlers.push(cb); },
      kill: () => pty.kill(),
    };
  };

  try {
    return spawnPty();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      throw new OperatorClaudeSpawnError(
        `Claude Code CLI not found: ${cfg.claudePath}`,
        'Install Claude Code from the operator panel, then sign in with Claude.',
        err,
      );
    }
    let finalError: unknown = err;
    const repairError = runNodePtyRepair();
    if (!repairError) {
      try {
        return spawnPty();
      } catch (retryErr) {
        const retryCode = (retryErr as NodeJS.ErrnoException | undefined)?.code;
        if (retryCode === 'ENOENT') {
          throw new OperatorClaudeSpawnError(
            `Claude Code CLI not found: ${cfg.claudePath}`,
            'Install Claude Code from the operator panel, then sign in with Claude.',
            retryErr,
          );
        }
        finalError = retryErr;
      }
    }
    // node-pty's prebuilt binary loaded but posix_spawnp / fork failed at runtime.
    // This is the ABI-mismatch case — the JS wrapper resolves but the native
    // module's internals can't actually spawn. Falling back to plain spawn
    // would silently produce a broken claude session.
    throw new OperatorClaudeSpawnError(
      `node-pty failed to spawn: ${finalError instanceof Error ? finalError.message : String(finalError)}`,
      'Run `npm rebuild node-pty` in the jinn-client install directory and restart the daemon. ' +
        'If the rebuild fails, ensure your system has a C++ toolchain (Xcode CLT on macOS, build-essential on Linux).' +
        (repairError ? ` Automatic repair failed: ${repairError}` : ''),
      finalError,
    );
  }
}
