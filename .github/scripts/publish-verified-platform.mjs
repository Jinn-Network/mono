#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  canonicalJsonBytes,
  catalogSha256,
} from './build-prepublication-bundle.mjs';
import { createVerificationReceipt } from './platform-verification-receipt.mjs';
import { loadPublishableCatalogPackages } from './platform-catalog.mjs';
import { renderRegistrationMarkdown } from './stack-trusted-publishers.mjs';

export const NPM_REGISTRY = 'https://registry.npmjs.org/';
export const TRUSTED_REPOSITORY = 'Jinn-Network/mono';

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const NOT_FOUND = Symbol('not-found');
const REGISTRATION_KEYS = [
  'allowedActions',
  'environment',
  'organization',
  'package',
  'provider',
  'repository',
  'workflow',
];
const DEFAULT_REGISTRY_RETRY_ATTEMPTS = Number.parseInt(
  process.env.JINN_NPM_REGISTRY_RETRY_ATTEMPTS ?? '12',
  10,
);
const DEFAULT_REGISTRY_RETRY_DELAY_MS = Number.parseInt(
  process.env.JINN_NPM_REGISTRY_RETRY_DELAY_MS ?? '5000',
  10,
);

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

function publicationEnv() {
  const env = { ...process.env };
  delete env.NODE_AUTH_TOKEN;
  delete env.NPM_TOKEN;
  return env;
}

function defaultSleep(ms) {
  if (ms <= 0) return;
  spawnSync('sleep', [String(Math.max(1, Math.ceil(ms / 1000)))], { stdio: 'ignore' });
}

export function defaultExec(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: publicationEnv(),
  });
  return {
    status: result.error ? 1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

function requireSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label}: ${(result.stderr || result.stdout || `status ${result.status}`).trim()}`);
  }
  return result;
}

function inside(child, parent) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`));
}

function walkFiles(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`prepublication bundle contains symbolic link ${path}`);
    if (entry.isDirectory()) files.push(...walkFiles(absolute, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`prepublication bundle contains unsupported entry ${path}`);
  }
  return files.sort();
}

function validatePackInventory(packRoot, receipt) {
  const expected = ['manifest.json', ...receipt.tarballs.map(({ filename }) => filename)].sort();
  const actual = walkFiles(packRoot);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('prepublication tarball inventory does not exactly match the verification receipt');
  }
}

function tarballPath(packRoot, filename) {
  const path = resolve(packRoot, ...filename.split('/'));
  if (!inside(path, packRoot)) throw new Error(`verification receipt tarball escapes pack root: ${filename}`);
  return path;
}

