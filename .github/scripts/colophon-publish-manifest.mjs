import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUNTIME_DEPENDENCY_SECTIONS, loadCatalogPackages } from './platform-catalog.mjs';
import { DEPENDENCY_SECTIONS } from './stack-package-graph.mjs';

export const COLOPHON_PUBLISH_WORKFLOW = 'colophon-npm-publish.yml';
export const FIRST_CUT_PLATFORM_PIN_PATH = 'packages/benchmark-product/first-cut-platform-pin.json';
export const PRODUCT_RELEASE_PLATFORM_PINS_PATH = 'packages/benchmark-product/product-release-platform-pins.json';

/**
 * Every source file that seals a published reader version into a claim or a bundle asset. Two
 * names are published: `@colophon-claims/check`, the checker itself, and `@colophon-claims/verify`,
 * the name it shipped under first and keeps alive as a passthrough alias (issue #4188).
 * A pin here is sealed immutably into every bundle built from this tree and cannot be corrected
 * after the bundle ships, so the publish workflow refuses whenever the set of pins and the version
 * it is about to publish disagree (issue #3244).
 *
 * Reader instructions that live in repository markdown are *not* in this set: they ship no bytes
 * into a bundle and stay correctable after the fact, so they carry their own list
 * (`READER_INSTRUCTION_DOCS`) and their own check, which runs in the test suite rather than
 * gating a publish (issue #3647).
 */
export const CLAIM_PIN_SOURCES = [
  'packages/benchmark-product/core/src/legacy-closures.ts',
  'packages/benchmark-product/check/src/legacy-closures.ts',
  // The composed `/10` claim's reader lines, under the checker's own name (issue #4746).
  'packages/benchmark-product/check/src/capabilities.ts',
  'packages/benchmark-product/cli/src/main.ts',
];

/**
 * Every markdown file in the product tree that tells a reader which published reader version to
 * run, under either published name. These are corrigible after publication, so they never gate a
 * publish -- but a version npm has never served is still an instruction to fail, and CI refuses one
 * (issue #3647).
 * Dated plans and decision records elsewhere in the repository are historical and out of scope.
 */
