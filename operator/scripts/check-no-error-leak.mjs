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
 *
 * Completeness backstop (issue #4246): a file that reaches an RPC client
 * only through an *injected port* — a structural type with no import edge,
 * like `PluginPublicationReader` / `ArchiveReads` — is invisible to both the
 * import-graph check (`findGraphCompletenessGaps`) and a future
 * `INDIRECT_RPC_PATTERN` seam until someone remembers to add it. So every
 * `api/` file with a raw error-to-string conversion must additionally be
 * either `isRpcAdjacent` or named on `NON_RPC_API_ALLOWLIST` with a reason
 * (`findRawHitCompletenessGaps`) — an unrecognized file fails the guard
 * instead of passing silently.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(SCRIPT_DIR, '..', 'src');
const API_DIR = join(SRC_ROOT, 'api');

/**
 * The three `rpc/transport.ts` masking helpers are file-scope triggers as well
 * as fixes: a file that imports one has declared it handles RPC-derived error
 * text, so every *other* raw stringification in it comes under this guard.
 */
const MASKED_CALL_MARKERS = ['maskUrlsInMessage', 'sanitizeErrorText', 'sanitizePersistedText'];

/**
 * Indirect RPC adjacency (issue #2416).
 *
 * The triggers above are all *direct*: a file talks to viem itself, or has
 * already adopted the fix. Neither covers a route that reaches the chain only
 * through an injected reader — `discovery-endpoint.ts` takes a
 * `PluginPublicationReader` / `ArchiveReads`, `rewards-endpoint.ts` calls
 * `gather-status.js`, `admin-endpoint.ts` calls `intents/claim-rewards.js`.
 * Those routes leaked exactly the same key-in-path, and scoping them by the
 * masking helper alone would be circular: removing the fix would remove the
 * file from scope and the guard would go green on the regression it exists to
 * catch.
 *
 * So each entry below names a seam whose *implementation* reaches an RPC
 * client even though the seam's own module does not import viem. The listed
 * type/module names are the import-site spelling, which is what survives a
 * revert of the masking call.
 *
 * This list is the injected-port / fixture path: a type-only port often does
 * not import `viem`, so a graph walk cannot replace these names without
 * going green on a masking revert (issue #2416 / #4246). The live-tree
 * completeness check below is the staleness net for a *new* api file that
 * statically reaches `viem` through some other relative import.
 */
const INDIRECT_RPC_PATTERN =
  /PluginPublicationReader|ArchiveReads|gather-status\.js|intents\/claim-rewards\.js/;

const DIRECT_RPC_PATTERN = new RegExp(
  [
    "from\\s+['\"]viem(\\/[\\w.-]+)?['\"]",
    'createJinnPublicClient',
    'PublicClient',
    ...MASKED_CALL_MARKERS,
  ].join('|'),
);

/** A file is in scope when it reaches an RPC client directly or through a seam. */
export function isRpcAdjacent(text) {
  return DIRECT_RPC_PATTERN.test(text) || INDIRECT_RPC_PATTERN.test(text);
}

const RELATIVE_IMPORT_RE = /(?:from|import)\s+['"](\.\.?\/[^'"]+)['"]/g;
const VIEM_IMPORT_RE = /from\s+['"]viem(\/[\w.-]+)?['"]/;

/** Relative `from './x.js'` / `import './x.js'` specs; package names are ignored. */
export function parseRelativeImportSpecs(text) {
  const specs = [];
  const re = new RegExp(RELATIVE_IMPORT_RE.source, 'g');
  let match;
  while ((match = re.exec(text)) !== null) {
    specs.push(match[1]);
  }
  return specs;
}

function pathStaysUnderRoot(candidate, srcRoot) {
  const root = resolve(srcRoot);
  const resolved = resolve(candidate);
  return resolved === root || resolved.startsWith(`${root}/`);
}

function resolveRelativeModule(fromFile, spec, srcRoot) {
  const abs = resolve(dirname(fromFile), spec.split('?')[0]);
  const candidates = [];
  if (abs.endsWith('.js')) candidates.push(`${abs.slice(0, -3)}.ts`, abs);
  else {
    candidates.push(abs);
    if (!abs.endsWith('.ts')) {
      candidates.push(`${abs}.ts`, `${abs}.js`, join(abs, 'index.ts'));
    }
  }
  for (const candidate of candidates) {
    if (!pathStaysUnderRoot(candidate, srcRoot)) continue;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function isUnderApiRoot(absPath, srcRoot) {
  const apiRoot = resolve(srcRoot, 'api');
  const resolved = resolve(absPath);
  return resolved === apiRoot || resolved.startsWith(`${apiRoot}/`);
}

function fileImportsViem(text) {
  return VIEM_IMPORT_RE.test(text);
}

/**
 * One-hop destinations outside `api/` count only when they import the viem
 * *package root* (or an RPC client type/factory). `viem/accounts` is signing
 * material, not an RPC client — treating it as adjacency would pull
 * filesystem-only helpers such as `portfolio-v0-doctor.ts` into the leak net.
 */
const ONE_HOP_RPC_VIEM_RE =
  /from\s+['"]viem['"]|createJinnPublicClient|\bPublicClient\b/;

function fileImportsRpcViem(text) {
  return ONE_HOP_RPC_VIEM_RE.test(text);
}

/**
 * True when this file imports `viem`, a relative import *inside `srcRoot/api`*
 * does, or a *one-hop* import outside `api/` does.
 *
 * Recursing through `store.ts` / daemon modules would mark every Store-using
 * route as graph-adjacent (those trees eventually reach viem). Injected-port
 * files that never import viem stay out of this net on purpose —
 * `INDIRECT_RPC_PATTERN` covers them. Cycles are not a hit.
 */
export function moduleTouchesViem(
  absPath,
  srcRoot,
  cache = new Map(),
  visiting = new Set(),
) {
  if (cache.has(absPath)) return cache.get(absPath);
  if (visiting.has(absPath)) return false;
  visiting.add(absPath);
  let text;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    cache.set(absPath, false);
    return false;
  }
  if (fileImportsViem(text)) {
    cache.set(absPath, true);
    return true;
  }
  for (const spec of parseRelativeImportSpecs(text)) {
    const dest = resolveRelativeModule(absPath, spec, srcRoot);
    if (!dest) continue;
    if (isUnderApiRoot(dest, srcRoot)) {
      if (moduleTouchesViem(dest, srcRoot, cache, visiting)) {
        cache.set(absPath, true);
        return true;
      }
      continue;
    }
    // One hop outside api/: the destination file itself, not its imports.
    let destText;
    try {
      destText = readFileSync(dest, 'utf8');
    } catch {
      continue;
    }
    if (fileImportsRpcViem(destText)) {
      cache.set(absPath, true);
      return true;
    }
  }
  cache.set(absPath, false);
  return false;
}

/**
 * Live-tree staleness net: every api file that transitively imports `viem`
 * must already be `isRpcAdjacent`. Injected-port files that never import
 * `viem` are out of this net on purpose — `INDIRECT_RPC_PATTERN` covers them.
 */
export function findGraphCompletenessGaps(apiDir, srcRoot) {
  const gaps = [];
  const cache = new Map();
  for (const file of walk(apiDir)) {
    if (!moduleTouchesViem(file, srcRoot, cache)) continue;
    const text = readFileSync(file, 'utf8');
    if (isRpcAdjacent(text)) continue;
    const rel = relative(srcRoot, file).split('\\').join('/');
    gaps.push(`operator/src/${rel}`);
  }
  return gaps;
}

const RAW_MESSAGE_PATTERN = /\.message\b|String\(\s*(e|err|error)\w*\s*\)/;
const ALLOW_MARKER = 'lint:no-error-leak-allow';

/**
 * True when `line` is a raw error-to-string conversion this guard cares
 * about: not an inline-allowed line, and not itself a call through one of
 * the masking helpers (a *mention*, like a trailing comment, does not
 * count — `RAW_MESSAGE_PATTERN` must still match a bare `.message` sitting
 * next to it).
 */
function isRawHitLine(line) {
  if (line.includes(ALLOW_MARKER)) return false;
  if (MASKED_CALL_MARKERS.some((m) => line.includes(`${m}(`))) return false;
  return RAW_MESSAGE_PATTERN.test(line);
}

/** True when any line in `text` is a raw error-to-string conversion. */
function hasRawHit(text) {
  return text.split('\n').some(isRawHitLine);
}

/**
 * Non-RPC allowlist (issue #4246 review of PR #4663).
 *
 * `findGraphCompletenessGaps` closes the completeness gap for a file whose
 * *import graph* statically reaches viem. It cannot close the gap for a file
 * that reaches an RPC client only through an injected port — a structural
 * type like `PluginPublicationReader` / `ArchiveReads` with no import edge
 * to follow. `INDIRECT_RPC_PATTERN` names today's seams, but a *new* one
 * stays invisible to both nets until someone remembers to extend that list.
 *
 * `findRawHitCompletenessGaps` is the backstop: every `src/api/**\/*.ts` file
 * with a raw error-to-string conversion must be either `isRpcAdjacent` (and
 * so already flagged directly by `findErrorLeaks` if unmasked) or named here
 * with the reason it does not reach an RPC client. A new file that adds a
 * raw conversion and is neither fails the guard, forcing a human decision
 * instead of a silent pass. Each entry below was verified against the live
 * source at review time — re-verify before removing an entry's justification.
 */
const NON_RPC_API_ALLOWLIST = new Map([
  [
    'claim-policy-endpoints.ts',
    "zod issue.message from local claim-policy body validation; no RPC import",
  ],
  [
    'daemon-token.ts',
    'fs-only DAEMON_API_TOKEN keystore persistence failure message; no RPC import',
  ],
  [
    'harness-status-endpoint.ts',
    "deps.getStatus() (main.ts) hashes a local impl-state dir via hashImplStateDir; no RPC call",
  ],
  [
    'hermes-doctor-endpoint.ts',
    'fetch() to a literal OpenRouter URL with the key sent as a Bearer header, not in the URL',
  ],
  [
    'loop-completion-build.ts',
    "execFileSync('git', ...) local repo listing; not an RPC client",
  ],
  [
    'operator-artifacts-endpoint.ts',
    'local config-file read/write (readConfigFile/persistConfigValue) and Store reads; no RPC',
  ],
  [
    'portfolio-v0-doctor.ts',
    "loadApiWalletState uses viem/accounts (key signing material), not an RPC transport",
  ],
  [
    'stop-hook.ts',
    'zod issue.message from local stop-hook payload validation; no RPC import',
  ],
]);

/**
 * Backstop for the injected-port gap (issue #4246): every `src/api/**\/*.ts`
 * file with a raw error-to-string conversion must be either `isRpcAdjacent`
 * or named on `NON_RPC_API_ALLOWLIST`. Empty on a healthy live tree.
 */
export function findRawHitCompletenessGaps(apiDir, srcRoot) {
  const gaps = [];
  for (const file of walk(apiDir)) {
    const text = readFileSync(file, 'utf8');
    if (!hasRawHit(text)) continue;
    if (isRpcAdjacent(text)) continue;
    const rel = relative(apiDir, file).split('\\').join('/');
    if (NON_RPC_API_ALLOWLIST.has(rel)) continue;
    const reportedRel = relative(srcRoot, file).split('\\').join('/');
    gaps.push(`operator/src/${reportedRel}`);
  }
  return gaps;
}

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
    if (!isRpcAdjacent(text)) continue; // not RPC-adjacent — out of scope

    const rel = relative(srcRoot, file).split('\\').join('/');
    // Already routed through a choke point — the fix, not the leak. A *call*
    // is required, not a mention: `err.message, // masked by sanitizeErrorText`
    // must still be flagged. See `isRawHitLine`.
    text.split('\n').forEach((line, idx) => {
      if (isRawHitLine(line)) {
        violations.push({ file: `operator/src/${rel}`, line: idx + 1, snippet: line.trim() });
      }
    });
  }
  return violations;
}

// CLI entry only — importing this module (the guard's own tests do) must not
// walk the live tree or call process.exit.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // argv[1] names something unresolvable (an --eval shim, a deleted path).
    // Treat that as "imported", never as "run": a false positive here would
    // process.exit out of whatever imported us.
    return false;
  }
}

if (invokedDirectly()) main();

function main() {
  const gaps = findGraphCompletenessGaps(API_DIR, SRC_ROOT);
  if (gaps.length > 0) {
    console.error('✗ Graph-adjacent api/ files are not isRpcAdjacent (issue #4246).');
    console.error('  A new route that statically reaches viem needs a masking helper');
    console.error('  or an INDIRECT_RPC_PATTERN seam in the same change.\n');
    for (const file of gaps) console.error(`    ${file}`);
    process.exit(1);
  }

  const rawHitGaps = findRawHitCompletenessGaps(API_DIR, SRC_ROOT);
  if (rawHitGaps.length > 0) {
    console.error('✗ api/ files with a raw error-to-string conversion are neither isRpcAdjacent');
    console.error('  nor on the NON_RPC_API_ALLOWLIST (issue #4246).\n');
    console.error('  Route the conversion through a masking helper (or an INDIRECT_RPC_PATTERN');
    console.error('  seam), or add a named, justified NON_RPC_API_ALLOWLIST entry if the file');
    console.error('  genuinely never reaches an RPC client.\n');
    for (const file of rawHitGaps) console.error(`    ${file}`);
    process.exit(1);
  }

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
