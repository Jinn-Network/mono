import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packages = join(root, 'packages', 'task-execution');
const taskExecutionDirectories = [
  'protocol', 'backend', 'testing', 'profiles',
  'backend-local/supervisor', 'backend-local/workspace', 'backend-local/launchers', 'backend-local/assembly',
  'evaluation-harness', 'evaluator-adapters', 'oci-grader',
];
const APPLICATION_AND_LEGACY_ROOTS = [
  join(root, 'apps'),
  join(root, 'client'),
  ...[
    'autopilot', 'core', 'indexer', 'indexer-enrichment', 'layer', 'plugin',
    'sdk',
  ].map((directory) => join(root, 'packages', directory)),
];

// Packages the whole task-execution tree is forbidden to import (coordinator import graph:
// "TEP protocol imports nothing … evidence refs are structural"). The `backend-local/assembly`
// package carves out exactly `@jinn-network/evidence-repository`, `@jinn-network/evidence-discovery`,
// and `@jinn-network/execution-recorder` below (program §7.7) — every other tree/package here
// stays forbidden everywhere, assembly included.
const TASK_EXECUTION_FOREIGN_PACKAGES = [
  '@jinn-network/marketplace-binding',
  '@jinn-network/marketplace-pipeline',
  '@jinn-network/marketplace-projector',
  '@jinn-network/marketplace-testing',
  '@jinn-network/marketplace-venue-base',
  '@jinn-network/evidence-protocol',
  '@jinn-network/evidence-repository',
  '@jinn-network/evidence-repository-oci',
  '@jinn-network/evidence-repository-ipfs',
  '@jinn-network/evidence-discovery',
  '@jinn-network/evidence-catalog-sqlite',
  '@jinn-network/evidence-derivation',
  '@jinn-network/evidence-publication',
  '@jinn-network/evidence-local-runtime',
  '@jinn-network/execution-recorder',
  '@jinn-network/attestation-issuer',
  '@jinn-network/trust-core',
  '@jinn-network/trust-resolve',
  '@jinn-network/trust-testing',
  '@jinn-network/record-discovery-protocol',
  '@jinn-network/record-discovery-serve',
  '@jinn-network/record-discovery-client',
  '@jinn-network/record-discovery-testing',
  'viem',
  'better-sqlite3',
  'kubo-rpc-client',
];

const AMBIENT_NETWORK_APIS = ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest'];
const ambientNetworkIdentifier = new RegExp(
  String.raw`(?<![\w$."'\x60])(?:${AMBIENT_NETWORK_APIS.join('|')})\b`,
  'g',
);
const ambientNetworkGlobal = new RegExp(
  String.raw`\b(?:globalThis|global)\s*(?:(?:\.|\?\.)\s*(?:${AMBIENT_NETWORK_APIS.join('|')})\b|(?:\?\.)?\s*\[\s*["'](?:${AMBIENT_NETWORK_APIS.join('|')})["']\s*\])`,
  'g',
);

// Canonical task-execution bytes must not depend on the host locale or the bundled ICU data.
// These APIs all consult one or both, so an ordering or formatting decision made with them can
// change a record's SHA-256 digest between two hosts running identical code. Use a code-unit
// comparator instead; see any package's src/order.ts.
const LOCALE_SENSITIVE_APIS = [
  'localeCompare',
  'toLocaleUpperCase',
  'toLocaleLowerCase',
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
];
const localeSensitiveMember = new RegExp(
  String.raw`(?:\.|\?\.)\s*(?:${LOCALE_SENSITIVE_APIS.join('|')})\s*\(`,
  'g',
);
const localeSensitiveIntl = new RegExp(
  String.raw`(?<![\w$."'\x60])Intl\s*(?:\.|\?\.)`,
  'g',
);

function localeSensitiveUsesInFiles(sourceFiles) {
  return sourceFiles.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [
      ...[...source.matchAll(localeSensitiveMember)],
      ...[...source.matchAll(localeSensitiveIntl)],
    ].map((match) => `${relative(root, file)} -> ${match[0].trim()}`);
  }).sort();
}

function ambientNetworkUsesInFiles(sourceFiles) {
  return sourceFiles.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const identifiers = [...source.matchAll(ambientNetworkIdentifier)]
      .map((match) => `${relative(root, file)} -> ${match[0]}`);
    const globals = [...source.matchAll(ambientNetworkGlobal)]
      .map((match) => `${relative(root, file)} -> ${match[0]}`);
    return [...identifiers, ...globals];
  }).sort();
}

