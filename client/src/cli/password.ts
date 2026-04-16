/**
 * CLI password resolution: JINN_PASSWORD env or --password-fd N (reads once, trims).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

export function resolveCurrentPassword(
  argv: string[],
  env: Record<string, string | undefined>,
): { ok: true; password: string; fromFile: boolean } | { ok: false; message: string } {
  // 1. Check keystore-password file
  const home = env['HOME'] ?? homedir();
  const passwordFilePath = join(home, '.jinn-client', 'keystore-password');
  if (existsSync(passwordFilePath)) {
    const password = readFileSync(passwordFilePath, 'utf-8').trim();
    if (password) return { ok: true, password, fromFile: true };
  }
  // 2. Fall through to existing resolveCliPassword
  const result = resolveCliPassword(argv, env);
  if (result.ok) return { ok: true, password: result.password, fromFile: false };
  return { ok: false, message: result.message };
}

export function resolveNewPassword(
  env: Record<string, string | undefined>,
): { ok: true; password: string } | { ok: false; message: string } {
  const newPass = env['JINN_NEW_PASSWORD'];
  if (newPass && newPass.length >= 8) return { ok: true, password: newPass };
  if (newPass && newPass.length < 8)
    return { ok: false, message: 'New password must be at least 8 characters.' };
  return {
    ok: false,
    message: 'Set JINN_NEW_PASSWORD environment variable with your new password (min 8 characters).',
  };
}