export const READER_INSTRUCTION_DOCS = [
  // The claimant walkthrough ends with the reader's check, so it prints the checker's line too.
  'packages/benchmark-product/CLAIMANT-WALKTHROUGH.md',
  'packages/benchmark-product/EXTERNAL-VERIFICATION.md',
  'packages/benchmark-product/PUBLIC-BUNDLE.md',
  'packages/benchmark-product/README.md',
  'packages/benchmark-product/check/README.md',
  'packages/benchmark-product/cli/README.md',
  'packages/benchmark-product/core/README.md',
  'packages/benchmark-product/verify/README.md',
];

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const EXACT_CANARY_PIN = /^0\.1\.0-canary\.sha\.[0-9a-f]{40}$/u;
const PRODUCT_RELEASE_PINS_KEYS = ['schemaVersion', 'receipts'];
const VERIFY_020_RECEIPT_KEYS = [
  'decision',
  'product',
  'platformSourceSha',
  'platformVersion',
  'platformDistTag',
  'platformLatestVersion',
  'stackPublishRunUrl',
  'platformPackages',
];
const VERIFY_020_PRODUCT_KEYS = ['packageName', 'version'];
const VERIFY_020_PACKAGE_KEYS = ['name', 'version', 'gitHead', 'integrity', 'provenanceUrl'];
// A receipt that records each package's own `latest` dist-tag, as npm served it when the receipt was
// read, in place of one `platformLatestVersion` it assumed for every package. Earlier receipts keep
// the shape they were sealed in: their digests cannot change.
const LATEST_PER_PACKAGE_RECEIPT_KEYS = VERIFY_020_RECEIPT_KEYS.filter((key) => key !== 'platformLatestVersion');
const LATEST_PER_PACKAGE_KEYS = [...VERIFY_020_PACKAGE_KEYS, 'latestVersion'];
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?$/u;
const VERIFY_020_PLATFORM_CLOSURE = [
  '@jinn-network/benchmarking-aggregate',
  '@jinn-network/benchmarking-evidence',
  '@jinn-network/benchmarking-interop',
  '@jinn-network/benchmarking-local',
  '@jinn-network/benchmarking-protocol',
  '@jinn-network/benchmarking-records',
  '@jinn-network/benchmarking-run',
  '@jinn-network/environment-record',
  '@jinn-network/evidence-protocol',
  '@jinn-network/task-admission',
  '@jinn-network/task-execution-profiles',
  '@jinn-network/task-execution-protocol',
  '@jinn-network/trust-core',
  '@jinn-network/trust-resolve',
  '@jinn-network/trust-testing',
];
const CORE_010_PLATFORM_CLOSURE = [
  '@jinn-network/attestation-issuer',
  '@jinn-network/benchmarking-aggregate',
  '@jinn-network/benchmarking-evaluation',
  '@jinn-network/benchmarking-evidence',
  '@jinn-network/benchmarking-interop',
  '@jinn-network/benchmarking-local',
  '@jinn-network/benchmarking-native-capture',
  '@jinn-network/benchmarking-protocol',
  '@jinn-network/benchmarking-publication',
  '@jinn-network/benchmarking-records',
  '@jinn-network/benchmarking-run',
  '@jinn-network/record-discovery-protocol',
  '@jinn-network/record-discovery-serve',
  '@jinn-network/record-discovery-transport-http',
  '@jinn-network/record-publication',
  '@jinn-network/task-admission',
  '@jinn-network/task-execution-backend',
  '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-evaluation-harness',
  '@jinn-network/task-execution-evaluator-adapters',
  '@jinn-network/task-execution-launchers',
  '@jinn-network/task-execution-oci-grader',
  '@jinn-network/task-execution-profiles',
  '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-supervisor',
  '@jinn-network/task-execution-workspace',
  '@jinn-network/trust-core',
];
const CLI_010_PLATFORM_CLOSURE = [];
// The checker's closure once `@jinn-network/verify` is its runtime dependency (issue #5120): the 15
// above, plus `verify` and the two it brings that the checker did not already hold.
const CHECK_022_PLATFORM_CLOSURE = [
  '@jinn-network/benchmarking-aggregate',
  '@jinn-network/benchmarking-evidence',
  '@jinn-network/benchmarking-interop',
  '@jinn-network/benchmarking-local',
  '@jinn-network/benchmarking-protocol',
  '@jinn-network/benchmarking-records',
  '@jinn-network/benchmarking-run',
  '@jinn-network/environment-record',
  '@jinn-network/evidence-offer',
  '@jinn-network/evidence-protocol',
  '@jinn-network/record-discovery-protocol',
  '@jinn-network/task-admission',
  '@jinn-network/task-execution-profiles',
  '@jinn-network/task-execution-protocol',
  '@jinn-network/trust-core',
  '@jinn-network/trust-resolve',
  '@jinn-network/trust-testing',
  '@jinn-network/verify',
];
const PRODUCT_RELEASES = {
  '@colophon-claims/verify@0.2.0': {
    decision: 'DR-2026-08-22-a',
    platformSourceSha: 'e00b2fc47fc5635b007eb349fb1e41aa81bb3c50',
    stackPublishRunUrl: 'https://github.com/Jinn-Network/mono/actions/runs/32544891098/attempts/2',
    receiptSha256: '8c6749c2e6c303b17ceccbc12712e1210e275dcdbcb37fd495a14a15cbb4474e',
    closure: VERIFY_020_PLATFORM_CLOSURE,
  },
  '@colophon-claims/verify@0.2.1': {
    decision: 'operator-authorization-2026-08-26',
    platformSourceSha: '0533a224cf99f06d7facf0c23455f2781a5b9e62',
    stackPublishRunUrl: 'https://github.com/Jinn-Network/mono/actions/runs/33517790412/attempts/2',
    receiptSha256: '2f2aa7e82f75c2775bd8de8673d3286caf8c6b9a92133a5a93f1766f942b1797',
    closure: VERIFY_020_PLATFORM_CLOSURE,
  },
  '@colophon-claims/core@0.1.0': {
    decision: 'DR-2026-08-22-a',
    platformSourceSha: '272455add1170766f064181c105071519a6baf95',
    stackPublishRunUrl: 'https://github.com/Jinn-Network/mono/actions/runs/38246145514/attempts/1',
    receiptSha256: 'c84c824116af3f0816223a4c4eb9766cdf7988697b59efaa524fed5548aa63a5',
    closure: CORE_010_PLATFORM_CLOSURE,
  },
  '@colophon-claims/cli@0.1.0': {
    decision: 'DR-2026-08-22-a',
    platformSourceSha: '272455add1170766f064181c105071519a6baf95',
    stackPublishRunUrl: 'https://github.com/Jinn-Network/mono/actions/runs/38246145514/attempts/1',
    receiptSha256: 'bf499ca302b60c2eaf72165888e64159713523d8110b2cc5ccf3a180d75f86b9',
    closure: CLI_010_PLATFORM_CLOSURE,
  },
  '@colophon-claims/check@0.2.1': {
    decision: 'operator-authorization-2026-09-23-issue-4733',
    platformSourceSha: '272455add1170766f064181c105071519a6baf95',
    stackPublishRunUrl: 'https://github.com/Jinn-Network/mono/actions/runs/38246145514/attempts/1',
    receiptSha256: 'd9963a3d7eb18f5fad4a91bdc2aaab3cf94a2f572744ff92581d44e0db1835ba',
    closure: VERIFY_020_PLATFORM_CLOSURE,
  },
  // The checker's runtime move to `@jinn-network/verify` (issue #5120), at the canary of #5158's
  // merge. These receipts record each package's own `latest`: the maintainer pointed
  // `@jinn-network/verify`'s at a canary build.
  '@colophon-claims/core@0.1.1': {
    decision: 'operator-authorization-2026-10-30-issue-5120',
    latestPerPackage: true,
    platformSourceSha: 'f2aa6f30f2c7d7bcfc4c11e1f6b69f3f44c28603',
    stackPublishRunUrl: 'https://github.com/Jinn-Network/mono/actions/runs/41639352404/attempts/1',
    receiptSha256: '718001f48001d4311ddd43fb77562d1b0ebd488e5687884a5594a1a56db9be0a',
    closure: CORE_010_PLATFORM_CLOSURE,
  },
  '@colophon-claims/cli@0.1.1': {
    decision: 'operator-authorization-2026-10-30-issue-5120',
    latestPerPackage: true,
    platformSourceSha: 'f2aa6f30f2c7d7bcfc4c11e1f6b69f3f44c28603',
    stackPublishRunUrl: 'https://github.com/Jinn-Network/mono/actions/runs/41639352404/attempts/1',
    receiptSha256: '21c0ed4fced453d8699a4323d6704de51dcbcd7ebdcee33a09d13cd47a2df83e',
    closure: CLI_010_PLATFORM_CLOSURE,
  },
  '@colophon-claims/check@0.2.2': {
    decision: 'operator-authorization-2026-10-30-issue-5120',
    latestPerPackage: true,
    platformSourceSha: 'f2aa6f30f2c7d7bcfc4c11e1f6b69f3f44c28603',
    stackPublishRunUrl: 'https://github.com/Jinn-Network/mono/actions/runs/41639352404/attempts/1',
    receiptSha256: '67ef705484ce6facb65b8b37e834ffb830cd4799fc544b3e443e69ecb2816cd3',
    closure: CHECK_022_PLATFORM_CLOSURE,
  },
};
const PRODUCT_RELEASE_IDS = Object.keys(PRODUCT_RELEASES);

function isFloatingCanarySpecifier(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed === 'canary' || trimmed === '@canary' || trimmed.endsWith('@canary');
}

function refuseFloatingCanary(value, label) {
  if (isFloatingCanarySpecifier(value)) {
    throw new Error(`floating canary dist-tag in ${label}: ${value}`);
  }
}

