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
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { canonicalJsonBytes, catalogSha256 } from './build-prepublication-bundle.mjs';
import { loadCatalogPackages, loadPlatformCatalog, loadStackPublishedCatalogPackages, requireStackPublishedReleaseGroup } from './platform-catalog.mjs';
import {
  deriveNativeVerticalRoleClosures,
  loadNativeVerticalRoleFixtures,
  nativeVerticalRuntimePackageNames,
} from './native-vertical-role-packages.mjs';

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const UNREACHABLE_SCOPED_REGISTRY = 'http://127.0.0.1:9/';

function defaultExec(command, args, cwd, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  delete env.NODE_AUTH_TOKEN;
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  return {
    status: result.error ? 1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

function requireSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout || `status ${result.status}`).trim()}`);
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} ${path}: ${error?.message ?? String(error)}`);
  }
}

function sameNames(left, right) {
  return left.length === right.length
    && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function assertNoForbiddenLocalProvenance(value, context) {
  if (typeof value === 'string') {
    if (/^(?:file|link|portal|workspace):/iu.test(value)) {
      throw new Error(`${context} retains forbidden local provenance ${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenLocalProvenance(item, context);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) assertNoForbiddenLocalProvenance(item, context);
  }
}

function inside(child, parent) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`));
}

function removeNpmBinShims(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.bin') rmSync(absolute, { recursive: true, force: true });
      else removeNpmBinShims(absolute);
    }
  }
}

function walkSourceFiles(directory, prefix, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const absolute = join(directory, entry.name);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkSourceFiles(absolute, path, found);
    else if (entry.isFile()) found.add(path);
  }
}

function flattenedExportTargets(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(flattenedExportTargets);
}

