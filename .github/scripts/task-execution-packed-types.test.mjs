import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const taskExecutionRoot = join(root, 'packages', 'task-execution');
const evidenceRoot = join(root, 'packages', 'evidence');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'jinn-task-execution-packed-types-'));
const archivesRoot = join(temporaryRoot, 'archives');
const consumerRoot = join(temporaryRoot, 'consumer');

const packages = [
  [join(taskExecutionRoot, 'protocol'), '@jinn-network/task-execution-protocol'],
  [join(taskExecutionRoot, 'backend'), '@jinn-network/task-execution-backend'],
  [join(taskExecutionRoot, 'testing'), '@jinn-network/task-execution-testing'],
  [join(taskExecutionRoot, 'profiles'), '@jinn-network/task-execution-profiles'],
  [join(taskExecutionRoot, 'backend-local', 'supervisor'), '@jinn-network/task-execution-supervisor'],
  [join(taskExecutionRoot, 'backend-local', 'workspace'), '@jinn-network/task-execution-workspace'],
  [join(taskExecutionRoot, 'backend-local', 'launchers'), '@jinn-network/task-execution-launchers'],
  [join(taskExecutionRoot, 'backend-local', 'assembly'), '@jinn-network/task-execution-backend-local'],
  [join(taskExecutionRoot, 'evaluation-harness'), '@jinn-network/task-execution-evaluation-harness'],
];

// The assembly's production dependencies reach outside the task-execution tree into the
// evidence CONTRACT packages (program §7.7) — packed here too so the synthetic consumer's flat
// install can satisfy them from local tarballs, never the (unpublished) registry.
const externalPackages = [
  [join(evidenceRoot, 'protocol'), '@jinn-network/evidence-protocol'],
  [join(evidenceRoot, 'repository'), '@jinn-network/evidence-repository'],
  [join(evidenceRoot, 'discovery'), '@jinn-network/evidence-discovery'],
  [join(evidenceRoot, 'execution-recorder'), '@jinn-network/execution-recorder'],
  [join(evidenceRoot, 'attestation-issuer'), '@jinn-network/attestation-issuer'],
];

const codeEntrypoints = [
  '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-backend',
  '@jinn-network/task-execution-testing',
  '@jinn-network/task-execution-testing/backend-local',
  '@jinn-network/task-execution-profiles',
  '@jinn-network/task-execution-profiles/testing',
  '@jinn-network/task-execution-supervisor',
  '@jinn-network/task-execution-workspace',
  '@jinn-network/task-execution-launchers',
  '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-evaluation-harness',
  '@jinn-network/task-execution-evaluation-harness/launcher',
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

const allPackages = [...packages, ...externalPackages];

try {
  await mkdir(archivesRoot);
  const archives = new Map();
  for (const [packageDir, name] of allPackages) {
    const packed = JSON.parse(await run(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', archivesRoot],
      { cwd: packageDir },
    ));
    if (packed.length !== 1 || typeof packed[0]?.filename !== 'string') {
      throw new Error(`npm pack returned an unexpected result for ${name}`);
    }
    archives.set(name, join(archivesRoot, packed[0].filename));
  }

  await mkdir(consumerRoot);
  await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    dependencies: Object.fromEntries([
      ...allPackages.map(([, name]) => [name, `file:${archives.get(name)}`]),
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
      + `export type TaskExecutionEntrypoints = [\n${codeEntrypoints
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

  for (const [packageDir, name] of allPackages) {
    const installed = JSON.parse(await readFile(
      join(consumerRoot, 'node_modules', ...name.split('/'), 'package.json'),
      'utf8',
    ));
    if (installed.name !== name) {
      throw new Error(`${packageDir} installed as ${installed.name ?? 'an unnamed package'}`);
    }
  }

  console.log(
    `Compiled a packed TypeScript consumer against ${codeEntrypoints.length} public code entrypoints across all task-execution packages.`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
