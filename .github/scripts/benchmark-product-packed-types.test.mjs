// Local-registry cold-install proof for Colophon's public packages.
//
// This deliberately uses npm tarballs and a disposable in-process registry, rather than Yarn
// portals. It proves that a consumer can resolve core, cli, and verify as independently packed
// public packages while all Tier 1-3 dependencies retain their @jinn-network identity.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const familyRoot = join(root, 'packages', 'benchmark-product');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'colophon-packed-consumer-'));
const archivesRoot = join(temporaryRoot, 'archives');
const consumerRoot = join(temporaryRoot, 'consumer');
const readerRoot = join(temporaryRoot, 'reader');
const oneShotRoot = join(temporaryRoot, 'one-shot');

const PUBLIC_PACKAGES = [
  ['verify', '@colophon-claims/verify'],
  ['core', '@colophon-claims/core'],
  ['cli', '@colophon-claims/cli'],
];
const PACKED_EXCLUDED = [
  ['web', '@colophon-claims/web', 'private application with no public package entrypoint'],
];
const CROSS_TREE_PACKAGES = [
  ['@jinn-network/task-execution-protocol', join(root, 'packages/task-execution/protocol')],
  ['@jinn-network/trust-core', join(root, 'packages/trust/core')],
  ['@jinn-network/environment-record', join(root, 'packages/environments/record')],
  ['@jinn-network/task-execution-profiles', join(root, 'packages/task-execution/profiles')],
  ['@jinn-network/benchmarking-records', join(root, 'packages/benchmarking/records')],
  ['@jinn-network/benchmarking-aggregate', join(root, 'packages/benchmarking/aggregate')],
  ['@jinn-network/task-admission', join(root, 'packages/task-supply/admission')],
  ['@jinn-network/benchmarking-interop', join(root, 'packages/benchmarking/interop')],
  ['@jinn-network/task-execution-backend', join(root, 'packages/task-execution/backend')],
  ['@jinn-network/task-execution-supervisor', join(root, 'packages/task-execution/backend-local/supervisor')],
  ['@jinn-network/task-execution-workspace', join(root, 'packages/task-execution/backend-local/workspace')],
  ['@jinn-network/task-execution-launchers', join(root, 'packages/task-execution/backend-local/launchers')],
  ['@jinn-network/evidence-protocol', join(root, 'packages/evidence/protocol')],
  ['@jinn-network/evidence-repository', join(root, 'packages/evidence/repository')],
  ['@jinn-network/evidence-discovery', join(root, 'packages/evidence/discovery')],
  ['@jinn-network/execution-recorder', join(root, 'packages/evidence/execution-recorder')],
  ['@jinn-network/attestation-issuer', join(root, 'packages/evidence/attestation-issuer')],
  ['@jinn-network/task-execution-evaluation-harness', join(root, 'packages/task-execution/evaluation-harness')],
  ['@jinn-network/task-execution-evaluator-adapters', join(root, 'packages/task-execution/evaluator-adapters')],
  ['@jinn-network/task-execution-oci-grader', join(root, 'packages/task-execution/oci-grader')],
  ['@jinn-network/task-execution-backend-local', join(root, 'packages/task-execution/backend-local/assembly')],
  ['@jinn-network/benchmarking-run', join(root, 'packages/benchmarking/run')],
  ['@jinn-network/benchmarking-local', join(root, 'packages/benchmarking/local')],
];