function files(directory) {
  if (!existsSync(directory)) return [];
  if (lstatSync(directory).isFile()) return /\.(?:[cm]?[jt]sx?)$/.test(directory) ? [directory] : [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
  });
}

function specifiers(source) {
  const trivia = String.raw`(?:(?:\s+)|(?:\/\*[\s\S]*?\*\/)|(?:\/\/[^\r\n]*(?:\r?\n|$)))*`;
  return [
    new RegExp(String.raw`\bfrom${trivia}["']([^"']+)["']`, 'g'),
    new RegExp(String.raw`\bimport${trivia}["']([^"']+)["']`, 'g'),
    new RegExp(String.raw`\bimport${trivia}\(${trivia}["']([^"']+)["']${trivia}\)`, 'g'),
    new RegExp(String.raw`\brequire${trivia}\(${trivia}["']([^"']+)["']${trivia}\)`, 'g'),
    new RegExp(String.raw`\bimport${trivia}\(${trivia}\x60((?:(?!\$\{)[^\x60])*)\x60${trivia}\)`, 'g'),
    new RegExp(String.raw`\brequire${trivia}\(${trivia}\x60((?:(?!\$\{)[^\x60])*)\x60${trivia}\)`, 'g'),
  ].flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

function inside(child, parent) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'));
}

function sourceModuleStem(path) {
  return path.replace(/\.[cm]?[jt]sx?$/u, '');
}

function insideForbiddenRoot(path, forbiddenRoot) {
  return existsSync(forbiddenRoot) && lstatSync(forbiddenRoot).isFile()
    ? sourceModuleStem(path) === sourceModuleStem(forbiddenRoot)
    : inside(path, forbiddenRoot);
}

function forbiddenImportsInFiles(sourceFiles, forbiddenPackages, forbiddenRoots = []) {
  return sourceFiles.flatMap((file) => specifiers(readFileSync(file, 'utf8')).flatMap((specifier) => {
    const packageMatch = forbiddenPackages.some((forbidden) => forbidden.endsWith('/')
      ? specifier.startsWith(forbidden) : specifier === forbidden || specifier.startsWith(`${forbidden}/`));
    const pathMatch = specifier.startsWith('.') && forbiddenRoots.some((forbiddenRoot) =>
      insideForbiddenRoot(resolve(dirname(file), specifier), forbiddenRoot));
    return packageMatch || pathMatch ? [`${relative(root, file)} -> ${specifier}`] : [];
  })).sort();
}

function forbiddenImports(sourceRoot, forbiddenPackages, forbiddenRoots = []) {
  return forbiddenImportsInFiles(files(sourceRoot), forbiddenPackages, forbiddenRoots);
}

function assertBoundary(sourceRoot, forbiddenPackages, forbiddenRoots = []) {
  assert.deepEqual(forbiddenImports(sourceRoot, forbiddenPackages, forbiddenRoots), [],
    `${relative(root, sourceRoot)} crosses a task-execution architecture boundary`);
}