export function sourceWildcardExportViolations(repoRoot) {
  const violations = [];
  for (const pkg of loadStackPublishedCatalogPackages(repoRoot)) {
    const files = new Set();
    walkSourceFiles(join(repoRoot, pkg.directory), '', files);
    for (const [key, value] of Object.entries(pkg.manifest.exports ?? {})) {
      if (!key.includes('*')) continue;
      const targets = flattenedExportTargets(value).map((target) => target.replace(/^\.\//u, ''));
      const matched = targets.some((target) => {
        const star = target.indexOf('*');
        if (star === -1) return false;
        const prefix = target.slice(0, star);
        const suffix = target.slice(star + 1);
        return [...files].some((file) => file.startsWith(prefix) && file.endsWith(suffix));
      });
      if (!matched) violations.push(`${pkg.name}: export ${key} has no source targets to pack`);
    }
  }
  return violations.sort();
}

function publicFileInventory(repoRoot, pkg) {
  const found = new Set();
  for (const kind of ['schemas', 'profiles', 'fixtures']) {
    for (const directory of pkg.catalog.publicSurface[kind]) {
      walkSourceFiles(join(repoRoot, pkg.directory, directory), directory, found);
    }
  }
  return [...found].sort();
}

function validateBundle(repoRoot, manifestPath) {
  const manifest = readJson(manifestPath, 'prepublication manifest');
  if (manifest.schemaVersion !== 1) throw new Error('prepublication manifest schemaVersion must be 1');
  if (!COMMIT_SHA.test(String(manifest.sourceSha))) {
    throw new Error('prepublication manifest sourceSha must be a 40-character lowercase commit SHA');
  }
  const actualCatalogDigest = catalogSha256(repoRoot);
  if (manifest.catalog?.sha256 !== actualCatalogDigest) {
    throw new Error(
      `prepublication catalog digest mismatch: manifest ${manifest.catalog?.sha256 ?? '<missing>'}, checked out ${actualCatalogDigest}`,
    );
  }

  const allCatalogPackages = loadCatalogPackages(repoRoot);
  let catalogPackages;
  if (manifest.selection?.kind === 'native-vertical-runtime-closure') {
    const roleRoots = Object.fromEntries(Object.entries(loadNativeVerticalRoleFixtures(repoRoot))
      .map(([role, { roots }]) => [role, roots]));
    if (!sameNames(Object.keys(manifest.selection.roleRoots ?? {}), Object.keys(roleRoots))
      || Object.entries(roleRoots).some(([role, roots]) => (
        !sameNames(manifest.selection.roleRoots[role] ?? [], roots)
      ))) {
      throw new Error('native vertical role roots do not match the checked-in runtime imports');
    }
    // Phase C removed the task-supply publication canary. The packed native bundle is now the
    // executable role closure only; disabled experimental packages are included solely when a
    // role actually depends on them.
    const promoted = new Set();
    const selected = new Set(nativeVerticalRuntimePackageNames(
      repoRoot,
      allCatalogPackages,
      [...promoted],
    ));
    catalogPackages = allCatalogPackages.filter(({ name }) => selected.has(name));
    const closureOnly = [...selected].filter((name) => !promoted.has(name)).sort();
    if (JSON.stringify(manifest.selection.closureOnlyPackages) !== JSON.stringify(closureOnly)) {
      throw new Error('native vertical closure-only package set does not match the catalog-derived closure');
    }
  } else {
    catalogPackages = allCatalogPackages.filter(({ catalog }) => catalog.releaseGroup === manifest.releaseGroup);
    requireStackPublishedReleaseGroup(loadPlatformCatalog(repoRoot), manifest.releaseGroup);
  }
  const catalogNames = catalogPackages.map(({ name }) => name);
  const order = manifest.packageOrder;
  const waveOrder = Array.isArray(manifest.waves) ? manifest.waves.flat() : [];
  const tarballNames = Array.isArray(manifest.tarballs)
    ? manifest.tarballs.map(({ name }) => name)
    : [];
  if (!Array.isArray(order)
    || new Set(order).size !== order.length
    || !sameNames(order, catalogNames)
    || JSON.stringify(order) !== JSON.stringify(waveOrder)
    || JSON.stringify(order) !== JSON.stringify(tarballNames)) {
    throw new Error('bundle package set does not match its catalog-derived package selection');
  }

  const bundleRoot = dirname(resolve(manifestPath));
  const tarballs = manifest.tarballs.map((tarball) => {
    if (typeof tarball.filename !== 'string' || !SRI_SHA512.test(String(tarball.integrity))) {
      throw new Error(`invalid tarball record for ${tarball.name ?? '<missing>'}`);
    }
    const path = resolve(bundleRoot, ...tarball.filename.split('/'));
    if (!inside(path, bundleRoot)) throw new Error(`tarball path escapes the bundle: ${tarball.filename}`);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`missing tarball for ${tarball.name}: ${tarball.filename}`);
    }
    const actual = `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;
    if (actual !== tarball.integrity) {
      throw new Error(`tarball integrity mismatch for ${tarball.name}: manifest ${tarball.integrity}, actual ${actual}`);
    }
    return { ...tarball, path };
  });

  return { manifest, catalogPackages, tarballs };
}

async function consumerProbeMain() {
  const {
    existsSync: fileExists,
    lstatSync: fileLstat,
    readFileSync: readFile,
    readdirSync: readDirectory,
    realpathSync: realPath,
    statSync: fileStat,
    writeFileSync: writeFile,
  } = await import('node:fs');
  const { join: joinPath, relative: relativePath, resolve: resolvePath, sep: pathSeparator } = await import('node:path');
  const { fileURLToPath: urlToPath } = await import('node:url');

  const consumerRoot = process.cwd();
  const expectations = JSON.parse(readFile(joinPath(consumerRoot, 'consumer-expectations.json'), 'utf8'));

  function assertNoLocalSpecs(value, context) {
    if (typeof value === 'string') {
      if (/^(?:file|link|portal|workspace):/iu.test(value)) {
        throw new Error(`${context} retains forbidden local specifier ${value}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) assertNoLocalSpecs(item, context);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) assertNoLocalSpecs(item, context);
    }
  }

  if (fileExists(joinPath(consumerRoot, 'package-lock.json'))
    || fileExists(joinPath(consumerRoot, 'node_modules', '.package-lock.json'))) {
    throw new Error('clean consumer retained a package-lock with installation provenance');
  }
  assertNoLocalSpecs(
    JSON.parse(readFile(joinPath(consumerRoot, 'package.json'), 'utf8')),
    'clean consumer package.json',
  );

  function walk(directory, prefix = '') {
    const files = [];
    for (const entry of readDirectory(directory, { withFileTypes: true })) {
      const absolute = joinPath(directory, entry.name);
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) files.push(...walk(absolute, path));
      else if (entry.isFile()) files.push(path);
    }
    return files.sort();
  }

  function exportTargets(value) {
    if (typeof value === 'string') return [value];
    if (!value || typeof value !== 'object') return [];
    return Object.values(value).flatMap(exportTargets);
  }

  function specifierForFile(name, exportsMap, file) {
    for (const [key, value] of Object.entries(exportsMap ?? {})) {
      for (const rawTarget of exportTargets(value)) {
        const target = rawTarget.replace(/^\.\//u, '');
        const star = target.indexOf('*');
        if (star === -1) {
          if (target === file && !key.includes('*')) return `${name}${key === '.' ? '' : key.slice(1)}`;
          continue;
        }
        if (!key.includes('*')) continue;
        const prefix = target.slice(0, star);
        const suffix = target.slice(star + 1);
        if (!file.startsWith(prefix) || !file.endsWith(suffix)) continue;
        const replacement = file.slice(prefix.length, file.length - suffix.length || undefined);
        return `${name}${key.slice(1).replace('*', replacement)}`;
      }
    }
    throw new Error(`${name}: installed public file ${file} is not reachable through package exports`);
  }

  function wildcardReplacement(target, file) {
    const star = target.indexOf('*');
    if (star === -1) return null;
    const prefix = target.slice(0, star);
    const suffix = target.slice(star + 1);
    if (!file.startsWith(prefix) || !file.endsWith(suffix)) return null;
    return file.slice(prefix.length, file.length - suffix.length || undefined);
  }

  function assertResolvedFile(specifier, expectedRoot, expectedRelative) {
    const resolvedUrl = import.meta.resolve(specifier);
    if (!resolvedUrl.startsWith('file:')) throw new Error(`${specifier} resolved outside the installed filesystem`);
    const resolved = urlToPath(resolvedUrl);
    if (!fileExists(resolved) || !fileStat(resolved).isFile()) {
      throw new Error(`${specifier} resolved to missing installed target ${resolved}`);
    }
    const within = relativePath(expectedRoot, resolved);
    if (within === '..' || within.startsWith(`..${pathSeparator}`)) {
      throw new Error(`${specifier} escaped installed package ${expectedRoot}`);
    }
    if (expectedRelative && resolvePath(expectedRoot, ...expectedRelative.split('/')) !== resolved) {
      throw new Error(`${specifier} resolved to ${within}, expected ${expectedRelative}`);
    }
  }

  const resolvedSpecifiers = new Set();
  for (const expected of expectations.packages) {
    const packageRoot = joinPath(consumerRoot, 'node_modules', ...expected.name.split('/'));
    const manifestPath = joinPath(packageRoot, 'package.json');
    if (!fileExists(manifestPath)) throw new Error(`${expected.name}: installed package is missing`);
    if (fileLstat(packageRoot).isSymbolicLink()) {
      throw new Error(`${expected.name}: installed package is a symbolic link`);
    }
    const realPackageRoot = realPath(packageRoot);
    const relativeRealRoot = relativePath(realPath(consumerRoot), realPackageRoot);
    if (relativeRealRoot === '..' || relativeRealRoot.startsWith(`..${pathSeparator}`)) {
      throw new Error(`${expected.name}: installed package resolves outside the clean consumer`);
    }
    const manifest = JSON.parse(readFile(manifestPath, 'utf8'));
    assertNoLocalSpecs(manifest, `${expected.name} installed manifest`);
    if (manifest.name !== expected.name
      || manifest.version !== expectations.packageVersion
      || manifest.gitHead !== expectations.sourceSha) {
      throw new Error(`${expected.name}: installed identity/version/gitHead does not match the bundle`);
    }
    if (JSON.stringify(manifest.exports ?? {}) !== JSON.stringify(expected.exports ?? {})) {
      throw new Error(`${expected.name}: installed export map does not match the source manifest`);
    }

    const installedFiles = walk(packageRoot);
    for (const [key, value] of Object.entries(manifest.exports ?? {})) {
      const targets = exportTargets(value).map((target) => target.replace(/^\.\//u, ''));
      if (key.includes('*')) {
        const captures = new Set();
        for (const target of targets) {
          for (const file of installedFiles) {
            const replacement = wildcardReplacement(target, file);
            if (replacement !== null) captures.add(replacement);
          }
        }
        if (captures.size === 0) {
          throw new Error(`${expected.name}: export ${key} has no installed tarball targets`);
        }
        for (const capture of captures) {
          for (const target of targets) {
            const concreteTarget = target.split('*').join(capture);
            const targetPath = joinPath(packageRoot, ...concreteTarget.split('/'));
            if (!fileExists(targetPath) || !fileStat(targetPath).isFile()) {
              throw new Error(
                `${expected.name}: export ${key} capture ${capture} is missing target ${concreteTarget}`,
              );
            }
          }
          const specifier = `${expected.name}${key.slice(1).split('*').join(capture)}`;
          assertResolvedFile(specifier, packageRoot);
          resolvedSpecifiers.add(specifier);
        }
      } else {
        for (const target of targets) {
          if (target.includes('*')) continue;
          const targetPath = joinPath(packageRoot, ...target.split('/'));
          if (!fileExists(targetPath) || !fileStat(targetPath).isFile()) {
            throw new Error(`${expected.name}: export ${key} points at missing installed target ${target}`);
          }
        }
        const specifier = key === '.' ? expected.name : `${expected.name}${key.slice(1)}`;
        assertResolvedFile(specifier, packageRoot);
        resolvedSpecifiers.add(specifier);
      }
    }

    assertResolvedFile(expected.name, packageRoot);
    resolvedSpecifiers.add(expected.name);

    for (const subpath of expected.publicSurface.conformance) {
      const specifier = subpath === '.' ? expected.name : `${expected.name}${subpath.slice(1)}`;
      assertResolvedFile(specifier, packageRoot);
      resolvedSpecifiers.add(specifier);
    }

    const visited = new Set();
    for (const file of expected.publicFiles) {
      const absolute = joinPath(packageRoot, ...file.split('/'));
      if (!fileExists(absolute) || !fileStat(absolute).isFile()) {
        throw new Error(`${expected.name}: missing expected public file ${file}`);
      }
      const specifier = specifierForFile(expected.name, manifest.exports, file);
      assertResolvedFile(specifier, packageRoot, file);
      resolvedSpecifiers.add(specifier);
      visited.add(file);
    }
    for (const kind of ['schemas', 'profiles', 'fixtures']) {
      for (const directory of expected.publicSurface[kind]) {
        const absolute = joinPath(packageRoot, ...directory.split('/'));
        if (!fileExists(absolute) || !fileStat(absolute).isDirectory()) {
          throw new Error(`${expected.name}: missing installed publicSurface.${kind} directory ${directory}`);
        }
        const files = walk(absolute).map((file) => `${directory}/${file}`);
        if (files.length === 0) {
          throw new Error(`${expected.name}: publicSurface.${kind} directory ${directory} contains no files`);
        }
        for (const file of files) {
          if (visited.has(file)) continue;
          visited.add(file);
          const specifier = specifierForFile(expected.name, manifest.exports, file);
          assertResolvedFile(specifier, packageRoot, file);
          resolvedSpecifiers.add(specifier);
        }
      }
    }
  }
  if (expectations.role) {
    const namespace = await import('./role-fixture.mjs');
    if (namespace.role !== expectations.role) {
      throw new Error(`${expectations.role}: role fixture did not start with the expected identity`);
    }
    if (expectations.role === 'consumer') {
      const reportPath = joinPath(consumerRoot, 'native-vertical-verification.json');
      if (!fileExists(reportPath)) throw new Error('consumer fixture did not emit its verification report');
      const report = JSON.parse(readFile(reportPath, 'utf8'));
      const requiredChecks = [
        'exact-record-digests',
        'grant-free-evaluation-submission',
        'requester-admission-executor-evaluator-bindings',
        'execution-evidence-graph',
        'solution-delivery-graph',
        'pair-fixed-evaluation-task',
        'signed-result-evaluation-statement',
        'evaluation-delivery-verdict-join',
        'decision-grade-verdict-gate',
        'signed-discovery-entry',
      ];
      if (report.schemaVersion !== 1 || report.decisionGrade !== true
        || !Array.isArray(report.records) || report.records.length < 14
        || report.records.some((record) => !String(record.digest).match(/^sha256:[a-f0-9]{64}$/u))
        || !Array.isArray(report.bindings) || report.bindings.length < 6
        || requiredChecks.some((check) => !report.checks?.includes(check))
        || !String(report.operations?.solutionSettlementId).match(/^sha256:[a-f0-9]{64}$/u)
        || !String(report.operations?.verdictSettlementId).match(/^sha256:[a-f0-9]{64}$/u)
        || !String(report.sourceHead?.entry).match(/^sha256:[a-f0-9]{64}$/u)
        || JSON.stringify(report).includes('"verified":true')) {
        throw new Error('consumer fixture emitted an invalid verification report');
      }
      if (JSON.stringify(report).includes(consumerRoot)) {
        throw new Error('consumer verification report contains a private state path');
      }
    }
  }
  const resolutionProvenance = [...resolvedSpecifiers].sort().map((specifier) => {
    const resolved = urlToPath(import.meta.resolve(specifier));
    const path = relativePath(consumerRoot, resolved).split(pathSeparator).join('/');
    if (path === '..' || path.startsWith('../')) {
      throw new Error(`${specifier}: module-resolution provenance escapes the clean consumer`);
    }
    return { specifier, path };
  });
  writeFile(
    joinPath(consumerRoot, 'module-resolution-provenance.json'),
    `${JSON.stringify({ schemaVersion: 1, resolutions: resolutionProvenance })}\n`,
    'utf8',
  );
  console.log(
    `resolved ${resolvedSpecifiers.size} installed targets across ${expectations.packages.length} packages`
    + `${expectations.role ? ` and started ${expectations.role}` : ''}`,
  );
}

function probeSource() {
  return `(${consumerProbeMain.toString()})().catch((error) => {\n  console.error(error?.message ?? String(error));\n  process.exitCode = 1;\n});\n`;
}

export function writeConsumerProbe({ consumerRoot, expectations }) {
  writeFileSync(
    join(consumerRoot, 'consumer-expectations.json'),
    `${JSON.stringify(expectations)}\n`,
    'utf8',
  );
  writeFileSync(join(consumerRoot, 'consumer-probe.mjs'), probeSource(), 'utf8');
}

export function runConsumerProbe({ consumerRoot, exec = defaultExec }) {
  return exec(process.execPath, ['consumer-probe.mjs'], consumerRoot);
}

export async function runTarballConsumer({
  repoRoot,
  manifestPath,
  manifestPaths,
  nativeManifestPath,
  keep = false,
  exec = defaultExec,
}) {
  const root = resolve(repoRoot);
  const paths = [...new Set((manifestPaths ?? []).concat(manifestPath ? [manifestPath] : []))]
    .map((path) => resolve(path));
  if (paths.length === 0) throw new Error('--manifest is required');
  const bundles = paths.map((path) => validateBundle(root, path));
  const names = bundles.flatMap((bundle) => bundle.catalogPackages.map(({ name }) => name));
  if (new Set(names).size !== names.length) {
    throw new Error('stack-published prepublication manifests contain overlapping packages');
  }
  const identities = new Set(bundles.map((bundle) => JSON.stringify({
    sourceSha: bundle.manifest.sourceSha,
    catalog: bundle.manifest.catalog,
    packageVersion: bundle.manifest.packageVersion,
  })));
  if (identities.size !== 1) {
    throw new Error('stack-published prepublication manifests do not share one exact source identity');
  }
  const validated = {
    manifest: bundles[0].manifest,
    catalogPackages: bundles.flatMap((bundle) => bundle.catalogPackages),
    tarballs: bundles.flatMap((bundle) => bundle.tarballs),
  };
  const nativeValidated = nativeManifestPath
    ? validateBundle(root, resolve(nativeManifestPath))
    : undefined;
  if (nativeValidated && (
    nativeValidated.manifest.sourceSha !== validated.manifest.sourceSha
    || nativeValidated.manifest.catalog.sha256 !== validated.manifest.catalog.sha256
    || nativeValidated.manifest.packageVersion !== validated.manifest.packageVersion
  )) throw new Error('platform and native role bundles do not share one exact source identity');
  const consumerRoots = [];
  try {
    const install = ({ label, bundle, packages, role, fixtureSource }) => {
      const consumerRoot = mkdtempSync(join(tmpdir(), `jinn-${label}-prepublication-consumer-`));
      consumerRoots.push(consumerRoot);
      const selected = new Set(packages.map(({ name }) => name));
      const tarballs = bundle.tarballs.filter(({ name }) => selected.has(name));
      if (tarballs.length !== packages.length) throw new Error(`${label}: bundle is missing role closure tarballs`);
      const dependencies = Object.fromEntries(packages.map(({ name }) => [
        name,
        bundle.manifest.packageVersion,
      ]));
      writeFileSync(join(consumerRoot, 'package.json'), canonicalJsonBytes({
        name: `jinn-${label}-prepublication-consumer`,
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies,
      }), 'utf8');
      writeFileSync(join(consumerRoot, '.npmrc'), [
        `@jinn-network:registry=${UNREACHABLE_SCOPED_REGISTRY}`,
        'fetch-retries=0',
        'audit=false',
        'fund=false',
        '',
      ].join('\n'), 'utf8');
      writeConsumerProbe({
        consumerRoot,
        expectations: {
          sourceSha: bundle.manifest.sourceSha,
          packageVersion: bundle.manifest.packageVersion,
          role,
          packages: packages.map((pkg) => ({
            name: pkg.name,
            exports: pkg.manifest.exports ?? {},
            publicFiles: publicFileInventory(root, pkg),
            publicSurface: pkg.catalog.publicSurface,
          })),
        },
      });
      if (fixtureSource) writeFileSync(join(consumerRoot, 'role-fixture.mjs'), fixtureSource, 'utf8');
      const isolatedHome = join(consumerRoot, '.home');
      const isolatedCache = join(consumerRoot, '.npm-cache');
      mkdirSync(isolatedHome);
      mkdirSync(isolatedCache);
      requireSuccess(exec('npm', [
        'install',
        '--no-save',
        '--no-package-lock',
        '--ignore-scripts',
        '--registry',
        'https://registry.npmjs.org',
        ...tarballs.map(({ path }) => path),
      ], consumerRoot, {
        env: { HOME: isolatedHome, npm_config_cache: isolatedCache },
      }), `${label} clean versioned tarball install`);
      // npm 11 writes an internal installation lock even when package-lock is disabled. It records
      // the transient tarball paths, so it is not acceptable retained provenance for this proof.
      // The versioned root manifest plus npm-ls document below are the durable provenance record.
      rmSync(join(consumerRoot, 'node_modules', '.package-lock.json'), { force: true });
      // npm also creates executable symlinks for package bins. The acceptance fixtures start with
      // node directly, so retain neither those shims nor any symlink-shaped resolution provenance.
      removeNpmBinShims(join(consumerRoot, 'node_modules'));
      requireSuccess(runConsumerProbe({ consumerRoot, exec }), `${label} installed public-target probe`);
      const provenance = exec('npm', ['ls', '--all', '--json'], consumerRoot, {
        env: { HOME: isolatedHome, npm_config_cache: isolatedCache },
      });
      requireSuccess(provenance, `${label} dependency provenance`);
      const provenanceDocument = JSON.parse(provenance.stdout || '{}');
      assertNoForbiddenLocalProvenance(provenanceDocument, `${label} npm dependency provenance`);
      writeFileSync(
        join(consumerRoot, 'dependency-provenance.json'),
        canonicalJsonBytes(provenanceDocument),
        'utf8',
      );
      return {
        label,
        consumerRoot,
        packageCount: packages.length,
        provenance: provenanceDocument,
      };
    };

    const results = [install({
      label: 'platform',
      bundle: validated,
      packages: validated.catalogPackages,
    })];
    if (nativeValidated) {
      const roles = deriveNativeVerticalRoleClosures(root, nativeValidated.catalogPackages);
      const byName = new Map(nativeValidated.catalogPackages.map((pkg) => [pkg.name, pkg]));
      for (const [role, definition] of Object.entries(roles)) {
        results.push(install({
          label: `native-${role}`,
          role,
          fixtureSource: definition.source,
          bundle: nativeValidated,
          packages: definition.closure.map((name) => byName.get(name)),
        }));
      }
    }
    return { packageCount: validated.catalogPackages.length, results };
  } finally {
    if (!keep) for (const consumerRoot of consumerRoots) {
      rmSync(consumerRoot, { recursive: true, force: true });
    }
  }
}

function parseArgs(argv) {
  const parsed = { repoRoot: process.cwd(), keep: false, manifestPaths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--keep') {
      parsed.keep = true;
      continue;
    }
    if (flag !== '--root' && flag !== '--manifest' && flag !== '--native-manifest') {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    if (flag === '--root') parsed.repoRoot = value;
    if (flag === '--manifest') parsed.manifestPaths.push(value);
    if (flag === '--native-manifest') parsed.nativeManifestPath = value;
    index += 1;
  }
  if (parsed.manifestPaths.length === 0) throw new Error('--manifest is required');
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runTarballConsumer(args);
    console.log(`external consumer accepted ${result.packageCount} prepublication tarballs`);
    if (args.keep) for (const entry of result.results) {
      console.log(`${entry.label} prefix: ${entry.consumerRoot}`);
    }
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