function familyManifests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || ['.next', 'dist', 'node_modules'].includes(entry.name)) return [];
    const child = join(directory, entry.name);
    const manifest = join(child, 'package.json');
    return [...(existsSync(manifest) ? [manifest] : []), ...familyManifests(child)];
  });
}
function assertFamilyCoverage() {
  const discovered = familyManifests(familyRoot).flatMap((manifestPath) => {
    const { name } = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return typeof name === 'string' && name.startsWith('@colophon-claims/') ? [[relative(familyRoot, dirname(manifestPath)), name]] : [];
  }).sort();
  const registered = [...PUBLIC_PACKAGES, ...PACKED_EXCLUDED].map(([directory, name]) => [directory, name]).sort();
  if (JSON.stringify(discovered) !== JSON.stringify(registered)) {
    throw new Error(`Colophon package coverage drifted: discovered ${JSON.stringify(discovered)}, registered ${JSON.stringify(registered)}`);
  }
}
function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const stdout = []; const stderr = [];
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolvePromise(Buffer.concat(stdout).toString('utf8'))
      : reject(new Error(`${command} exited with ${code}:\n${Buffer.concat(stdout)}${Buffer.concat(stderr)}`)));
  });
}
function runExpectingExit(command, args, expectedExitCode, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const stdout = []; const stderr = [];
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => code === expectedExitCode
      ? resolvePromise({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
      : reject(new Error(`${command} exited with ${code}, expected ${expectedExitCode}:\n${Buffer.concat(stdout)}${Buffer.concat(stderr)}`)));
  });
}
function proveViewer(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    const stdout = []; const stderr = [];
    let settled = false;
    let probing = false;
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error('installed viewer did not become ready within 30 seconds'));
    }, 30_000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) resolvePromise(); else reject(error);
    };
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', async (chunk) => {
      stderr.push(chunk);
      const match = /Viewer: (http:\/\/127\.0\.0\.1:\d+\/launch\?token=\S+)/u.exec(Buffer.concat(stderr).toString('utf8'));
      if (match === null || settled || probing) return;
      probing = true;
      try {
        const launch = await fetch(match[1], { redirect: 'manual' });
        const cookie = launch.headers.get('set-cookie')?.split(';', 1)[0];
        if (launch.status !== 303 || launch.headers.get('location') !== '/' || cookie === undefined) throw new Error('viewer launch handshake failed');
        const headers = { cookie };
        const [home, report] = await Promise.all([
          fetch(new URL('/', match[1]), { headers }),
          fetch(new URL('/bundle/index.html', match[1]), { headers }),
        ]);
        const [homeBytes, reportBytes] = await Promise.all([home.text(), report.text()]);
        if (!home.ok || !homeBytes.includes('Verified: 6 of 6 checks passed')) throw new Error('verified viewer page was not served');
        if (!report.ok || !reportBytes.includes('Colophon report')) throw new Error('authenticated bundle report was not served');
        child.kill('SIGTERM');
      } catch (cause) {
        child.kill('SIGTERM');
        finish(cause);
      }
    });
    child.once('error', finish);
    child.once('exit', (code) => code === 0
      ? finish()
      : finish(new Error(`${command} viewer exited with ${code}:\n${Buffer.concat(stdout)}${Buffer.concat(stderr)}`)));
  });
}
async function packOne(directory, name) {
  const packed = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', archivesRoot], { cwd: directory }));
  if (packed.length !== 1 || typeof packed[0]?.filename !== 'string') throw new Error(`npm pack returned an unexpected result for ${name}`);
  return join(archivesRoot, packed[0].filename);
}
async function archiveFiles(archive) {
  return (await run('tar', ['-tzf', archive])).trim().split('\n').filter(Boolean);
}
function manifestFor(directory) { return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')); }
const isFirstParty = (name) => name.startsWith('@colophon-claims/') || name.startsWith('@jinn-network/');
function declaredFirstPartyClosure(records, roots) {
  const closure = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift();
    if (closure.has(name)) continue;
    closure.add(name);
    const manifest = records.get(name)?.manifest;
    if (manifest === undefined) throw new Error(`no local-registry manifest exists for first-party dependency ${name}`);
    for (const dependency of Object.keys(manifest.dependencies ?? {}).filter(isFirstParty)) queue.push(dependency);
  }
  return [...closure].sort();
}
function lockPackageName(location, record) {
  if (typeof record?.name === 'string') return record.name;
  const marker = 'node_modules/';
  const index = location.lastIndexOf(marker);
  if (index < 0) return undefined;
  const path = location.slice(index + marker.length);
  const segments = path.split('/');
  return path.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}
