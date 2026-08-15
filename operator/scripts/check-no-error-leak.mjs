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
 * already imports `maskUrlsInMessage`) must not contain a raw
 * `X instanceof Error ? X.message : String(X)` (or bare `.message` /
 * `String(err)`) error-to-string conversion — it must go through
 * `maskUrlsInMessage` (directly, or via a local choke-point helper such as
 * gather-status.ts's `errorMessage`). Any line that itself calls
 * `maskUrlsInMessage(...)` is skipped (it's the fix, not the leak) — this is
 * how e.g. server.ts's inline
 * `maskUrlsInMessage(err instanceof Error ? err.message : String(err))` stays
 * green without a suppression comment. The one other legitimate raw read
 * (the choke point's own implementation, e.g. gather-status.ts's
 * `errorMessage`) is marked with the `lint:no-error-leak-allow` inline
 * comment and skipped.
 *
 * `maskUrlsInMessage` is itself a file-scope trigger so that any file which
 * already imports the masking helper — even one that doesn't talk to viem
 * directly, like server.ts — comes under the same "no *other* raw
 * stringification in this file" discipline once it starts using it.
 *
 * Scope note: most of operator/src/api/ uses `.message` for unrelated, non-RPC
 * errors (zod validation issues, subprocess failures, artifact hash
 * mismatches, …) — those files are out of scope for this guard and untouched
 * by it. If a future file starts talking to an RPC client directly, this
 * guard extends to it automatically (no allowlist edit needed) because the
 * check is import/usage-driven, not a file list.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(SCRIPT_DIR, '..', 'src');
const API_DIR = join(SRC_ROOT, 'api');

const RPC_ADJACENT_PATTERN =
  /from\s+['"]viem(\/[\w.-]+)?['"]|createJinnPublicClient|PublicClient|maskUrlsInMessage/;
const RAW_MESSAGE_PATTERN = /\.message\b|String\(\s*(e|err|error)\w*\s*\)/;
const ALLOW_MARKER = 'lint:no-error-leak-allow';
const MASKED_CALL_MARKER = 'maskUrlsInMessage';

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

const files = walk(API_DIR);
const violations = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (!RPC_ADJACENT_PATTERN.test(text)) continue; // not RPC-adjacent — out of scope

  const rel = relative(SRC_ROOT, file).split('\\').join('/');
  text.split('\n').forEach((line, idx) => {
    if (line.includes(ALLOW_MARKER)) return;
    if (line.includes(MASKED_CALL_MARKER)) return; // already routed through the choke point
    if (RAW_MESSAGE_PATTERN.test(line)) {
      violations.push({ file: `operator/src/${rel}`, line: idx + 1, snippet: line.trim() });
    }
  });
}

if (violations.length === 0) {
  console.log('✓ No raw (unmasked) error-message stringification in RPC-adjacent api/ files.');
  process.exit(0);
}

console.error('✗ Raw error.message stringification detected in a file that talks to an RPC');
console.error('  client. This can leak a paid provider\'s key-in-path through a viem');
console.error('  HttpRequestError message (spec §14.2 item 2, issue #2402).\n');
console.error('  Route the conversion through maskUrlsInMessage (operator/src/rpc/transport.js)');
console.error('  — directly, or via a local choke point like gather-status.ts\'s');
console.error('  errorMessage() — instead of `X instanceof Error ? X.message : ...`.\n');
console.error('  Violations:');
for (const v of violations) {
  console.error(`    ${v.file}:${v.line}  ${v.snippet}`);
}
process.exit(1);
