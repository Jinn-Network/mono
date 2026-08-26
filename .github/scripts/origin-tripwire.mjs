#!/usr/bin/env node

/**
 * The standing guard on the identifier origin.
 *
 * Authority: DR-2026-08-04 (`log/decisions/2026-08-04-spec-origin-and-vocabulary.md`) moved
 * the protocol identifier origin from `https://jinn.network/` to `https://spec.jinn.network/`
 * (Decision 1: "Dedicated identifier origin"). Component C1 rewrote the documents; component
 * C2 closed the transition window and wired this module into CI. It is the reason the
 * narrowing stays narrow: a legacy origin reintroduced into an enforced source scope fails
 * the build.
 *
 * Run with no arguments it enforces (non-zero exit on any violation in an enforced scope).
 * Run with `--report` it prints the whole-tree census, exclusions included, and never fails.
 */

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The retired origin this tripwire watches for. Never confuse with the new
 * `https://spec.jinn.network/` origin -- see {@link matchesLegacyOrigin}. */
export const LEGACY_ORIGIN = 'https://jinn.network/';

/** Directory names skipped everywhere in the tree, regardless of depth. */
export const DEFAULT_SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git']);

/**
 * The scopes the tripwire *enforces*: the source trees a protocol identifier can actually be
 * minted from. Everything else in the repository is reported by `--report` but never fails a
 * build -- history, generated output, and the product website all legitimately name the apex.
 *
 * `packages/**` is narrowed to the three public-surface directory kinds, since a package's
 * `fixtures/` holds sealed pre-re-seal bytes that are never retro-edited.
 */
export const ENFORCED_SCOPE_PREFIXES = [
  '.github/scripts/',
  'operator/src/',
  'plugin/runtime/src/',
];
const ENFORCED_PACKAGE_DIRECTORIES = /\/(?:src|schemas|profiles)\//u;

/** True when `relativePath` sits in a scope the tripwire fails the build over. */
export function isEnforcedPath(relativePath) {
  if (ENFORCED_SCOPE_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) return true;
  return relativePath.startsWith('packages/') && ENFORCED_PACKAGE_DIRECTORIES.test(relativePath);
}

/**
 * Frozen strings that must never be rewritten or flagged, and the dated-record trees that
 * are never retro-edited (DR-2026-08-04 Decision 7 / Consequences: "pre-migration
 * content-addressed bytes are never retro-edited").
 *
 * Every entry carries its reason. The list is closed: `origin-tripwire.test.mjs` asserts it
 * matches exactly, so widening the hole is a reviewed edit rather than a quiet one.
 */
export const DEFAULT_EXCLUSIONS = {
  // Exact repository-relative paths.
  paths: [
    // -- The frozen wire carrier --
    // `bridge/legacy-execution-envelope/1.0`: a namespaced Delivery extension key
    // (DeliveryRecordSchema `.loose()` extension, TEP §21.3) negotiated with legacy
    // evaluators as a literal wire-format string. It is not a protocol identifier the re-seal
    // renames -- see DR-2026-08-04's "envelope" ruling (the *record*
    // `records/delivery-envelope/1.0` was renamed by the migration; this carrier key was not).
    'operator/src/daemon/bridge-legacy-delivery.ts',
    'packages/task-execution/backend-local/assembly/src/backend.evidence.test.ts',

    // -- The recognition machinery itself --
    // This module's own LEGACY_ORIGIN constant and the fixtures that prove it detects.
    '.github/scripts/origin-tripwire.mjs',
    '.github/scripts/origin-tripwire.test.mjs',
    // The per-document guard: it keeps the retired origin as a *candidate* identity so an
    // unmigrated document is rejected by name instead of passing as "declares nothing".
    '.github/scripts/public-surface-assets.mjs',
    '.github/scripts/public-surface-assets.test.mjs',

    // -- Legacy-rejection vectors --
    // Each of these asserts that a pre-re-seal spelling NO LONGER parses as a record kind.
    // The literal is the assertion; without it the narrowing has no regression test. The
    // authoritative grammar plus the six mirrors that copy it (those packages declare no
    // Jinn dependency and so cannot import `assertRecordKindUri`).
    'packages/discovery/protocol/src/grammar.test.ts',
    'packages/benchmarking/records/src/identifiers.test.ts',
    'packages/discovery/facts/benchmarking/src/identifiers.test.ts',
    'packages/environments/chain-record/src/identifiers.test.ts',
    'packages/environments/chain-record/src/primitives.test.ts',
    'packages/environments/information-world/src/identifiers.test.ts',
    'packages/environments/record/src/identifiers.test.ts',
    'packages/evidence/trace/src/vocabulary.test.ts',
  ],
  // Repository-relative directory prefixes (trailing slash), excluded wholesale.
  prefixes: [
    'spec/', // dated specification proposals
    'log/', // decision records (DRs), including DR-2026-08-04 itself
    'docs/press/', // published press releases
    'docs/superpowers/', // dated design specs and implementation plans
    'legacy/', // frozen legacy surface
  ],
};