function hasExactKeys(value, expected) {
  return value !== null
    && typeof value === 'object'
    && JSON.stringify(Object.keys(value)) === JSON.stringify(expected);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Records one `packageName -> versions` pin in a collector's accumulator. */
function addPin(pins, packageName, version) {
  if (!pins.has(packageName)) pins.set(packageName, new Set());
  pins.get(packageName).add(version);
}

/** A collector's accumulator as a plain `{ packageName: sortedVersions }` object, names sorted. */
function groupPins(pins) {
  return Object.fromEntries(
    [...pins.keys()].sort().map((packageName) => [packageName, [...pins.get(packageName)].sort()]),
  );
}

/**
 * The pins in `versions` that `published` cannot satisfy: an exact `X.Y.Z` npm does not serve, or a
 * shorter `X`/`X.Y` line with no published version under it.
 */
function unresolvableAgainst(versions, published) {
  return versions.filter((pin) =>
    pin.split('.').length === 3
      ? !published.includes(pin)
      : !published.some((version) => version.startsWith(`${pin}.`)),
  );
}

function sha256CanonicalJson(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function loadFirstCutPlatformPin(repoRoot) {
  const pinPath = resolve(repoRoot, ...FIRST_CUT_PLATFORM_PIN_PATH.split('/'));
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  if (pin.schemaVersion !== 2) {
    throw new Error(`first-cut pin schemaVersion must be 2, got ${pin.schemaVersion ?? '<missing>'}`);
  }
  if (pin.decision !== 'DR-2026-08-17-c') {
    throw new Error(`first-cut pin must name DR-2026-08-17-c, got ${pin.decision ?? '<missing>'}`);
  }
  refuseFloatingCanary(pin.platformVersion, 'first-cut pin platformVersion');
  if (!COMMIT_SHA.test(String(pin.platformSourceSha))) {
    throw new Error(`first-cut pin platformSourceSha must be a 40-character commit sha, got ${pin.platformSourceSha ?? '<missing>'}`);
  }
  const expectedVersion = `0.1.0-canary.sha.${pin.platformSourceSha}`;
  if (pin.platformVersion !== expectedVersion || !EXACT_CANARY_PIN.test(pin.platformVersion)) {
    throw new Error(`first-cut pin platformVersion must be ${expectedVersion}, got ${pin.platformVersion ?? '<missing>'}`);
  }
  if (pin.platformDistTag !== 'canary') {
    throw new Error(`first-cut pin platformDistTag must remain canary, got ${pin.platformDistTag ?? '<missing>'}`);
  }
  if (pin.platformLatestVersion !== '0.0.0') {
    throw new Error(`first-cut pin platformLatestVersion must be 0.0.0, got ${pin.platformLatestVersion ?? '<missing>'}`);
  }
  const product = pin.productRelease;
  if (
    product?.packageName !== '@colophon-claims/verify'
    || product.version !== '0.1.0'
    || product.distTag !== 'latest'
    || !COMMIT_SHA.test(String(product.sourceSha))
  ) {
    throw new Error('first-cut pin must record @colophon-claims/verify@0.1.0 on latest with an exact source sha');
  }
  return pin;
}

function loadProductReleasePlatformPins(repoRoot) {
  const pinsPath = resolve(repoRoot, ...PRODUCT_RELEASE_PLATFORM_PINS_PATH.split('/'));
  const pins = JSON.parse(readFileSync(pinsPath, 'utf8'));
  if (!hasExactKeys(pins, PRODUCT_RELEASE_PINS_KEYS) || pins.schemaVersion !== 1 || !Array.isArray(pins.receipts)) {
    throw new Error('product-release platform pins must use schemaVersion 1 with a receipts array');
  }
  return pins;
}

export function validateProductReleasePlatformPin(pin, manifest) {
  const releaseId = `${pin?.product?.packageName}@${pin?.product?.version}`;
  const release = PRODUCT_RELEASES[releaseId];
  const latestPerPackage = release?.latestPerPackage === true;
  if (
    !hasExactKeys(pin, latestPerPackage ? LATEST_PER_PACKAGE_RECEIPT_KEYS : VERIFY_020_RECEIPT_KEYS)
    || !hasExactKeys(pin.product, VERIFY_020_PRODUCT_KEYS)
  ) {
    throw new Error('product-release pin must retain the immutable verifier 0.2 receipt shape');
  }
  if (
    release === undefined
    || pin?.decision !== release.decision
    || pin.platformSourceSha !== release.platformSourceSha
    || pin.platformVersion !== `0.1.0-canary.sha.${release.platformSourceSha}`
    || manifest.name !== pin.product.packageName
    || manifest.version !== pin.product.version
  ) {
    throw new Error(`only a registered product release may use its exact canary receipt (${releaseId})`);
  }
  refuseFloatingCanary(pin.platformVersion, 'product-release pin platformVersion');
  if (!COMMIT_SHA.test(String(pin.platformSourceSha))) {
    throw new Error('product-release pin platformSourceSha must be a 40-character commit sha');
  }
  if (!EXACT_CANARY_PIN.test(pin.platformVersion)) {
    throw new Error(`product-release pin platformVersion must be 0.1.0-canary.sha.${release.platformSourceSha}`);
  }
  if (
    pin.platformDistTag !== 'canary'
    || (!latestPerPackage && pin.platformLatestVersion !== '0.0.0')
    || pin.stackPublishRunUrl !== release.stackPublishRunUrl
  ) {
    throw new Error('product-release pin must retain its recorded stack-canary receipt');
  }
  const directNames = Object.keys(manifest.dependencies ?? {})
    .filter((name) => name.startsWith('@jinn-network/'));
  const packages = pin.platformPackages;
  if (!Array.isArray(packages) || packages.length !== release.closure.length) {
    throw new Error(`product-release pin must record the complete ${releaseId} Jinn closure`);
  }
  const names = packages.map((pkg) => pkg?.name);
  if (JSON.stringify(names) !== JSON.stringify(release.closure)) {
    throw new Error(`product-release pin Jinn package names must be the sorted ${releaseId} closure`);
  }
  if (directNames.some((name) => !names.includes(name))) {
    throw new Error('product-release pin must include every direct Jinn dependency');
  }
  for (const pkg of packages) {
    if (!hasExactKeys(pkg, latestPerPackage ? LATEST_PER_PACKAGE_KEYS : VERIFY_020_PACKAGE_KEYS)) {
      throw new Error(`product-release pin package row shape drift for ${pkg?.name ?? '<missing>'}`);
    }
    if (latestPerPackage && !EXACT_VERSION.test(String(pkg.latestVersion))) {
      throw new Error(`product-release pin must record the exact version npm's latest tag served for ${pkg.name}`);
    }
    if (
      pkg.version !== pin.platformVersion
      || pkg.gitHead !== pin.platformSourceSha
      || typeof pkg.integrity !== 'string'
      || !pkg.integrity.startsWith('sha512-')
      || pkg.provenanceUrl !== `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(pkg.name)}@${pin.platformVersion}`
    ) {
      throw new Error(`product-release pin must record registry integrity and provenance for ${pkg.name}`);
    }
  }
  if (sha256CanonicalJson(pin) !== release.receiptSha256) {
    throw new Error(`product-release pin must retain the immutable ${releaseId} receipt values`);
  }
  return pin;
}

export function validateProductReleasePlatformPins(pins, manifest) {
  if (
    !hasExactKeys(pins, PRODUCT_RELEASE_PINS_KEYS)
    || pins.schemaVersion !== 1
    || !Array.isArray(pins.receipts)
    || JSON.stringify(pins.receipts.map((pin) => `${pin?.product?.packageName}@${pin?.product?.version}`)) !== JSON.stringify(PRODUCT_RELEASE_IDS)
  ) {
    throw new Error('product-release platform pins must contain the exact ordered immutable product-release receipts');
  }
  for (const pin of pins.receipts) {
    validateProductReleasePlatformPin(pin, {
      name: pin.product.packageName,
      version: pin.product.version,
    });
  }
  const selected = pins.receipts.find(
    (pin) => pin.product.packageName === manifest.name && pin.product.version === manifest.version,
  );
  if (selected === undefined) {
    throw new Error(`no immutable platform receipt is registered for ${manifest.name}@${manifest.version}`);
  }
  return validateProductReleasePlatformPin(selected, manifest);
}

export function loadProductReleasePlatformPin(repoRoot, manifest) {
  const pins = loadProductReleasePlatformPins(repoRoot);
  return validateProductReleasePlatformPins(pins, manifest);
}

/**
 * Refuses a receipt row that is not what npm serves for that package and version.
 *
 * The validator above compares the receipts file with `PRODUCT_RELEASES`, and both are files in the
 * dispatched commit, so a row edited together with its digest passes it. The registry is not in the
 * commit. Every row of every receipt is read, not only the one being published: a `cli` install
 * brings in `core` and the checker, whose receipts record what it gets (issue #5044).
 *
 * Fails closed: a version npm does not serve, or a registry that cannot be read, refuses.
 */
export async function assertReceiptRowsServed(receipts, fetchImpl = fetch) {
  const served = new Map();
  for (const receipt of receipts) {
    const releaseId = `${receipt.product.packageName}@${receipt.product.version}`;
    for (const row of receipt.platformPackages) {
      const id = `${row.name}@${row.version}`;
      if (!served.has(id)) {
        const response = await fetchImpl(`https://registry.npmjs.org/${row.name.replace('/', '%2f')}/${encodeURIComponent(row.version)}`);
        if (response.status === 404) throw new Error(`the ${releaseId} receipt row ${id} names a version npm does not serve`);
        if (!response.ok) throw new Error(`cannot check the ${releaseId} receipt row ${id} against npm: HTTP ${response.status}`);
        served.set(id, await response.json());
      }
      const document = served.get(id);
      for (const [field, recorded, actual] of [
        ['integrity', row.integrity, document?.dist?.integrity],
        ['gitHead', row.gitHead, document?.gitHead],
      ]) {
        if (recorded !== actual) {
          throw new Error(`the ${releaseId} receipt row ${id} records ${field} ${recorded}, but npm serves ${actual ?? 'none'} for that version`);
        }
      }
    }
  }
}

/**
 * The tree directory of every platform package a publish of `manifest` installs, sorted by name:
 * the `@jinn-network` dependencies the manifest names in any section, and those of each in-tree
 * `@colophon-claims` package it depends on, followed through the runtime dependencies of each.
 * A `cli` install brings in `core` and the checker, and the `cli` build compiles the private web
 * application from these directories through portals (#5045).
 */
export function platformSourceDirectories(repoRoot, manifest) {
  const catalog = new Map(loadCatalogPackages(repoRoot).map((pkg) => [pkg.name, pkg]));
  const platform = new Set();
  const products = new Set();
  const visitProduct = (product) => {
    if (products.has(product.name)) return;
    products.add(product.name);
    for (const section of DEPENDENCY_SECTIONS) {
      for (const dependency of Object.keys(product[section] ?? {})) {
        if (dependency.startsWith('@jinn-network/')) platform.add(dependency);
        else if (dependency.startsWith('@colophon-claims/') && catalog.has(dependency)) visitProduct(catalog.get(dependency).manifest);
      }
    }
  };
  visitProduct(manifest);
  const pending = [...platform];
  while (pending.length > 0) {
    const name = pending.pop();
    const pkg = catalog.get(name);
    if (pkg === undefined) throw new Error(`cannot find the source of ${name} in this tree`);
    for (const section of RUNTIME_DEPENDENCY_SECTIONS) {
      for (const dependency of Object.keys(pkg.manifest[section] ?? {})) {
        if (dependency.startsWith('@jinn-network/') && !platform.has(dependency)) {
          platform.add(dependency);
          pending.push(dependency);
        }
      }
    }
  }
  return [...platform].sort().map((name) => ({ name, directory: catalog.get(name).directory }));
}

/**
 * The files under `directories` that differ between `platformSourceSha` and `HEAD`, from git.
 *
 * The publish job checks out one commit, so the receipt's commit is fetched by sha when it is not
 * there. Fails closed: a commit that cannot be fetched or compared refuses, and a value that is not
 * a commit sha never reaches git.
 */
export function gitChangedFiles(repoRoot, platformSourceSha, directories) {
  if (!COMMIT_SHA.test(String(platformSourceSha))) {
    throw new Error(`a receipt's platform commit must be a 40-character commit sha, got ${platformSourceSha ?? '<missing>'}`);
  }
  const git = (...args) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  const failure = (result) => (result.stderr ?? '').trim() || result.error?.message || `exit ${result.status}`;
  if (git('cat-file', '-e', `${platformSourceSha}^{commit}`).status !== 0) {
    const fetched = git('fetch', '--quiet', '--no-tags', '--depth=1', 'origin', platformSourceSha);
    if (fetched.status !== 0) {
      throw new Error(`cannot fetch platform commit ${platformSourceSha} from origin: ${failure(fetched)}`);
    }
  }
  const diff = git('diff', '--name-only', '--no-renames', platformSourceSha, 'HEAD', '--', ...directories);
  if (diff.status !== 0) {
    throw new Error(`cannot compare platform commit ${platformSourceSha} with HEAD: ${failure(diff)}`);
  }
  return diff.stdout.split('\n').filter(Boolean);
}

/**
 * A file no published platform package is built or packed from: a test, or its vitest config.
 * Every package in a Colophon closure builds with a `tsconfig.build.json` that excludes each
 * `*.test.ts` under `src`, and none lists either in `files` (#5045).
 */
function isPlatformTestFile(path) {
  return /\.test\.ts$/u.test(path) || /(?:^|\/)vitest\.config\.ts$/u.test(path);
}

/**
 * Refuses a receipt whose platform commit is not the platform source of the dispatched commit.
 *
 * A publish installs the canary the receipt names, while this tree's products are built and tested
 * against this tree's platform source, and the `cli` build compiles the web application from it. A
 * receipt that names an older canary passes every other check here, and a reader built against it
 * can refuse what the tree's own bundles use: the checker receipt before #5030 named a canary
 * without the `external-verifier` family (issue #5044). Only tests are exempt.
 */
export function assertPlatformSourceMatchesReceipt(pin, sources, changedFiles) {
  const releaseId = `${pin.product.packageName}@${pin.product.version}`;
  const differing = changedFiles(pin.platformSourceSha, sources.map(({ directory }) => directory))
    .filter((path) => !isPlatformTestFile(path));
  if (differing.length > 0) {
    throw new Error([
      `the ${releaseId} receipt pins the platform canary built from ${pin.platformSourceSha}, but this commit's platform source differs from that commit in ${differing.length} ${differing.length === 1 ? 'file' : 'files'}:`,
      ...differing.map((path) => `  ${path}`),
      'Publish from a commit whose platform source is that commit\'s, or re-pin the receipt to a canary of this commit\'s platform source.',
    ].join('\n'));
  }
}

/**
 * The `--check-receipt` step: the registered receipt for `manifest`, refused unless npm serves every
 * row of every receipt as recorded and the dispatched commit's platform source is the receipt's.
 */
export async function checkProductReleaseReceipt(repoRoot, manifest, {
  fetchImpl = fetch,
  changedFiles = (sha, directories) => gitChangedFiles(repoRoot, sha, directories),
} = {}) {
  const pins = loadProductReleasePlatformPins(repoRoot);
  const pin = validateProductReleasePlatformPins(pins, manifest);
  await assertReceiptRowsServed(pins.receipts, fetchImpl);
  assertPlatformSourceMatchesReceipt(pin, platformSourceDirectories(repoRoot, manifest), changedFiles);
  return pin;
}

export function transformColophonManifestForPublish(manifest, pin, { gitHead } = {}) {
  refuseFloatingCanary(pin?.platformVersion, 'pin platformVersion');
  if (!EXACT_CANARY_PIN.test(String(pin?.platformVersion ?? ''))) {
    throw new Error(`Colophon publish pin must be an exact canary sha version, got ${pin?.platformVersion ?? '<missing>'}`);
  }
  const patched = structuredClone(manifest);
  delete patched.packageManager;
  if (gitHead && COMMIT_SHA.test(gitHead)) patched.gitHead = gitHead;
  for (const section of DEPENDENCY_SECTIONS) {
    const entries = patched[section];
    if (!entries) continue;
    for (const [dependency, specifier] of Object.entries(entries)) {
      refuseFloatingCanary(specifier, `${section}.${dependency}`);
      if (dependency.startsWith('@jinn-network/')) entries[dependency] = pin.platformVersion;
    }
  }
  if (patched.resolutions) {
    for (const [key, value] of Object.entries(patched.resolutions)) {
      if (typeof value !== 'string') continue;
      if (value.startsWith('portal:') || value.startsWith('workspace:')) delete patched.resolutions[key];
    }
    if (Object.keys(patched.resolutions).length === 0) delete patched.resolutions;
  }
  patched.scripts ??= {};
  patched.scripts.prepack = 'npm run build';
  return patched;
}

/**
 * Pins a shipped README's links into this repository to the publishing commit.
 *
 * In the repository the READMEs link documents on the `next` branch, which is where a reader of the
 * repository wants them. A tarball is different: it is immutable, and a branch link in it would
 * follow the documents wherever they go after the publish. So the same commit `--apply` writes into
 * the manifest as `gitHead` replaces the branch in every `/blob/next/` and `/tree/next/` link, and
 * the README on npm describes the bytes it shipped with (issue #4954).
 *
 * Only this repository's links move: the commit exists nowhere else. With no commit to pin to, the
 * README is returned as written, and its links still resolve on the branch.
 * `packages/benchmark-product/core/src/published-readme-links.test.ts` holds the READMEs to the one
 * link form this rewrites.
 */
export function transformColophonReadmeForPublish(readme, { gitHead } = {}) {
  if (!gitHead || !COMMIT_SHA.test(gitHead)) return readme;
  return readme.replace(
    /(https:\/\/github\.com\/Jinn-Network\/mono\/(?:blob|tree)\/)next\//gu,
    (_link, prefix) => `${prefix}${gitHead}/`,
  );
}

export function applyColophonPublishManifest(manifestPath, pin, options = {}) {
  const originalBytes = readFileSync(manifestPath, 'utf8');
  const patched = transformColophonManifestForPublish(JSON.parse(originalBytes), pin, options);
  writeFileSync(manifestPath, `${JSON.stringify(patched, null, 2)}\n`, 'utf8');
  // The README beside the manifest ships in the same tarball, so the same step pins it.
  const readmePath = resolve(dirname(manifestPath), 'README.md');
  const originalReadme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : undefined;
  if (originalReadme !== undefined) {
    writeFileSync(readmePath, transformColophonReadmeForPublish(originalReadme, options), 'utf8');
  }
  return {
    restore() {
      writeFileSync(manifestPath, originalBytes, 'utf8');
      if (originalReadme !== undefined) writeFileSync(readmePath, originalReadme, 'utf8');
    },
  };
}

/**
 * Every release this repository has registered for each published reader name. This is the offline
 * floor, not the authority: an entry is added in the same change that bumps the version, so the
 * ledger names a release before the registry does. `fetchPublishedReaderVersions` is what the
 * workflow actually asks.
 *
 * It is deliberately not derived from `PRODUCT_RELEASES`. A platform receipt attests one publish
 * run; a registered release is any version this tree may resolve against. `verify@0.1.0` predates
 * the receipt file and `verify@0.2.2` and `0.2.3` are the alias, which carries no Jinn closure to
 * attest.
 */
const READER_RELEASES = {
  '@colophon-claims/check': ['0.2.1', '0.2.2'],
  '@colophon-claims/verify': ['0.1.0', '0.2.0', '0.2.1', '0.2.2', '0.2.3'],
};

export function registeredReaderReleases(packageName) {
  const releases = READER_RELEASES[packageName];
  if (releases === undefined) {
    throw new Error(`no registered release ledger for ${packageName}; only a published reader name has one`);
  }
  return [...releases];
}

/**
 * The versions npm actually serves. Fails closed: a registry that cannot be read leaves the guard
 * unable to tell a pin that resolves from one that 404s, and guessing in that state is the exact
 * failure the guard exists to prevent.
 *
 * A clean 404 is the one answer that is not a failure to read. It is what npm returns for a name it
 * has never served, which is exactly the state a first publish is in -- so refusing there would make
 * the guard block the release it exists to gate, permanently. That case falls back to the offline
 * ledger, which already names the version about to be published; every other status still refuses
 * (issue #4188). A caller that publishes nothing under the name passes `ledgerOnNotFound: false`,
 * because for it a 404 is exactly what it reads: npm serves nothing there (issue #4746).
 */
export async function fetchPublishedReaderVersions(packageName, fetchImpl = fetch, { ledgerOnNotFound = true } = {}) {
  const response = await fetchImpl(`https://registry.npmjs.org/${packageName.replace('/', '%2f')}`);
  if (response.status === 404) return ledgerOnNotFound ? registeredReaderReleases(packageName) : [];
  if (!response.ok) {
    throw new Error(`cannot read published ${packageName} versions from npm: HTTP ${response.status}`);
  }
  const versions = Object.keys((await response.json()).versions ?? {});
  if (versions.length === 0) throw new Error(`npm reports no published versions of ${packageName}`);
  return versions;
}

/**
 * Every specifier shape npx resolves, under either published reader name: the exact `X.Y.Z`, and
 * the compatible `X.Y` and `X` lines. The bare major is in the pattern because that is the shape
 * that 404s against a 0.x package, and a scan that cannot see it cannot refuse it (issue #3647).
 *
 * Both names are in one pattern because a scan that sees only the retired one drops a file the
 * moment its instruction moves to the new name -- silently, out of the sealed set the exhaustiveness
 * walk enumerates (issue #4188).
 */
const READER_PIN_PATTERN = /@colophon-claims\/(verify|check)@([0-9]+(?:\.[0-9]+){0,2})/gu;

const REGEX_PRECEDING_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return', 'throw',
  'typeof', 'void', 'yield',
]);

