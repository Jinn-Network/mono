import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidenceRoot = join(root, 'packages', 'discovery');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'jinn-record-discovery-packed-types-'));
const archivesRoot = join(temporaryRoot, 'archives');
const consumerRoot = join(temporaryRoot, 'consumer');

const packages = [
  ['protocol', '@jinn-network/record-discovery-protocol'],
  ['testing', '@jinn-network/record-discovery-testing'],
  ['serve', '@jinn-network/record-discovery-serve'],
  ['client', '@jinn-network/record-discovery-client'],
  ['facts/evidence', '@jinn-network/record-discovery-facts-evidence'],
  ['facts/trust', '@jinn-network/record-discovery-facts-trust'],
  ['facts/task-execution', '@jinn-network/record-discovery-facts-task-execution'],
  ['facts/benchmarking', '@jinn-network/record-discovery-facts-benchmarking'],
  ['sources/evidence-journal', '@jinn-network/record-discovery-source-evidence-journal'],
  ['transport-http', '@jinn-network/record-discovery-transport-http'],
];

const codeEntrypoints = [
  '@jinn-network/record-discovery-protocol',
  '@jinn-network/record-discovery-testing',
  '@jinn-network/record-discovery-serve',
  '@jinn-network/record-discovery-client',
  '@jinn-network/record-discovery-facts-evidence',
  '@jinn-network/record-discovery-facts-trust',
  '@jinn-network/record-discovery-facts-task-execution',
  '@jinn-network/record-discovery-facts-benchmarking',
  '@jinn-network/record-discovery-source-evidence-journal',
  '@jinn-network/record-discovery-transport-http',
];

// Cross-tree Jinn dependencies each *then-present* discovery package
// references, packed as file: deps so NodeNext resolves them (program §7.8).
// M1 seeds trust-core only; M7 adds evidence-protocol, evidence-repository,
// and evidence-discovery (facts/evidence's dependency, including the
// "/indexer" subpath its exported recompute fns use); M8 adds
// task-execution-protocol AND task-execution-profiles as facts/task-
// execution lands -- both, not profiles alone, because profiles' public
// surface does not re-export Task/Submission/Delivery's schemas (see the
// inventory guard's dependency-graph comment and facts/task-execution's
// src/recompute.ts for the full rationale). sources/evidence-journal adds
// no NEW cross-tree package here -- its evidence-protocol/evidence-
// repository/evidence-discovery dependencies are already packed by M7.
const CROSS_TREE_PACKAGES = [
  ['@jinn-network/trust-core', join(root, 'packages', 'trust', 'core')],
  ['@jinn-network/evidence-protocol', join(root, 'packages', 'evidence', 'protocol')],
  ['@jinn-network/evidence-repository', join(root, 'packages', 'evidence', 'repository')],
  ['@jinn-network/evidence-discovery', join(root, 'packages', 'evidence', 'discovery')],
  ['@jinn-network/task-execution-protocol', join(root, 'packages', 'task-execution', 'protocol')],
  ['@jinn-network/task-execution-profiles', join(root, 'packages', 'task-execution', 'profiles')],
  ['@jinn-network/benchmarking-records', join(root, 'packages', 'benchmarking', 'records')],
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
    archives.set(name, await packOne(join(evidenceRoot, directory), name));
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
    codeEntrypoints
      .map((specifier, index) => `import type * as Entry${index} from ${JSON.stringify(specifier)};`)
      .join('\n')
      + '\n\n'
      + `export type RecordDiscoveryEntrypoints = [\n${codeEntrypoints
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
    `Compiled a packed TypeScript consumer against ${codeEntrypoints.length} public code entrypoints across all ${packages.length} record discovery packages.`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
