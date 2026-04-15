import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ParsedArgs {
  flags: Record<string, string>;
  bools: Set<string>;
}

export interface CommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  command: string;
}

export function parseArgs(args: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;

    const token = arg.slice(2);
    const [key, inlineValue] = token.split('=');

    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }

    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
      continue;
    }

    bools.add(key);
  }

  return { flags, bools };
}

export function normalizeAddress(value: string): string {
  const lower = value.trim().toLowerCase();
  return lower.startsWith('0x') ? lower : `0x${lower}`;
}

export function normalizeHexKey(value: string): `0x${string}` {
  const normalized = normalizeAddress(value) as `0x${string}`;
  if (!/^0x[a-f0-9]{64}$/i.test(normalized)) {
    throw new Error('Invalid private key format (expected 0x + 64 hex chars).');
  }
  return normalized;
}

export function asInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

export function summarizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function runCommand(args: {
  cmd: string;
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): CommandResult {
  const argv = args.argv ?? [];
  const result = spawnSync(args.cmd, argv, {
    cwd: args.cwd,
    env: args.env,
    encoding: 'utf-8',
    timeout: args.timeoutMs ?? 120_000,
    maxBuffer: 25 * 1024 * 1024,
  });

  if (result.error) {
    return {
      ok: false,
      code: 1,
      stdout: result.stdout ?? '',
      stderr: `${result.stderr ?? ''}\n${result.error.message}`.trim(),
      command: [args.cmd, ...argv].join(' '),
    };
  }

  const code = result.status ?? 1;
  return {
    ok: code === 0,
    code,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    command: [args.cmd, ...argv].join(' '),
  };
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

export async function withRailwayContext<T>(args: {
  project: string;
  environment: string;
  service?: string;
  work: (cwd: string) => Promise<T>;
}): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'jinn-railway-link-'));
  const linkArgs = ['link', '-p', args.project, '-e', args.environment];
  if (args.service) linkArgs.push('-s', args.service);
  const link = runCommand({ cmd: 'railway', argv: linkArgs, cwd, timeoutMs: 120_000 });
  if (!link.ok) {
    throw new Error(`railway link failed for ${args.project}/${args.environment}: ${link.stderr || link.stdout}`);
  }

  return args.work(cwd);
}

export async function runRailwayJson<T = any>(args: {
  cwd: string;
  argv: string[];
  timeoutMs?: number;
}): Promise<T> {
  const res = runCommand({
    cmd: 'railway',
    argv: args.argv,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
  });
  if (!res.ok) {
    throw new Error(`railway ${args.argv.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  try {
    return JSON.parse(res.stdout) as T;
  } catch (err) {
    throw new Error(`Failed to parse JSON from railway ${args.argv.join(' ')}: ${summarizeError(err)}`);
  }
}

export function bool(value: unknown): boolean {
  return value === true;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function postGraphql<T = any>(url: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GraphQL ${url} failed: HTTP ${response.status} ${text.slice(0, 240)}`);
  }

  let payload: any;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`GraphQL ${url} returned non-JSON response`);
  }

  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error(`GraphQL ${url} errors: ${JSON.stringify(payload.errors).slice(0, 240)}`);
  }

  return payload as T;
}

export function parseJsonLines<T = Record<string, unknown>>(text: string): T[] {
  const out: T[] = [];
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // ignore non-json lines
    }
  }
  return out;
}

export function providerList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function nowIso(): string {
  return new Date().toISOString();
}