const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u;

/**
 * Whether a `/` opens a regex literal, by the standard previous-significant-token rule. The rule is
 * biased toward regex: only a value -- an identifier that is not a regex-admitting keyword, a
 * number, a closing `)` or `]`, or a completed literal -- reads the `/` as division. Reading a
 * regex as division is the direction that loses a pin, because `/^https:\/\//` then opens a line
 * comment and `/a\/*b/` opens a block comment. Reading division as a regex only widens a span, and
 * a pin inside a span that is neither string nor comment refuses rather than vanishing.
 */
function slashOpensRegex(previous) {
  if (previous === null) return true;
  if (previous.value) return false;
  if (previous.word !== undefined) return REGEX_PRECEDING_KEYWORDS.has(previous.word);
  return true;
}

/**
 * The index of the closing `/` of the regex literal opening at `index`, or -1 when the text is not
 * one. A regex literal cannot carry an unescaped newline, so a `/` whose line ends before a closing
 * `/` was division after all.
 */
function regexLiteralEnd(text, index) {
  let cursor = index + 1;
  let inClass = false;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === '\\') cursor += 2;
    else if (char === '\n') return -1;
    else if (inClass) {
      if (char === ']') inClass = false;
      cursor += 1;
    } else if (char === '[') {
      inClass = true;
      cursor += 1;
    } else if (char === '/') return cursor;
    else cursor += 1;
  }
  return -1;
}

