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
];

// Packages OUTSIDE the task-execution tree that a task-execution package may legitimately
// portal-resolve (backend plan program §7.7: the assembly consumes the evidence CONTRACT
// packages + the I/O-free execution-recorder producer only — never evidence-local-runtime or
// any record-discovery-* package). [directory relative to the repo root, expected name].
const EXTERNAL_JINN_PACKAGES = [
  ['packages/evidence/protocol', '@jinn-network/evidence-protocol'],
  ['packages/evidence/repository', '@jinn-network/evidence-repository'],
  ['packages/evidence/discovery', '@jinn-network/evidence-discovery'],
  ['packages/evidence/execution-recorder', '@jinn-network/execution-recorder'],
];

// A component's dev-only portal to the backend-local testing kit must also resolve the kit's
// production component closure locally. These are RESOLUTION overrides only: they do not add
// manifest dependency edges or create a production cycle. With node-modules Yarn cannot safely
// materialize that cyclic portal graph; the component projects use PnP for this dev-only kit
// edge, while the testing package itself remains independently installable.
const BACKEND_LOCAL_TESTING_PORTAL_CLOSURE = [
  '@jinn-network/evidence-discovery', '@jinn-network/evidence-protocol',
  '@jinn-network/evidence-repository', '@jinn-network/execution-recorder',
  '@jinn-network/task-execution-backend', '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-launchers', '@jinn-network/task-execution-profiles',
  '@jinn-network/task-execution-protocol', '@jinn-network/task-execution-supervisor',
  '@jinn-network/task-execution-testing', '@jinn-network/task-execution-workspace',
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
    devDependencies: ['@jinn-network/task-execution-testing'],
    optionalDependencies: [], peerDependencies: [],
  }],
  ['backend-local/workspace', {
    dependencies: ['@jinn-network/task-execution-profiles', '@jinn-network/task-execution-protocol'],
    devDependencies: ['@jinn-network/task-execution-backend', '@jinn-network/task-execution-testing'],
    optionalDependencies: [], peerDependencies: [],
  }],
  ['backend-local/launchers', {
    dependencies: [
      '@jinn-network/task-execution-profiles', '@jinn-network/task-execution-protocol',
      '@jinn-network/task-execution-supervisor', '@jinn-network/task-execution-workspace',
    ],
    devDependencies: ['@jinn-network/task-execution-backend', '@jinn-network/task-execution-testing'],
    optionalDependencies: [], peerDependencies: [],
  }],
  ['backend-local/assembly', {
    dependencies: [
      '@jinn-network/evidence-discovery', '@jinn-network/evidence-repository', '@jinn-network/execution-recorder',
      '@jinn-network/task-execution-backend', '@jinn-network/task-execution-launchers',
      '@jinn-network/task-execution-profiles', '@jinn-network/task-execution-protocol',
      '@jinn-network/task-execution-supervisor', '@jinn-network/task-execution-workspace',
    ],
    devDependencies: ['@jinn-network/evidence-protocol', '@jinn-network/task-execution-testing'],
    optionalDependencies: [], peerDependencies: [],
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
  assert.equal(TASK_EXECUTION_PACKAGES.length, 8);
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
    const ownName = manifest.name;
    const expectedResolved = directory.startsWith('backend-local/')
      ? [...new Set([...declared, ...BACKEND_LOCAL_TESTING_PORTAL_CLOSURE.filter((name) => name !== ownName)])].sort()
      : declared;
    const resolved = Object.keys(resolutions).filter((name) => name.startsWith('@jinn-network/')).sort();
    assert.deepEqual(resolved, expectedResolved, `${directory} has unmatched Jinn resolutions`);
    for (const dependencyName of expectedResolved) {
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
