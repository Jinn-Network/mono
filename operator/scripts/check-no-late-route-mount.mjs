#!/usr/bin/env node
/**
 * Lint guard: no Hono `app.METHOD(...)` route registration outside the
 * startApiServer call graph.
 *
 * The 2026-05-18 canary crashed with "Can not add a route since the matcher
 * is already built" because main.ts called addHarnessReadinessRoutes(app, ...)
 * AFTER bootstrap completed (i.e. after the panel had been making /v1/bootstrap
 * polls for several minutes during faucet drips). Hono's matcher is finalized
 * on first request; late-mounting throws. See jinn-mono-u34i.
 *
 * Policy enforced here: every `app.get|post|put|patch|delete|use|all(...)`
 * call in operator/src/ must live in a file that startApiServer eagerly
 * imports + calls during its setup. Today that's:
 *
 *   - operator/src/api/server.ts        (the startApiServer body itself)
 *   - operator/src/api/*-endpoint.ts    (route helpers called from server.ts)
 *   - operator/src/api/*-endpoints.ts   (same — plural variant)
 *   - operator/src/api/*-routes.ts      (same — third naming variant)
 *   - operator/src/api/*-build.ts       (status/rollup builders that also mount)
 *   - operator/src/api/operator-artifacts-endpoint.ts (existing exception)
 *   - operator/src/api/peers.ts         (peer-sync subsystem; calls app.use)
 *   - operator/src/api/admin-endpoint.ts
 *   - operator/src/api/hermes-doctor-endpoint.ts
 *   - operator/src/api/harness-readiness-endpoint.ts
 *   - operator/src/api/harness-status-endpoint.ts
 *   - operator/src/api/bootstrap-endpoint.ts
 *   - operator/src/api/setup-endpoints.ts
 *   - operator/src/api/agent-binding-endpoint.ts
 *   - operator/src/api/stop-hook-endpoint.ts
 *   - operator/src/api/discovery-routes.ts
 *   - operator/src/trajectory/llm-proxy.ts (standalone Hono instance, not the
 *                                         operator daemon's app)
 *
 * If you're adding a NEW route helper, drop it under operator/src/api/, end the
 * filename in *-endpoint.ts / *-endpoints.ts / *-routes.ts, and call it from
 * startApiServer in server.ts. Use the holder-ref pattern (see
 * harnessReadinessRegistry) if the registry isn't ready
 * at startup time.
 *
 * If your route registration is genuinely a separate Hono app (not the
 * operator daemon's), add the file path to the ALLOWLIST below.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve src/ from the script's location so the check works regardless of
// where it's invoked from (yarn lint runs with cwd=operator/, CI runs with the
// same — but a direct `node operator/scripts/...` from repo root needs both).
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(SCRIPT_DIR, '..', 'src');

const ALLOWED_PREFIXES = [
  // Operator daemon API server + its route helpers.
  'api/',
  // LLM proxy is its own standalone Hono instance, not the operator daemon's.
  'trajectory/llm-proxy.ts',
];

const FORBIDDEN_PATTERN = /\bapp\.(get|post|put|patch|delete|use|all)\s*\(/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      // Skip node_modules and dist if they accidentally land under src/.
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function isAllowed(relPath) {
  return ALLOWED_PREFIXES.some((p) => relPath.startsWith(p));
}

const files = walk(SRC_ROOT);
const violations = [];

for (const file of files) {
  const rel = relative(SRC_ROOT, file).split('\\').join('/');
  if (isAllowed(rel)) continue;
  const text = readFileSync(file, 'utf8');
  text.split('\n').forEach((line, idx) => {
    if (FORBIDDEN_PATTERN.test(line)) {
      violations.push({ file: `operator/src/${rel}`, line: idx + 1, snippet: line.trim() });
    }
  });
}

if (violations.length === 0) {
  console.log('✓ No late route mounts detected outside the startApiServer call graph.');
  process.exit(0);
}

console.error('✗ Late route mount detected — this can crash the daemon with');
console.error('  "Can not add a route since the matcher is already built" when');
console.error('  bootstrap takes long enough that the panel makes API requests');
console.error('  before these routes are added. See jinn-mono-u34i.\n');
console.error('  Move the registration into a *-endpoint.ts / *-endpoints.ts /');
console.error('  *-routes.ts file under operator/src/api/ and have startApiServer');
console.error('  call it. Use the holder-ref pattern (harnessReadinessRegistry)');
console.error('  if the registry is not ready at');
console.error('  server-start time.\n');
console.error('  Violations:');
for (const v of violations) {
  console.error(`    ${v.file}:${v.line}  ${v.snippet}`);
}
process.exit(1);
