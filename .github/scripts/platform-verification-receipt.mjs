#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { canonicalJsonBytes, catalogSha256 } from './build-prepublication-bundle.mjs';
import { buildProfileRoot } from './build-profile-root.mjs';
import {
  PLATFORM_CATALOG_PATH,
  loadCatalogPackages,
} from './platform-catalog.mjs';
import { buildDependencyGraph, topologicalWaves } from './stack-package-graph.mjs';
import { resolvePublishVersion } from './stack-publish-manifest.mjs';

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;

export const REQUIRED_VERIFICATION_GATES = Object.freeze([
  'catalog',
  'benchmarking',
  'record-discovery',
  'evidence',
  'marketplace',
  'task-execution',
  'trust',
  'artifacts',
  'external-consumer',
]);

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} ${path}: ${error?.message ?? String(error)}`);
  }
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sameSet(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && new Set(left).size === left.length
    && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function inside(child, parent) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`));
}

function validateConclusions(conclusions) {
  if (!conclusions || typeof conclusions !== 'object' || Array.isArray(conclusions)) {
    throw new Error('gate conclusions must be a named object');
  }
  for (const gate of REQUIRED_VERIFICATION_GATES) {
    if (!(gate in conclusions)) throw new Error(`missing required gate conclusion ${gate}`);
    if (conclusions[gate] !== 'success') {
      throw new Error(`gate ${gate} must be exact success, got ${String(conclusions[gate])}`);
    }
  }
  const extras = Object.keys(conclusions).filter((gate) => !REQUIRED_VERIFICATION_GATES.includes(gate));
  if (extras.length > 0) throw new Error(`unknown gate conclusions: ${extras.sort().join(', ')}`);
}

function requireManifestIdentity(manifest, label, { sourceSha, catalogDigest, releaseGroup, lane }) {
  if (manifest.sourceSha !== sourceSha) throw new Error(`${label} source SHA does not match the receipt input`);
  if (manifest.catalog?.sha256 !== catalogDigest) {
    throw new Error(`${label} catalog digest does not match the receipt input`);
  }
  if (manifest.releaseGroup !== releaseGroup) throw new Error(`${label} release group does not match the receipt input`);
  if (manifest.lane !== lane) throw new Error(`${label} lane does not match the receipt input`);
}

function expectedVersion(catalogPackages, lane, sourceSha) {
  const versions = new Set(catalogPackages.map(({ manifest }) => manifest.version));
  if (versions.size !== 1) throw new Error('catalog package versions disagree');
  const [baseVersion] = [...versions];
  return resolvePublishVersion({
    mode: lane,
    baseVersion,
    sha: sourceSha,
    ...(lane === 'stable' ? { releaseTag: `stack-v${baseVersion}` } : {}),
  });
}