/**
 * The source ranges a JavaScript or TypeScript file spends inside a string literal, inside a
 * comment, or inside a regex literal. Everything else is code.
 *
 * A pin is sealed into a bundle by a string constant; a version named in a comment is prose about
 * a pin, not a pin. Scanning the raw text cannot tell the two apart, so a sentence explaining a
 * pending bump would refuse a publish that nothing in the tree actually blocks (issue #3686).
 *
 * Regex literals are tracked for the opposite reason. A scanner with no state for them reads the
 * escaped slashes in `/^https:\/\//` as a line comment and the escaped slash-star in `/a\/*b/` as
 * a block comment, and a
 * pin caught inside either bogus span is classified as prose and dropped -- silently, because a
 * dropped pin never reaches `unclassified` (issue #3900). They are yielded as their own span kind
 * rather than folded into `string`, so a pin inside one refuses instead of sealing.
 */
function* literalAndCommentSpans(text) {
  const stack = [{ kind: 'code', depth: 0, previous: null }];
  let index = 0;
  while (index < text.length) {
    const frame = stack[stack.length - 1];
    const char = text[index];
    // Computed once per slash the heuristic admits; the comment branches below still win the tie,
    // because `//` is never an empty regex and `/*` is never a valid one.
    const regexEnd =
      frame.kind === 'code' && char === '/' && slashOpensRegex(frame.previous)
        ? regexLiteralEnd(text, index)
        : -1;
    if (frame.kind === 'template') {
      if (char === '\\') {
        index += 2;
      } else if (char === '`') {
        yield { kind: 'string', start: frame.chunkStart, end: index };
        stack.pop();
        stack[stack.length - 1].previous = { value: true };
        index += 1;
      } else if (char === '$' && text[index + 1] === '{') {
        yield { kind: 'string', start: frame.chunkStart, end: index };
        stack.push({ kind: 'code', depth: 0, previous: null });
        index += 2;
      } else {
        index += 1;
      }
    } else if (char === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index);
      yield { kind: 'comment', start: index, end: end < 0 ? text.length : end };
      if (end < 0) return;
      index = end + 1;
    } else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      // An unterminated block comment is a syntax error, and calling the rest of the file prose
      // would drop every pin in it without a word. Refuse the tail instead.
      yield {
        kind: end < 0 ? 'unterminated' : 'comment',
        start: index,
        end: end < 0 ? text.length : end + 2,
      };
      index = end < 0 ? text.length : end + 2;
    } else if (regexEnd >= 0) {
      yield { kind: 'regex', start: index, end: regexEnd + 1 };
      frame.previous = { value: true };
      index = regexEnd + 1;
    } else if (char === '"' || char === "'") {
      let cursor = index + 1;
      while (cursor < text.length) {
        if (text[cursor] === '\\') cursor += 2;
        else if (text[cursor] === char || text[cursor] === '\n') break;
        else cursor += 1;
      }
      yield { kind: 'string', start: index, end: Math.min(cursor + 1, text.length) };
      frame.previous = { value: true };
      index = cursor + 1;
    } else if (char === '`') {
      stack.push({ kind: 'template', chunkStart: index + 1 });
      index += 1;
    } else if (IDENTIFIER_CHAR.test(char)) {
      let cursor = index;
      while (cursor < text.length && IDENTIFIER_CHAR.test(text[cursor])) cursor += 1;
      const word = text.slice(index, cursor);
      frame.previous = /^[0-9]/u.test(word) ? { value: true } : { word };
      index = cursor;
    } else if (char === '{') {
      frame.depth += 1;
      frame.previous = { punct: char };
      index += 1;
    } else if (char === '}') {
      if (frame.depth > 0) {
        frame.depth -= 1;
        frame.previous = { punct: char };
      } else if (stack.length > 1) {
        stack.pop();
        stack[stack.length - 1].chunkStart = index + 1;
      } else {
        frame.previous = { punct: char };
      }
      index += 1;
    } else {
      if (!/\s/u.test(char)) {
        frame.previous = char === ')' || char === ']' ? { value: true } : { punct: char };
      }
      index += 1;
    }
  }
}