test('the import scanner catches static, export, dynamic, require, and local-path escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-task-execution-boundary-'));
  try {
    const source = join(fixture, 'src');
    const forbidden = join(fixture, 'forbidden');
    mkdirSync(source); mkdirSync(forbidden);
    writeFileSync(join(source, 'source.ts'), [
      'import value from "@jinn-network/forbidden";',
      'export { value } from "@jinn-network/forbidden/export";',
      'await import("@jinn-network/forbidden/dynamic");',
      'require("@jinn-network/forbidden/require");',
      'await import(/* webpackIgnore: true */ "@jinn-network/forbidden/commented-dynamic");',
      'export { value } from /* boundary */ "@jinn-network/forbidden/commented-export";',
      'await import(// boundary', '  "@jinn-network/forbidden/line-comment");',
      'export { value } from /* first */ /* second */ "@jinn-network/forbidden/multiple-comments";',
      'await import(`@jinn-network/forbidden/template-dynamic`);',
      'require(`@jinn-network/forbidden/template-require`);',
      'import "../forbidden/local.js";',
    ].join('\n'));
    const findings = forbiddenImports(source, ['@jinn-network/'], [forbidden]);
    assert.equal(findings.length, 11);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

// task-execution sibling packages must never import beyond their approved dependencies — new
// siblings are added here as they register.
const TASK_EXECUTION_SIBLINGS_FORBIDDEN_FROM_BACKEND = [
  '@jinn-network/task-execution-testing',
  '@jinn-network/task-execution-supervisor',
  '@jinn-network/task-execution-workspace',
  '@jinn-network/task-execution-launchers',
  '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-evaluation-harness',
];

// profiles depends on protocol only (program §7.3/§7.15; plan Global Constraints): every other
// task-execution sibling is forbidden, same as the foreign-package boundary.
const TASK_EXECUTION_SIBLINGS_FORBIDDEN_FROM_PROFILES = [
  '@jinn-network/task-execution-backend',
  '@jinn-network/task-execution-testing',
  '@jinn-network/task-execution-supervisor',
  '@jinn-network/task-execution-workspace',
  '@jinn-network/task-execution-launchers',
  '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-evaluation-harness',
];

// backend-local component import allowlists (backend plan Task A2 Step 4): a package-level
// one-way dependency graph enforcing the design §5 never-touches columns. The internal DAG is
// [supervisor ∥ workspace] → launchers → assembly (plan Finding (e)); `supervisor` is
// deliberately the most dependency-free component (design §15).

// supervisor: protocol + backend only — never workspace/launchers/assembly, never profiles,
// never evidence, never git.
const SUPERVISOR_FORBIDDEN = [
  ...TASK_EXECUTION_FOREIGN_PACKAGES,
  '@jinn-network/task-execution-profiles',
  '@jinn-network/task-execution-testing',
  '@jinn-network/task-execution-workspace',
  '@jinn-network/task-execution-launchers',
  '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-evaluation-harness',
];

// workspace: protocol + profiles only — never supervisor/launchers/assembly, never evidence.
// (`executionEnv` takes the workspace-owned `LaunchEnv` subset, never the launchers `LaunchPlan`
// — so there is no workspace↔launchers cycle, plan A2 §7.1.)
const WORKSPACE_FORBIDDEN = [
  ...TASK_EXECUTION_FOREIGN_PACKAGES,
  '@jinn-network/task-execution-testing',
  '@jinn-network/task-execution-supervisor',
  '@jinn-network/task-execution-launchers',
  '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-evaluation-harness',
];

// launchers: protocol + profiles + supervisor + workspace — never assembly, never evidence, and
// never spawns (design §8.4 — no `node:child_process`; the supervisor spawns through the shim).
const LAUNCHERS_FORBIDDEN = [
  ...TASK_EXECUTION_FOREIGN_PACKAGES,
  '@jinn-network/task-execution-testing',
  '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-evaluation-harness',
  'node:child_process',
];

// assembly (`@jinn-network/task-execution-backend-local`): the three siblings + protocol/backend/
// profiles + the evidence CONTRACT packages only (program §7.7) — never
// `@jinn-network/evidence-local-runtime`, never `@jinn-network/evidence-protocol` directly
// (types against the contracts only), never any `record-discovery-*` package.
const ASSEMBLY_ALLOWED_EVIDENCE = [
  '@jinn-network/evidence-repository',
  '@jinn-network/evidence-discovery',
  '@jinn-network/execution-recorder',
];
const ASSEMBLY_FORBIDDEN = [
  ...TASK_EXECUTION_FOREIGN_PACKAGES.filter((name) => !ASSEMBLY_ALLOWED_EVIDENCE.includes(name)),
  '@jinn-network/task-execution-testing',
  '@jinn-network/task-execution-evaluation-harness',
];

const EVALUATION_HARNESS_ALLOWED_EVIDENCE = [
  '@jinn-network/evidence-protocol',
  '@jinn-network/attestation-issuer',
];
const EVALUATION_HARNESS_PRODUCTION_FORBIDDEN = [
  ...TASK_EXECUTION_FOREIGN_PACKAGES
    .filter((name) => !EVALUATION_HARNESS_ALLOWED_EVIDENCE.includes(name)),
  '@jinn-network/task-execution-backend',
  '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-testing',
];
const EVALUATION_HARNESS_TEST_ALLOWED_EVIDENCE = [
  ...EVALUATION_HARNESS_ALLOWED_EVIDENCE,
  '@jinn-network/evidence-repository',
  '@jinn-network/evidence-discovery',
  '@jinn-network/execution-recorder',
];
const EVALUATION_HARNESS_TEST_FORBIDDEN = TASK_EXECUTION_FOREIGN_PACKAGES
  .filter((name) => !EVALUATION_HARNESS_TEST_ALLOWED_EVIDENCE.includes(name));

// evaluator-adapters (composition design §6.3) is a leaf: it consumes the adapter
// contract, the EvaluationSpec vocabulary, and the Attempt identity, and imports no
// evidence/trust/discovery package and no chain or network client in production.
const EVALUATOR_ADAPTERS_PRODUCTION_FORBIDDEN = [
  ...TASK_EXECUTION_FOREIGN_PACKAGES,
  '@jinn-network/task-execution-backend',
  '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-launchers',
  '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-testing',
  '@jinn-network/task-execution-workspace',
];
// oci-grader is a leaf: it consumes the GraderReportSource port, the EvaluationSpec vocabulary,
// and the harness's operational-error/exact-material types. It never reaches a backend, a
// workspace, a launcher, or any evidence/trust/discovery package, and never touches the network
// itself — only the container runtime it spawns does.
const OCI_GRADER_PRODUCTION_FORBIDDEN = [
  ...TASK_EXECUTION_FOREIGN_PACKAGES,
  '@jinn-network/task-execution-backend',
  '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-launchers',
  '@jinn-network/task-execution-protocol',
  '@jinn-network/task-execution-testing',
  '@jinn-network/task-execution-workspace',
];
// Its tests drive the real harness runtime end-to-end, so they may seal Task/Delivery
// documents and place workspace paths — but still touch no evidence runtime.
const EVALUATOR_ADAPTERS_TEST_FORBIDDEN = [
  ...TASK_EXECUTION_FOREIGN_PACKAGES
    .filter((name) => name !== '@jinn-network/evidence-protocol'),
  '@jinn-network/task-execution-backend-local',
  '@jinn-network/task-execution-testing',
];

// The downstream backend-local conformance test is the sanctioned real-assembly consumer
// (backend plan C4, program §7.25). It injects the evidence repository/catalog test
// implementations through the assembly-owned ports; no production testing-kit module may
// import them, and every other evidence/runtime package remains forbidden even in this test.
const TESTING_BACKEND_LOCAL_TEST_ALLOWED_EVIDENCE = [
  '@jinn-network/evidence-repository',
  '@jinn-network/evidence-discovery',
];
const TESTING_BACKEND_LOCAL_TEST_FORBIDDEN = TASK_EXECUTION_FOREIGN_PACKAGES
  .filter((name) => !TESTING_BACKEND_LOCAL_TEST_ALLOWED_EVIDENCE.includes(name));

// Cross-tree consumption rule (program §7.18): nothing OUTSIDE `packages/task-execution/backend-local/`
// imports `@jinn-network/task-execution-{supervisor,workspace,launchers}` except the assembly,
// the testing `./backend-local` slice, and the evaluation harness's launcher surface. `protocol`
// already forbids every `@jinn-network/` import outright; `backend` and `profiles` gain the
// three component names via their sibling-forbidden lists above; `testing` is the sanctioned
// exception (plan Finding (a)/(c)) so it is deliberately NOT added there.
const BACKEND_LOCAL_COMPONENT_PACKAGES = [
  '@jinn-network/task-execution-supervisor',
  '@jinn-network/task-execution-workspace',
  '@jinn-network/task-execution-launchers',
];

// profiles' approved production/dev dependency inventory (plan Task 1 Step 3; sorted, code
// unit). New dependencies require a plan/design amendment, not an ad hoc guard edit.
const PROFILES_ALLOWED_DEPENDENCIES = [
  '@jinn-network/task-execution-protocol',
  '@noble/hashes',
  'ajv',
  'safe-regex',
  'zod',
];
const PROFILES_ALLOWED_DEV_DEPENDENCIES = [
  '@types/node',
  '@types/safe-regex',
  'typescript',
  'vitest',
];

test('task-execution source boundaries remain one-way across the approved graph', () => {
  assertBoundary(join(packages, 'protocol', 'src'), ['@jinn-network/']);
  assertBoundary(join(packages, 'protocol', 'src'), TASK_EXECUTION_FOREIGN_PACKAGES);

  // backend depends on protocol only: protocol imports freely, every other task-execution
  // sibling and every foreign package are forbidden.
  assertBoundary(
    join(packages, 'backend', 'src'),
    [...TASK_EXECUTION_FOREIGN_PACKAGES, ...TASK_EXECUTION_SIBLINGS_FORBIDDEN_FROM_BACKEND],
  );

  // Production testing-kit modules remain evidence-independent. The downstream C4
  // conformance test alone may construct the injected in-memory repository/catalog.
  const testingSrc = join(packages, 'testing', 'src');
  const testingBackendLocalTests = files(join(testingSrc, 'backend-local'))
    .filter((file) => /\.test\.[cm]?[jt]sx?$/.test(file));
  const testingWithoutBackendLocalTests = files(testingSrc)
    .filter((file) => !testingBackendLocalTests.includes(file));
  assert.deepEqual(
    forbiddenImportsInFiles(testingWithoutBackendLocalTests, TASK_EXECUTION_FOREIGN_PACKAGES),
    [],
    'testing production source and non-backend-local tests must remain evidence-independent',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(testingBackendLocalTests, TESTING_BACKEND_LOCAL_TEST_FORBIDDEN),
    [],
    'backend-local conformance tests may import only injected repository/catalog test bindings',
  );

  // profiles depends on protocol only: every foreign package and every other task-execution
  // sibling (backend, testing) are forbidden.
  assertBoundary(
    join(packages, 'profiles', 'src'),
    [...TASK_EXECUTION_FOREIGN_PACKAGES, ...TASK_EXECUTION_SIBLINGS_FORBIDDEN_FROM_PROFILES],
  );

  // backend-local (design §15, program §6 decision 2 revised): the package-level one-way
  // dependency graph enforcing the §5 never-touches columns (plan Task A2 Step 4).
  assertBoundary(join(packages, 'backend-local', 'supervisor', 'src'), SUPERVISOR_FORBIDDEN);
  assertBoundary(join(packages, 'backend-local', 'workspace', 'src'), WORKSPACE_FORBIDDEN);
  assertBoundary(join(packages, 'backend-local', 'launchers', 'src'), LAUNCHERS_FORBIDDEN);
  assertBoundary(join(packages, 'backend-local', 'assembly', 'src'), ASSEMBLY_FORBIDDEN);

  // The harness consumes the launcher/workspace/supervisor contract surface and only the
  // Evidence Protocol + Attestation Issuer production contracts. Assembly and fake evidence
  // bindings are downstream integration-test dependencies, never production imports.
  const harnessSrc = join(packages, 'evaluation-harness', 'src');
  const harnessTests = files(harnessSrc)
    .filter((file) => /\.test\.[cm]?[jt]sx?$/u.test(file));
  const harnessProduction = files(harnessSrc)
    .filter((file) => !harnessTests.includes(file));
  assert.deepEqual(
    forbiddenImportsInFiles(
      harnessProduction,
      EVALUATION_HARNESS_PRODUCTION_FORBIDDEN,
    ),
    [],
    'evaluation-harness production source crosses its approved contract boundary',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(harnessTests, EVALUATION_HARNESS_TEST_FORBIDDEN),
    [],
    'evaluation-harness tests may import only approved injected evidence bindings',
  );

  const adaptersSrc = join(packages, 'evaluator-adapters', 'src');
  const adaptersTests = files(adaptersSrc)
    .filter((file) => /\.test\.[cm]?[jt]sx?$/u.test(file));
  const adaptersProduction = files(adaptersSrc)
    .filter((file) => !adaptersTests.includes(file));
  assert.deepEqual(
    forbiddenImportsInFiles(adaptersProduction, EVALUATOR_ADAPTERS_PRODUCTION_FORBIDDEN),
    [],
    'evaluator-adapters production source crosses its approved contract boundary',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(adaptersTests, EVALUATOR_ADAPTERS_TEST_FORBIDDEN),
    [],
    'evaluator-adapters tests may import only the approved harness-driving surface',
  );

  const ociGraderSrc = join(packages, 'oci-grader', 'src');
  const ociGraderTests = files(ociGraderSrc)
    .filter((file) => /\.test\.[cm]?[jt]sx?$/u.test(file));
  const ociGraderProduction = files(ociGraderSrc)
    .filter((file) => !ociGraderTests.includes(file));
  assert.deepEqual(
    forbiddenImportsInFiles(ociGraderProduction, OCI_GRADER_PRODUCTION_FORBIDDEN),
    [],
    'oci-grader production source crosses its approved contract boundary',
  );
  assert.deepEqual(
    forbiddenImportsInFiles(ociGraderTests, OCI_GRADER_PRODUCTION_FORBIDDEN),
    [],
    'oci-grader tests may import only the approved contract surface',
  );
});

test('cross-tree consumption: only assembly, the testing kit slice, and the evaluation harness may import backend-local components (program §7.18)', () => {
  for (const directory of ['protocol', 'backend', 'profiles']) {
    assertBoundary(join(packages, directory, 'src'), BACKEND_LOCAL_COMPONENT_PACKAGES);
  }
  // `testing` is the sanctioned exception (plan Finding (a)/(c)) for its `./backend-local` kit
  // slice — but the rest of testing/src has no legitimate reason to reach into the components.
  const testingSrc = join(packages, 'testing', 'src');
  const testingBackendLocalSlice = join(testingSrc, 'backend-local');
  const testingOutsideSlice = files(testingSrc).filter((file) => !inside(file, testingBackendLocalSlice));
  assert.deepEqual(
    forbiddenImportsInFiles(testingOutsideSlice, BACKEND_LOCAL_COMPONENT_PACKAGES),
    [],
    'testing/src outside the backend-local kit slice must not import backend-local components',
  );
});

test('backend-local component packages expose a single "." export entry (no subpath exports)', () => {
  for (const directory of ['backend-local/supervisor', 'backend-local/workspace', 'backend-local/launchers', 'backend-local/assembly']) {
    const manifest = JSON.parse(readFileSync(join(packages, directory, 'package.json'), 'utf8'));
    assert.deepEqual(
      Object.keys(manifest.exports ?? {}),
      ['.'],
      `${directory} must expose exactly one "." export entry — the four packages replace the former subpaths`,
    );
  }
});

test('profiles production and development dependency inventories match the approved design', () => {
  const manifest = JSON.parse(readFileSync(join(packages, 'profiles', 'package.json'), 'utf8'));
  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}).sort(),
    PROFILES_ALLOWED_DEPENDENCIES,
    'profiles production dependencies must match the approved design inventory',
  );
  assert.deepEqual(
    Object.keys(manifest.devDependencies ?? {}).sort(),
    PROFILES_ALLOWED_DEV_DEPENDENCIES,
    'profiles development dependencies must match the approved toolchain',
  );
});

