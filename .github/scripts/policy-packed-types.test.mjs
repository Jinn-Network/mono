// The packed-consumer canary for the policy tree.
//
// `yarn test` compiles against `src/`; this compiles against what an installer actually receives.
// A public entrypoint that resolves in the workspace and not from the tarball — a missing
// `exports` condition, a `.d.ts` that never got emitted, a type that leaked out of the build's
// rootDir — shows up here and nowhere else.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const policyRoot = join(root, 'packages', 'policy');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'jinn-policy-packed-types-'));
const archivesRoot = join(temporaryRoot, 'archives');
const consumerRoot = join(temporaryRoot, 'consumer');

// C2 (`@jinn-network/policy-outcomes`) appends its row here as it lands.
const packages = [
  ['identity', '@jinn-network/policy-identity'],
];

const codeEntrypoints = [
  '@jinn-network/policy-identity',
];

// The policy tree depends on no Jinn package (substrate §2), so there is no cross-tree pack list.
const CROSS_TREE_PACKAGES = [];

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code === 0) { resolvePromise(output); return; }
      reject(new Error(`${command} exited with ${code}:\n${output}${errorOutput}`));
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
    archives.set(name, await packOne(join(policyRoot, directory), name));
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
    ]),
  }, null, 2));
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumerRoot });

  await writeFile(
    join(consumerRoot, 'consumer.ts'),
    codeEntrypoints
      .map((specifier, index) => `import type * as Entry${index} from ${JSON.stringify(specifier)};`)
      .join('\n')
      + '\n\n'
      + `export type PolicyEntrypoints = [\n${codeEntrypoints
        .map((_, index) => `  typeof Entry${index},`)
        .join('\n')}\n];\n`
      // The namespace imports above prove the entrypoint resolves; the frozen C1 surface is
      // additionally named symbol-by-symbol, so a rename in the packed `.d.ts` is a compile error
      // here rather than a silently-narrower public surface for every downstream unit.
      + [
        '',
        'import {',
        '  deriveExecutionTuple,',
        '  canonicalTupleBytes,',
        '  canonicalTupleText,',
        '  tupleDigest,',
        '  expressAsRunPinning,',
        '  assertValidTuple,',
        '  sealCandidateManifest,',
        '  validateCandidateManifest,',
        '  parseExactCandidateManifest,',
        '  verifyCandidateStatementBinding,',
        '  preAuthenticationEncoding,',
        '  verifyEd25519Signature,',
        '  hashTreeLearnerPublicV1,',
        '  assertMaterializable,',
        '  canonicalJsonBytes,',
        '  canonicalJsonText,',
        '  compareCodeUnitStrings,',
        '  sha256Hex,',
        '  prefixedDigest,',
        '  CORE_AXES,',
        '  CORE_KEY_CLASSES,',
        '  EXECUTION_TUPLE_FORMAT_TOKEN,',
        '  CANDIDATE_MANIFEST_FORMAT_TOKEN,',
        '  HARNESS_STATE_LOADOUT_KIND,',
        '  LEARNER_PUBLIC_V1,',
        '} from "@jinn-network/policy-identity";',
        'import type {',
        '  CandidateManifest, DsseEnvelope, ExecutionPolicyTuple, PolicyParentRef,',
        '  RequirementEntries, ResolvedTaskProfile, SealedDocument, SealedSubmissionDoc,',
        '  SealedTaskDoc, TreeEntry, ValidationResult,',
        '} from "@jinn-network/policy-identity";',
        '',
        'export type PolicyIdentitySurface = [',
        '  typeof deriveExecutionTuple,',
        '  typeof canonicalTupleBytes,',
        '  typeof canonicalTupleText,',
        '  typeof tupleDigest,',
        '  typeof expressAsRunPinning,',
        '  typeof assertValidTuple,',
        '  typeof sealCandidateManifest,',
        '  typeof validateCandidateManifest,',
        '  typeof parseExactCandidateManifest,',
        '  typeof verifyCandidateStatementBinding,',
        '  typeof preAuthenticationEncoding,',
        '  typeof verifyEd25519Signature,',
        '  typeof hashTreeLearnerPublicV1,',
        '  typeof assertMaterializable,',
        '  typeof canonicalJsonBytes,',
        '  typeof canonicalJsonText,',
        '  typeof compareCodeUnitStrings,',
        '  typeof sha256Hex,',
        '  typeof prefixedDigest,',
        '  typeof CORE_AXES,',
        '  typeof CORE_KEY_CLASSES,',
        '  typeof EXECUTION_TUPLE_FORMAT_TOKEN,',
        '  typeof CANDIDATE_MANIFEST_FORMAT_TOKEN,',
        '  typeof HARNESS_STATE_LOADOUT_KIND,',
        '  typeof LEARNER_PUBLIC_V1,',
        '  CandidateManifest, DsseEnvelope, ExecutionPolicyTuple, PolicyParentRef,',
        '  RequirementEntries, ResolvedTaskProfile, SealedDocument, SealedSubmissionDoc,',
        '  SealedTaskDoc, TreeEntry, ValidationResult,',
        '];',
        '',
      ].join('\n'),
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
    consumerRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
  );
  await run(typescript, ['--project', 'tsconfig.json'], { cwd: consumerRoot });

  for (const [directory, name] of packages) {
    const installed = JSON.parse(await readFile(
      join(consumerRoot, 'node_modules', ...name.split('/'), 'package.json'), 'utf8',
    ));
    if (installed.name !== name) {
      throw new Error(`${directory} installed as ${installed.name ?? 'an unnamed package'}`);
    }
  }

  console.log(
    `Compiled a packed TypeScript consumer against ${codeEntrypoints.length} public code entrypoint(s) across all ${packages.length} policy package(s).`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
