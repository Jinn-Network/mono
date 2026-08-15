/**
 * Shared resolver for the operator dashboard's "Harness auth status" panel (#564).
 *
 * A harness declares WHERE its credential lives via `getAuthSource()`. This
 * helper owns the unsafe part: stat the file for mtime, read the credential,
 * keep ONLY the last-4 suffix, discard the full value. It NEVER returns full
 * key bytes. See docs/runbooks/rotating-harness-keys.md.
 */
import { stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Harness } from './types.js';

/**
 * Tilde-abbreviate an absolute path for operator display when it sits under the
 * real home dir; otherwise return it unchanged. Used by harness `getAuthSource`
 * implementations so the dashboard shows `~/.hermes/.env` rather than a full
 * `/Users/...` path.
 */
export function displayPath(absolutePath: string): string {
  const home = homedir();
  return absolutePath.startsWith(home) ? absolutePath.replace(home, '~') : absolutePath;
}

export type HarnessAuthSource =
  | {
      sourceKind: 'file';
      sourcePath: string;
      absolutePath: string;
      envKey: string;
      docAnchor: string;
      /**
       * When true the credential file is structured (e.g. codex `auth.json`)
       * rather than a flat `KEY=value` dotenv. The resolver then reports
       * `loaded` from file existence alone and masks the suffix to null — it
       * never parses a key line out of the structured body.
       */
      credentialIsJson?: boolean;
    }
  | {
      sourceKind: 'env';
      envKey: string;
      docAnchor: string;
    }
  | {
      sourceKind: 'session';
      docAnchor: string;
    };

export interface HarnessAuthStatusEntry {
  harnessName: string;
  sourceKind: 'file' | 'env' | 'session' | 'none';
  sourcePath?: string;
  envKey?: string;
  keySuffix: string | null;
  lastModified: string | null;
  state: 'loaded' | 'missing' | 'unknown';
  docAnchor?: string;
}

export interface HarnessAuthStatusResponse {
  harnesses: HarnessAuthStatusEntry[];
}

const MIN_SUFFIX_LEN = 8;

/** Last-4 suffix, or null when the value is too short / empty to safely show. */
function safeSuffix(value: string): string | null {
  if (value.length < MIN_SUFFIX_LEN) return null;
  return value.slice(-4);
}

/**
 * Extract the value of a single `KEY=value` line from a dotenv-style file body.
 * Matches the named key at the start of a line only — a value that merely
 * mentions the key name elsewhere is ignored. Strips surrounding quotes.
 */
function readEnvValueFromFile(body: string, envKey: string): string | undefined {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line.startsWith(`${envKey}=`)) continue;
    let value = line.slice(envKey.length + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

export interface ResolveOptions {
  /** Env bag for env-kind sources. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve one harness's safe auth status. Iteration-safe: any error collapses
 * to a session-shaped `unknown` entry rather than throwing.
 */
export async function resolveHarnessAuthStatus(
  harness: Harness,
  opts: ResolveOptions = {},
): Promise<HarnessAuthStatusEntry> {
  if (!harness.getAuthSource) {
    return {
      harnessName: harness.name,
      sourceKind: 'none',
      keySuffix: null,
      lastModified: null,
      state: 'unknown',
    };
  }

  let source: HarnessAuthSource;
  try {
    source = await harness.getAuthSource();
  } catch {
    return {
      harnessName: harness.name,
      sourceKind: 'session',
      keySuffix: null,
      lastModified: null,
      state: 'unknown',
    };
  }

  if (source.sourceKind === 'session') {
    return {
      harnessName: harness.name,
      sourceKind: 'session',
      keySuffix: null,
      lastModified: null,
      state: 'unknown',
      docAnchor: source.docAnchor,
    };
  }

  if (source.sourceKind === 'env') {
    const env = opts.env ?? process.env;
    const value = env[source.envKey]?.trim() ?? '';
    return {
      harnessName: harness.name,
      sourceKind: 'env',
      envKey: source.envKey,
      keySuffix: safeSuffix(value),
      lastModified: null,
      state: value.length > 0 ? 'loaded' : 'missing',
      docAnchor: source.docAnchor,
    };
  }

  // file-kind
  let mtime: string | null = null;
  let body: string;
  try {
    const st = await stat(source.absolutePath);
    mtime = st.mtime.toISOString();
    body = await readFile(source.absolutePath, 'utf8');
  } catch {
    return {
      harnessName: harness.name,
      sourceKind: 'file',
      sourcePath: source.sourcePath,
      envKey: source.envKey,
      keySuffix: null,
      lastModified: null,
      state: 'missing',
      docAnchor: source.docAnchor,
    };
  }

  // Structured credential files (e.g. codex auth.json): report `loaded` from
  // existence + mtime, but never parse a key out — suffix stays masked.
  if (source.credentialIsJson) {
    return {
      harnessName: harness.name,
      sourceKind: 'file',
      sourcePath: source.sourcePath,
      envKey: source.envKey,
      keySuffix: null,
      lastModified: mtime,
      state: 'loaded',
      docAnchor: source.docAnchor,
    };
  }

  const value = readEnvValueFromFile(body, source.envKey)?.trim() ?? '';
  if (value.length === 0) {
    return {
      harnessName: harness.name,
      sourceKind: 'file',
      sourcePath: source.sourcePath,
      envKey: source.envKey,
      keySuffix: null,
      lastModified: null,
      state: 'missing',
      docAnchor: source.docAnchor,
    };
  }

  return {
    harnessName: harness.name,
    sourceKind: 'file',
    sourcePath: source.sourcePath,
    envKey: source.envKey,
    keySuffix: safeSuffix(value),
    lastModified: mtime,
    state: 'loaded',
    docAnchor: source.docAnchor,
  };
}
