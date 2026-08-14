import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages', 'discovery');
const DEPENDENCY_SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
];

const DISCOVERY_PACKAGES = [
  ['protocol', '@jinn-network/record-discovery-protocol'],
  ['testing', '@jinn-network/record-discovery-testing'],
  ['serve', '@jinn-network/record-discovery-serve'],
  ['publication', '@jinn-network/record-publication'],
  ['client', '@jinn-network/record-discovery-client'],
  ['facts/evidence', '@jinn-network/record-discovery-facts-evidence'],
  ['facts/trust', '@jinn-network/record-discovery-facts-trust'],
  ['facts/task-execution', '@jinn-network/record-discovery-facts-task-execution'],
  ['facts/benchmarking', '@jinn-network/record-discovery-facts-benchmarking'],
  ['facts/environments', '@jinn-network/record-discovery-facts-environments'],
  ['facts/chain-environments', '@jinn-network/record-discovery-facts-chain-environments'],
  ['sources/evidence-journal', '@jinn-network/record-discovery-source-evidence-journal'],
  ['transport-http', '@jinn-network/record-discovery-transport-http'],
];

// Cross-tree Jinn dependencies live outside packages/discovery; map name -> absolute dir.
const SIBLING_TREE_DIRS = new Map([
  ['@jinn-network/trust-core', join(root, 'packages', 'trust', 'core')],
  ['@jinn-network/task-execution-protocol', join(root, 'packages', 'task-execution', 'protocol')],
  ['@jinn-network/task-execution-profiles', join(root, 'packages', 'task-execution', 'profiles')],
  ['@jinn-network/evidence-protocol', join(root, 'packages', 'evidence', 'protocol')],
  ['@jinn-network/evidence-discovery', join(root, 'packages', 'evidence', 'discovery')],
  ['@jinn-network/evidence-repository', join(root, 'packages', 'evidence', 'repository')],
  ['@jinn-network/benchmarking-records', join(root, 'packages', 'benchmarking', 'records')],
  ['@jinn-network/environment-record', join(root, 'packages', 'environments', 'record')],
  ['@jinn-network/chain-environment-record', join(root, 'packages', 'environments', 'chain-record')],
  ['@jinn-network/information-world', join(root, 'packages', 'environments', 'information-world')],
]);

