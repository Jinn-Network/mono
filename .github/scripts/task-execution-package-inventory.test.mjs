import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// This guard scans every first-party manifest in the repository for the declared @noble/hashes
// range and the absence of resolution overrides; the decision behind the range is recorded in
// packages/task-execution/profiles/README.md.
//
// Boundary: the walk starts at the repository root and skips dot-prefixed directories (.git,
// .yarn, .next, .github including .github/fixtures/*, .local, and transient dot-prefixed test
// directories) plus SKIPPED_MANIFEST_DIRECTORIES (node_modules, build outputs, the read-only
// legacy/ reference subtree, and test-fixture trees such as operator/test/fixtures/*).
const NOBLE_HASHES_RANGE = '^2.2.0';
const NOBLE_HASHES_KEY = /(?:^|\/)@noble\/hashes(?:@|$)/u;
const SKIPPED_MANIFEST_DIRECTORIES = new Set([
  'node_modules', 'dist', 'build', 'coverage', 'legacy', 'fixtures', '__fixtures__',
]);
// One manifest still carries a @noble/hashes resolutions entry: packages/benchmark-product/check
// ("2.2.0", published as @colophon-claims/check). No manifest in its portal closure pins an exact
// version any more, so its install does not need it. It stays because
// colophon-publish-manifest.test.mjs asserts the published manifest keeps it. In check's lock it
// also forces viem, ox, @scure/bip32, @scure/bip39 and @noble/curves 1.9.x onto 2.2.0. Retiring
// it is tracked in #5232.
const NOBLE_HASHES_RESOLUTION_EXCEPTIONS = new Map([
  ['packages/benchmark-product/check', '2.2.0'],
]);

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
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      if (
        !entry.isDirectory()
        || entry.name.startsWith('.')
        || SKIPPED_MANIFEST_DIRECTORIES.has(entry.name)
      ) {
        return [];
      }
      const child = join(directory, entry.name);
      const packageJson = join(child, 'package.json');
      return [
        ...(existsSync(packageJson) ? [packageJson] : []),
        ...packageManifests(child),
      ];
    });
}

function firstPartyManifests(repoRoot = root) {
  const rootManifest = join(repoRoot, 'package.json');
  const paths = [
    ...(existsSync(rootManifest) ? [rootManifest] : []),
    ...packageManifests(repoRoot),
  ];
  return paths.map((manifestPath) => ({
    directory: relative(repoRoot, dirname(manifestPath)).split('\\').join('/') || '.',
    manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
  }));
}

function auditNobleHashesRanges(manifests) {
  const declarers = [];
  const violations = [];
  for (const { directory, manifest } of manifests) {
    for (const section of DEPENDENCY_SECTIONS) {
      const dependencies = manifest[section];
      if (!dependencies || !Object.hasOwn(dependencies, '@noble/hashes')) continue;
      const range = dependencies['@noble/hashes'];
      declarers.push({ directory, section, range });
      if (range !== NOBLE_HASHES_RANGE) {
        violations.push(
          `${directory} declares @noble/hashes as ${JSON.stringify(range)} in ${section}; expected ${NOBLE_HASHES_RANGE}`,
        );
      }
    }
  }
  return { declarers, violations };
}

function collectNobleHashesEntries(table, prefix = '') {
  if (!table || typeof table !== 'object' || Array.isArray(table)) return [];
  return Object.entries(table).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}>${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return [
        ...(NOBLE_HASHES_KEY.test(key) ? [[path, JSON.stringify(value)]] : []),
        ...collectNobleHashesEntries(value, path),
      ];
    }
    return NOBLE_HASHES_KEY.test(key) ? [[path, value]] : [];
  });
}

