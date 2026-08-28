#!/usr/bin/env node

import {
  mkdtempSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ARCHITECTURE_OWNERS_PATH, committedOwnershipView, validateArchitectureControl } from './architecture-control.mjs';
import { canonicalJsonBytes } from './build-prepublication-bundle.mjs';
import {
  PLATFORM_CATALOG_PATH,
  loadCatalogPackages,
  loadPlatformCatalog,
  stackPublishedReleaseGroupIds,
} from './platform-catalog.mjs';
import { buildDependencyGraph, topologicalWaves } from './stack-package-graph.mjs';
import { buildRegistrationList } from './stack-trusted-publishers.mjs';
import { enumeratePublicSurfaceAssets } from './public-surface-assets.mjs';

const GENERATED_DIRECTORY = 'architecture/generated';
const GENERATED_FILES = ['platform-topology.md', 'platform-topology.v1.json'];
const EDGE_SECTIONS = {
  runtime: 'dependencies',
  optional: 'optionalDependencies',
  peer: 'peerDependencies',
};
const LIVE_TOPOLOGY_DOCS = [
  'architecture/README.md',
  'docs/runbooks/jinn-network-profile-hosting.md',
  'docs/runbooks/stack-npm-publishing.md',
  'docs/superpowers/specs/2026-07-25-evidence-layer-architecture.md',
  'docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md',
  'docs/superpowers/specs/2026-07-30-jinn-platform-architecture.md',
];
const HISTORICAL_TOPOLOGY_DOCS = [
  'docs/superpowers/plans/2026-07-30-stack-publish-path.md',
  'docs/superpowers/specs/2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md',
  'log/decisions/2026-07-30-platform-boundary-and-topology.md',
];
const OBSOLETE_EVIDENCE_LINKS = [
  ['docs/superpowers/specs/2026-07-23-jinn-execution-evidence-protocol-design.md', '../../../packages/evidence-protocol/'],
  ['docs/superpowers/specs/2026-07-24-jinn-execution-recorder-design.md', '../../../packages/evidence-protocol/'],
  ['docs/superpowers/specs/2026-07-24-jinn-execution-recorder-design.md', '../../../packages/evidence-repository/'],
];