function toPosix(value) {
  return value.split(sep).join('/');
}

/**
 * True when `line` contains the legacy origin as a literal substring. A plain substring
 * search is deliberate and sufficient: `https://spec.jinn.network/` never contains
 * `https://jinn.network/` as a contiguous substring (the character after `https://` is `s`,
 * not `j`), so the new canonical origin can never be mistaken for the retired one. Verified
 * by the "does not flag the canonical spec.jinn.network origin" test.
 */
export function matchesLegacyOrigin(line) {
  return typeof line === 'string' && line.includes(LEGACY_ORIGIN);
}

/** True when `relativePath` (repository-relative, posix separators) is excluded. */
export function isExcludedPath(relativePath, exclusions = DEFAULT_EXCLUSIONS) {
  if (exclusions.paths.includes(relativePath)) return true;
  return exclusions.prefixes.some((prefix) => relativePath.startsWith(prefix));
}

/**
 * True when `buffer` looks like a binary file (a NUL byte in the first sampled bytes), the
 * same cheap heuristic `git diff`/`grep` use. Binary-ish files are skipped rather than
 * decoded as UTF-8 text.
 */
function looksBinary(buffer) {
  const sampleSize = Math.min(buffer.length, 8000);
  for (let i = 0; i < sampleSize; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function walk(absoluteDirectory, skipDirectories, found) {
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue; // never follow symlinks
    const absolute = join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      if (skipDirectories.has(entry.name)) continue;
      walk(absolute, skipDirectories, found);
    } else if (entry.isFile()) {
      found.push(absolute);
    }
  }
  return found;
}

/**
 * Scan `scanRoots` (repository-relative directories, default the whole repo) under
 * `repoRoot` for literal `https://jinn.network/` occurrences, skipping anything covered by
 * `exclusions` or `skipDirectories`. Returns one entry per matching line:
 * `{ path, line, text }` where `path` is repository-relative (posix) and `line` is 1-based.
 *
 * Pure and offline: no network, no mutation, Node built-ins only.
 */
export function findLegacyOriginOccurrences({
  repoRoot,
  scanRoots = ['.'],
  exclusions = DEFAULT_EXCLUSIONS,
  skipDirectories = DEFAULT_SKIP_DIRECTORIES,
}) {
  const hits = [];
  for (const scanRoot of scanRoots) {
    const absoluteRoot = join(repoRoot, scanRoot);
    let stat;
    try {
      stat = lstatSync(absoluteRoot);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const absoluteFile of walk(absoluteRoot, skipDirectories, [])) {
      const relativePath = toPosix(relative(repoRoot, absoluteFile));
      if (isExcludedPath(relativePath, exclusions)) continue;
      const buffer = readFileSync(absoluteFile);
      if (looksBinary(buffer)) continue;
      const lines = buffer.toString('utf8').split(/\r?\n/u);
      lines.forEach((text, index) => {
        if (matchesLegacyOrigin(text)) {
          hits.push({ path: relativePath, line: index + 1, text });
        }
      });
    }
  }
  return hits.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

/** The subset of {@link findLegacyOriginOccurrences} that fails the build. */
export function findEnforcedScopeViolations(options) {
  return findLegacyOriginOccurrences(options).filter(({ path }) => isEnforcedPath(path));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();
  const hits = findLegacyOriginOccurrences({ repoRoot: root });
  if (args.includes('--report')) {
    console.log(`origin-tripwire: ${hits.length} occurrence(s) of ${LEGACY_ORIGIN} outside exclusions (report-only)`);
    for (const hit of hits) console.log(`  ${hit.path}:${hit.line}: ${hit.text.trim()}`);
  } else {
    const violations = hits.filter(({ path }) => isEnforcedPath(path));
    if (violations.length === 0) {
      console.log(`origin-tripwire: no ${LEGACY_ORIGIN} occurrences in the enforced source scopes`);
    } else {
      console.error(
        `origin-tripwire: ${violations.length} occurrence(s) of the retired ${LEGACY_ORIGIN} origin `
        + 'in enforced source scopes. Protocol identifiers moved to https://spec.jinn.network/ in '
        + 'the DR-2026-08-04 re-seal (log/decisions/2026-08-04-spec-origin-and-vocabulary.md). '
        + 'If the occurrence is deliberate -- a frozen wire carrier, or a vector proving the '
        + 'legacy spelling is rejected -- add it to DEFAULT_EXCLUSIONS with its reason.',
      );
      for (const hit of violations) console.error(`  ${hit.path}:${hit.line}: ${hit.text.trim()}`);
      process.exitCode = 1;
    }
  }
}
