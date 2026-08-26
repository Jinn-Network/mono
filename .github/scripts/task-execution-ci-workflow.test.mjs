import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const workflowPath = resolve(root, '.github/workflows/task-execution-ci.yml');
const workflow = readFileSync(workflowPath, 'utf8');
const packedTypesSource = readFileSync(
  resolve(root, '.github/scripts/task-execution-packed-types.test.mjs'),
  'utf8',
);
const inventorySource = readFileSync(
  resolve(root, '.github/scripts/task-execution-package-inventory.test.mjs'),
  'utf8',
);

/** @type {[string, string][]} */
const PACKED_PACKAGES = [
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

/** @type {[string, string][]} */
const INVENTORY_PACKAGES = [
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

const INVENTORY_JOB_BY_PATH = new Map([
  ['protocol', 'foundation'],
  ['backend', 'backend'],
  ['testing', 'testing'],
  ['profiles', 'profiles'],
  ['backend-local/supervisor', 'supervisor'],
  ['backend-local/workspace', 'workspace'],
  ['backend-local/launchers', 'launchers'],
  ['backend-local/assembly', 'backend-local'],
  ['evaluation-harness', 'evaluation-harness'],
  ['evaluator-adapters', 'evaluator-adapters'],
  ['oci-grader', 'oci-grader'],
]);

function artifactSlugForPath(packagePath) {
  if (packagePath === 'backend-local/assembly') return 'backend-local';
  if (packagePath.startsWith('backend-local/')) {
    return packagePath.slice('backend-local/'.length);
  }
  return packagePath;
}

function artifactNameForPath(packagePath) {
  return `task-execution-${artifactSlugForPath(packagePath)}-dist`;
}

function parseVerifyPlacementSlugs() {
  const marker = '      - name: Place package distributions\n        run: |\n';
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, 'verify job must place package distributions');
  const block = workflow.slice(start, start + 2500);
  const topLevelMatch = block.match(
    /for package in ([^;]+); do\n\s+mkdir -p "packages\/task-execution\/\$\{package\}\/dist"/u,
  );
  assert.ok(topLevelMatch, 'verify must stage top-level task-execution packages');
  const backendLocalMatch = block.match(
    /for package in ([^;]+); do\n\s+mkdir -p "packages\/task-execution\/backend-local\/\$\{package\}\/dist"/u,
  );
  assert.ok(backendLocalMatch, 'verify must stage backend-local packages');
  const topLevel = topLevelMatch[1].trim().split(/\s+/u);
  const backendLocal = backendLocalMatch[1].trim().split(/\s+/u);
  assert.ok(
    block.includes('task-execution-backend-local-dist'),
    'verify must stage backend-local assembly dist',
  );
  return { topLevel, backendLocal, stagesAssembly: true };
}

function parseVerifyNeeds() {
  const marker = '  verify:\n    needs: [';
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, 'verify job must declare needs');
  const end = workflow.indexOf(']', start);
  return workflow.slice(start + marker.length - 1, end + 1)
    .replace(/[\[\]]/gu, '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseVerifyResultJobs() {
  const marker = '      - name: Require every Task Execution CI stage to succeed\n        env:\n';
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, 'verify must aggregate upstream job results');
  const block = workflow.slice(start, start + 1200);
  const envMatches = [...block.matchAll(/^\s+([A-Z0-9_]+_RESULT): \$\{\{ needs\.([a-z0-9-]+)\.result \}\}/gmu)];
  return new Map(envMatches.map((match) => [match[2], match[1]]));
}

function parseUploadArtifactNames() {
  return new Set([...workflow.matchAll(/name: (task-execution-[a-z0-9-]+-dist)/gu)].map((match) => match[1]));
}

test('packed-types source stays aligned with the canonical pack list', () => {
  for (const [, packageName] of PACKED_PACKAGES) {
    assert.match(
      packedTypesSource,
      new RegExp(`'${packageName.replace(/\//gu, '\\/')}'`),
      `${packageName} must appear in task-execution-packed-types.test.mjs`,
    );
  }
});

test('inventory source stays aligned with the canonical package inventory', () => {
  for (const [packagePath, packageName] of INVENTORY_PACKAGES) {
    const escapedPath = packagePath.replace(/\//gu, '\\/');
    const escapedName = packageName.replace(/\//gu, '\\/');
    assert.match(
      inventorySource,
      new RegExp(`\\['${escapedPath}', '${escapedName}'\\]`),
      `${packageName} must appear in task-execution-package-inventory.test.mjs`,
    );
  }
});

test('every packed-types package is staged by the verify job placement loop', () => {
  const placement = parseVerifyPlacementSlugs();
  for (const [packagePath] of PACKED_PACKAGES) {
    if (packagePath.startsWith('backend-local/')) {
      const slug = packagePath.slice('backend-local/'.length);
      if (slug === 'assembly') {
        assert.ok(placement.stagesAssembly, 'verify must stage backend-local assembly dist');
        continue;
      }
      assert.ok(
        placement.backendLocal.includes(slug),
        `verify placement loop must stage ${packagePath} (slug ${slug})`,
      );
      continue;
    }
    assert.ok(
      placement.topLevel.includes(packagePath),
      `verify placement loop must stage ${packagePath}`,
    );
  }
});

test('every packed-types package has a matching upload-artifact step', () => {
  const artifactNames = parseUploadArtifactNames();
  for (const [packagePath] of PACKED_PACKAGES) {
    const artifactName = artifactNameForPath(packagePath);
    assert.ok(
      artifactNames.has(artifactName),
      `workflow must upload ${artifactName} for ${packagePath}`,
    );
  }
});

test('every inventory package has a CI job gated by verify needs and result loop', () => {
  const verifyNeeds = new Set(parseVerifyNeeds());
  const resultJobs = parseVerifyResultJobs();

  for (const [packagePath] of INVENTORY_PACKAGES) {
    const jobId = INVENTORY_JOB_BY_PATH.get(packagePath);
    assert.ok(jobId, `missing job mapping for ${packagePath}`);
    assert.ok(
      verifyNeeds.has(jobId),
      `verify.needs must include ${jobId} for ${packagePath}`,
    );
    assert.ok(
      resultJobs.has(jobId),
      `verify result loop must gate ${jobId} for ${packagePath}`,
    );
  }
});