/**
 * The published reader specifiers one source file seals, grouped by package name, in every shape
 * npx resolves.
 *
 * The scanner above is deliberately small -- it tracks nested template interpolations and regex
 * literals, and nothing else -- so it refuses rather than guesses: any specifier it cannot place in
 * a string or a comment throws, including one it can place in a regex literal and one it can place
 * nowhere at all. Silently dropping one would hide it from the publish guard, which is the failure
 * this scan exists to prevent.
 */
export function collectPinsFromSource(text, label = 'source') {
  const spans = [...literalAndCommentSpans(text)];
  const pins = new Map();
  const unclassified = [];
  for (const match of text.matchAll(READER_PIN_PATTERN)) {
    const specifier = `@colophon-claims/${match[1]}`;
    const span = spans.find(({ start, end }) => match.index >= start && match.index < end);
    if (span?.kind === 'string') addPin(pins, specifier, match[2]);
    else if (span?.kind !== 'comment') unclassified.push(`${specifier}@${match[2]}`);
  }
  if (unclassified.length > 0) {
    throw new Error(
      `cannot tell whether ${unclassified.join(', ')} in ${label} is sealed or explained; put the specifier in a plain string constant`,
    );
  }
  return groupPins(pins);
}

/**
 * Every reader specifier pinned by `CLAIM_PIN_SOURCES`, grouped by package name, deduplicated and
 * sorted.
 */
