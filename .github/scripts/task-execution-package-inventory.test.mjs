import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages', 'task-execution');
const DEPENDENCY_SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
];

const TASK_EXECUTION_PACKAGES = [
  ['protocol', '@jinn-network/task-execution-protocol'],
  ['backend', '@jinn-network/task-execution-backend'],
  ['testing', '@jinn-network/task-execution-testing'],
  ['profiles', '@jinn-network/task-execution-profiles'],
  ['backend-local/supervisor', '@jinn-network/task-execution-supervisor'],
  ['backend-local/workspace', '@jinn-network/task-execution-workspace'],
  ['backend-local/launchers', '@jinn-network/task-execution-launchers'],
  ['backend-local/assembly', '@jinn-network/task-execution-backend-local'],
  ['evaluation-harness', '@jinn-network/task-execution-evaluation-harness'],
  ['evaluator-adapters', '@jinn-network/task-execution-evaluator-adapters'],
  ['oci-grader', '@jinn-network/task-execution-oci-grader'],
];

// Packages OUTSIDE the task-execution tree that a task-execution package may legitimately
// portal-resolve (backend plan program §7.7: the assembly consumes the evidence CONTRACT
// packages + the I/O-free execution-recorder producer only — never evidence-local-runtime or
// any record-discovery-* package). [directory relative to the repo root, expected name].
const EXTERNAL_JINN_PACKAGES = [
  ['packages/evidence/protocol', '@jinn-network/evidence-protocol'],
  ['packages/evidence/repository', '@jinn-network/evidence-repository'],
  ['packages/evidence/discovery', '@jinn-network/evidence-discovery'],
  ['packages/evidence/execution-evidence-builder', '@jinn-network/execution-evidence-builder'],
  ['packages/evidence/execution-recorder', '@jinn-network/execution-recorder'],
  ['packages/evidence/attestation-issuer', '@jinn-network/attestation-issuer'],
];