function installedFirstPartyClosure(lockBytes) {
  const lock = JSON.parse(lockBytes);
  return [...new Set(Object.entries(lock.packages ?? {}).flatMap(([location, record]) => {
    if (location === '') return [];
    const name = lockPackageName(location, record);
    return typeof name === 'string' && isFirstParty(name) ? [name] : [];
  }))].sort();
}
function npxInstalledBinary(cacheRoot, binary) {
  const npxRoot = join(cacheRoot, '_npx');
  const candidates = readdirSync(npxRoot).map((entry) => join(npxRoot, entry, 'node_modules', '.bin', binary)).filter(existsSync);
  if (candidates.length !== 1) throw new Error(`expected one cached npx ${binary} binary, found ${JSON.stringify(candidates)}`);
  return candidates[0];
}
async function startRegistry(records) {
  const requests = new Set();
  let baseUrl = '';
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', baseUrl).pathname);
    const record = records.get(pathname.slice(1));
    if (record !== undefined) {
      requests.add(`metadata:${record.manifest.name}`);
      const metadata = { name: record.manifest.name, 'dist-tags': { latest: record.manifest.version }, versions: {
        [record.manifest.version]: { ...record.manifest, dist: { tarball: `${baseUrl}${record.tarballPath}`, integrity: record.integrity } },
      } };
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(metadata)); return;
    }
    const tarball = [...records.values()].find((candidate) => candidate.tarballPath === pathname);
    if (tarball !== undefined) {
      requests.add(`tarball:${tarball.manifest.name}`);
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(readFileSync(tarball.archive)); return;
    }
    response.writeHead(404); response.end('not found');
  });
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('ephemeral registry did not expose a TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
  return { baseUrl, requests, close: () => new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())) };
}

