import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEPENDENCY_SECTIONS } from './stack-package-graph.mjs';

export const COLOPHON_PUBLISH_WORKFLOW = 'colophon-npm-publish.yml';
export const FIRST_CUT_PLATFORM_PIN_PATH = 'packages/benchmark-product/first-cut-platform-pin.json';
export const PRODUCT_RELEASE_PLATFORM_PINS_PATH = 'packages/benchmark-product/product-release-platform-pins.json';

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const EXACT_CANARY_PIN = /^0\.1\.0-canary\.sha\.[0-9a-f]{40}$/u;
/**
 * Registered product releases, keyed `<package name>@<version>`. Issue #3023 split the reader's
 * published identity: the checker now publishes as `@colophon-claims/check` and
 * `@colophon-claims/verify` stays published as a passthrough alias. Both keys live here so a
 * receipt is bound to the name it was actually issued for — an alias release must never inherit
 * the checker's canary receipt, and vice versa. The two `@colophon-claims/verify` entries below
 * are the already-published 0.2 line and are byte-frozen: their `receiptSha256` covers the pin
 * object, `product.packageName` included.
 */
const PRODUCT_RELEASES = {
  '@colophon-claims/verify@0.2.0': {
    decision: 'DR-2026-08-22-a',
    platformSourceSha: 'e00b2fc47fc5635b007eb349fb1e41aa81bb3c50',
    stackPublishRunUrl: 'https://github.com/Jinn-Network/mono/actions/runs/32544891098/attempts/2',
    receiptSha256: '8c6749c2e6c303b17ceccbc12712e1210e275dcdbcb37fd495a14a15cbb4474e',
  },
  '@colophon-claims/verify@0.2.1': {
    decision: 'operator-authorization-2026-08-26',
    platformSourceSha: '7a138d2c104d09243e306952d0ce77caa64e4707',
    stackPublishRunUrl: 'https://github.com/Jinn-Network/mono/actions/runs/32976208098',
    receiptSha256: 'fdd1ecf49eb6c0cec4b05e5c0d201dfcacbbeaf8164f766b9ca5e27b646b6dad',
  },
};
const PRODUCT_RELEASE_KEYS = Object.keys(PRODUCT_RELEASES);
const releaseKey = (packageName, version) => `${packageName}@${version}`;
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
  if (!hasExactKeys(pin, VERIFY_020_RECEIPT_KEYS) || !hasExactKeys(pin.product, VERIFY_020_PRODUCT_KEYS)) {
    throw new Error('product-release pin must retain the immutable verifier 0.2 receipt shape');
  }
  const release = PRODUCT_RELEASES[releaseKey(pin?.product?.packageName, pin?.product?.version)];
  if (
    release === undefined
    || pin?.decision !== release.decision
    || pin.platformSourceSha !== release.platformSourceSha
    || pin.platformVersion !== `0.1.0-canary.sha.${release.platformSourceSha}`
    || manifest.name !== pin.product.packageName
    || manifest.version !== pin.product.version
  ) {
    throw new Error(`only a registered ${pin?.product?.packageName ?? '<missing>'} release may use its exact canary receipt`);
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
    || pin.platformLatestVersion !== '0.0.0'
    || pin.stackPublishRunUrl !== release.stackPublishRunUrl
  ) {
    throw new Error('product-release pin must retain its recorded stack-canary receipt');
  }
  const directNames = Object.keys(manifest.dependencies ?? {})
    .filter((name) => name.startsWith('@jinn-network/'));
  const packages = pin.platformPackages;
  if (!Array.isArray(packages) || packages.length !== VERIFY_020_PLATFORM_CLOSURE.length) {
    throw new Error('product-release pin must record the complete verifier 0.2 Jinn closure');
  }
  const names = packages.map((pkg) => pkg?.name);
  if (JSON.stringify(names) !== JSON.stringify(VERIFY_020_PLATFORM_CLOSURE)) {
    throw new Error('product-release pin Jinn package names must be the sorted verifier 0.2 closure');
  }
  if (directNames.some((name) => !names.includes(name))) {
    throw new Error('product-release pin must include every direct Jinn dependency');
  }
  for (const pkg of packages) {
    if (!hasExactKeys(pkg, VERIFY_020_PACKAGE_KEYS)) {
      throw new Error(`product-release pin package row shape drift for ${pkg?.name ?? '<missing>'}`);
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
    throw new Error(`product-release pin must retain the immutable verifier ${pin.product.version} receipt values`);
  }
  return pin;
}

export function validateProductReleasePlatformPins(pins, manifest) {
  if (
    !hasExactKeys(pins, PRODUCT_RELEASE_PINS_KEYS)
    || pins.schemaVersion !== 1
    || !Array.isArray(pins.receipts)
    || JSON.stringify(pins.receipts.map((pin) => releaseKey(pin?.product?.packageName, pin?.product?.version)))
      !== JSON.stringify(PRODUCT_RELEASE_KEYS)
  ) {
    throw new Error('product-release platform pins must contain the exact ordered registered release receipts');
  }
  for (const pin of pins.receipts) {
    validateProductReleasePlatformPin(pin, {
      ...manifest,
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

export function applyColophonPublishManifest(manifestPath, pin, options = {}) {
  const originalBytes = readFileSync(manifestPath, 'utf8');
  const patched = transformColophonManifestForPublish(JSON.parse(originalBytes), pin, options);
  writeFileSync(manifestPath, `${JSON.stringify(patched, null, 2)}\n`, 'utf8');
  return {
    restore() {
      writeFileSync(manifestPath, originalBytes, 'utf8');
    },
  };
}

function parseArgs(argv) {
  if (argv[0] !== '--apply' || !argv[1]) {
    throw new Error('usage: node .github/scripts/colophon-publish-manifest.mjs --apply <package.json>');
  }
  return { manifestPath: argv[1] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const { manifestPath } = parseArgs(process.argv.slice(2));
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, manifestPath), 'utf8'));
    const pin = loadProductReleasePlatformPin(repoRoot, manifest);
    const gitHead = COMMIT_SHA.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : undefined;
    applyColophonPublishManifest(resolve(repoRoot, manifestPath), pin, { gitHead });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