const JINN_DEPENDENCY_GRAPH = new Map([
  ['protocol', { dependencies: [], devDependencies: [], optionalDependencies: [], peerDependencies: [] }],
  ['backend', {
    dependencies: ['@jinn-network/task-execution-protocol'],
    devDependencies: [], optionalDependencies: [], peerDependencies: [],
  }],
  // testing's `./backend-local` slice (backend plan Task A3, program §7.5/Finding (a)) takes
  // PRODUCTION deps on the four backend-local components (its fake launcher implements the
  // launchers contract, its fixture families drive supervisor/workspace, its backend-level
  // suite drives the assembly) — the arrows point one way at production scope: each component
  // consumes testing back only as a devDependency (see below), so there is no production cycle
  // (the evidence-tree `local-runtime → execution-recorder` devDep precedent). The
  // devDependencies below are transitive-only gap-fills: packages testing never imports
  // directly, but that a production dependency of a production dependency needs resolved
  // locally instead of from the (unpublished) registry — profiles (workspace/launchers/
  // assembly's own dependency) and the evidence contract chain (assembly's own dependency;
  // evidence-repository/-discovery/execution-recorder each depend on evidence-protocol).
  ['testing', {
    dependencies: [
      '@jinn-network/task-execution-backend', '@jinn-network/task-execution-backend-local',
      '@jinn-network/task-execution-launchers', '@jinn-network/task-execution-protocol',
      '@jinn-network/task-execution-supervisor', '@jinn-network/task-execution-workspace',
    ],
    devDependencies: [
      '@jinn-network/evidence-discovery', '@jinn-network/evidence-protocol',
      '@jinn-network/evidence-repository', '@jinn-network/execution-recorder',
      '@jinn-network/task-execution-profiles',
    ],
    optionalDependencies: [], peerDependencies: [],
    transitivePortalResolutions: ['@jinn-network/execution-evidence-builder'],
  }],
  ['profiles', {
    dependencies: ['@jinn-network/task-execution-protocol'],
    devDependencies: [], optionalDependencies: [], peerDependencies: [],
  }],
  // backend-local (design §15, program §6 decision 2 revised): the internal DAG is
  // [supervisor ∥ workspace] → launchers → assembly (plan Finding (e)). Each component also
  // takes `@jinn-network/task-execution-testing` as a devDependency ONLY (program §7.5) to run
  // the `./backend-local` kit slice locally; where that slice's own production dependencies
  // (task-execution-backend, evidence-protocol) are not already satisfied by the component's
  // own `dependencies`, they are added as devDependencies too so the standalone project's local
  // install resolves them from a portal instead of the (unpublished) registry.
  ['backend-local/supervisor', {
    dependencies: ['@jinn-network/task-execution-backend', '@jinn-network/task-execution-protocol'],
    devDependencies: [],
    optionalDependencies: [], peerDependencies: [],
  }],
  ['backend-local/workspace', {
    dependencies: ['@jinn-network/task-execution-profiles', '@jinn-network/task-execution-protocol'],
    devDependencies: ['@jinn-network/task-execution-backend'],
    optionalDependencies: [], peerDependencies: [],
  }],
  ['backend-local/launchers', {
    dependencies: [
      '@jinn-network/task-execution-profiles', '@jinn-network/task-execution-protocol',
      '@jinn-network/task-execution-supervisor', '@jinn-network/task-execution-workspace',
    ],
    devDependencies: ['@jinn-network/task-execution-backend'],
    optionalDependencies: [], peerDependencies: [],
  }],
  ['backend-local/assembly', {
    dependencies: [
      '@jinn-network/evidence-discovery', '@jinn-network/evidence-repository', '@jinn-network/execution-recorder',
      '@jinn-network/task-execution-backend', '@jinn-network/task-execution-launchers',
      '@jinn-network/task-execution-profiles', '@jinn-network/task-execution-protocol',
      '@jinn-network/task-execution-supervisor', '@jinn-network/task-execution-workspace',
    ],
    devDependencies: ['@jinn-network/evidence-protocol'],
    optionalDependencies: [], peerDependencies: [],
    transitivePortalResolutions: ['@jinn-network/execution-evidence-builder'],
  }],
  ['evaluation-harness', {
    dependencies: [
      '@jinn-network/attestation-issuer', '@jinn-network/evidence-protocol',
      '@jinn-network/task-execution-launchers', '@jinn-network/task-execution-profiles',
      '@jinn-network/task-execution-supervisor', '@jinn-network/task-execution-workspace',
    ],
    devDependencies: [
      '@jinn-network/evidence-discovery', '@jinn-network/evidence-repository',
      '@jinn-network/execution-recorder', '@jinn-network/task-execution-backend',
      '@jinn-network/task-execution-backend-local', '@jinn-network/task-execution-protocol',
    ],
    optionalDependencies: [], peerDependencies: [],
    transitivePortalResolutions: ['@jinn-network/execution-evidence-builder'],
  }],
  // evaluator-adapters (composition design §6.3): concrete result parsers plugged into
  // the evaluation harness's deployment allowlist. Production surface is the adapter
  // contract (evaluation-harness), the EvaluationSpec vocabulary (profiles), the Task
  // document contract (protocol), and the Attempt identity (supervisor). Nothing else —
  // no evidence package, no backend.
  ['evaluator-adapters', {
    dependencies: [
      '@jinn-network/task-execution-evaluation-harness',
      '@jinn-network/task-execution-profiles',
      '@jinn-network/task-execution-protocol',
      '@jinn-network/task-execution-supervisor',
    ],
    devDependencies: [
      '@jinn-network/attestation-issuer', '@jinn-network/evidence-protocol',
      '@jinn-network/evidence-repository', '@jinn-network/task-execution-backend',
      '@jinn-network/task-execution-launchers',
      '@jinn-network/task-execution-workspace',
    ],
    optionalDependencies: [], peerDependencies: [],
  }],
  // oci-grader: host-owned OCI grader execution. Production surface is the GraderReportSource
  // port (evaluator-adapters), the EvaluationSpec vocabulary (profiles), and the operational
  // error + exact-material types (evaluation-harness). Nothing else — no evidence, no trust,
  // no backend, no chain or network client. The devDependencies below are transitive-only
  // gap-fills (same pattern as evaluator-adapters/evaluation-harness): production dependencies
  // of oci-grader's own production dependencies that must be portal-resolvable locally since
  // they are not published to the registry.
  ['oci-grader', {
    dependencies: [
      '@jinn-network/task-execution-evaluation-harness',
      '@jinn-network/task-execution-evaluator-adapters',
      '@jinn-network/task-execution-profiles',
    ],
    devDependencies: [
      '@jinn-network/attestation-issuer',
      '@jinn-network/evidence-discovery',
      '@jinn-network/evidence-protocol',
      '@jinn-network/evidence-repository',
      '@jinn-network/execution-recorder',
      '@jinn-network/task-execution-backend',
      '@jinn-network/task-execution-backend-local',
      '@jinn-network/task-execution-launchers',
      '@jinn-network/task-execution-protocol',
      '@jinn-network/task-execution-supervisor',
      '@jinn-network/task-execution-workspace',
    ],
    optionalDependencies: [], peerDependencies: [],
    transitivePortalResolutions: ['@jinn-network/execution-evidence-builder'],
  }],
]);