function sortStrings(values) {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function dependencyClosure(graph) {
  const closure = {};
  for (const name of sortStrings(graph.keys())) {
    const found = new Set();
    const visit = (node) => {
      for (const dependency of graph.get(node) ?? []) {
        if (found.has(dependency)) continue;
        found.add(dependency);
        visit(dependency);
      }
    };
    visit(name);
    closure[name] = sortStrings(found);
  }
  return closure;
}

function releaseGroupView(catalog, groupId) {
  const definition = catalog.releaseGroups[groupId];
  return {
    ...definition,
    packages: catalog.packages
      .filter(({ releaseGroup }) => releaseGroup === groupId)
      .map(({ name }) => name)
      .sort(),
  };
}

export function buildArchitectureReport(repoRoot) {
  const root = resolve(repoRoot);
  const catalog = loadPlatformCatalog(root);
  const hydrated = loadCatalogPackages(root);
  const catalogNames = new Set(hydrated.map(({ name }) => name));
  const packageRecords = hydrated.map(({ catalog: pkg, manifest }) => ({
    name: pkg.name,
    path: pkg.path,
    version: manifest.version,
    domain: pkg.domain,
    role: pkg.role,
    tier: pkg.tier,
    classification: pkg.classification,
    stability: pkg.stability,
    releaseGroup: pkg.releaseGroup,
    publishPolicy: pkg.publishPolicy,
    ownerGroup: pkg.ownerGroup,
    requiredGateIds: pkg.requiredGateIds,
    boundaryPolicy: pkg.boundaryPolicy,
    publicSurface: pkg.publicSurface,
    supersedes: pkg.supersedes,
    replacedBy: pkg.replacedBy,
    transition: pkg.transition ?? null,
    dependencies: {
      runtime: sortStrings(Object.keys(manifest.dependencies ?? {})),
      optional: sortStrings(Object.keys(manifest.optionalDependencies ?? {})),
      peer: sortStrings(Object.keys(manifest.peerDependencies ?? {})),
    },
  }));
  const edges = packageRecords.flatMap((pkg) => Object.entries(EDGE_SECTIONS).flatMap(([kind]) => (
    pkg.dependencies[kind]
      .filter((dependency) => dependency !== pkg.name && catalogNames.has(dependency))
      .map((dependency) => ({ from: pkg.name, kind, to: dependency }))
  ))).sort((left, right) => (
    left.from.localeCompare(right.from)
      || left.to.localeCompare(right.to)
      || left.kind.localeCompare(right.kind)
  ));
  const stackPublishedIds = stackPublishedReleaseGroupIds(catalog);
  const stackPublishedGraphs = Object.fromEntries(stackPublishedIds.map((groupId) => {
    const packages = hydrated.filter(({ catalog: pkg }) => pkg.releaseGroup === groupId);
    const graph = buildDependencyGraph(packages);
    return [groupId, {
      closure: dependencyClosure(graph),
      waves: topologicalWaves(graph),
    }];
  }));
  const experimentalPolicy = catalog.releaseGroups['experimental-policy']
    ? releaseGroupView(catalog, 'experimental-policy')
    : { packages: [] };
  const packagesRoot = catalog.packages.filter(({ path }) => path.startsWith('packages/'));
  const countedGroups = new Set([...stackPublishedIds, 'experimental-policy']);
  const otherPackagesRoot = packagesRoot.filter(({ releaseGroup }) => !countedGroups.has(releaseGroup));
  const sealedCount = catalog.packages.filter(({ releaseGroup }) => releaseGroup === 'sealed-platform-v1').length;
  const implementationsCount = catalog.packages.filter(({ releaseGroup }) => releaseGroup === 'implementations-v1').length;
  const publicSurfacePackages = packageRecords.map(({ name, path, releaseGroup, publicSurface }) => ({
    name,
    path,
    releaseGroup,
    schemas: publicSurface.schemas,
    profiles: publicSurface.profiles,
    fixtures: publicSurface.fixtures,
    conformance: publicSurface.conformance,
  }));
  const publicSurfaceAssets = enumeratePublicSurfaceAssets({ repoRoot: root, packages: hydrated });
  return {
    schemaVersion: 1,
    sources: {
      catalog: PLATFORM_CATALOG_PATH,
      architectureOwners: ARCHITECTURE_OWNERS_PATH,
      manifests: 'catalog package paths/package.json',
    },
    counts: {
      inventory: catalog.packages.length,
      packagesRootEntries: packagesRoot.length,
      sealedPlatformV1: sealedCount,
      implementationsV1: implementationsCount,
      experimentalPolicy: experimentalPolicy.packages.length,
      otherPackagesRootEntries: otherPackagesRoot.length,
      adjacentEntries: catalog.packages.length - packagesRoot.length,
    },
    releaseGroups: Object.fromEntries(Object.keys(catalog.releaseGroups).sort().map((groupId) => [
      groupId,
      releaseGroupView(catalog, groupId),
    ])),
    packages: packageRecords,
    graph: {
      edgeSections: EDGE_SECTIONS,
      nodes: packageRecords.map(({ name }) => name).sort(),
      edges,
      stackPublished: stackPublishedGraphs,
    },
    release: {
      stackPublished: {
        packages: catalog.packages
          .filter(({ releaseGroup }) => stackPublishedIds.includes(releaseGroup))
          .map(({ name }) => name)
          .sort(),
        trustedPublishers: buildRegistrationList(root),
        groups: Object.fromEntries(stackPublishedIds.map((groupId) => {
          const definition = catalog.releaseGroups[groupId];
          return [groupId, {
            packages: catalog.packages
              .filter(({ releaseGroup }) => releaseGroup === groupId)
              .map(({ name }) => name)
              .sort(),
            policy: {
              publishPolicies: definition.publishPolicies,
              stackPublished: definition.stackPublished,
              canary: definition.canary,
              stable: definition.stable,
              stableBlocker: 'stable-publish-gate: live https://spec.jinn.network profile host verification of the same run',
            },
          }];
        })),
      },
      experimentalPolicy,
    },
    publicSurfaces: {
      packages: publicSurfacePackages,
      assets: publicSurfaceAssets,
      selfIdentifyingClaims: publicSurfaceAssets.filter(({ claim }) => claim !== null).map((asset) => ({
        field: asset.claim.field,
        identifier: asset.claim.identifier,
        kind: asset.kind,
        package: asset.package,
        path: asset.path,
      })).sort((left, right) => left.identifier.localeCompare(right.identifier)),
    },
    // Census fields are deliberately not committed (#3076); the validator
    // still runs here and still throws on an ownership violation.
    ownership: committedOwnershipView(validateArchitectureControl({ repoRoot: root })),
    transitions: packageRecords.filter((pkg) => (
      ['deprecated', 'transitional'].includes(pkg.stability)
        || pkg.supersedes.length > 0
        || pkg.replacedBy.length > 0
    )).map(({
      name, path, stability, releaseGroup, publishPolicy, supersedes, replacedBy, transition,
    }) => ({
      name,
      path,
      stability,
      releaseGroup,
      publishPolicy,
      supersedes,
      replacedBy,
      transition,
    })),
  };
}

function cell(value) {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    return '—';
  }
  const rendered = Array.isArray(value) ? value.join('<br>') : String(value);
  return rendered.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function packageInventoryRows(packages) {
  return packages.map((pkg) => [
    pkg.name,
    pkg.path,
    pkg.domain,
    pkg.tier,
    pkg.classification,
    pkg.role,
    pkg.stability,
    pkg.releaseGroup,
    pkg.publishPolicy,
    pkg.dependencies.runtime,
    pkg.dependencies.optional,
    pkg.dependencies.peer,
  ].map(cell).join(' | ')).map((row) => `| ${row} |`);
}

export function renderArchitectureMarkdown(report) {
  const lines = [
    '<!-- GENERATED FILE — DO NOT EDIT. Run: node .github/scripts/generate-architecture.mjs -->',
    '',
    '# Generated platform topology',
    '',
    `Source authority: [\`${report.sources.catalog}\`](../platform-packages.v1.json) and each cataloged package manifest.`,
    '',
    '## Inventory',
    '',
    `The catalog contains **${report.counts.inventory}** entries: **${report.counts.sealedPlatformV1}** \`sealed-platform-v1\` packages, **${report.counts.implementationsV1}** \`implementations-v1\` packages, **${report.counts.experimentalPolicy}** disabled \`experimental-policy\` packages, **${report.counts.otherPackagesRootEntries}** other entries below \`packages/**\`, and **${report.counts.adjacentEntries}** adjacent entries.`,
    '',
    '| Package | Path | Domain | Tier | Classification | Role | Stability | Release group | Publish policy | Runtime dependencies | Optional dependencies | Peer dependencies |',
    '| --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...packageInventoryRows(report.packages),
    '',
    '## Runtime dependency topology',
    '',
    'Only `dependencies`, `optionalDependencies`, and `peerDependencies` contribute edges. `devDependencies` never affect closure or publication order.',
    '',
    '| From | Kind | To |',
    '| --- | --- | --- |',
    ...report.graph.edges.map(({ from, kind, to }) => `| ${cell(from)} | ${kind} | ${cell(to)} |`),
    '',
    ...Object.entries(report.graph.stackPublished).flatMap(([groupId, view]) => [
      '',
      `### \`${groupId}\` runtime waves`,
      '',
      ...view.waves.map((wave, index) => `${index + 1}. ${wave.map((name) => `\`${name}\``).join(', ')}`),
      '',
      `### \`${groupId}\` transitive closure`,
      '',
      '| Package | Runtime closure |',
      '| --- | --- |',
      ...Object.entries(view.closure).map(([name, closure]) => (
        `| ${cell(name)} | ${cell(closure)} |`
      )),
    ]),
    '',
    '## Release and trusted publishers',
    '',
    '| Release group | Packages | Required gates | Publish policies | Stack published | Canary | Stable |',
    '| --- | ---: | --- | --- | --- | --- | --- |',
    ...Object.entries(report.releaseGroups).map(([groupId, group]) => (
      `| ${groupId} | ${group.packages.length} | ${cell(group.requiredGateIds)} | ${cell(group.publishPolicies)} | ${group.stackPublished} | ${group.canary} | ${group.stable} |`
    )),
    '',
    `The exact ${report.release.stackPublished.packages.length}-package trusted-publisher set is the union of stack-published groups. Receipt-gated canary publication is enabled for every stack-published group. **Stable publication is disabled until live \`spec.jinn.network\` profile hosting verification passes.** The ${report.release.experimentalPolicy.packages.length} \`experimental-policy\` packages remain disabled. Legacy and product lines publish independently or remain private/never-published according to the catalog.`,
    '',
    '| Package | Workflow | Environment field |',
    '| --- | --- | --- |',
    ...report.release.stackPublished.trustedPublishers.map((registration) => (
      `| ${cell(registration.package)} | ${registration.workflow} | ${cell(registration.environment)} |`
    )),
    '',
    '## Public surfaces and identity claims',
    '',
    '| Package | Release group | Schemas | Profiles | Fixtures | Conformance exports |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.publicSurfaces.packages.map((pkg) => (
      `| ${cell(pkg.name)} | ${pkg.releaseGroup} | ${cell(pkg.schemas)} | ${cell(pkg.profiles)} | ${cell(pkg.fixtures)} | ${cell(pkg.conformance)} |`
    )),
    '',
    '### Exact public assets',
    '',
    '| Kind | Package | Source | Export | Packed targets | Self-identifying claim |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.publicSurfaces.assets.map((asset) => (
      `| ${asset.kind} | ${cell(asset.package)} | ${cell(asset.path)} | ${cell(asset.export)} | ${cell(asset.packedTargets)} | ${cell(asset.claim?.identifier)} |`
    )),
    '',
    '### Self-identifying `jinn.network` claims',
    '',
    '| Identifier | Field | Kind | Package | Source |',
    '| --- | --- | --- | --- | --- |',
    ...report.publicSurfaces.selfIdentifyingClaims.map((claim) => (
      `| ${cell(claim.identifier)} | \`${claim.field}\` | ${claim.kind} | ${cell(claim.package)} | ${cell(claim.path)} |`
    )),
    '',
    '## Architecture-control ownership',
    '',
    `Task 6's validator enforces that every architecture-controlled path resolves to exactly these effective owners: ${report.ownership.requiredOwners.map((owner) => `\`${owner}\``).join(' ')}. A path that does not reds \`platform-architecture-control\`.`,
    'The exhaustive path list and its per-category counts are a file census, not architecture: they move whenever any file is added, renamed, or deleted in scope, which made independent branches mutually inconsistent under merge (#3076). They are no longer committed. Run `node .github/scripts/architecture-control.mjs` for the full report, or read the coverage artifact that `platform-architecture-control` uploads on every run.',
    '',
    '## Transitional and deprecated entries',
    '',
    '| Package | Path | Stability | Release | Supersedes | Replaced by | Status | Reason | Sunset condition |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.transitions.map((entry) => (
      `| ${cell(entry.name)} | ${cell(entry.path)} | ${entry.stability} | ${entry.releaseGroup} / ${entry.publishPolicy} | ${cell(entry.supersedes)} | ${cell(entry.replacedBy)} | ${cell(entry.transition?.status)} | ${cell(entry.transition?.reason)} | ${cell(entry.transition?.sunsetCondition)} |`
    )),
    '',
  ];
  return lines.join('\n');
}

