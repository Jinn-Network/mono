#!/usr/bin/env node
/**
 * Lint guard: no raw `error.message` stringification in a `client/src/api/`
 * file that talks to an RPC client (imports from `viem`), outside the
 * designated masking choke point.
 *
 * A failing RPC call (`client.getBlockNumber`, `readContract`, …) throws a
 * viem `HttpRequestError` whose `.message` embeds the full request URL — for
 * an operator-configured paid primary that's a key-in-path secret. `/v1/status`
 * is unauthenticated today, so `raw.rpc = { error: e.message }` (and the
 * sibling `raw.master` / `raw.l1Master` / balance-cache paths) leaked it
 * straight through. See spec §14.2 item 2, issue #2402.
 *
 * Policy enforced here: any `client/src/api/**\/*.ts` file that imports from
 * `'viem'` must not contain a raw `X instanceof Error ? X.message : ...` (or
 * bare `.message`) error-to-string conversion — it must go through
 * `maskUrlsInMessage` (directly, or via a local choke-point helper such as
 * gather-status.ts's `errorMessage`). The one legitimate raw read (the choke
 * point's own implementation) is marked with the `lint:no-error-leak-allow`
 * inline comment and skipped.
 *
 * Scope note: this only walks files that import viem. Most of client/src/api/
 * uses `.message` for unrelated, non-RPC errors (zod validation issues,
 * subprocess failures, artifact hash mismatches, …) — those are out of scope
 * for this guard and untouched by it. If a future file starts talking to an
 * RPC client directly, this guard extends to it automatically (no allowlist
 * edit needed) because the check is import-driven, not a file list.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(SCRIPT_DIR, '..', 'src');
const API_DIR = join(SRC_ROOT, 'api');

const VIEM_IMPORT_PATTERN = /from\s+['"]viem['"]/;
const RAW_MESSAGE_PATTERN = /\.message\b/;
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

const files = walk(API_DIR);
const violations = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (!VIEM_IMPORT_PATTERN.test(text)) continue; // not RPC-adjacent — out of scope

  const rel = relative(SRC_ROOT, file).split('\\').join('/');
  text.split('\n').forEach((line, idx) => {
    if (line.includes(ALLOW_MARKER)) return;
    if (RAW_MESSAGE_PATTERN.test(line)) {
      violations.push({ file: `client/src/${rel}`, line: idx + 1, snippet: line.trim() });
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
console.error('  Route the conversion through maskUrlsInMessage (client/src/rpc/transport.js)');
console.error('  — directly, or via a local choke point like gather-status.ts\'s');
console.error('  errorMessage() — instead of `X instanceof Error ? X.message : ...`.\n');
console.error('  Violations:');
for (const v of violations) {
  console.error(`    ${v.file}:${v.line}  ${v.snippet}`);
}
process.exit(1);