export function collectClaimReaderPins(repoRoot, sources = CLAIM_PIN_SOURCES) {
  const pins = new Map();
  for (const source of sources) {
    const text = readFileSync(resolve(repoRoot, ...source.split('/')), 'utf8');
    for (const [specifier, versions] of Object.entries(collectPinsFromSource(text, source))) {
      for (const version of versions) addPin(pins, specifier, version);
    }
  }
  return groupPins(pins);
}

/**
 * Every reader specifier a reader-instruction document tells a reader to run, grouped by package
 * name. Markdown has no string literals to scan and no comments to exclude, so the whole text
 * counts.
 */
export function collectReaderInstructionPins(repoRoot, docs = READER_INSTRUCTION_DOCS) {
  const pins = new Map();
  for (const doc of docs) {
    const text = readFileSync(resolve(repoRoot, ...doc.split('/')), 'utf8');
    for (const match of text.matchAll(READER_PIN_PATTERN)) {
      addPin(pins, `@colophon-claims/${match[1]}`, match[2]);
    }
  }
  return groupPins(pins);
}

/**
 * Refuses a reader instruction naming a reader version npm does not serve, resolving every pin
 * against its own package's ledger. An exact `X.Y.Z` must be published; a shorter `X` or `X.Y` line
 * must have a published version under it.
 *
 * The default authority is the offline release ledger, so this runs in CI without a network call.
 * The ledger names a release before the registry does, which leaves one window it cannot see: a
 * doc bumped in the same change as the receipt reads as resolvable until the manual publish
 * dispatch runs. That is the narrow, self-healing half; the shape it does catch -- a line npm has
 * never served at all -- is the one that strands a reader indefinitely.
 */
export function assertReaderInstructionPinsResolve(pins, published = registeredReaderReleases) {
  for (const [specifier, versions] of Object.entries(pins)) {
    const unresolvable = unresolvableAgainst(versions, published(specifier));
    if (unresolvable.length > 0) {
      throw new Error(
        `reader instructions name unpublished ${specifier}@${unresolvable.join(', @')}; a reader following them gets a 404`,
      );
    }
  }
  return pins;
}

