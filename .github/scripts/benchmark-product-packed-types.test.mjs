// Compiles a TypeScript consumer against the Benchmark Product family's packed public entrypoints
// (the same npm-pack-then-install-from-tarball technique as
// `benchmarking-packed-types.test.mjs` / `record-discovery-packed-types.test.mjs`): the guard that
// what a real external consumer would install actually type-resolves, not just what the monorepo's
// own workspace linking happens to resolve.
//
// The product is `private: true` (product design §2: publication disabled, `publishPolicy:
// "never"`) -- which is exactly why this uses `npm pack`, not `yarn pack`: npm packs a private
// package fine, yarn refuses. `npm pack --ignore-scripts` ships whatever `dist/` is already on
// disk, so CI builds every package (product and its cross-tree portal dependencies) before this
// script runs; this script does not build anything itself.
//
// BP-30 added the family's second member, `web` -- and deliberately does NOT pack it (see
// `PACKED_EXCLUDED` below). The family-coverage check that follows keeps that exclusion honest: a
// member present in the live tree but named in neither `packages` nor `PACKED_EXCLUDED` fails this
// script before any packing work starts, rather than silently having nothing checked for it.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const familyRoot = join(root, 'packages', 'benchmark-product');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'jinn-benchmark-product-packed-types-'));
const archivesRoot = join(temporaryRoot, 'archives');
const consumerRoot = join(temporaryRoot, 'consumer');

const packages = [
  ['core', '@jinn-network/benchmark-product-core'],
];

const codeEntrypoints = [
  '@jinn-network/benchmark-product-core',
];

// BP-31: the web application remains deliberately excluded from packing, not silently absent. It
// is `private: true` with no public package entrypoint (product design §5.3, GUI-as-client);
// nothing ever installs it, so there is no packed-consumer type surface to compile. A named,
// reasoned exclusion here (rather than just missing from `packages`) is what lets the
// family-coverage check below tell "deliberately excluded" apart from "forgotten".
const PACKED_EXCLUDED = [
  ['web', '@jinn-network/benchmark-product-web', 'private: true, no public package entrypoint -- nothing installs it'],
];

// Same walk as benchmark-product-package-inventory.test.mjs's `packageManifests`: every child
// directory of the family root with a package.json, recursively, node_modules excluded.
function familyManifests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name === 'node_modules') return [];
    const child = join(directory, entry.name);
    const packageJsonPath = join(child, 'package.json');
    return [
      ...(existsSync(packageJsonPath) ? [packageJsonPath] : []),
      ...familyManifests(child),
    ];
  });
}

// Run before any packing work. Without this, a family member named in neither `packages` nor
// `PACKED_EXCLUDED` would never fail this script -- there being nothing to pack for it is silent,
// not red. This script has no test framework wrapping it, so a thrown error is the failure mode.
function assertFamilyCoverage() {
  const discovered = familyManifests(familyRoot).flatMap((manifestPath) => {
    const { name } = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return typeof name === 'string' && /^@jinn-network\/benchmark-product-/.test(name)
      ? [[relative(familyRoot, dirname(manifestPath)), name]]
      : [];
  });
  const registered = new Set(
    [...packages, ...PACKED_EXCLUDED].map(([directory, name]) => `${directory} ${name}`),
  );
  const unregistered = discovered.filter(([directory, name]) => !registered.has(`${directory} ${name}`));
  if (unregistered.length > 0) {
    throw new Error(
      'benchmark-product family member(s) not registered in benchmark-product-packed-types.test.mjs: '
      + `${unregistered.map(([directory, name]) => `${name} (${directory})`).join(', ')}. `
      + 'Add each to `packages` (if it should be packed) or `PACKED_EXCLUDED` (with a reason).',
    );
  }
}

assertFamilyCoverage();

