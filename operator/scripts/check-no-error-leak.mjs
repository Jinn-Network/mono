#!/usr/bin/env node
/**
 * Lint guard: no raw error stringification in a `operator/src/api/` file that
 * talks to an RPC client, outside the designated masking choke point.
 *
 * A failing RPC call (`client.getBlockNumber`, `readContract`, …) throws a
 * viem `HttpRequestError` whose `.message` (and `.toString()`, hence a bare
 * `String(err)`) embeds the full request URL — for an operator-configured
 * paid primary that's a key-in-path secret. `/v1/status` is unauthenticated
 * today, so `raw.rpc = { error: e.message }` (and the sibling `raw.master` /
 * `raw.l1Master` / balance-cache paths) leaked it straight through. See spec
 * §14.2 item 2, issue #2402.
 *
 * Policy enforced here: any `operator/src/api/**\/*.ts` file that is
 * RPC-adjacent (imports from `viem` — any subpath, not just the package
 * root — or uses `createJinnPublicClient` / a `PublicClient` type, or
 * already imports one of the `rpc/transport.ts` masking helpers) must not
 * contain a raw
 * `X instanceof Error ? X.message : String(X)` (or bare `.message` /
 * `String(err)`) error-to-string conversion — it must go through
 * `maskUrlsInMessage` / `sanitizeErrorText` / `sanitizePersistedText`
 * (directly, or via a local choke-point helper such as gather-status.ts's
 * `errorMessage`). Any line that itself calls one of those is skipped (it's the fix, not the leak) — this is
 * how e.g. server.ts's inline
 * `maskUrlsInMessage(err instanceof Error ? err.message : String(err))` stays
 * green without a suppression comment. The one other legitimate raw read
 * (the choke point's own implementation, e.g. gather-status.ts's
 * `errorMessage`) is marked with the `lint:no-error-leak-allow` inline
 * comment and skipped.
 *
 * Each masking helper is itself a file-scope trigger so that any file which
 * already imports one — even one that doesn't talk to viem directly, like
 * server.ts, or the token-gated routes fixed in #2416 — comes under the same
 * "no *other* raw stringification in this file" discipline once it starts
 * using it.
 *
 * Scope note: most of operator/src/api/ uses `.message` for unrelated, non-RPC
 * errors (zod validation issues, subprocess failures, artifact hash
 * mismatches, …) — those files are out of scope for this guard and untouched
 * by it. If a future file starts talking to an RPC client directly, this
 * guard extends to it automatically (no allowlist edit needed) because the
 * check is import/usage-driven, not a file list.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(SCRIPT_DIR, '..', 'src');
const API_DIR = join(SRC_ROOT, 'api');

/**
 * The three `rpc/transport.ts` masking helpers are file-scope triggers as well
 * as fixes: a file that imports one has declared it handles RPC-derived error
 * text, so every *other* raw stringification in it comes under this guard.
 * That is how issue #2416's newly-fixed files (discovery-endpoint,
 * rewards-endpoint, admin-endpoint) enter scope — none of them imports viem
 * directly, so the import/usage triggers below are what covers them.
 */
const MASKED_CALL_MARKERS = ['maskUrlsInMessage', 'sanitizeErrorText', 'sanitizePersistedText'];
const RPC_ADJACENT_PATTERN = new RegExp(
  ['from\\s+[\'"]viem(\\/[\\w.-]+)?[\'"]', 'createJinnPublicClient', 'PublicClient', ...MASKED_CALL_MARKERS].join('|'),
);
const RAW_MESSAGE_PATTERN = /\.message\b|String\(\s*(e|err|error)\w*\s*\)/;
const ALLOW_MARKER = 'lint:no-error-leak-allow';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scan one `api/`-shaped directory and return every violation. Exported so the
 * guard's own behaviour is testable against a fixture tree instead of only
 * against the live source (issue #2416 AC3).
 *
 * @param {string} apiDir directory to walk
 * @param {string} srcRoot root the reported paths are made relative to
 */
export function findErrorLeaks(apiDir, srcRoot) {
  const violations = [];
  for (const file of walk(apiDir)) {
    const text = readFileSync(file, 'utf8');
    if (!RPC_ADJACENT_PATTERN.test(text)) continue; // not RPC-adjacent — out of scope

    const rel = relative(srcRoot, file).split('\\').join('/');
    text.split('\n').forEach((line, idx) => {
      if (line.includes(ALLOW_MARKER)) return;
      // already routed through a choke point — the fix, not the leak
      if (MASKED_CALL_MARKERS.some((m) => line.includes(m))) return;
      if (RAW_MESSAGE_PATTERN.test(line)) {
        violations.push({ file: `operator/src/${rel}`, line: idx + 1, snippet: line.trim() });
      }
    });
  }
  return violations;
}

// CLI entry only — importing this module (the guard's own tests do) must not
// walk the live tree or call process.exit.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}

function main() {
  const violations = findErrorLeaks(API_DIR, SRC_ROOT);

  if (violations.length === 0) {
    console.log('✓ No raw (unmasked) error-message stringification in RPC-adjacent api/ files.');
    process.exit(0);
  }

  console.error('✗ Raw error.message stringification detected in a file that talks to an RPC');
  console.error('  client. This can leak a paid provider\'s key-in-path through a viem');
  console.error('  HttpRequestError message (spec §14.2 item 2, issue #2402).\n');
  console.error('  Route the conversion through maskUrlsInMessage / sanitizeErrorText');
  console.error('  (operator/src/rpc/transport.js)');
  console.error('  — directly, or via a local choke point like gather-status.ts\'s');
  console.error('  errorMessage() — instead of `X instanceof Error ? X.message : ...`.\n');
  console.error('  Violations:');
  for (const v of violations) {
    console.error(`    ${v.file}:${v.line}  ${v.snippet}`);
  }
  process.exit(1);
}