test('locale-sensitive API detection catches member calls, optional chaining, and Intl', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-task-execution-locale-boundary-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      ...LOCALE_SENSITIVE_APIS.flatMap((api) => [
        `left.${api}(right);`,
        `left?.${api}(right);`,
      ]),
      'new Intl.Collator("en-US").compare(left, right);',
      'Intl?.Collator;',
    ].join('\n'));
    assert.equal(
      localeSensitiveUsesInFiles(files(source)).length,
      LOCALE_SENSITIVE_APIS.length * 2 + 2,
    );

    writeFileSync(join(source, 'clean.ts'), [
      'export function compareCodeUnitStrings(left, right) {',
      '  return left < right ? -1 : left > right ? 1 : 0;',
      '}',
      '// localeCompare is banned; this comment must not trip the scanner.',
    ].join('\n'));
    assert.deepEqual(localeSensitiveUsesInFiles([join(source, 'clean.ts')]), []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('Task-execution production source never orders or formats with the host locale', () => {
  for (const directory of taskExecutionDirectories) {
    const source = join(packages, directory, 'src');
    if (!existsSync(source)) continue;
    const production = files(source)
      .filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
    assert.deepEqual(
      localeSensitiveUsesInFiles(production),
      [],
      `${directory} production source must not depend on the host locale or ICU data; `
        + 'canonical task-execution bytes would differ between hosts. Use src/order.ts.',
    );
  }
});

// Program §1 C5 / §9 addendum F9: `packages/task-execution/backend-local/workspace/src/
// harness-state-package.ts` MIRRORS (never imports — client is tier 4, workspace is tier 3, and
// the frozen dependency direction forbids the reverse edge) the `learner-public.v1` hash profile
// shipped in `client/src/harnesses/hash-profile.ts`. This is the drift guard: it reads both
// files as plain text (the established `packages/task-supply/curation` "drift" pattern —
// `.github/scripts/task-supply-curation-guards.test.mjs`) and asserts the mirrored constants and
// the cross-unit golden digest still agree. A third independent implementation exists in
// `@jinn-network/policy-identity` (`packages/policy/identity/src/hash-profile.ts`, C1) — merged
// with #2368 and asserted below, so all three pairwise mirrors are bound (program review MAJOR 1:
// the "not part of this tree yet" exclusion expired when the substrate merged).
function extractStringArrayLiteral(source, label) {
  const labelIndex = source.indexOf(label);
  assert.ok(labelIndex !== -1, `label "${label}" not found`);
  const open = source.indexOf('[', labelIndex);
  const close = source.indexOf(']', open);
  const body = source.slice(open + 1, close);
  return [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map((match) => match[1] ?? match[2]);
}

test('the mirrored learner-public.v1 profile constants match client/src/harnesses/hash-profile.ts', () => {
  const clientSource = readFileSync(join(root, 'client', 'src', 'harnesses', 'hash-profile.ts'), 'utf8');
  const workspaceSource = readFileSync(
    join(packages, 'backend-local', 'workspace', 'src', 'harness-state-package.ts'), 'utf8',
  );
  // The labels include the opening bracket so the search lands on the value literal
  // (`ignoreRelPaths: ['.git', ...]`) rather than the interface's type signature
  // (`readonly ignoreRelPaths: readonly string[];`), which also contains the label text.
  assert.deepEqual(
    extractStringArrayLiteral(workspaceSource, 'LEARNER_PUBLIC_V1_EXCLUDED_ROOTS = ['),
    extractStringArrayLiteral(clientSource, 'ignoreRelPaths: ['),
    'the workspace mirror\'s excluded roots drifted from client\'s ignoreRelPaths',
  );
  assert.deepEqual(
    extractStringArrayLiteral(workspaceSource, 'LEARNER_PUBLIC_V1_ALLOWED_DIRS = ['),
    extractStringArrayLiteral(clientSource, 'allowedDirs: ['),
    'the workspace mirror\'s allowed dirs drifted from client\'s allowedDirs',
  );
  assert.deepEqual(
    extractStringArrayLiteral(workspaceSource, 'LEARNER_PUBLIC_V1_ALLOWED_FILES = ['),
    extractStringArrayLiteral(clientSource, 'allowedFiles: ['),
    'the workspace mirror\'s allowed files drifted from client\'s allowedFiles',
  );
  // Third mirror (program review MAJOR 1): @jinn-network/policy-identity ships the same
  // tables in packages/policy/identity/src/tokens.ts. Binding identity<->client here makes
  // all three pairwise agreements guarded (workspace<->client above; identity<->workspace
  // follows transitively).
  const identitySource = readFileSync(
    join(root, 'packages', 'policy', 'identity', 'src', 'tokens.ts'), 'utf8',
  );
  assert.deepEqual(
    extractStringArrayLiteral(identitySource, 'LEARNER_PUBLIC_V1_EXCLUDED_ROOTS = ['),
    extractStringArrayLiteral(clientSource, 'ignoreRelPaths: ['),
    "the policy-identity mirror's excluded roots drifted from client's ignoreRelPaths",
  );
  assert.deepEqual(
    extractStringArrayLiteral(identitySource, 'LEARNER_PUBLIC_V1_ALLOWED_DIRS = ['),
    extractStringArrayLiteral(clientSource, 'allowedDirs: ['),
    "the policy-identity mirror's allowed dirs drifted from client's allowedDirs",
  );
  assert.deepEqual(
    extractStringArrayLiteral(identitySource, 'LEARNER_PUBLIC_V1_ALLOWED_FILES = ['),
    extractStringArrayLiteral(clientSource, 'allowedFiles: ['),
    "the policy-identity mirror's allowed files drifted from client's allowedFiles",
  );
});

test('the fork-healing golden digest constant is shared between client and the workspace mirror', () => {
  const digest = '90b25998166464fbb356ce7738149e7f173a78b6bff4d6896aaa96445e89abd8';
  const clientTest = readFileSync(join(root, 'client', 'test', 'harnesses', 'hash-profile.test.ts'), 'utf8');
  assert.ok(clientTest.includes(digest), 'client/test/harnesses/hash-profile.test.ts lost the fork-healing digest constant');
  const workspaceTest = readFileSync(
    join(packages, 'backend-local', 'workspace', 'src', 'harness-state-package.test.ts'), 'utf8',
  );
  assert.ok(workspaceTest.includes(digest), 'the workspace mirror\'s test lost the fork-healing digest constant');
});