assertFamilyCoverage();
try {
  await mkdir(archivesRoot);
  const archives = new Map();
  const records = new Map();
  for (const [directory, name] of PUBLIC_PACKAGES) archives.set(name, await packOne(join(familyRoot, directory), name));
  for (const [name, directory] of CROSS_TREE_PACKAGES) archives.set(name, await packOne(directory, name));
  const cliArchive = archives.get('@colophon-claims/cli');
  const cliFiles = await archiveFiles(cliArchive);
  const webRoot = 'package/dist/local-web/packages/benchmark-product/web';
  for (const expected of [
    `${webRoot}/.next/BUILD_ID`,
    `${webRoot}/local-server.mjs`,
    `${webRoot}/server.js`,
    'package/dist/build-metadata.json',
  ]) {
    if (!cliFiles.includes(expected)) throw new Error(`packed CLI is missing private web build output: ${expected}`);
  }
  for (const [directory, name] of PUBLIC_PACKAGES) records.set(name, { manifest: manifestFor(join(familyRoot, directory)), archive: archives.get(name), tarballPath: `/tarballs/${name}/${archives.get(name).split('/').at(-1)}`, integrity: `sha512-${createHash('sha512').update(readFileSync(archives.get(name))).digest('base64')}` });
  for (const [name, directory] of CROSS_TREE_PACKAGES) records.set(name, { manifest: manifestFor(directory), archive: archives.get(name), tarballPath: `/tarballs/${name}/${archives.get(name).split('/').at(-1)}`, integrity: `sha512-${createHash('sha512').update(readFileSync(archives.get(name))).digest('base64')}` });
  const registry = await startRegistry(records);
  try {
    // Prove the reader's *installed closure*, not just its direct manifest, stays
    // independent of the Colophon runner and task-execution runtime packages.
    await mkdir(readerRoot);
    await writeFile(join(readerRoot, 'package.json'), JSON.stringify({ private: true, dependencies: {
      '@colophon-claims/verify': '1',
    } }, null, 2));
    await writeFile(join(readerRoot, '.npmrc'), `@colophon-claims:registry=${registry.baseUrl}\n@jinn-network:registry=${registry.baseUrl}\n`);
    await run('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      join(temporaryRoot, 'reader-npm-cache'),
    ], { cwd: readerRoot });
    const readerLock = await readFile(join(readerRoot, 'package-lock.json'), 'utf8');
    const installedReaderClosure = installedFirstPartyClosure(readerLock);
    const declaredReaderClosure = declaredFirstPartyClosure(records, ['@colophon-claims/verify']);
    if (JSON.stringify(installedReaderClosure) !== JSON.stringify(declaredReaderClosure)) {
      throw new Error(`reader first-party closure differs from its recursively declared closure: installed ${JSON.stringify(installedReaderClosure)}, declared ${JSON.stringify(declaredReaderClosure)}`);
    }
    for (const forbidden of [
      '@colophon-claims/cli',
      '@colophon-claims/core',
      '@jinn-network/task-execution-backend',
      '@jinn-network/task-execution-backend-local',
      '@jinn-network/task-execution-launchers',
      '@jinn-network/task-execution-supervisor',
      '@jinn-network/task-execution-workspace',
    ]) {
      if (installedReaderClosure.includes(forbidden)) {
        throw new Error(`reader-only install unexpectedly contains ${forbidden} at some dependency depth`);
      }
    }
    await rm(join(readerRoot, 'node_modules'), { recursive: true, force: true });
    await rm(join(temporaryRoot, 'reader-npm-cache'), { recursive: true, force: true });

    await mkdir(consumerRoot);
    await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
      '@colophon-claims/core': '1', '@colophon-claims/cli': '1', '@colophon-claims/verify': '1',
      '@types/node': '^22.0.0', typescript: '^5.9.3',
    } }, null, 2));
    await writeFile(join(consumerRoot, '.npmrc'), `@colophon-claims:registry=${registry.baseUrl}\n@jinn-network:registry=${registry.baseUrl}\n`);
    await run('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      join(temporaryRoot, 'npm-cache'),
    ], { cwd: consumerRoot });
    await writeFile(join(consumerRoot, 'consumer.ts'), `import { PRODUCT_BRANDING, verifyPublicBundle } from '@colophon-claims/core';
import { USAGE, runColophonCli } from '@colophon-claims/cli';
import { verifyPublicBundle as verifyBundle } from '@colophon-claims/verify';
export const publicEntrypoints = [PRODUCT_BRANDING, verifyPublicBundle, verifyBundle, USAGE, runColophonCli] as const;
`);
    await writeFile(join(consumerRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, strict: true, target: 'ES2022' }, include: ['consumer.ts'] }, null, 2));
    await run(join(consumerRoot, 'node_modules/.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'), ['--project', 'tsconfig.json'], { cwd: consumerRoot });
    const installedBuildMetadata = JSON.parse(await readFile(
      join(consumerRoot, 'node_modules', '@colophon-claims', 'cli', 'dist', 'build-metadata.json'),
      'utf8',
    ));
    if (
      installedBuildMetadata.kind !== 'colophon-package-build/1'
      || installedBuildMetadata.packageVersion !== '1.0.0'
      || !/^[0-9a-f]{40}$/.test(installedBuildMetadata.sourceCommit)
      || JSON.stringify(installedBuildMetadata.qualifiedTargets) !== JSON.stringify(['darwin/arm64', 'linux/x64'])
    ) {
      throw new Error(`cold-installed CLI has invalid build provenance or qualification: ${JSON.stringify(installedBuildMetadata)}`);
    }
    for (const [, name] of PUBLIC_PACKAGES) {
      const installed = join(consumerRoot, 'node_modules', ...name.split('/'));
      if (!statSync(installed).isDirectory() || statSync(installed).isSymbolicLink()) throw new Error(`${name} was not cold-installed as a real package directory`);
      if (!registry.requests.has(`tarball:${name}`)) {
        throw new Error(`cold install did not fetch ${name} through the ephemeral registry; observed ${JSON.stringify([...registry.requests].sort())}`);
      }
    }
    const lock = await readFile(join(consumerRoot, 'package-lock.json'), 'utf8');
    if (lock.includes('portal:') || lock.includes(familyRoot)) throw new Error('cold install retained a workspace portal or source-tree path');
    await rm(join(consumerRoot, 'node_modules'), { recursive: true, force: true });
    await rm(join(temporaryRoot, 'npm-cache'), { recursive: true, force: true });

    // Exercise the public one-shot selector exactly as a cold visitor will. The
    // consumer install above proves types; this separate empty directory proves
    // npx resolves the compatible @1 line without a preinstalled binary.
    await mkdir(oneShotRoot);
    await writeFile(join(oneShotRoot, 'package.json'), JSON.stringify({ private: true }, null, 2));
    await writeFile(join(oneShotRoot, '.npmrc'), `@colophon-claims:registry=${registry.baseUrl}\n@jinn-network:registry=${registry.baseUrl}\n`);
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const oneShotCache = join(temporaryRoot, 'one-shot-npm-cache');
    const qualifiedRuntime = `${process.platform}/${process.arch}`;
    const isQualifiedRuntime = installedBuildMetadata.qualifiedTargets.includes(qualifiedRuntime);
    if (!isQualifiedRuntime) {
      const forbiddenOutput = join(temporaryRoot, 'unsupported-target-must-not-exist');
      const unsupported = await runExpectingExit(
        npx,
        ['--yes', '@colophon-claims/cli@1', 'demo', '--output', forbiddenOutput, '--no-open', '--json'],
        1,
        { cwd: oneShotRoot, env: { ...process.env, npm_config_cache: oneShotCache } },
      );
      const response = JSON.parse(unsupported.stdout);
      if (response.ok !== false || !response.error?.detail?.includes(`not qualified for ${process.platform}/${process.arch}`) || existsSync(forbiddenOutput)) {
        throw new Error(`unsupported one-shot target did not fail before creation: ${unsupported.stdout}${unsupported.stderr}`);
      }
      console.log(`Proved @1 one-shot resolution and fail-before-creation on ${qualifiedRuntime}; retained-sample execution is qualified to darwin/arm64 and linux/x64.`);
    } else {
    const demo = JSON.parse(await run(
      npx,
      ['--yes', '@colophon-claims/cli@1', 'demo', '--no-open', '--json'],
      { cwd: oneShotRoot, env: { ...process.env, npm_config_cache: oneShotCache } },
    ));
    if (demo.ok !== true || demo.result?.portableChecks?.length !== 6 || demo.result?.output?.retained !== true) {
      throw new Error(`cold-installed Colophon sample did not retain a six-check bundle: ${JSON.stringify(demo)}`);
    }
    await proveViewer(
      npxInstalledBinary(oneShotCache, process.platform === 'win32' ? 'colophon.cmd' : 'colophon'),
      ['open', '--bundle', demo.result.output.bundle, '--no-browser'],
      { cwd: oneShotRoot },
    );
    const receipt = JSON.parse(await readFile(join(demo.result.output.root, 'quickstart-receipt.json'), 'utf8'));
    if (receipt.sourceCommit !== installedBuildMetadata.sourceCommit || receipt.colophonVersion !== '1.0.0') {
      throw new Error(`quickstart receipt did not preserve the packaged immutable provenance: ${JSON.stringify(receipt)}`);
    }
    const reader = JSON.parse(await run(
      npx,
      ['--yes', '@colophon-claims/verify@1', demo.result.output.bundle, '--json'],
      { cwd: oneShotRoot, env: { ...process.env, npm_config_cache: join(temporaryRoot, 'reader-one-shot-npm-cache') } },
    ));
    if (reader.ok !== true || reader.checks?.length !== 6 || reader.identity !== demo.result.digests.bundleIdentity) {
      throw new Error(`reader package did not independently verify the retained sample: ${JSON.stringify(reader)}`);
    }
    await appendFile(join(demo.result.output.bundle, 'README.md'), '\ntampered after publication\n');
    const tamperedReader = await runExpectingExit(
      npx,
      ['--yes', '@colophon-claims/verify@1', demo.result.output.bundle, '--json'],
      1,
      { cwd: oneShotRoot, env: { ...process.env, npm_config_cache: join(temporaryRoot, 'reader-one-shot-npm-cache') } },
    );
    const tamperedResult = JSON.parse(tamperedReader.stdout);
    if (tamperedResult.ok !== false || tamperedResult.code !== 'record-integrity') {
      throw new Error(`reader package did not fail closed on a tampered bundle: ${tamperedReader.stdout}${tamperedReader.stderr}`);
    }
    }
    console.log(isQualifiedRuntime
      ? `Cold-installed ${PUBLIC_PACKAGES.length} public Colophon packages, ran the retained sample, served its verified loopback viewer, and reverified it with the reader package.`
      : `Cold-installed ${PUBLIC_PACKAGES.length} public Colophon packages and proved the public @1 selectors; darwin/arm64 and linux/x64 CI complete sample execution, viewer, and reader reverification.`);
  } finally { await registry.close(); }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
