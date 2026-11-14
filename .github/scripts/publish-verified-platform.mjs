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
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalJsonBytes,
  catalogSha256,
} from './build-prepublication-bundle.mjs';
import { githubCommitOrder } from './github-commit-order.mjs';
import { createVerificationReceipt } from './platform-verification-receipt.mjs';
import {
  loadLanePublishableCatalogPackages,
  loadPublishableCatalogPackages,
  resolveRequestedReleaseGroup,
  stackPublishedGroupArtifactPaths,
  loadPlatformCatalog,
} from './platform-catalog.mjs';
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
const DEFAULT_TLOG_CONFLICT_RETRY_ATTEMPTS = Number.parseInt(
  process.env.JINN_NPM_TLOG_CONFLICT_RETRY_ATTEMPTS ?? '3',
  10,
);
const TLOG_CONFLICT = /\bTLOG_CREATE_ENTRY_ERROR\b[\s\S]*\bequivalent entry already exists in the transparency log\b/u;

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

function defaultLog(line) {
  console.error(line);
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
  const artifacts = stackPublishedGroupArtifactPaths(verificationRoot, releaseGroup);
  const packManifestPath = artifacts.packManifest;
  const publicManifestPath = artifacts.publicSurface;
  const profileManifestPath = artifacts.profileManifest;
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
  validatePackInventory(artifacts.packRoot, receipt);
  return {
    receipt,
    packManifestPath,
    publicManifestPath,
    profileManifestPath,
    packRoot: artifacts.packRoot,
    profileRoot: artifacts.profileRoot,
  };
}