/**
 * Refuses a publish whose version and whose in-tree claim pins disagree, in either direction.
 *
 * The workflow is a manual dispatch against whatever the default branch's HEAD is at the moment it
 * runs, so nothing but this check couples the reader being published to the bundles this tree
 * builds. Publishing a version no pin names ships a reader no bundle asks for; leaving a pin on a
 * version that is neither published nor about to be published ships bundles whose sealed command
 * 404s, or whose compatible line resolves to a reader that refuses their format.
 *
 * A bundle asks for a reader two ways, and both count. An exact `X.Y.Z` pin names one release; a
 * compatible `X.Y` line names every patch under it, which is what that line is for -- the closures
 * carrying it are frozen and cannot be repointed, so requiring an exact pin would leave a
 * verifier-only patch release unpublishable by the very design meant to deliver it (issue #3687).
 */
export function assertClaimPinsMatchPublish(
  pins,
  publishVersion,
  published = registeredReaderReleases('@colophon-claims/verify'),
) {
  const resolvable = new Set([...published, publishVersion]);
  const exact = pins.filter((pin) => pin.split('.').length === 3);
  const unresolvable = exact.filter((pin) => !resolvable.has(pin));
  if (unresolvable.length > 0) {
    throw new Error(
      `claim pins name unpublished verifier ${unresolvable.join(', ')}; publish those before ${publishVersion}`,
    );
  }
  const unsatisfied = pins
    .filter((pin) => pin.split('.').length < 3)
    .filter((line) => ![...resolvable].some((version) => version.startsWith(`${line}.`)));
  if (unsatisfied.length > 0) {
    throw new Error(`claim compatible lines @${unsatisfied.join(', @')} resolve to no published verifier`);
  }
  const admittingLine = pins
    .filter((pin) => pin.split('.').length < 3)
    .find((line) => publishVersion.startsWith(`${line}.`));
  if (!exact.includes(publishVersion) && !admittingLine) {
    throw new Error(
      `no claim pin names ${publishVersion} and no compatible line admits it; publishing it would ship a reader no bundle in this tree asks for`,
    );
  }
  return pins;
}

/**
 * Applies the publish contract across both published reader names.
 *
 * The name being published carries the whole contract above -- its pins must resolve, and something
 * in the tree must ask for the exact version going out. Every other name is only checked for
 * resolvability: publishing the checker does not publish the alias, so the alias's pins may not
 * borrow the version about to be released to satisfy themselves (issue #4188).
 */
export function assertClaimReaderPinsMatchPublish(
  pins,
  packageName,
  publishVersion,
  published = registeredReaderReleases,
) {
  assertClaimPinsMatchPublish(pins[packageName] ?? [], publishVersion, published(packageName));
  for (const [specifier, versions] of Object.entries(pins)) {
    if (specifier === packageName) continue;
    const unresolvable = unresolvableAgainst(versions, published(specifier));
    if (unresolvable.length > 0) {
      throw new Error(
        `claim pins name unpublished ${specifier}@${unresolvable.join(', @')}; publishing ${packageName}@${publishVersion} does not publish them`,
      );
    }
  }
  return pins;
}

/**
 * Refuses a publish of a package that is not a reader while any reader pin in the tree names a
 * version npm does not serve.
 *
 * `core` and `cli` publish no reader, so no version of theirs can satisfy a reader pin, and the
 * offline ledger names a release before npm serves it, so it is not evidence here either. Both are
 * dispatched after `check`, which publishes the checker and its alias; a core published before
 * them would seal claims -- the composed `/10` claim pins the first checker release -- whose reader
 * line 404s (issue #4746).
 */
export function assertClaimReaderPinsServed(pins, publishing, served) {
  for (const [specifier, versions] of Object.entries(pins)) {
    const unserved = unresolvableAgainst(versions, served(specifier));
    if (unserved.length > 0) {
      throw new Error(
        `claim pins name ${specifier}@${unserved.join(', @')}, which npm does not serve; publish ${specifier} before ${publishing}`,
      );
    }
  }
  return pins;
}

export async function checkClaimPins(repoRoot, manifest, published, fetchImpl = fetch) {
  if (!Object.hasOwn(READER_RELEASES, manifest.name)) {
    const pins = collectClaimReaderPins(repoRoot);
    const served = new Map();
    for (const specifier of Object.keys(pins)) {
      served.set(specifier, await fetchPublishedReaderVersions(specifier, fetchImpl, { ledgerOnNotFound: false }));
    }
    return assertClaimReaderPinsServed(pins, `${manifest.name}@${manifest.version}`, (specifier) => served.get(specifier));
  }
  const registry = published ?? await fetchPublishedReaderVersions(manifest.name, fetchImpl);
  return assertClaimReaderPinsMatchPublish(
    collectClaimReaderPins(repoRoot),
    manifest.name,
    manifest.version,
    (packageName) => (packageName === manifest.name ? registry : registeredReaderReleases(packageName)),
  );
}

const MODES = ['--apply', '--check-claim-pins', '--check-receipt'];

function parseArgs(argv) {
  if (!MODES.includes(argv[0]) || !argv[1]) {
    throw new Error(`usage: node .github/scripts/colophon-publish-manifest.mjs ${MODES.join('|')} <package.json>`);
  }
  return { mode: argv[0], manifestPath: argv[1] };
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const { mode, manifestPath } = parseArgs(process.argv.slice(2));
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, manifestPath), 'utf8'));
    if (mode === '--check-claim-pins') {
      await checkClaimPins(repoRoot, manifest);
      process.stdout.write(`claim pins agree with ${manifest.name}@${manifest.version}\n`);
    } else if (mode === '--check-receipt') {
      const pin = await checkProductReleaseReceipt(repoRoot, manifest);
      process.stdout.write(
        `the ${manifest.name}@${manifest.version} receipt matches npm, and this commit's platform source matches ${pin.platformSourceSha} (tests aside)\n`,
      );
    } else {
      const pin = loadProductReleasePlatformPin(repoRoot, manifest);
      const gitHead = COMMIT_SHA.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : undefined;
      applyColophonPublishManifest(resolve(repoRoot, manifestPath), pin, { gitHead });
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