function auditNobleHashesOverrides(manifests, exceptions = NOBLE_HASHES_RESOLUTION_EXCEPTIONS) {
  const violations = [];
  const matchedExceptions = new Set();
  for (const { directory, manifest } of manifests) {
    const expectedResolution = exceptions.get(directory);
    for (const [key, value] of collectNobleHashesEntries(manifest.resolutions)) {
      if (key === '@noble/hashes' && expectedResolution !== undefined && value === expectedResolution) {
        matchedExceptions.add(directory);
        continue;
      }
      violations.push(
        `${directory} must not override @noble/hashes in resolutions (${key}: ${JSON.stringify(value)})`,
      );
    }
    for (const [field, table] of [
      ['overrides', manifest.overrides],
      ['pnpm.overrides', manifest.pnpm?.overrides],
    ]) {
      for (const [key, value] of collectNobleHashesEntries(table)) {
        violations.push(
          `${directory} must not override @noble/hashes in ${field} (${key}: ${JSON.stringify(value)})`,
        );
      }
    }
  }
  for (const [directory, expectedResolution] of exceptions) {
    if (!matchedExceptions.has(directory)) {
      violations.push(
        `${directory} must carry resolutions["@noble/hashes"] = ${JSON.stringify(expectedResolution)} or retire its #5232 exception`,
      );
    }
  }
  return violations;
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

test('@noble/hashes uses one v2 compatibility range across every first-party declarer', () => {
  const manifests = firstPartyManifests();
  assert.ok(
    manifests.some(({ directory }) => directory === 'operator'),
    'first-party manifest scan must reach top-level workspaces outside packages/',
  );
  const { declarers, violations } = auditNobleHashesRanges(manifests);
  assert.ok(
    declarers.some(({ directory }) => directory === 'packages/task-execution/profiles')
      && declarers.some(({ directory }) => !directory.startsWith('packages/task-execution/')),
    'expected @noble/hashes declarer scan to find declarers both inside and outside packages/task-execution/',
  );
  assert.deepEqual(violations, []);
});

test('no first-party manifest overrides the @noble/hashes resolution outside #5232', () => {
  const manifests = firstPartyManifests();
  assert.ok(
    manifests.length > TASK_EXECUTION_PACKAGES.length + EXTERNAL_JINN_PACKAGES.length
      && manifests.some(({ directory }) => directory === 'operator'),
    'first-party manifest scan must cover workspaces beyond the task-execution closure',
  );
  assert.deepEqual(auditNobleHashesOverrides(manifests), []);
});

test('the testing kit declares no Vitest peer', () => {
  const testing = readPackage('testing');
  assert.equal(testing.peerDependencies, undefined);
  assert.equal(testing.peerDependenciesMeta, undefined);
});

function writeFixtureManifest(repoDir, relativeDir, manifest) {
  const targetDir = relativeDir === '.' ? repoDir : join(repoDir, relativeDir);
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

test('self-test: first-party manifest scan skips dot-directories, node_modules, build outputs, legacy, and fixtures', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-noble-hashes-walk-'));
  try {
    writeFixtureManifest(fixture, 'operator', { name: '@jinn-network/operator' });
    writeFixtureManifest(fixture, 'packages/alpha', { name: '@jinn-network/alpha' });
    writeFixtureManifest(fixture, 'node_modules/dep', { name: 'dep' });
    writeFixtureManifest(fixture, 'packages/alpha/node_modules/nested', { name: 'nested' });
    writeFixtureManifest(fixture, 'packages/alpha/dist', { name: 'built' });
    writeFixtureManifest(fixture, 'legacy/jinn-cli-agents-reference', { name: 'legacy-ref' });
    writeFixtureManifest(fixture, '.github/fixtures/role', { name: 'role-fixture' });
    writeFixtureManifest(fixture, 'operator/test/fixtures/app', { name: 'eval-fixture' });
    writeFixtureManifest(fixture, 'packages/alpha/src/__fixtures__/bundle', { name: 'bundle-fixture' });
    writeFixtureManifest(fixture, '.transient-test-dir', { name: 'transient' });
    assert.deepEqual(
      firstPartyManifests(fixture).map(({ directory }) => directory),
      ['operator', 'packages/alpha'],
    );
    assert.deepEqual(packageManifests(join(fixture, 'vanished')), []);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('self-test: range audit flags non-conforming @noble/hashes specs across all dependency sections and ignores near-misses', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-noble-hashes-ranges-'));
  try {
    writeFixtureManifest(fixture, 'packages/clean-dep', {
      dependencies: { '@noble/hashes': '^2.2.0', '@noble/curves': '2.3.0' },
    });
    writeFixtureManifest(fixture, 'packages/clean-dev', {
      devDependencies: { '@noble/hashes': '^2.2.0' },
    });
    writeFixtureManifest(fixture, 'packages/clean-peer', {
      peerDependencies: { '@noble/hashes': '^2.2.0' },
    });
    writeFixtureManifest(fixture, 'packages/clean-opt', {
      optionalDependencies: { '@noble/hashes': '^2.2.0' },
    });
    writeFixtureManifest(fixture, 'packages/unrelated', {
      dependencies: { zod: '4.4.3' },
    });
    writeFixtureManifest(fixture, 'legacy/ignored', {
      dependencies: { '@noble/hashes': '1.8.0' },
    });
    writeFixtureManifest(fixture, 'operator/test/fixtures/ignored', {
      dependencies: { '@noble/hashes': '2.2.0' },
    });
    writeFixtureManifest(fixture, 'packages/exact-dep', {
      dependencies: { '@noble/hashes': '2.2.0' },
    });
    writeFixtureManifest(fixture, 'packages/bad-dev', {
      dependencies: { '@noble/hashes': '^2.2.0' },
      devDependencies: { '@noble/hashes': '2.2.0' },
    });
    writeFixtureManifest(fixture, 'packages/bad-peer', {
      peerDependencies: { '@noble/hashes': '>=2.0.0' },
    });
    writeFixtureManifest(fixture, 'packages/bad-opt', {
      optionalDependencies: { '@noble/hashes': '~2.2.0' },
    });

    const { declarers, violations } = auditNobleHashesRanges(firstPartyManifests(fixture));
    assert.equal(declarers.length, 9);
    assert.deepEqual(violations, [
      'packages/bad-dev declares @noble/hashes as "2.2.0" in devDependencies; expected ^2.2.0',
      'packages/bad-opt declares @noble/hashes as "~2.2.0" in optionalDependencies; expected ^2.2.0',
      'packages/bad-peer declares @noble/hashes as ">=2.0.0" in peerDependencies; expected ^2.2.0',
      'packages/exact-dep declares @noble/hashes as "2.2.0" in dependencies; expected ^2.2.0',
    ]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('self-test: override audit flags unapproved resolutions or overrides, rejects stale exceptions, and ignores near-misses', () => {
  const compliant = [
    {
      directory: 'packages/benchmark-product/check',
      manifest: {
        resolutions: {
          '@noble/hashes': '2.2.0',
          '@jinn-network/trust-core': 'portal:../../trust/core',
        },
      },
    },
    {
      directory: 'packages/near-miss',
      manifest: {
        resolutions: { '@noble/curves': '2.3.0', '@noble/hashes-extra': '1.0.0' },
      },
    },
  ];
  assert.deepEqual(auditNobleHashesOverrides(compliant), []);

  assert.deepEqual(
    auditNobleHashesOverrides([
      ...compliant,
      { directory: 'packages/other', manifest: { resolutions: { '@noble/hashes': '2.2.0' } } },
      { directory: 'packages/scoped', manifest: { resolutions: { '@noble/curves/@noble/hashes': '2.2.0' } } },
      { directory: 'packages/npm-override', manifest: { overrides: { '@noble/curves': { '@noble/hashes': '2.2.0' } } } },
      { directory: 'packages/pnpm-override', manifest: { pnpm: { overrides: { '@noble/hashes': '2.2.0' } } } },
    ]),
    [
      'packages/other must not override @noble/hashes in resolutions (@noble/hashes: "2.2.0")',
      'packages/scoped must not override @noble/hashes in resolutions (@noble/curves/@noble/hashes: "2.2.0")',
      'packages/npm-override must not override @noble/hashes in overrides (@noble/curves>@noble/hashes: "2.2.0")',
      'packages/pnpm-override must not override @noble/hashes in pnpm.overrides (@noble/hashes: "2.2.0")',
    ],
  );

  assert.deepEqual(
    auditNobleHashesOverrides([
      { directory: 'packages/benchmark-product/check', manifest: { resolutions: {} } },
    ]),
    [
      'packages/benchmark-product/check must carry resolutions["@noble/hashes"] = "2.2.0" or retire its #5232 exception',
    ],
  );

  assert.deepEqual(
    auditNobleHashesOverrides([
      { directory: 'packages/benchmark-product/check', manifest: { resolutions: { '@noble/hashes': '2.3.0' } } },
    ]),
    [
      'packages/benchmark-product/check must not override @noble/hashes in resolutions (@noble/hashes: "2.3.0")',
      'packages/benchmark-product/check must carry resolutions["@noble/hashes"] = "2.2.0" or retire its #5232 exception',
    ],
  );
});

// The scan above reads every first-party manifest, so it must run on a change to any of them.
// Task Execution CI is path-filtered and merge-group selection skips lanes a manifest does not
// reach; Repository structure runs on every pull request and merge group, so the scan is wired
// there and that workflow must stay unfiltered (#5277).
test('the manifest scan runs in the unfiltered Repository structure workflow', () => {
  const workflow = readFileSync(join(root, '.github/workflows/repository-structure.yml'), 'utf8');
  const triggers = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\nconcurrency:'));
  for (const event of ['pull_request:', 'merge_group:']) {
    assert.ok(triggers.includes(event), `Repository structure must trigger on ${event}`);
  }
  assert.ok(!/^\s+paths(?:-ignore)?:/mu.test(triggers), 'Repository structure must not path-filter its triggers');
  assert.match(
    workflow,
    /^\s+run: node --test \.github\/scripts\/task-execution-package-inventory\.test\.mjs$/mu,
    'Repository structure must run the manifest scan',
  );
});