function readPackage(directory) {
  const packageJson = join(packageRoot, directory, 'package.json');
  assert.ok(existsSync(packageJson), `missing package manifest: ${packageJson}`);
  return JSON.parse(readFileSync(packageJson, 'utf8'));
}

function packageManifests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name === 'node_modules') return [];
    const child = join(directory, entry.name);
    const packageJson = join(child, 'package.json');
    return [
      ...(existsSync(packageJson) ? [packageJson] : []),
      ...packageManifests(child),
    ];
  });
}

function jinnDependencyNames(manifest, section) {
  return Object.keys(manifest[section] ?? {})
    .filter((name) => name.startsWith('@jinn-network/')).sort();
}

function expectedPortal(directory, dependencyName) {
  const internal = TASK_EXECUTION_PACKAGES.find(([, name]) => name === dependencyName);
  if (internal) {
    return `portal:${relative(join(packageRoot, directory), join(packageRoot, internal[0])) || '.'}`;
  }
  const external = EXTERNAL_JINN_PACKAGES.find(([, name]) => name === dependencyName);
  assert.ok(external, `${directory} declares unknown Jinn dependency ${dependencyName}`);
  return `portal:${relative(join(packageRoot, directory), join(root, external[0]))}`;
}

test('the task-execution package inventory is explicit and has one manifest', () => {
  // Read live (Global Constraints: package counts are computed against the guard's current
  // total, never a hardcoded guessed number) — TASK_EXECUTION_PACKAGES.length IS that live
  // total; this assertion documents the count this revision expects (4 pre-existing + the four
  // backend-local components, backend plan Task A1).
  assert.equal(TASK_EXECUTION_PACKAGES.length, 11);
  for (const [directory, expectedName] of TASK_EXECUTION_PACKAGES) {
    const manifest = readPackage(directory);
    assert.equal(manifest.name, expectedName);
    assert.equal(
      manifest.repository?.directory,
      `packages/task-execution/${directory}`,
      `${expectedName} has a stale repository directory`,
    );
  }
  const actual = packageManifests(join(root, 'packages'))
    .flatMap((packageJson) => {
      const { name } = JSON.parse(readFileSync(packageJson, 'utf8'));
      return /^@jinn-network\/task-execution-/.test(name)
        ? [[relative(packageRoot, dirname(packageJson)), name]]
        : [];
    }).sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(actual, [...TASK_EXECUTION_PACKAGES].sort(([left], [right]) => left.localeCompare(right)));
});

test('task-execution package Jinn dependencies and portal resolutions match the approved graph', () => {
  for (const [directory] of TASK_EXECUTION_PACKAGES) {
    const manifest = readPackage(directory);
    const approved = JINN_DEPENDENCY_GRAPH.get(directory);
    assert.ok(approved, `missing dependency graph entry for ${directory}`);
    for (const section of DEPENDENCY_SECTIONS) {
      assert.deepEqual(jinnDependencyNames(manifest, section), approved[section],
        `${directory} has unapproved Jinn ${section}`);
    }
    const declared = DEPENDENCY_SECTIONS.flatMap((section) => jinnDependencyNames(manifest, section)).sort();
    const resolutions = manifest.resolutions ?? {};
    const resolved = Object.keys(resolutions).filter((name) => name.startsWith('@jinn-network/')).sort();
    const transitive = [...(approved.transitivePortalResolutions ?? [])].sort();
    assert.deepEqual(resolved, [...declared, ...transitive].sort(), `${directory} has unmatched Jinn resolutions`);
    for (const dependencyName of [...declared, ...transitive]) {
      assert.equal(resolutions[dependencyName], expectedPortal(directory, dependencyName),
        `${directory} must resolve ${dependencyName} through its matching portal`);
    }
  }
});

test('the testing kit declares Vitest as an exact optional peer', () => {
  const testing = readPackage('testing');
  assert.deepEqual(testing.peerDependencies, { vitest: '^4.1.8' });
  assert.deepEqual(testing.peerDependenciesMeta, {
    vitest: { optional: true },
  });
});