const JINN_DEPENDENCY_GRAPH = new Map([
  ['protocol', { dependencies: ['@jinn-network/trust-core'], devDependencies: [], optionalDependencies: [], peerDependencies: [] }],
  // testing's own source only ever imports record-discovery-protocol (plan
  // Task 9: "no cross-tree deps"). trust-core is a *shadow* devDependency +
  // portal resolution -- yarn's per-project resolution step for this
  // standalone project resolves protocol's transitive `trust-core` npm
  // dependency too (no local registry publishes @jinn-network/*), and
  // that requires a matching top-level override here even though testing
  // never imports it (trust-testing's package.json shows the same
  // precedent: every Jinn package anywhere in the graph gets its own
  // resolutions entry). Recorded as a plan/mechanics deviation, not a
  // silent addition.
  ['testing', { dependencies: ['@jinn-network/record-discovery-protocol'], devDependencies: ['@jinn-network/trust-core'], optionalDependencies: [], peerDependencies: [] }],
  // serve's own source only ever imports record-discovery-protocol (plan
  // Task 14). It takes record-discovery-testing as a devDependency (M5's
  // conformance-kit-driven tests, `runSourceConformance`) plus the same
  // shadow trust-core devDependency + portal resolution `testing` needed
  // (see the comment above): protocol's transitive `trust-core` npm
  // dependency needs a matching top-level override in every standalone
  // per-package project that portals to protocol, even when serve's own
  // source never imports trust-core directly.
  ['serve', { dependencies: ['@jinn-network/record-discovery-protocol'], devDependencies: ['@jinn-network/record-discovery-testing', '@jinn-network/trust-core'], optionalDependencies: [], peerDependencies: [] }],
  // publication is the kind-neutral tier-3 coordinator. It composes the
  // durable source writer but deliberately has no record-kind dependency.
  ['publication', { dependencies: ['@jinn-network/record-discovery-protocol', '@jinn-network/record-discovery-serve'], devDependencies: ['@jinn-network/trust-core'], optionalDependencies: [], peerDependencies: [] }],
  // client's own source imports protocol + trust-core (plan Task 18: the
  // verification driver wires trust-core key-binding resolution). It
  // declares no facts/* dependency -- the facts leaves are reached only
  // through host-assembled runtime injection (Task 18 note, program §7.13).
  ['client', { dependencies: ['@jinn-network/record-discovery-protocol', '@jinn-network/trust-core'], devDependencies: ['@jinn-network/record-discovery-testing'], optionalDependencies: [], peerDependencies: [] }],
  // facts/evidence's own source imports protocol + evidence-discovery (root
  // and its /indexer subpath) + evidence-repository (plan Task 22). Two
  // shadow devDependencies + portal resolutions: evidence-protocol (a
  // transitive dependency of both evidence-discovery and evidence-repository)
  // and trust-core (protocol's own transitive dependency) -- the same
  // "every Jinn package anywhere in the graph gets its own resolutions
  // entry" precedent recorded above for testing/serve/client.
  ['facts/evidence', { dependencies: ['@jinn-network/evidence-discovery', '@jinn-network/evidence-repository', '@jinn-network/record-discovery-protocol'], devDependencies: ['@jinn-network/evidence-protocol', '@jinn-network/trust-core'], optionalDependencies: [], peerDependencies: [] }],
  // facts/trust's own source imports protocol + trust-core (plan Task 23),
  // both already declared as direct production dependencies -- no shadow
  // devDependency is needed (unlike facts/evidence): trust-core has no
  // further Jinn dependencies of its own.
  ['facts/trust', { dependencies: ['@jinn-network/record-discovery-protocol', '@jinn-network/trust-core'], devDependencies: [], optionalDependencies: [], peerDependencies: [] }],
  // facts/task-execution's own source imports protocol + task-execution-
  // protocol + task-execution-profiles (plan Task 24). Deviation from the
  // plan's literal package.json sketch, flagged in the implementer's
  // findings: the plan names only task-execution-profiles as "the single
  // record-kind-tree dependency for all seven kinds," but profiles' public
  // surface does not re-export Task/Submission/Delivery's zod schemas --
  // those are owned by task-execution-protocol (TEP §7/§8/§11) and are not
  // reachable through profiles alone. Both packages live under the one
  // `packages/task-execution/` tree this leaf is scoped to (task-execution-
  // profiles already depends on task-execution-protocol itself), so this
  // adds a second direct import within the same tree, not a new tree edge.
  // One shadow devDependency + portal resolution: trust-core (record-
  // discovery-protocol's own transitive dependency) -- the same "every Jinn
  // package anywhere in the graph gets its own resolutions entry"
  // precedent recorded above for testing/serve/client/facts-evidence.
  ['facts/task-execution', { dependencies: ['@jinn-network/record-discovery-protocol', '@jinn-network/task-execution-profiles', '@jinn-network/task-execution-protocol'], devDependencies: ['@jinn-network/trust-core'], optionalDependencies: [], peerDependencies: [] }],
  // facts/benchmarking's own source imports protocol + benchmarking-records
  // (plan M6 / program §7.128–§7.130): the sanctioned leaf edge into the
  // benchmarking record-kind tree. It takes record-discovery-testing as a
  // devDependency (facts-consistency conformance driver, configured locally)
  // plus trust-core, used structurally (without signature or trust resolution)
  // to validate an Accounting delegate-authorization reference before its
  // digest fact is emitted.
  ['facts/benchmarking', { dependencies: ['@jinn-network/benchmarking-records', '@jinn-network/record-discovery-protocol', '@jinn-network/trust-core'], devDependencies: ['@jinn-network/record-discovery-testing', '@jinn-network/task-execution-protocol'], optionalDependencies: [], peerDependencies: [] }],
  // facts/environments carries the one sanctioned edge between the discovery tree and the
  // environments record-kind tree (discovery design §12; supply design §3.3): protocol +
  // environment-record. It takes record-discovery-testing as a devDependency (the
  // facts-consistency conformance driver) plus the same shadow trust-core portal resolution
  // every protocol-consuming leaf needs for yarn's per-project resolution of protocol's
  // transitive trust-core dependency. environment-record has no Jinn dependency of its own,
  // so unlike facts/benchmarking this leaf needs no second shadow entry.
  ['facts/environments', { dependencies: ['@jinn-network/environment-record', '@jinn-network/record-discovery-protocol'], devDependencies: ['@jinn-network/record-discovery-testing', '@jinn-network/trust-core'], optionalDependencies: [], peerDependencies: [] }],
  // facts/chain-environments carries the one sanctioned edge between the discovery tree and the
  // chain-environment record-kind tree (discovery design §12; chain design §3): protocol +
  // chain-environment-record. `record-discovery-testing` is a test-only devDependency for the
  // conformance driver, and `trust-core` is the usual shadow entry — protocol's own transitive
  // dependency needs a matching top-level override in every standalone per-package project.
  // chain-environment-record has NO Jinn dependency of its own, so no second shadow is needed.
  ['facts/chain-environments', { dependencies: ['@jinn-network/chain-environment-record', '@jinn-network/information-world', '@jinn-network/record-discovery-protocol'], devDependencies: ['@jinn-network/record-discovery-testing', '@jinn-network/trust-core'], optionalDependencies: [], peerDependencies: [] }],
  // sources/evidence-journal's own source imports protocol + serve +
  // evidence-discovery + evidence-repository (plan Task 25; program §6/F7
  // widens the "one edge per discovery leaf meets a record-kind tree" rule
  // to include `sources/*`, not just `facts/*`). It takes
  // record-discovery-testing as a devDependency (M3's conformance kit,
  // `runSourceConformance`, mirroring serve's own precedent) plus two
  // shadow devDependencies + portal resolutions: evidence-protocol (a
  // transitive dependency of both evidence-discovery and evidence-
  // repository) and trust-core (record-discovery-protocol's own transitive
  // dependency, also pulled in by record-discovery-serve) -- the same
  // "every Jinn package anywhere in the graph gets its own resolutions
  // entry" precedent recorded above for testing/serve/client/facts-*.
  ['sources/evidence-journal', { dependencies: ['@jinn-network/evidence-discovery', '@jinn-network/evidence-repository', '@jinn-network/record-discovery-protocol', '@jinn-network/record-discovery-serve'], devDependencies: ['@jinn-network/evidence-protocol', '@jinn-network/record-discovery-testing', '@jinn-network/trust-core'], optionalDependencies: [], peerDependencies: [] }],
  // transport-http is the discovery tree's tier-3 adapter package: it
  // implements serve's BlobStore/PingTransport ports and client's
  // Transport/StreamTransport ports, so it is the one package that
  // legitimately depends on BOTH sides of the serve/client boundary.
  // Both edges are `import type` only -- no runtime import crosses them
  // (asserted by the source-boundaries guard) -- but they must be
  // production `dependencies` so the packed .d.ts files resolve for
  // downstream consumers. record-discovery-testing is the dev-only
  // conformance kit; trust-core is the same shadow devDependency +
  // portal resolution every protocol-consuming package in this tree
  // carries (client declares trust-core as a production dependency, so
  // yarn's per-project resolution for this standalone project needs a
  // matching top-level override even though transport-http's own source
  // never imports it).
  ['transport-http', { dependencies: ['@jinn-network/record-discovery-client', '@jinn-network/record-discovery-protocol', '@jinn-network/record-discovery-serve'], devDependencies: ['@jinn-network/record-discovery-testing', '@jinn-network/trust-core'], optionalDependencies: [], peerDependencies: [] }],
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
  const inTree = DISCOVERY_PACKAGES.find(([, name]) => name === dependencyName);
  const targetDir = inTree ? join(packageRoot, inTree[0]) : SIBLING_TREE_DIRS.get(dependencyName);
  assert.ok(targetDir, `${directory} declares unknown Jinn dependency ${dependencyName}`);
  return `portal:${relative(join(packageRoot, directory), targetDir) || '.'}`;
}

test('the record discovery package inventory is explicit and has one manifest per package', () => {
  assert.equal(DISCOVERY_PACKAGES.length, JINN_DEPENDENCY_GRAPH.size);
  for (const [directory, expectedName] of DISCOVERY_PACKAGES) {
    const manifest = readPackage(directory);
    assert.equal(manifest.name, expectedName);
    assert.equal(
      manifest.repository?.directory,
      `packages/discovery/${directory}`,
      `${expectedName} has a stale repository directory`,
    );
  }
  const actual = packageManifests(join(root, 'packages'))
    .flatMap((packageJson) => {
      const { name } = JSON.parse(readFileSync(packageJson, 'utf8'));
      return (/^@jinn-network\/record-discovery-/.test(name) || name === '@jinn-network/record-publication')
        ? [[relative(packageRoot, dirname(packageJson)), name]]
        : [];
    }).sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(actual, [...DISCOVERY_PACKAGES].sort(([left], [right]) => left.localeCompare(right)));
});

test('record discovery package Jinn dependencies and portal resolutions match the approved graph', () => {
  for (const [directory] of DISCOVERY_PACKAGES) {
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
    assert.deepEqual(resolved, declared, `${directory} has unmatched Jinn resolutions`);
    for (const dependencyName of declared) {
      assert.equal(resolutions[dependencyName], expectedPortal(directory, dependencyName),
        `${directory} must resolve ${dependencyName} through its matching portal`);
    }
  }
});
