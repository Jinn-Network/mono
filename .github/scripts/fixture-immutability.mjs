#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverStackPackages } from './stack-package-graph.mjs';
import { FIXTURE_MANIFEST_NAME, readFixtureManifest } from './fixture-manifest.mjs';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

// TEMPORARY -- REMOVED BY COMPONENT C2 OF THE DevX RE-SEAL PROGRAM (#2396).
//
// DR-2026-08-04 (log/decisions/2026-08-04-spec-origin-and-vocabulary.md, §Consequences)
// authorizes exactly one pre-publication fixture-manifest regeneration: the re-seal moves
// the protocol identifier origin to spec.jinn.network and the version convention to
// major-only /v1, which changes the bytes of already-sealed fixtures. The immutability law
// binds *published* identifiers, and none of these has ever been published -- that is the
// whole ground on which the DR permits this, and it is why the carve-out is single-use.
//
// What it does NOT relax: id removals stay forbidden. Fixture ids remain append-only
// through the re-seal, so the migration can rewrite bytes but cannot quietly drop a case.
//
// The flag is not a default anywhere. It is applied only on `reseal/*` branches, by an
// explicit condition in .github/workflows/stack-fixture-immutability.yml, and C2 deletes
// the flag, this constant, and that condition once the re-seal waves have landed.
export const RESEAL_DR_ID = 'DR-2026-08-04';

/**
 * Parses the `--allow-reseal <dr-id>` argument. Absent -> false (today's behavior).
 * Present with exactly the authorizing DR id -> true. Anything else is an error: a
 * misspelled or invented authorization must fail loudly, never fall through to a bypass.
 */
export function parseResealAuthorization(value) {
  if (value === undefined) return false;
  if (value !== RESEAL_DR_ID) {
    throw new Error(
      `--allow-reseal only authorizes ${RESEAL_DR_ID}; got ${value === '' ? '(empty)' : value}`,
    );
  }
  return true;
}

export function compareFixtureManifests(baseline, candidate, { label, allowReseal = false }) {
  const candidateById = new Map(candidate.entries.map((entry) => [entry.id, entry.sha256]));
  const resealed = [];
  for (const entry of baseline.entries) {
    if (!candidateById.has(entry.id)) {
      throw new Error(`${label}: ${entry.id} was removed; fixtures are append-only`);
    }
    const actual = candidateById.get(entry.id);
    if (actual !== entry.sha256) {
      if (!allowReseal) {
        throw new Error(
          `${label}: ${entry.id} changed from ${entry.sha256} to ${actual}; a published fixture is never edited, `
          + 'it is superseded by a new fixture plus a dated erratum',
        );
      }
      // Reported, never silent: a re-sealed digest is the one thing this gate exists to
      // notice, so the carve-out surfaces it in the run output rather than swallowing it.
      resealed.push(entry.id);
    }
  }
  const candidateErrata = new Map(candidate.errata.map((erratum) => [erratum.id, erratum]));
  for (const erratum of baseline.errata) {
    if (!candidateErrata.has(erratum.id)) {
      throw new Error(`${label}: erratum for ${erratum.id} was removed; errata are append-only`);
    }
  }
  for (const erratum of candidate.errata) {
    if (!candidateById.has(erratum.id)) {
      throw new Error(`${label}: erratum names ${erratum.id}, which is not a fixture in this manifest`);
    }
    if (!candidateById.has(erratum.supersededBy)) {
      throw new Error(`${label}: erratum for ${erratum.id} names supersededBy ${erratum.supersededBy}, which is not a fixture in this manifest`);
    }
    if (!ISO_DATE.test(String(erratum.date))) {
      throw new Error(`${label}: erratum for ${erratum.id} needs an ISO date (YYYY-MM-DD), got ${erratum.date}`);
    }
    if (typeof erratum.reason !== 'string' || erratum.reason.trim() === '') {
      throw new Error(`${label}: erratum for ${erratum.id} needs a non-empty reason`);
    }
  }
  const baselineIds = new Set(baseline.entries.map((entry) => entry.id));
  return {
    added: candidate.entries.map((entry) => entry.id).filter((id) => !baselineIds.has(id)),
    resealed,
  };
}

export function readManifestAtRef(ref, packageDirectory, { exec = defaultGit } = {}) {
  const path = `${packageDirectory}/fixtures/${FIXTURE_MANIFEST_NAME}`;
  const result = exec(['show', `${ref}:${path}`]);
  if (result.status !== 0) return null;
  const manifest = JSON.parse(result.stdout);
  return { version: manifest.version ?? 1, entries: manifest.entries ?? [], errata: manifest.errata ?? [] };
}

function defaultGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
}