export function generateArchitectureArtifacts(repoRoot) {
  const report = buildArchitectureReport(repoRoot);
  return {
    'platform-topology.md': renderArchitectureMarkdown(report),
    'platform-topology.v1.json': `${JSON.stringify(JSON.parse(canonicalJsonBytes(report)), null, 2)}\n`,
  };
}

function inspectGeneratedDirectory(outDir, expected, { requireExpected }) {
  let directory;
  try {
    directory = lstatSync(outDir);
  } catch {
    throw new Error('generated architecture directory must be a real directory');
  }
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error('generated architecture directory must be a real directory');
  }
  const entries = new Map(readdirSync(outDir, { withFileTypes: true }).map((entry) => [entry.name, entry]));
  for (const [name, entry] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    if (!expected.has(name)) {
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`unexpected generated architecture entry ${name} must be a regular file`);
      }
      throw new Error(`unexpected generated architecture file: ${name}`);
    }
  }
  for (const name of [...expected].sort()) {
    const entry = entries.get(name);
    if (!entry) {
      if (requireExpected) throw new Error(`generated architecture entry ${name} is missing`);
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`generated architecture entry ${name} must not be a symlink`);
    }
    if (!entry.isFile()) {
      throw new Error(`generated architecture entry ${name} must be a regular file`);
    }
  }
}