function provenanceSubjects({
  receipt,
  verificationReceiptPath,
  packManifestPath,
  publicManifestPath,
  profileManifestPath,
  packRoot,
  profileRoot,
  trustedPublishersJsonPath,
  trustedPublishersMarkdownPath,
}) {
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

function validateTrustedPublishers(verificationRoot, receipt, catalogNames, repoRoot) {
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
  const laneNames = loadLanePublishableCatalogPackages(repoRoot, receipt.lane)
    .map((pkg) => pkg.name)
    .sort();
  const receiptNames = [...receipt.packageOrder].sort();
  const catalogSorted = [...catalogNames].sort();
  if (new Set(names).size !== names.length
    || JSON.stringify([...names].sort()) !== JSON.stringify(laneNames)
    || JSON.stringify(receiptNames) !== JSON.stringify(catalogSorted)
    || receiptNames.some((name) => !names.includes(name))) {
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

function inspectPublishedVersion(tarball, receipt, context, { allowMissing, phase }) {
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
  return { version, integrity };
}

function inspectRegistry(tarball, receipt, context, { allowMissing, phase }) {
  const published = inspectPublishedVersion(tarball, receipt, context, { allowMissing, phase });
  if (published === null) return null;
  const { version, integrity } = published;
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

function publishAttemptReport(spec, attempt, attempts, result) {
  const output = [result.stdout, result.stderr]
    .map((stream) => String(stream ?? '').trim())
    .filter((stream) => stream !== '')
    .join('\n');
  const header = `npm publish ${spec} attempt ${attempt} of ${attempts}: exit status ${result.status}`;
  return output === '' ? header : `${header}\n${output}`;
}

function tlogConflictMissingError(spec, attempts) {
  return new Error([
    `npm publication failed for ${spec}:`,
    `TLOG_CREATE_ENTRY_ERROR 409 on ${attempts === 1 ? 'its only attempt' : `all ${attempts} attempts`}:`,
    'the transparency-log entry exists and the package is missing from the registry.',
    'Each attempt signs a fresh envelope, so these entries do not block a retry.',
    "Rerun the failed job while this run's verification artifacts still exist;",
    'otherwise the next push to next publishes a new canary version.',
    "See the Recovery section of docs/runbooks/stack-npm-publishing.md. Each attempt's npm output is logged above.",
  ].join(' '));
}

function publishMissingTarballs(receipt, missing, {
  exec,
  repoRoot,
  registry,
  packRoot,
  registryRetryAttempts,
  registryRetryDelayMs,
  tlogConflictRetryAttempts,
  sleep,
  log,
}) {
  const tarballs = new Map(receipt.tarballs.map((tarball) => [tarball.name, tarball]));
  const registryContext = { exec, repoRoot, registry };
  for (const wave of receipt.waves) {
    for (const name of wave) {
      if (!missing.has(name)) continue;
      const tarball = tarballs.get(name);
      const spec = `${name}@${receipt.packageVersion}`;
      for (let attempt = 1; attempt <= tlogConflictRetryAttempts; attempt += 1) {
        const result = exec('npm', [
          'publish',
          tarballPath(packRoot, tarball.filename),
          '--access',
          'public',
          '--provenance',
          '--tag',
          receipt.distTag,
          '--registry',
          registry,
        ], repoRoot);
        log(publishAttemptReport(spec, attempt, tlogConflictRetryAttempts, result));
        if (result.status === 0) break;

        const output = `${result.stdout}\n${result.stderr}`;
        if (!TLOG_CONFLICT.test(output)) {
          requireSuccess(result, `npm publication failed for ${spec}`);
        }

        // A TLOG_CREATE_ENTRY_ERROR 409 means this npm process uploaded nothing: npm writes the
        // provenance entry to the transparency log before it uploads the package. npm 11.19.0
        // bundles sigstore 4.1.1, which posts the entry with a 5-second timeout and two retries
        // and does not fetch an existing entry on conflict, so a response lost after the log
        // wrote the entry makes the retry resend the identical envelope and receive a 409.
        // A fresh npm process signs with a fresh certificate and writes a distinct entry, so it
        // does not collide with an earlier attempt. Established from run 43452336533
        // (2026-11-13): the three attempts for @jinn-network/verify wrote three distinct entries
        // for the same statement (log indexes 3858232769, 3858240435 and 3858250469), and the
        // third attempt's 409 named the entry that same process had written two seconds after it
        // started. A fresh process can therefore succeed once the log stops losing responses, and
        // the existing entries never block a rerun. Another publisher may still have landed the
        // exact receipt tarball, so the registry decides before any retry: the exact version
        // with the receipt integrity is success (the post-publish check below still enforces
        // the dist-tag), other bytes fail closed, and absence retries. Never retry any other
        // publish error.
        if (inspectPublishedVersion(tarball, receipt, registryContext, {
          allowMissing: true,
          phase: 'post-conflict',
        }) !== null) {
          log(`${spec} is on the registry with the receipt integrity after a transparency-log conflict; verifying it`);
          break;
        }
        if (attempt === tlogConflictRetryAttempts) {
          throw tlogConflictMissingError(spec, tlogConflictRetryAttempts);
        }
        sleep(registryRetryDelayMs);
      }
      verifyPublishedTarball(tarball, receipt, registryContext, {
        registryRetryAttempts,
        registryRetryDelayMs,
        sleep,
      });
    }
  }
}

function packagesLabel(names) {
  if (names.length === 1) return names[0];
  const others = names.length - 1;
  return `${names[0]} and ${others} other package${others === 1 ? '' : 's'}`;
}

// The dist-tag a package carries now, or null when npm has no such package or the package has
// no such tag yet (a name reserved under another tag prints nothing). Either way there is no
// tag for this leg to move back.
function currentDistTag(name, distTag, { exec, repoRoot, registry }) {
  const field = `dist-tags.${distTag}`;
  const result = exec('npm', ['view', name, field, '--json', '--registry', registry], repoRoot);
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.status !== 0) {
    if (/\bE404\b|404 Not Found/u.test(output)) return null;
    throw new Error(`registry query failed for ${name} ${field}: ${output}`);
  }
  if (result.stdout.trim() === '') return null;
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`registry returned invalid JSON for ${name} ${field}: ${error?.message ?? String(error)}`);
  }
}

// The preflight checks the canary tag only for versions that already exist. A leg that
// published nothing has every version missing, so a rerun of an old leg after a later run
// published the same group would publish with --tag canary and move the tag back to this
// older sha. Every canary version embeds its source sha, and that commit must be this run's
// source or one of its ancestors. GitHub's compare of the two commits decides, because the
// leg's checkout is shallow. Anything else, including an order that cannot be determined,
// is refused before any publish.
function refuseCanaryRollback(receipt, missing, { exec, repoRoot, registry, repository, sourceSha }) {
  const refusal = (kind, detail) => new Error(
    `canary rollback ${kind} for ${receipt.releaseGroup}: ${detail}; `
    + 'nothing was published. See the Recovery section of docs/runbooks/stack-npm-publishing.md.',
  );
  const taggedBySha = new Map();
  for (const { name } of receipt.tarballs) {
    if (!missing.has(name)) continue;
    let version;
    try {
      version = currentDistTag(name, receipt.distTag, { exec, repoRoot, registry });
    } catch (error) {
      throw refusal('check failed', `${error.message}, so its order against this run's source ${sourceSha} is unknown`);
    }
    if (version === null) continue;
    const taggedSha = typeof version === 'string'
      ? /-canary\.sha\.([0-9a-f]{40})$/u.exec(version)?.[1]
      : undefined;
    if (taggedSha === undefined) {
      throw refusal(
        'check failed',
        `the ${receipt.distTag} tag of ${name} points at ${JSON.stringify(version)}, which names no source commit, `
        + `so it cannot be ordered against this run's source ${sourceSha}`,
      );
    }
    if (taggedSha === sourceSha) continue;
    if (!taggedBySha.has(taggedSha)) taggedBySha.set(taggedSha, { version, names: [] });
    taggedBySha.get(taggedSha).names.push(name);
  }

  for (const [taggedSha, { version, names }] of taggedBySha) {
    const { order, reason } = githubCommitOrder({
      exec,
      cwd: repoRoot,
      repository,
      source: sourceSha,
      other: taggedSha,
    });
    if (order === 'behind') continue;
    const tagged = `the ${receipt.distTag} tag of ${packagesLabel(names)} points at ${version}, from ${taggedSha}`;
    if (order === 'ahead') {
      throw refusal(
        'refused',
        `${tagged}, a later commit than this run's source ${sourceSha}. `
        + `Publishing ${receipt.packageVersion} would move ${receipt.distTag} back`,
      );
    }
    throw refusal('check failed', `${tagged}, and its order against this run's source ${sourceSha} is unknown: ${reason}`);
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
  tlogConflictRetryAttempts,
}) {
  if (!COMMIT_SHA.test(String(sourceSha))) {
    throw new Error('publication source SHA must be a 40-character lowercase commit SHA');
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
  if (!Number.isSafeInteger(tlogConflictRetryAttempts) || tlogConflictRetryAttempts < 1) {
    throw new Error('tlog conflict retry attempts must be a positive integer');
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
    tlogConflictRetryAttempts = DEFAULT_TLOG_CONFLICT_RETRY_ATTEMPTS,
    sleep = defaultSleep,
    log = defaultLog,
  } = options;
  const root = resolve(repoRoot);
  const artifactRoot = resolve(verificationRoot);
  const receiptPath = resolve(verificationReceiptPath);
  const publicationReceiptPath = resolve(outputPath);
  const groupId = resolveRequestedReleaseGroup(loadPlatformCatalog(root), releaseGroup);
  validateArguments({
    sourceSha,
    releaseGroup: groupId,
    lane,
    registry,
    repository,
    outputPath: publicationReceiptPath,
    registryRetryAttempts,
    registryRetryDelayMs,
    tlogConflictRetryAttempts,
  });

  const validated = reconstructVerificationReceipt({
    repoRoot: root,
    verificationRoot: artifactRoot,
    verificationReceiptPath: receiptPath,
    sourceSha,
    releaseGroup: groupId,
    lane,
  });
  const { receipt } = validated;
  const catalogNames = loadPublishableCatalogPackages(root, { releaseGroup: groupId, lane })
    .map(({ name }) => name);
  if (receipt.packageOrder.length !== receipt.tarballs.length
    || JSON.stringify([...receipt.packageOrder].sort()) !== JSON.stringify([...catalogNames].sort())) {
    throw new Error('verified canary publication package and tarball sets must match the catalog');
  }
  const trustedPublishers = validateTrustedPublishers(artifactRoot, receipt, catalogNames, root);
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
  refuseCanaryRollback(receipt, missing, { ...registryContext, repository, sourceSha });
  publishMissingTarballs(receipt, missing, {
    exec,
    repoRoot: root,
    registry,
    packRoot: validated.packRoot,
    registryRetryAttempts,
    registryRetryDelayMs,
    tlogConflictRetryAttempts,
    sleep,
    log,
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

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const receipt = await publishVerifiedPlatform(parseArgs(process.argv.slice(2)));
    console.log(`published and verified ${receipt.packageOrder.length} packages at ${receipt.packageVersion}`);
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
