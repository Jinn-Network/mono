/**
 * Build-time metadata consumed by the engine when assembling V1 envelopes.
 *
 * In a production build (`yarn build` → tsc + write-dist-build-meta.mjs),
 * dist/build-info.json is written alongside the compiled JS.  At runtime the
 * compiled module reads that file via `createRequire` (since JSON imports
 * require `assert { type: 'json' }` which isn't universally supported).
 *
 * In dev mode (running via `yarn jinn` / `tsx` without a prior build) the
 * JSON file is absent.  The module falls back to clearly-labelled placeholder
 * values so it never throws — callers always receive a usable object.
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
  /** Short git SHA of the client commit, or 'dev' in dev mode. */
  clientGitSha: string;
  /**
   * sha256 digest of dist/main.js (the compiled production entrypoint),
   * prefixed with 'sha256:'.  'sha256:dev-build' in dev mode.
   */
  codeDigest: string;
  /** ISO-8601 build timestamp, or 'dev' in dev mode. */
  builtAt: string;
  /** Semver version from package.json at build time. */
  implVersion: string;
}

const DEV_FALLBACK: BuildInfo = {
  clientGitSha: 'dev',
  codeDigest: 'sha256:dev-build',
  builtAt: 'dev',
  implVersion: '0.0.0-dev',
};

function tryLoadBuildInfo(): BuildInfo {
  // Locate dist/build-info.json relative to this file.
  // In a production build: __filename = dist/build-info.js
  //                        → ../build-info.json resolves to dist/build-info.json
  // In dev (tsx):          __filename = src/build-info.ts
  //                        → ../dist/build-info.json (may or may not exist)
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return DEV_FALLBACK;
  }

  // When compiled: dir = .../dist  → join(dir, 'build-info.json') is the file.
  // When running via tsx: dir = .../src → check ../dist/build-info.json.
  const candidates = [
    join(dir, 'build-info.json'),
    join(dir, '..', 'dist', 'build-info.json'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const raw = readFileSync(candidate, 'utf8');
        const parsed = JSON.parse(raw) as Partial<BuildInfo>;
        if (parsed.clientGitSha && parsed.codeDigest && parsed.implVersion) {
          return {
            clientGitSha: parsed.clientGitSha,
            codeDigest: parsed.codeDigest,
            builtAt: parsed.builtAt ?? 'unknown',
            implVersion: parsed.implVersion,
          };
        }
      } catch {
        // malformed JSON — fall through to dev fallback
      }
    }
  }

  return DEV_FALLBACK;
}

/**
 * Build metadata for this client process.
 *
 * In production builds: real git SHA, sha256 of dist/main.js, package version.
 * In dev mode (tsx / no build): clearly-labelled placeholder values.
 */
export const buildInfo: BuildInfo = tryLoadBuildInfo();