function reconstructVerificationReceipt({
  repoRoot,
  verificationRoot,
  verificationReceiptPath,
  sourceSha,
  releaseGroup,
  lane,
}) {
  const receipt = readJson(verificationReceiptPath, 'verification receipt');
  const packManifestPath = join(verificationRoot, 'pack/manifest.json');
  const publicManifestPath = join(verificationRoot, 'public-surface-manifest.json');
  const profileManifestPath = join(verificationRoot, 'profile-root/manifest.json');
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'jinn-publication-receipt-check-'));
  const expectedPath = join(temporaryRoot, 'verification-receipt.json');
  try {
    createVerificationReceipt({
      repoRoot,
      sourceSha,
      catalogDigest: catalogSha256(repoRoot),
      releaseGroup,
      lane,
      packManifestPath,
      publicManifestPath,
      profileManifestPath,
      conclusions: receipt.conclusions,
      outputPath: expectedPath,
    });
    if (readFileSync(expectedPath, 'utf8') !== readFileSync(verificationReceiptPath, 'utf8')) {
      throw new Error('verification receipt does not match the independently reconstructed receipt');
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  validatePackInventory(join(verificationRoot, 'pack'), receipt);
  return {
    receipt,
    packManifestPath,
    publicManifestPath,
    profileManifestPath,
  };
}

function provenanceSubjects({
  receipt,
  verificationRoot,
  verificationReceiptPath,
  packManifestPath,
  publicManifestPath,
  profileManifestPath,
  trustedPublishersJsonPath,
  trustedPublishersMarkdownPath,
}) {
  const packRoot = join(verificationRoot, 'pack');
  const profileRoot = join(verificationRoot, 'profile-root');
  const subjects = [
    packManifestPath,
    ...receipt.tarballs.map(({ filename }) => tarballPath(packRoot, filename)),
    publicManifestPath,
    profileManifestPath,
    ...receipt.surfaces.profile.documents.map(({ path }) => resolve(profileRoot, ...path.split('/'))),
    trustedPublishersJsonPath,
    trustedPublishersMarkdownPath,
    verificationReceiptPath,
  ];
  if (new Set(subjects).size !== subjects.length) {
    throw new Error('provenance subject list contains duplicate paths');
  }
  for (const subject of subjects) {
    if (!existsSync(subject)) throw new Error(`provenance subject is missing: ${subject}`);
  }
  return subjects;
}

function validateTrustedPublishers(verificationRoot, receipt, catalogNames) {
  const trustedPublishersJsonPath = join(
    verificationRoot,
    'trusted-publishers/trusted-publishers.json',
  );
  const trustedPublishersMarkdownPath = join(
    verificationRoot,
    'trusted-publishers/trusted-publishers.md',
  );
  const registrations = readJson(trustedPublishersJsonPath, 'trusted-publisher registration JSON');
  if (!Array.isArray(registrations)) {
    throw new Error('trusted-publisher registration JSON must be an array');
  }
  const names = registrations.map((registration) => registration?.package);
  if (new Set(names).size !== names.length
    || JSON.stringify([...names].sort()) !== JSON.stringify([...catalogNames].sort())
    || JSON.stringify([...names].sort()) !== JSON.stringify([...receipt.packageOrder].sort())) {
    throw new Error('trusted-publisher package set does not exactly match the catalog and verification receipt');
  }
  for (const registration of registrations) {
    if (JSON.stringify(Object.keys(registration).sort()) !== JSON.stringify(REGISTRATION_KEYS)) {
      throw new Error(`trusted-publisher registration fields drifted for ${registration?.package ?? '<missing>'}`);
    }
    if (registration.provider !== 'GitHub Actions'
      || registration.organization !== 'Jinn-Network'
      || registration.repository !== 'mono'
      || registration.workflow !== 'stack-npm-publish.yml'
      || registration.environment !== 'npm-publish'
      || JSON.stringify(registration.allowedActions) !== '["npm publish"]') {
      throw new Error(`trusted-publisher identity drifted for ${registration.package}`);
    }
  }
  let markdown;
  try {
    markdown = readFileSync(trustedPublishersMarkdownPath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read trusted-publisher registration Markdown: ${error?.message ?? String(error)}`);
  }
  if (markdown !== renderRegistrationMarkdown(registrations)) {
    throw new Error('trusted-publisher registration Markdown does not match the validated JSON');
  }
  return {
    trustedPublishersJsonPath,
    trustedPublishersMarkdownPath,
    receiptBinding: {
      registrationCount: registrations.length,
      jsonSha256: fileSha256(trustedPublishersJsonPath),
      markdownSha256: fileSha256(trustedPublishersMarkdownPath),
    },
  };
}

function registryStateError(message, retryable = false) {
  const error = new Error(message);
  error.retryableRegistryPropagation = retryable;
  return error;
}

function verifyProvenance(subjects, { exec, repoRoot, repository, sourceSha }) {
  const signerWorkflow = `${repository}/.github/workflows/platform-verification.yml`;
  for (const subject of subjects) {
    requireSuccess(
      exec('gh', [
        'attestation',
        'verify',
        subject,
        '--repo',
        repository,
        '--signer-workflow',
        signerWorkflow,
        '--source-digest',
        sourceSha,
      ], repoRoot),
      `attestation verification failed for ${subject}`,
    );
  }
}

function registryValue(target, field, {
  exec,
  repoRoot,
  registry,
  allowNotFound,
  phase,
}) {
  const args = ['view', target, field, '--json', '--registry', registry];
  const result = exec('npm', args, repoRoot);
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (allowNotFound && /\bE404\b|404 Not Found/u.test(output)) return NOT_FOUND;
    throw registryStateError(
      `${phase} registry query failed for ${target} ${field}: ${output.trim()}`,
      /\bE404\b|404 Not Found/u.test(output),
    );
  }
  if (result.stdout.trim() === '') {
    throw registryStateError(`${phase} registry ${field} is missing for ${target}`, true);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${phase} registry returned invalid JSON for ${target} ${field}: ${error?.message ?? String(error)}`);
  }
}

function inspectRegistry(tarball, receipt, context, { allowMissing, phase }) {
  const spec = `${tarball.name}@${receipt.packageVersion}`;
  const version = registryValue(spec, 'version', {
    ...context,
    allowNotFound: allowMissing,
    phase,
  });
  if (version === NOT_FOUND) return null;
  if (version !== receipt.packageVersion) {
    throw new Error(`${phase} version mismatch for ${tarball.name}: expected ${receipt.packageVersion}, got ${String(version)}`);
  }
  const integrity = registryValue(spec, 'dist.integrity', {
    ...context,
    allowNotFound: false,
    phase,
  });
  if (integrity !== tarball.integrity) {
    throw new Error(`${phase} integrity mismatch for ${spec}: receipt ${tarball.integrity}, registry ${String(integrity)}`);
  }
  const taggedVersion = registryValue(tarball.name, `dist-tags.${receipt.distTag}`, {
    ...context,
    allowNotFound: false,
    phase,
  });
  if (taggedVersion !== receipt.packageVersion) {
    throw registryStateError(
      `${phase} ${receipt.distTag} mismatch for ${tarball.name}: expected ${receipt.packageVersion}, got ${String(taggedVersion)}`,
      true,
    );
  }
  return {
    name: tarball.name,
    version,
    integrity,
    distTag: receipt.distTag,
    taggedVersion,
  };
}

function verifyPublishedTarball(tarball, receipt, context, {
  registryRetryAttempts,
  registryRetryDelayMs,
  sleep,
}) {
  for (let attempt = 1; attempt <= registryRetryAttempts; attempt += 1) {
    try {
      return inspectRegistry(tarball, receipt, context, {
        allowMissing: false,
        phase: 'post-publish',
      });
    } catch (error) {
      if (!error?.retryableRegistryPropagation || attempt === registryRetryAttempts) throw error;
      sleep(registryRetryDelayMs);
    }
  }
  throw new Error('unreachable registry propagation retry state');
}

function publishMissingTarballs(receipt, missing, {
  exec,
  repoRoot,
  registry,
  verificationRoot,
  registryRetryAttempts,
  registryRetryDelayMs,
  sleep,
}) {
  const packRoot = join(verificationRoot, 'pack');
  const tarballs = new Map(receipt.tarballs.map((tarball) => [tarball.name, tarball]));
  const registryContext = { exec, repoRoot, registry };
  for (const wave of receipt.waves) {
    for (const name of wave) {
      if (!missing.has(name)) continue;
      const tarball = tarballs.get(name);
      requireSuccess(
        exec('npm', [
          'publish',
          tarballPath(packRoot, tarball.filename),
          '--access',
          'public',
          '--provenance',
          '--tag',
          receipt.distTag,
          '--registry',
          registry,
        ], repoRoot),
        `npm publication failed for ${name}@${receipt.packageVersion}`,
      );
      verifyPublishedTarball(tarball, receipt, registryContext, {
        registryRetryAttempts,
        registryRetryDelayMs,
        sleep,
      });
    }
  }
}

function validateArguments({
  sourceSha,
  releaseGroup,
  lane,
  registry,
  repository,
  outputPath,
  registryRetryAttempts,
  registryRetryDelayMs,
}) {
  if (!COMMIT_SHA.test(String(sourceSha))) {
    throw new Error('publication source SHA must be a 40-character lowercase commit SHA');
  }
  if (releaseGroup !== 'platform-v1') {
    throw new Error(`publication release group must be platform-v1, got ${releaseGroup}`);
  }
  if (lane !== 'canary') throw new Error(`publication lane must be canary, got ${lane}`);
  if (registry !== NPM_REGISTRY) {
    throw new Error(`publication registry must be exactly ${NPM_REGISTRY}, got ${registry}`);
  }
  if (repository !== TRUSTED_REPOSITORY) {
    throw new Error(`publication repository must be exactly ${TRUSTED_REPOSITORY}, got ${repository}`);
  }
  if (!Number.isSafeInteger(registryRetryAttempts) || registryRetryAttempts < 1) {
    throw new Error('registry retry attempts must be a positive integer');
  }
  if (!Number.isSafeInteger(registryRetryDelayMs) || registryRetryDelayMs < 0) {
    throw new Error('registry retry delay must be a non-negative integer');
  }
  if (existsSync(outputPath)) {
    throw new Error(`refusing to overwrite existing publication receipt ${outputPath}`);
  }
}

export async function publishVerifiedPlatform(options) {
  const {
    repoRoot,
    verificationRoot,
    verificationReceiptPath,
    sourceSha,
    releaseGroup,
    lane,
    registry,
    repository,
    outputPath,
    exec = defaultExec,
    registryRetryAttempts = DEFAULT_REGISTRY_RETRY_ATTEMPTS,
    registryRetryDelayMs = DEFAULT_REGISTRY_RETRY_DELAY_MS,
    sleep = defaultSleep,
  } = options;
  const root = resolve(repoRoot);
  const artifactRoot = resolve(verificationRoot);
  const receiptPath = resolve(verificationReceiptPath);
  const publicationReceiptPath = resolve(outputPath);
  validateArguments({
    sourceSha,
    releaseGroup,
    lane,
    registry,
    repository,
    outputPath: publicationReceiptPath,
    registryRetryAttempts,
    registryRetryDelayMs,
  });

  const validated = reconstructVerificationReceipt({
    repoRoot: root,
    verificationRoot: artifactRoot,
    verificationReceiptPath: receiptPath,
    sourceSha,
    releaseGroup,
    lane,
  });
  const { receipt } = validated;
  const catalogNames = loadPublishableCatalogPackages(root, { releaseGroup, lane })
    .map(({ name }) => name);
  if (receipt.packageOrder.length !== receipt.tarballs.length
    || JSON.stringify([...receipt.packageOrder].sort()) !== JSON.stringify([...catalogNames].sort())) {
    throw new Error('verified canary publication package and tarball sets must match the catalog');
  }
  const trustedPublishers = validateTrustedPublishers(artifactRoot, receipt, catalogNames);
  verifyProvenance(provenanceSubjects({
    ...validated,
    ...trustedPublishers,
    verificationRoot: artifactRoot,
    verificationReceiptPath: receiptPath,
  }), {
    exec,
    repoRoot: root,
    repository,
    sourceSha,
  });

  const registryContext = { exec, repoRoot: root, registry };
  const missing = new Set();
  for (const tarball of receipt.tarballs) {
    const existing = inspectRegistry(tarball, receipt, registryContext, {
      allowMissing: true,
      phase: 'preflight',
    });
    if (existing === null) missing.add(tarball.name);
  }
  publishMissingTarballs(receipt, missing, {
    exec,
    repoRoot: root,
    registry,
    verificationRoot: artifactRoot,
    registryRetryAttempts,
    registryRetryDelayMs,
    sleep,
  });

  const observedRegistry = receipt.tarballs.map((tarball) => inspectRegistry(
    tarball,
    receipt,
    registryContext,
    { allowMissing: false, phase: 'final' },
  ));
  const publicationReceipt = {
    schemaVersion: 1,
    verificationReceiptSha256: fileSha256(receiptPath),
    sourceSha: receipt.sourceSha,
    catalog: receipt.catalog,
    releaseGroup: receipt.releaseGroup,
    lane: receipt.lane,
    packageVersion: receipt.packageVersion,
    distTag: receipt.distTag,
    waves: receipt.waves,
    packageOrder: receipt.packageOrder,
    npm: { registry },
    trustedPublishers: trustedPublishers.receiptBinding,
    observedRegistry,
  };
  mkdirSync(dirname(publicationReceiptPath), { recursive: true });
  writeFileSync(publicationReceiptPath, canonicalJsonBytes(publicationReceipt), 'utf8');
  return publicationReceipt;
}

function parseArgs(argv) {
  const parsed = {
    repoRoot: process.cwd(),
    releaseGroup: 'platform-v1',
    lane: 'canary',
    registry: NPM_REGISTRY,
  };
  const fields = new Map([
    ['--root', 'repoRoot'],
    ['--verification-root', 'verificationRoot'],
    ['--verification-receipt', 'verificationReceiptPath'],
    ['--source-sha', 'sourceSha'],
    ['--release-group', 'releaseGroup'],
    ['--lane', 'lane'],
    ['--registry', 'registry'],
    ['--repository', 'repository'],
    ['--out', 'outputPath'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const field = fields.get(flag);
    if (!field) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    parsed[field] = value;
    index += 1;
  }
  for (const [field, flag] of [
    ['verificationRoot', '--verification-root'],
    ['verificationReceiptPath', '--verification-receipt'],
    ['sourceSha', '--source-sha'],
    ['repository', '--repository'],
    ['outputPath', '--out'],
  ]) {
    if (!parsed[field]) throw new Error(`${flag} is required`);
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const receipt = await publishVerifiedPlatform(parseArgs(process.argv.slice(2)));
    console.log(`published and verified ${receipt.packageOrder.length} packages at ${receipt.packageVersion}`);
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