// Cross-tree Jinn dependencies the product references, packed as `file:` deps so NodeNext resolves
// them (program plan §4.1; record-discovery-packed-types.test.mjs precedent). This is the product's
// full RUNTIME dependency closure -- direct dependencies plus every transitive @jinn-network edge
// (none is on the registry), in dependency order (pack/install order): protocol + records (BP-01),
// BP-11's intake edges (interop, task-admission, and their transitives environment-record /
// trust-core / profiles), BP-12's real local-venue stack (backend, backend-local, supervisor,
// workspace, launchers, the evaluation-harness + evaluator-adapters pair, benchmarking-run,
// benchmarking-local, and the evidence-* / attestation-issuer transitives the evaluation-harness
// pair pulls in), and BP-13's `benchmarking-aggregate` (Report production/verification -- depends
// only on records + trust-core, both already earlier in this list). Each `npm pack` is independent,
// and `--ignore-scripts` ships whatever `dist/` is on disk -- CI builds every one of these before
// this script runs.
const CROSS_TREE_PACKAGES = [
  ['@jinn-network/task-execution-protocol', join(root, 'packages', 'task-execution', 'protocol')],
  ['@jinn-network/trust-core', join(root, 'packages', 'trust', 'core')],
  ['@jinn-network/environment-record', join(root, 'packages', 'environments', 'record')],
  ['@jinn-network/task-execution-profiles', join(root, 'packages', 'task-execution', 'profiles')],
  ['@jinn-network/benchmarking-records', join(root, 'packages', 'benchmarking', 'records')],
  ['@jinn-network/benchmarking-aggregate', join(root, 'packages', 'benchmarking', 'aggregate')],
  ['@jinn-network/task-admission', join(root, 'packages', 'task-supply', 'admission')],
  ['@jinn-network/benchmarking-interop', join(root, 'packages', 'benchmarking', 'interop')],
  ['@jinn-network/task-execution-backend', join(root, 'packages', 'task-execution', 'backend')],
  ['@jinn-network/task-execution-supervisor', join(root, 'packages', 'task-execution', 'backend-local', 'supervisor')],
  ['@jinn-network/task-execution-workspace', join(root, 'packages', 'task-execution', 'backend-local', 'workspace')],
  ['@jinn-network/task-execution-launchers', join(root, 'packages', 'task-execution', 'backend-local', 'launchers')],
  ['@jinn-network/evidence-protocol', join(root, 'packages', 'evidence', 'protocol')],
  ['@jinn-network/evidence-repository', join(root, 'packages', 'evidence', 'repository')],
  ['@jinn-network/evidence-discovery', join(root, 'packages', 'evidence', 'discovery')],
  ['@jinn-network/execution-recorder', join(root, 'packages', 'evidence', 'execution-recorder')],
  ['@jinn-network/attestation-issuer', join(root, 'packages', 'evidence', 'attestation-issuer')],
  ['@jinn-network/task-execution-evaluation-harness', join(root, 'packages', 'task-execution', 'evaluation-harness')],
  ['@jinn-network/task-execution-evaluator-adapters', join(root, 'packages', 'task-execution', 'evaluator-adapters')],
  ['@jinn-network/task-execution-backend-local', join(root, 'packages', 'task-execution', 'backend-local', 'assembly')],
  ['@jinn-network/benchmarking-run', join(root, 'packages', 'benchmarking', 'run')],
  ['@jinn-network/benchmarking-local', join(root, 'packages', 'benchmarking', 'local')],
];

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code === 0) {
        resolvePromise(output);
        return;
      }
      reject(new Error(
        `${command} exited with ${code}:\n${output}${errorOutput}`,
      ));
    });
  });
}

async function packOne(directory, name) {
  const packed = JSON.parse(await run(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', archivesRoot],
    { cwd: directory },
  ));
  if (packed.length !== 1 || typeof packed[0]?.filename !== 'string') {
    throw new Error(`npm pack returned an unexpected result for ${name}`);
  }
  return join(archivesRoot, packed[0].filename);
}

try {
  await mkdir(archivesRoot);
  const archives = new Map();
  for (const [directory, name] of packages) {
    archives.set(name, await packOne(join(familyRoot, directory), name));
  }
  for (const [name, directory] of CROSS_TREE_PACKAGES) {
    archives.set(name, await packOne(directory, name));
  }

  await mkdir(consumerRoot);
  await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    dependencies: Object.fromEntries([
      ...packages.map(([, name]) => [name, `file:${archives.get(name)}`]),
      ...CROSS_TREE_PACKAGES.map(([name]) => [name, `file:${archives.get(name)}`]),
      ['@types/node', '^22.0.0'],
      ['typescript', '^5.9.3'],
      ['vitest', '^4.1.8'],
    ]),
  }, null, 2));
  await run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: consumerRoot },
  );

  await writeFile(
    join(consumerRoot, 'consumer.ts'),
    `import {
  GUI_CAPABILITY_CATALOG,
  LOCAL_VENUE_LIMITS,
  PRODUCT_BRANDING,
  runPreview,
} from '@jinn-network/benchmark-product-core';
import type {
  PreviewArtifact,
  QuoteArmSize,
  QuoteCoverageRefusal,
  QuoteEstimatedWallTime,
  QuotePresentation,
  RunPreviewDeps,
  RunPreviewInput,
  RunPreviewResult,
} from '@jinn-network/benchmark-product-core';

export type BenchmarkProductEntrypoints = [
  typeof import('@jinn-network/benchmark-product-core'),
];
export type PublicPreviewAndQuoteTypes = [
  PreviewArtifact,
  RunPreviewDeps,
  RunPreviewInput,
  RunPreviewResult,
  QuoteArmSize,
  QuoteCoverageRefusal,
  QuoteEstimatedWallTime,
  QuotePresentation,
];
export const publicRunPreview: typeof runPreview = runPreview;
export const localVenueLimits: readonly string[] = LOCAL_VENUE_LIMITS;
export const productName: string = PRODUCT_BRANDING.displayName;
const guiInitCapability = GUI_CAPABILITY_CATALOG.initWorkspace;
export const guiInitOperation: string = guiInitCapability.status === 'shipped'
  ? guiInitCapability.action
  : guiInitCapability.deferredTo;
`,
  );
  await writeFile(join(consumerRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      strict: true,
      target: 'ES2022',
    },
    include: ['consumer.ts'],
  }, null, 2));

  const typescript = join(
    consumerRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
  );
  await run(typescript, ['--project', 'tsconfig.json'], { cwd: consumerRoot });

  for (const [directory, name] of packages) {
    const installed = JSON.parse(await readFile(
      join(consumerRoot, 'node_modules', ...name.split('/'), 'package.json'),
      'utf8',
    ));
    if (installed.name !== name) {
      throw new Error(`${directory} installed as ${installed.name ?? 'an unnamed package'}`);
    }
  }

  console.log(
    `Compiled a packed TypeScript consumer against ${codeEntrypoints.length} public code entrypoint across all ${packages.length} benchmark-product packages.`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