function parseSemver(version, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(String(version));
  if (!match) throw new Error(`${label}: ${version} is not a semver`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function assertMinorBump(publishedVersion, candidateVersion, { label, added }) {
  const published = parseSemver(publishedVersion, label);
  const candidate = parseSemver(candidateVersion, label);
  const publishedRank = [published.major, published.minor, published.patch];
  const candidateRank = [candidate.major, candidate.minor, candidate.patch];
  const identical = candidateRank.every((value, index) => value === publishedRank[index]);
  const ahead = candidateRank.some((value, index) => value > publishedRank[index]
    && candidateRank.slice(0, index).every((earlier, i) => earlier === publishedRank[i]));
  // A candidate re-publishing the exact version already on the registry is the
  // documented stable-lane recovery path (a failed multi-package publish is safe
  // to re-run; docs/runbooks/stack-npm-publishing.md #Recovery). It adds no
  // fixture and protects nothing, so the ahead-of-latest requirement does not
  // apply here. This is not a bypass of the append-only half: compareFixtureManifests
  // already ran against this same baseline and would have thrown on any digest
  // mismatch or removal before assertMinorBump is ever reached.
  if (!ahead && !identical) {
    throw new Error(`${label}: candidate ${candidateVersion} is not ahead of the published ${publishedVersion}`);
  }
  if (added.length === 0) return;
  const bumped = candidate.major > published.major || candidate.minor > published.minor;
  if (!bumped) {
    throw new Error(
      `${label}: ${added.length} fixture added since ${publishedVersion} (${added.join(', ')}); `
      + `a fixture addition is at least a minor bump, but ${candidateVersion} keeps minor ${published.minor}`,
    );
  }
}

export function readManifestFromRegistry(name, { exec = defaultNpm, npmCommand = 'npm' } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'jinn-fixture-registry-'));
  try {
    const packed = exec(npmCommand, ['pack', `${name}@latest`, '--json', '--pack-destination', workDir], workDir);
    if (packed.status !== 0) return null;
    const [entry] = JSON.parse(packed.stdout);
    const extracted = exec('tar', ['-xzf', join(workDir, entry.filename), '-C', workDir], workDir);
    if (extracted.status !== 0) return null;
    let bytes;
    try {
      bytes = readFileSync(join(workDir, 'package', 'fixtures', FIXTURE_MANIFEST_NAME), 'utf8');
    } catch {
      return null;
    }
    const manifest = JSON.parse(bytes);
    return {
      version: entry.version,
      manifest: { version: manifest.version ?? 1, entries: manifest.entries ?? [], errata: manifest.errata ?? [] },
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function defaultNpm(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function runRegistryBaseline(root, candidateVersion) {
  let checked = 0;
  for (const pkg of discoverStackPackages(root)) {
    const candidate = readFixtureManifest(join(root, pkg.directory));
    if (candidate === null) continue;
    const published = readManifestFromRegistry(pkg.name);
    if (published === null) {
      console.log(`${pkg.directory}: no published latest yet; nothing to protect`);
      continue;
    }
    const { added } = compareFixtureManifests(published.manifest, candidate, { label: pkg.directory });
    assertMinorBump(published.version, candidateVersion, { label: pkg.directory, added });
    checked += 1;
  }
  console.log(`fixture immutability holds against the published registry set across ${checked} packages`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = process.argv.slice(2);
    const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();
    // See RESEAL_DR_ID above -- single-use, branch-gated in CI, deleted by C2. A bare
    // `--allow-reseal` with no value reaches parseResealAuthorization as '' and is refused;
    // the flag never authorizes anything by its mere presence.
    const resealIndex = args.indexOf('--allow-reseal');
    const allowReseal = parseResealAuthorization(
      resealIndex === -1 ? undefined : (args[resealIndex + 1] ?? ''),
    );
    if (allowReseal && args.includes('--registry-baseline')) {
      throw new Error(`--allow-reseal is a pre-publication carve-out (${RESEAL_DR_ID}); it does not apply to the registry baseline`);
    }
    if (args.includes('--registry-baseline')) {
      const version = args[args.indexOf('--version') + 1];
      if (!args.includes('--version') || !version) throw new Error('--version <candidate-version> is required');
      runRegistryBaseline(root, version);
    } else {
      const base = args[args.indexOf('--base') + 1];
      if (!args.includes('--base') || !base) throw new Error('--base <git-ref> is required');
      let checked = 0;
      const additions = [];
      const reseals = [];
      for (const pkg of discoverStackPackages(root)) {
        const candidate = readFixtureManifest(join(root, pkg.directory));
        if (candidate === null) continue;
        const baseline = readManifestAtRef(base, pkg.directory);
        if (baseline === null) continue;
        const { added, resealed } = compareFixtureManifests(baseline, candidate, {
          label: pkg.directory,
          allowReseal,
        });
        checked += 1;
        if (added.length > 0) additions.push(`${pkg.directory}: +${added.join(', +')}`);
        if (resealed.length > 0) reseals.push(`${pkg.directory}: ${resealed.join(', ')}`);
      }
      console.log(`fixture immutability holds across ${checked} packages against ${base}`);
      if (additions.length > 0) {
        console.log(`fixture additions in this change (each needs a minor bump and a changelog note):\n  ${additions.join('\n  ')}`);
      }
      if (reseals.length > 0) {
        console.log(`${RESEAL_DR_ID} re-sealed fixture digests (carve-out active):\n  ${reseals.join('\n  ')}`);
      }
    }
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
