#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { discoverStackPackages } from './stack-package-graph.mjs';
import { FIXTURE_MANIFEST_NAME, readFixtureManifest } from './fixture-manifest.mjs';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function compareFixtureManifests(baseline, candidate, { label }) {
  const candidateById = new Map(candidate.entries.map((entry) => [entry.id, entry.sha256]));
  for (const entry of baseline.entries) {
    if (!candidateById.has(entry.id)) {
      throw new Error(`${label}: ${entry.id} was removed; fixtures are append-only`);
    }
    const actual = candidateById.get(entry.id);
    if (actual !== entry.sha256) {
      throw new Error(
        `${label}: ${entry.id} changed from ${entry.sha256} to ${actual}; a published fixture is never edited, `
        + 'it is superseded by a new fixture plus a dated erratum',
      );
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
  return { added: candidate.entries.map((entry) => entry.id).filter((id) => !baselineIds.has(id)) };
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

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = process.argv.slice(2);
    const base = args[args.indexOf('--base') + 1];
    const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();
    if (!args.includes('--base') || !base) throw new Error('--base <git-ref> is required');
    let checked = 0;
    const additions = [];
    for (const pkg of discoverStackPackages(root)) {
      const candidate = readFixtureManifest(join(root, pkg.directory));
      if (candidate === null) continue;
      const baseline = readManifestAtRef(base, pkg.directory);
      if (baseline === null) continue;
      const { added } = compareFixtureManifests(baseline, candidate, { label: pkg.directory });
      checked += 1;
      if (added.length > 0) additions.push(`${pkg.directory}: +${added.join(', +')}`);
    }
    console.log(`fixture immutability holds across ${checked} packages against ${base}`);
    if (additions.length > 0) {
      console.log(`fixture additions in this change (each needs a minor bump and a changelog note):\n  ${additions.join('\n  ')}`);
    }
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
