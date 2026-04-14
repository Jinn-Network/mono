/**
 * CLI password resolution: JINN_PASSWORD env or --password-fd N (reads once, trims).
 */

import { readFileSync } from 'node:fs';

export function parsePasswordFdFromArgv(argv: string[]): number | undefined {
  const idx = argv.indexOf('--password-fd');
  if (idx === -1) return undefined;
  const raw = argv[idx + 1];
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

export function readPasswordFromFd(fd: number): string {
  const buf = readFileSync(fd, { encoding: 'utf8' });
  return buf.replace(/\r?\n$/, '').trim();
}

function mergeArgv(argv?: string[]): string[] {
  const fromVerb = argv ?? [];
  const fromProcess = typeof process !== 'undefined' ? process.argv.slice(2) : [];
  return [...fromVerb, ...fromProcess];
}

export function resolveCliPassword(
  argv?: string[],
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; password: string } | { ok: false; message: string } {
  const merged = mergeArgv(argv);
  const fd = parsePasswordFdFromArgv(merged);
  if (fd !== undefined) {
    try {
      const password = readPasswordFromFd(fd);
      if (!password) {
        return { ok: false, message: 'Password from --password-fd is empty.' };
      }
      return { ok: true, password };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }
  const p = env['JINN_PASSWORD'];
  if (!p) {
    return {
      ok: false,
      message: 'Set JINN_PASSWORD or pass --password-fd N with a readable file descriptor.',
    };
  }
  return { ok: true, password: p };
}
