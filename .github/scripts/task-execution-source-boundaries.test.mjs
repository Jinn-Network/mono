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
];

// launchers: protocol + profiles + supervisor + workspace — never assembly, never evidence, and
// never spawns (design §8.4 — no `node:child_process`; the supervisor spawns through the shim).
const LAUNCHERS_FORBIDDEN = [
  ...TASK_EXECUTION_FOREIGN_PACKAGES,
  '@jinn-network/task-execution-testing',
  '@jinn-network/task-execution-backend-local',
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
];

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
  'canonicalize',
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

  // testing depends on protocol + backend only: both import freely, every foreign package and
  // every other task-execution sibling (none yet besides protocol/backend) are forbidden.
  assertBoundary(join(packages, 'testing', 'src'), TASK_EXECUTION_FOREIGN_PACKAGES);

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
