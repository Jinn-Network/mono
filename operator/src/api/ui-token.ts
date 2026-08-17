/**
 * UI session token — local-only auth secret shared between the daemon and
 * operator surfaces (SPA cookie, console/CLI `x-jinn-ui-token` header).
 *
 * On-disk format is JSON `{ token, expiresAt }` mode 0600 beside daemon state
 * (headless §9). Readers accept a legacy raw-hex file for one minor: a 64-char
 * hex line is treated as unexpired and rewritten to JSON on the next
 * `ensureUiToken`. Resolution order for readers: `JINN_UI_TOKEN`, else the file.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LEGACY_HEX = /^[0-9a-f]{64}$/i;

export interface UiTokenRecord {
  token: string;
  expiresAt: string;
}

export function defaultTokenPath(stateDir?: string): string {
  return join(stateDir ?? join(homedir(), '.jinn-client'), 'ui-token');
}

function writeRecord(path: string, record: UiTokenRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function freshRecord(now: Date): UiTokenRecord {
  return {
    token: randomBytes(32).toString('hex'),
    expiresAt: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
  };
}

function parseRecord(raw: string, now: Date): UiTokenRecord | 'legacy' | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { token?: unknown; expiresAt?: unknown };
      if (typeof parsed.token === 'string' && parsed.token.length >= 32 && typeof parsed.expiresAt === 'string') {
        return { token: parsed.token, expiresAt: parsed.expiresAt };
      }
    } catch {
      return null;
    }
    return null;
  }
  if (trimmed.length > 0) return 'legacy';
  return null;
}

export function readUiTokenRecord(path: string = defaultTokenPath(), now: () => Date = () => new Date()): UiTokenRecord | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseRecord(raw, now());
  if (parsed === null) return null;
  if (parsed === 'legacy') {
    const trimmed = raw.trim();
    return {
      token: trimmed,
      expiresAt: new Date(now().getTime() + TOKEN_TTL_MS).toISOString(),
    };
  }
  return parsed;
}

export function uiTokenExpired(record: UiTokenRecord, now: Date = new Date()): boolean {
  const expires = Date.parse(record.expiresAt);
  if (!Number.isFinite(expires)) return true;
  return now.getTime() >= expires;
}

/** Read the token at `path`; if missing, short, or expired, generate and persist a new one. */
export function ensureUiToken(path = defaultTokenPath(), now: () => Date = () => new Date()): string {
  return ensureUiTokenRecord(path, now).token;
}

export function ensureUiTokenRecord(path = defaultTokenPath(), now: () => Date = () => new Date()): UiTokenRecord {
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf-8');
    const parsed = parseRecord(raw, now());
    if (parsed === 'legacy') {
      const trimmed = raw.trim();
      if (trimmed.length < 32) {
        const record = freshRecord(now());
        writeRecord(path, record);
        return record;
      }
      const record: UiTokenRecord = {
        token: trimmed,
        expiresAt: new Date(now().getTime() + TOKEN_TTL_MS).toISOString(),
      };
      writeRecord(path, record);
      return record;
    }
    if (parsed && !uiTokenExpired(parsed, now())) return parsed;
  }
  const record = freshRecord(now());
  writeRecord(path, record);
  return record;
}

/** Forcibly rotate to a fresh token. */
export function rotateUiToken(path = defaultTokenPath(), now: () => Date = () => new Date()): string {
  const record = freshRecord(now());
  writeRecord(path, record);
  return record.token;
}

export function tokensEqual(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Resolution order: `JINN_UI_TOKEN`, else the on-disk record (skipping expired JSON). */
export function resolveStoredUiToken(
  path: string = defaultTokenPath(),
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): string | undefined {
  const fromEnv = env['JINN_UI_TOKEN'];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const record = readUiTokenRecord(path, now);
  if (!record) return undefined;
  if (uiTokenExpired(record, now())) return undefined;
  return record.token;
}