export function writeGeneratedArchitecture({ repoRoot, outDir = resolve(repoRoot, GENERATED_DIRECTORY) }) {
  const output = resolve(outDir);
  const artifacts = generateArchitectureArtifacts(repoRoot);
  try {
    lstatSync(output);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mkdirSync(output, { recursive: true });
  }
  inspectGeneratedDirectory(output, new Set(Object.keys(artifacts)), { requireExpected: false });
  for (const [filename, bytes] of Object.entries(artifacts)) {
    writeFileSync(join(output, filename), bytes, 'utf8');
  }
  return { files: Object.keys(artifacts).sort() };
}

export function checkGeneratedArchitecture({ repoRoot, trackedDir = resolve(repoRoot, GENERATED_DIRECTORY) }) {
  const tracked = resolve(trackedDir);
  const expectedNames = new Set(GENERATED_FILES);
  inspectGeneratedDirectory(tracked, expectedNames, { requireExpected: true });
  const temporary = mkdtempSync(join(tmpdir(), 'jinn-generated-architecture-check-'));
  try {
    writeGeneratedArchitecture({ repoRoot, outDir: temporary });
    for (const filename of GENERATED_FILES) {
      const actual = readFileSync(join(tracked, filename));
      const expected = readFileSync(join(temporary, filename));
      if (!actual.equals(expected)) throw new Error(`generated architecture drift: ${filename}`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return { files: [...GENERATED_FILES] };
}

function source(repoRoot, path) {
  return readFileSync(resolve(repoRoot, ...path.split('/')), 'utf8');
}

export function architectureDocumentationViolations(repoRoot) {
  const root = resolve(repoRoot);
  const violations = [];
  for (const path of LIVE_TOPOLOGY_DOCS) {
    const text = source(root, path);
    if (!text.includes('architecture/generated/platform-topology.md')) {
      violations.push(`${path}: must link to generated platform topology`);
    }
  }
  for (const path of [
    'docs/runbooks/stack-npm-publishing.md',
    'docs/superpowers/specs/2026-07-30-jinn-platform-architecture.md',
  ]) {
    const text = source(root, path);
    if (/\b45 (?:platform |stack )?packages?\b/iu.test(text)) {
      violations.push(`${path}: contains stale live 45-package authority`);
    }
    if (text.includes('STACK_ROOTS')) violations.push(`${path}: contains retired STACK_ROOTS authority`);
  }
  const evidence = source(root, 'docs/superpowers/specs/2026-07-25-evidence-layer-architecture.md');
  if (evidence.includes('The consolidated eight-package foundation already contains:')) {
    violations.push('docs/superpowers/specs/2026-07-25-evidence-layer-architecture.md: contains a hand-maintained package inventory');
  }
  const discovery = source(root, 'docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md');
  if (discovery.includes('packages/discovery/\n  protocol/')) {
    violations.push('docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md: contains a hand-maintained package inventory');
  }
  const profileRunbook = source(root, 'docs/runbooks/jinn-network-profile-hosting.md');
  if (profileRunbook.includes("PROFILE_SOURCE_DIRECTORIES") || profileRunbook.includes('walking that directory')) {
    violations.push('docs/runbooks/jinn-network-profile-hosting.md: contains retired directory-walker rationale');
  }
  for (const [path, obsolete] of OBSOLETE_EVIDENCE_LINKS) {
    if (source(root, path).includes(obsolete)) violations.push(`${path}: obsolete evidence path ${obsolete}`);
  }
  for (const path of HISTORICAL_TOPOLOGY_DOCS) {
    const text = source(root, path);
    if (!text.includes('Historical snapshot (2026-07-30)')
      || !text.includes('architecture/generated/platform-topology.md')) {
      violations.push(`${path}: requires a dated historical snapshot notice and live topology link`);
    }
  }
  return violations.sort();
}

function parseArgs(argv) {
  const parsed = { repoRoot: process.cwd(), check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--check') parsed.check = true;
    else if (flag === '--root' || flag === '--out') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${flag} requires a value`);
      if (flag === '--root') parsed.repoRoot = value;
      else parsed.outDir = value;
      index += 1;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const outDir = options.outDir ?? resolve(options.repoRoot, GENERATED_DIRECTORY);
    const result = options.check
      ? checkGeneratedArchitecture({ repoRoot: options.repoRoot, trackedDir: outDir })
      : writeGeneratedArchitecture({ repoRoot: options.repoRoot, outDir });
    process.stdout.write(`${options.check ? 'checked' : 'wrote'} ${result.files.length} generated architecture files in ${basename(outDir)}\n`);
  } catch (error) {
    process.stderr.write(`architecture generation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