function validatePackManifest(pack, packManifestPath, context) {
  requireManifestIdentity(pack, 'pack manifest', context);
  if (pack.schemaVersion !== 1) throw new Error('pack manifest schemaVersion must be 1');
  const graphPackages = context.catalogPackages.map(({ name, manifest }) => ({ name, manifest }));
  const expectedWaves = topologicalWaves(buildDependencyGraph(graphPackages));
  const expectedOrder = expectedWaves.flat();
  if (JSON.stringify(pack.waves) !== JSON.stringify(expectedWaves)
    || JSON.stringify(pack.packageOrder) !== JSON.stringify(expectedOrder)) {
    throw new Error('pack manifest package order/waves do not match the catalog runtime graph');
  }
  const version = expectedVersion(context.catalogPackages, context.lane, context.sourceSha);
  if (pack.packageVersion !== version.version || pack.distTag !== version.distTag) {
    throw new Error('pack manifest version/dist-tag do not match the selected lane and source');
  }
  if (!Array.isArray(pack.tarballs)
    || JSON.stringify(pack.tarballs.map(({ name }) => name)) !== JSON.stringify(expectedOrder)) {
    throw new Error('pack manifest tarballs do not match package order');
  }

  const packRoot = dirname(packManifestPath);
  for (const tarball of pack.tarballs) {
    if (typeof tarball.filename !== 'string' || !SRI_SHA512.test(String(tarball.integrity))) {
      throw new Error(`pack manifest has an invalid tarball record for ${tarball.name ?? '<missing>'}`);
    }
    const path = resolve(packRoot, ...tarball.filename.split('/'));
    if (!inside(path, packRoot) || !existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`pack manifest tarball is missing or escapes the bundle for ${tarball.name}`);
    }
    const integrity = `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;
    if (integrity !== tarball.integrity) throw new Error(`pack manifest integrity drift for ${tarball.name}`);
  }
  return { expectedWaves, expectedOrder, version };
}

function validatePublicManifest(publicManifest, context) {
  requireManifestIdentity(publicManifest, 'public surface manifest', context);
  if (publicManifest.schemaVersion !== 1) throw new Error('public surface manifest schemaVersion must be 1');
  const names = publicManifest.packages?.map(({ name }) => name);
  if (!sameSet(names, context.catalogNames)) {
    throw new Error(`public surface package set does not match ${context.releaseGroup}`);
  }
  const expected = context.catalogPackages.map(({ name, directory, catalog }) => ({
    name,
    path: directory,
    publicSurface: catalog.publicSurface,
  }));
  if (canonicalJsonBytes(publicManifest.packages) !== canonicalJsonBytes(expected)) {
    throw new Error('public surface manifest declarations drift from the checked-out catalog');
  }
}

function profileDocumentPath(profileRoot, path) {
  if (typeof path !== 'string' || path === '' || path.includes('\\')) {
    throw new Error('profile manifest document path must be a non-empty forward-slash path');
  }
  const absolute = resolve(profileRoot, ...path.split('/'));
  const normalized = relative(profileRoot, absolute).split(sep).join('/');
  if (!inside(absolute, profileRoot) || normalized !== path) {
    throw new Error(`profile manifest document path escapes the profile root: ${path}`);
  }
  return absolute;
}

function walkProfileRoot(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`profile root contains symbolic link ${path}`);
    if (entry.isDirectory()) files.push(...walkProfileRoot(absolute, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`profile root contains unsupported entry ${path}`);
  }
  return files.sort();
}

function expectedProfileManifest(context) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'jinn-expected-profile-root-'));
  try {
    return buildProfileRoot({
      repoRoot: context.repoRoot,
      outDir: temporaryRoot,
      commit: context.sourceSha,
      catalogDigest: context.catalogDigest,
      releaseGroup: context.releaseGroup,
      lane: context.lane,
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function validateProfileManifest(profileManifest, profileManifestPath, context) {
  if (profileManifest.generatedFrom?.commit !== context.sourceSha) {
    throw new Error('profile manifest source SHA does not match the receipt input');
  }
  if (profileManifest.catalog?.sha256 !== context.catalogDigest) {
    throw new Error('profile manifest catalog digest does not match the receipt input');
  }
  if (profileManifest.releaseGroup !== context.releaseGroup) {
    throw new Error('profile manifest release group does not match the receipt input');
  }
  if (profileManifest.lane !== context.lane) throw new Error('profile manifest lane does not match the receipt input');
  if (!sameSet(profileManifest.packages, context.catalogNames)) {
    throw new Error(`profile package set does not match ${context.releaseGroup}`);
  }
  if (!Array.isArray(profileManifest.documents)) throw new Error('profile manifest documents must be an array');
  const profileRoot = dirname(profileManifestPath);
  const documentPaths = new Set();
  for (const document of profileManifest.documents) {
    if (!context.catalogNames.includes(document.sourcePackage)) {
      throw new Error(`profile document ${document.path ?? '<missing>'} names an out-of-set source package`);
    }
    profileDocumentPath(profileRoot, document.path);
    if (documentPaths.has(document.path)) {
      throw new Error(`profile manifest repeats document path ${document.path}`);
    }
    documentPaths.add(document.path);
  }

  const expected = expectedProfileManifest(context);
  if (canonicalJsonBytes(profileManifest.documents) !== canonicalJsonBytes(expected.documents)) {
    throw new Error('profile manifest document inventory does not match the checked-out source');
  }

  const expectedFiles = new Set(['manifest.json', ...expected.documents.map(({ path }) => path)]);
  for (const path of walkProfileRoot(profileRoot)) {
    if (!expectedFiles.has(path)) throw new Error(`profile root contains unexpected file ${path}`);
  }
  for (const document of expected.documents) {
    const path = profileDocumentPath(profileRoot, document.path);
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error(`profile root is missing declared document ${document.path}`);
    }
    const digest = fileSha256(path);
    if (digest !== document.sha256) {
      throw new Error(`profile root document digest does not match manifest for ${document.path}`);
    }
  }
}

export function createVerificationReceipt({
  repoRoot,
  sourceSha,
  catalogDigest,
  releaseGroup,
  lane,
  packManifestPath,
  publicManifestPath,
  profileManifestPath,
  conclusions,
  outputPath,
}) {
  validateConclusions(conclusions);
  if (existsSync(outputPath)) throw new Error(`refusing to overwrite existing verification receipt ${outputPath}`);
  if (!COMMIT_SHA.test(String(sourceSha))) throw new Error('receipt source SHA must be a 40-character lowercase commit SHA');
  if (!SHA256.test(String(catalogDigest))) throw new Error('receipt catalog digest must be lowercase SHA-256');
  if (releaseGroup !== 'platform-v1') throw new Error(`receipt release group must be platform-v1, got ${releaseGroup}`);
  if (lane !== 'canary' && lane !== 'stable') throw new Error(`receipt lane must be canary or stable, got ${lane}`);

  const root = resolve(repoRoot);
  const actualCatalogDigest = catalogSha256(root);
  if (actualCatalogDigest !== catalogDigest) {
    throw new Error(`receipt catalog digest does not match the checked-out catalog: ${actualCatalogDigest}`);
  }
  const catalogPackages = loadCatalogPackages(root, { releaseGroup });
  const catalogNames = catalogPackages.map(({ name }) => name);
  if (catalogNames.length !== 50) throw new Error(`receipt requires exactly 50 ${releaseGroup} packages`);
  const context = {
    repoRoot: root,
    sourceSha,
    catalogDigest,
    releaseGroup,
    lane,
    catalogPackages,
    catalogNames,
  };

  const packPath = resolve(packManifestPath);
  const publicPath = resolve(publicManifestPath);
  const profilePath = resolve(profileManifestPath);
  const pack = readJson(packPath, 'pack manifest');
  const publicManifest = readJson(publicPath, 'public surface manifest');
  const profileManifest = readJson(profilePath, 'profile manifest');
  const { expectedWaves, expectedOrder, version } = validatePackManifest(pack, packPath, context);
  validatePublicManifest(publicManifest, context);
  validateProfileManifest(profileManifest, profilePath, context);

  const receipt = {
    schemaVersion: 1,
    sourceSha,
    catalog: { path: PLATFORM_CATALOG_PATH, sha256: catalogDigest },
    releaseGroup,
    lane,
    packageVersion: version.version,
    distTag: version.distTag,
    waves: expectedWaves,
    packageOrder: expectedOrder,
    prepublicationManifestSha256: fileSha256(packPath),
    tarballs: pack.tarballs,
    surfaces: {
      public: {
        manifestSha256: fileSha256(publicPath),
        packageCount: publicManifest.packages.length,
        packages: publicManifest.packages,
      },
      profile: {
        manifestSha256: fileSha256(profilePath),
        documentCount: profileManifest.documents.length,
        documents: profileManifest.documents,
      },
    },
    conclusions,
  };
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(resolve(outputPath), canonicalJsonBytes(receipt), 'utf8');
  return receipt;
}

function parseArgs(argv) {
  const parsed = {
    repoRoot: process.cwd(),
    releaseGroup: 'platform-v1',
    conclusions: {},
  };
  const fields = new Map([
    ['--root', 'repoRoot'],
    ['--source-sha', 'sourceSha'],
    ['--catalog-digest', 'catalogDigest'],
    ['--release-group', 'releaseGroup'],
    ['--lane', 'lane'],
    ['--pack-manifest', 'packManifestPath'],
    ['--public-manifest', 'publicManifestPath'],
    ['--profile-manifest', 'profileManifestPath'],
    ['--out', 'outputPath'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    if (flag === '--gate') {
      const equals = value.indexOf('=');
      if (equals <= 0) throw new Error('--gate requires name=conclusion');
      const name = value.slice(0, equals);
      if (name in parsed.conclusions) throw new Error(`duplicate gate conclusion ${name}`);
      parsed.conclusions[name] = value.slice(equals + 1);
    } else {
      const field = fields.get(flag);
      if (!field) throw new Error(`unknown argument: ${flag}`);
      parsed[field] = value;
    }
    index += 1;
  }
  for (const [field, flag] of [
    ['sourceSha', '--source-sha'],
    ['catalogDigest', '--catalog-digest'],
    ['lane', '--lane'],
    ['packManifestPath', '--pack-manifest'],
    ['publicManifestPath', '--public-manifest'],
    ['profileManifestPath', '--profile-manifest'],
    ['outputPath', '--out'],
  ]) {
    if (!parsed[field]) throw new Error(`${flag} is required`);
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const receipt = createVerificationReceipt(parseArgs(process.argv.slice(2)));
    console.log(`wrote verification receipt for ${receipt.sourceSha}`);
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
