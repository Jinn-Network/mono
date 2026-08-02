#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PLATFORM_CATALOG_PATH,
  loadCatalogPackages,
} from './platform-catalog.mjs';
import { packWave } from './publish-stack-run.mjs';
import { buildPublishPlan } from './publish-stack.mjs';

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const LANES = new Set(['canary', 'stable']);

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().flatMap((key) => (
      value[key] === undefined ? [] : [[key, canonicalValue(value[key])]]
    )));
  }
  return value;
}

export function canonicalJsonBytes(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function catalogSha256(repoRoot) {
  return createHash('sha256')
    .update(readFileSync(resolve(repoRoot, ...PLATFORM_CATALOG_PATH.split('/'))))
    .digest('hex');
}

function requireIdentity({ repoRoot, sourceSha, catalogDigest, releaseGroup, lane }) {
  if (!COMMIT_SHA.test(String(sourceSha))) {
    throw new Error('sourceSha must be a 40-character lowercase commit SHA');
  }
  if (!SHA256.test(String(catalogDigest))) {
    throw new Error('catalogDigest must be a lowercase SHA-256 digest');
  }
  const actualDigest = catalogSha256(repoRoot);
  if (catalogDigest !== actualDigest) {
    throw new Error(`catalog digest mismatch: expected ${catalogDigest}, checked out catalog is ${actualDigest}`);
  }
  if (releaseGroup !== 'platform-v1') {
    throw new Error(`prepublication supports the catalog-backed platform-v1 release group, got ${releaseGroup}`);
  }
  if (!LANES.has(lane)) throw new Error(`lane must be canary or stable, got ${lane ?? '<missing>'}`);
}

function stableReleaseTag(repoRoot, releaseGroup) {
  const versions = new Set(loadCatalogPackages(repoRoot, { releaseGroup })
    .map(({ manifest }) => manifest.version));
  if (versions.size !== 1) return undefined;
  return `stack-v${[...versions][0]}`;
}

function ensureFreshOutput(outDir) {
  mkdirSync(outDir, { recursive: true });
  const conflicts = ['manifest.json', 'tarballs'].filter((entry) => existsSync(join(outDir, entry)));
  if (conflicts.length > 0) {
    throw new Error(`prepublication output already contains ${conflicts.join(', ')}`);
  }
  const tarballsDir = join(outDir, 'tarballs');
  mkdirSync(tarballsDir);
  return tarballsDir;
}

function relativeFilename(outDir, tarball) {
  const filename = relative(outDir, tarball).split(sep).join('/');
  if (filename === '' || filename === '..' || filename.startsWith('../')) {
    throw new Error(`packed tarball escaped the caller output directory: ${tarball}`);
  }
  return filename;
}

export async function buildPrepublicationBundle({
  repoRoot,
  outDir,
  sourceSha,
  catalogDigest,
  releaseGroup = 'platform-v1',
  lane,
  exec,
}) {
  const root = resolve(repoRoot);
  const output = resolve(outDir);
  requireIdentity({ repoRoot: root, sourceSha, catalogDigest, releaseGroup, lane });

  const plan = buildPublishPlan({
    repoRoot: root,
    mode: lane,
    sha: sourceSha,
    releaseGroup,
    ...(lane === 'stable' ? { releaseTag: stableReleaseTag(root, releaseGroup) } : {}),
  });
  const packageOrder = plan.waves.flat().map(({ name }) => name);
  const catalogNames = loadCatalogPackages(root, { releaseGroup }).map(({ name }) => name).sort();
  if (new Set(packageOrder).size !== packageOrder.length) {
    throw new Error(`${releaseGroup} prepublication plan contains duplicate packages`);
  }
  const plannedNames = [...packageOrder].sort();
  if (JSON.stringify(catalogNames) !== JSON.stringify(plannedNames)) {
    throw new Error(`publish plan package set does not match catalog release group ${releaseGroup}`);
  }

  const tarballsDir = ensureFreshOutput(output);
  const artifacts = [];
  for (const wave of plan.waves) {
    artifacts.push(...await packWave(wave, {
      repoRoot: root,
      version: plan.version,
      gitHead: sourceSha,
      inSetNames: plan.inSetNames,
      tarballsDir,
      ...(exec ? { exec } : {}),
    }));
  }
  if (artifacts.length !== catalogNames.length
    || JSON.stringify(artifacts.map(({ name }) => name).sort()) !== JSON.stringify(catalogNames)) {
    throw new Error(
      `prepublication tarball set does not match catalog release group ${releaseGroup}`,
    );
  }

  const manifest = {
    schemaVersion: 1,
    sourceSha,
    catalog: { path: PLATFORM_CATALOG_PATH, sha256: catalogDigest },
    releaseGroup,
    lane,
    packageVersion: plan.version,
    distTag: plan.distTag,
    waves: plan.waves.map((wave) => wave.map(({ name }) => name)),
    packageOrder,
    tarballs: artifacts.map((artifact) => ({
      name: artifact.name,
      filename: relativeFilename(output, artifact.tarball),
      integrity: artifact.integrity,
    })),
  };
  writeFileSync(join(output, 'manifest.json'), canonicalJsonBytes(manifest), 'utf8');
  return manifest;
}

function parseArgs(argv) {
  const parsed = {
    repoRoot: process.cwd(),
    releaseGroup: 'platform-v1',
  };
  const flags = new Map([
    ['--root', 'repoRoot'],
    ['--out', 'outDir'],
    ['--source-sha', 'sourceSha'],
    ['--catalog-digest', 'catalogDigest'],
    ['--release-group', 'releaseGroup'],
    ['--lane', 'lane'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = flags.get(argv[index]);
    if (!field) throw new Error(`unknown argument: ${argv[index]}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argv[index]} requires a value`);
    parsed[field] = value;
    index += 1;
  }
  for (const [field, flag] of [
    ['outDir', '--out'],
    ['sourceSha', '--source-sha'],
    ['catalogDigest', '--catalog-digest'],
    ['lane', '--lane'],
  ]) {
    if (!parsed[field]) throw new Error(`${flag} is required`);
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const manifest = await buildPrepublicationBundle(args);
    console.log(
      `packed ${manifest.tarballs.length} ${manifest.releaseGroup} packages at ${manifest.packageVersion}`
      + ` into ${resolve(args.outDir)}`,
    );
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
