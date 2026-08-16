/**
 * Preflight check: is the `claude` CLI resolvable and executable?
 *
 * The daemon spawns Claude Code as a subprocess via `ClaudeRunner`
 * (operator/src/runner/claude.ts). If the binary isn't on PATH (or at
 * the configured claudePath), the failure surfaces only at the moment
 * a request is claimed — long after bootstrap. This check moves that
 * failure to startup with a clear envelope.
 */

import { promises as fs, constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';

const execFileAsync = promisify(execFile);

export interface ClaudeBinaryCheckResult {
  ok: boolean;
  resolvedPath?: string;
  detail: string;
}

/**
 * Resolve and verify a `claude` binary. Accepts either an absolute path or a
 * bare name to look up on PATH (via `which`/`where`).
 */
export async function checkClaudeBinary(claudePath: string): Promise<ClaudeBinaryCheckResult> {
  // Absolute / relative path: fs.access is authoritative.
  if (isAbsolute(claudePath) || claudePath.includes('/')) {
    try {
      await fs.access(claudePath, fsConstants.X_OK);
      return { ok: true, resolvedPath: claudePath, detail: `${claudePath} is executable` };
    } catch {
      return { ok: false, detail: `claude binary not found at ${claudePath}` };
    }
  }

  // Bare name: shell out to `which` (POSIX) or `where` (Windows). We only
  // support POSIX here; the production target is macOS/Linux.
  try {
    const { stdout } = await execFileAsync('which', [claudePath]);
    const resolved = stdout.trim().split('\n')[0];
    if (!resolved) {
      return { ok: false, detail: `claude binary '${claudePath}' not found on PATH` };
    }
    return { ok: true, resolvedPath: resolved, detail: `${resolved} is on PATH` };
  } catch {
    return { ok: false, detail: `claude binary '${claudePath}' not found on PATH` };
  }
}
