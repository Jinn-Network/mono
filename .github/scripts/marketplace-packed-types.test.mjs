import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const marketplaceRoot = join(root, 'packages', 'marketplace');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'jinn-marketplace-packed-types-'));
const archivesRoot = join(temporaryRoot, 'archives');
const consumerRoot = join(temporaryRoot, 'consumer');

const packages = [
  ['binding', '@jinn-network/marketplace-binding'],
  ['projector', '@jinn-network/marketplace-projector'],
  ['pipeline', '@jinn-network/marketplace-pipeline'],
  ['venue-base', '@jinn-network/marketplace-venue-base'],
  ['testing', '@jinn-network/marketplace-testing'],
];

const codeEntrypoints = [
  '@jinn-network/marketplace-binding',
  '@jinn-network/marketplace-projector',
  '@jinn-network/marketplace-pipeline',
  '@jinn-network/marketplace-venue-base',
  '@jinn-network/marketplace-testing',
  '@jinn-network/marketplace-testing/backend-conformance',
  '@jinn-network/marketplace-testing/named-check-fixtures',
  '@jinn-network/marketplace-testing/projector-conformance',
  '@jinn-network/marketplace-testing/venue-conformance',
];

// Cross-tree Jinn dependencies each *then-present* marketplace package references, packed as
// file: deps so NodeNext resolves them (program §7.8). M0-M1: binding's six direct deps (contract-abis, plus
// task-execution-{protocol,backend,profiles}, trust-{core,resolve}); projector adds
// record-discovery-{protocol,serve} + their own trust-core/record-discovery-testing shadow
// deps; testing adds task-execution-testing + record-discovery-testing, then trust-testing for
// M5.3's real sealed binding fixtures and evidence-protocol for §7.55 exact family validation.
// task-execution-testing's runtime closure includes backend-local/{supervisor,workspace,
// launchers,assembly} plus the assembly's evidence contract deps — packed before testing.
// Pipeline and testing's shadow closures are covered below.
const CROSS_TREE_PACKAGES = [
  ['@jinn-network/contract-abis', join(root, 'packages', 'contract-abis')],
  ['@jinn-network/evidence-protocol', join(root, 'packages', 'evidence', 'protocol')],
  ['@jinn-network/evidence-repository', join(root, 'packages', 'evidence', 'repository')],
  ['@jinn-network/evidence-discovery', join(root, 'packages', 'evidence', 'discovery')],
  ['@jinn-network/execution-evidence-builder', join(root, 'packages', 'evidence', 'execution-evidence-builder')],
  ['@jinn-network/execution-recorder', join(root, 'packages', 'evidence', 'execution-recorder')],
  ['@jinn-network/task-execution-protocol', join(root, 'packages', 'task-execution', 'protocol')],
  ['@jinn-network/task-execution-backend', join(root, 'packages', 'task-execution', 'backend')],
  ['@jinn-network/task-execution-profiles', join(root, 'packages', 'task-execution', 'profiles')],
  ['@jinn-network/task-execution-supervisor', join(root, 'packages', 'task-execution', 'backend-local', 'supervisor')],
  ['@jinn-network/task-execution-workspace', join(root, 'packages', 'task-execution', 'backend-local', 'workspace')],
  ['@jinn-network/task-execution-launchers', join(root, 'packages', 'task-execution', 'backend-local', 'launchers')],
  ['@jinn-network/task-execution-backend-local', join(root, 'packages', 'task-execution', 'backend-local', 'assembly')],
  ['@jinn-network/task-execution-testing', join(root, 'packages', 'task-execution', 'testing')],
  ['@jinn-network/trust-core', join(root, 'packages', 'trust', 'core')],
  ['@jinn-network/trust-resolve', join(root, 'packages', 'trust', 'resolve')],
  ['@jinn-network/trust-testing', join(root, 'packages', 'trust', 'testing')],
  ['@jinn-network/record-discovery-protocol', join(root, 'packages', 'discovery', 'protocol')],
  ['@jinn-network/record-discovery-serve', join(root, 'packages', 'discovery', 'serve')],
  ['@jinn-network/record-discovery-testing', join(root, 'packages', 'discovery', 'testing')],
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
  // Cross-tree dependencies first (leaves before the marketplace packages that portal to them).
  for (const [name, directory] of CROSS_TREE_PACKAGES) {
    archives.set(name, await packOne(directory, name));
  }
  for (const [directory, name] of packages) {
    archives.set(name, await packOne(join(marketplaceRoot, directory), name));
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
    codeEntrypoints
      .map((specifier, index) => `import type * as Entry${index} from ${JSON.stringify(specifier)};`)
      .join('\n')
      + '\n\n'
      + `export type MarketplaceEntrypoints = [\n${codeEntrypoints
        .map((_, index) => `  typeof Entry${index},`)
        .join('\n')}\n];\n`,
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
    `Compiled a packed TypeScript consumer against ${codeEntrypoints.length} public code entrypoints across all ${packages.length} marketplace packages.`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
