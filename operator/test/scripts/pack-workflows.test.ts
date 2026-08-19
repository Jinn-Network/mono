import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const repoRoot = resolve(import.meta.dirname, '../../..');

function workflow(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function workflowStep(path: string, name: string): string {
  const parsed = parseYaml(workflow(path)) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
  };
  const step = Object.values(parsed.jobs)
    .flatMap((job) => job.steps)
    .find((candidate) => candidate.name === name);

  if (step?.run === undefined) {
    throw new Error(`Workflow ${path} has no runnable step named ${name}`);
  }

  return step.run;
}

// The paths operator CI selects on. They were the workflow-level `paths:` filter
// until DR-2026-08-18-b D3/D6 moved selection into the `changes` job — a required
// merge-queue context must not sit behind a workflow-level filter, because a
// filtered-out workflow never reports on the merge group and the entry hangs.
const OPERATOR_CI_SELECTED_PATHS = [
  'operator/**',
  'apps/operator-console/**',
  'packages/lifecycle-notifications/**',
  'packages/sdk/**',
  'packages/core/**',
  'packages/plugin/**',
  '.github/workflows/ci.yml',
  '.github/workflows/npm-publish.yml',
  '.github/scripts/npm-publish-workflow.test.mjs',
  '.github/scripts/operator-*.test.mjs',
];

function selectionPatterns(path: string): RegExp[] {
  const parsed = parseYaml(workflow(path)) as {
    jobs: Record<string, { steps: Array<{ id?: string; run?: string }> }>;
  };
  const select = parsed.jobs.changes?.steps.find((step) => step.id === 'select');

  if (select?.run === undefined) {
    throw new Error(`Workflow ${path} has no changes/select step`);
  }

  const list = select.run.match(/patterns=\(\n([\s\S]*?)\n\s*\)\n/u);

  if (list === null) {
    throw new Error(`Workflow ${path} has no selection pattern list`);
  }

  return list[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const quoted = line.match(/^'(.+)'$/u);

      if (quoted === null) {
        throw new Error(`Unquoted selection pattern in ${path}: ${line}`);
      }

      return new RegExp(quoted[1], 'u');
    });
}

// A file whose change the glob is meant to catch.
function changedPathFor(glob: string): string {
  if (glob.endsWith('/**')) {
    return `${glob.slice(0, -2)}probe/file.ts`;
  }

  if (glob.includes('*')) {
    return glob.replace('*', 'probe');
  }

  return glob;
}

function selectionOf(patterns: RegExp[], paths: string[]): Record<string, boolean> {
  return Object.fromEntries(
    paths.map((path) => [path, patterns.some((pattern) => pattern.test(path))]),
  );
}

describe('packed client workflow coverage', () => {
  it('publishes client 0.2.2 with SDK 0.2.0 and wires the combined external consumer gate', () => {
    const packageJson = JSON.parse(workflow('operator/package.json')) as {
      version: string;
      scripts: Record<string, string>;
    };
    const sdkPackageJson = JSON.parse(workflow('packages/sdk/package.json')) as {
      version: string;
    };

    expect(packageJson.version).toBe('0.2.2');
    expect(sdkPackageJson.version).toBe('0.2.0');
    expect(packageJson.scripts['consumer:acceptance']).toBe(
      'node scripts/external-consumer-acceptance.mjs',
    );
    expect(packageJson.scripts['pack:smoke']).toContain('yarn consumer:acceptance');
    expect(workflow('operator/scripts/external-consumer-acceptance.mjs')).toContain(
      '--sdk-spec',
    );
  });

  it('vendors SDK fixtures alongside its public dist snapshot', () => {
    const vendorSdk = workflow('operator/scripts/vendor-sdk.mjs');

    expect(vendorSdk).toContain("join(sdkRoot, 'fixtures')");
    expect(vendorSdk).toContain("join(targetRoot, 'fixtures')");
  });

  it('.github/workflows/sdk-npm-publish.yml covers client, SDK, core, and plugin changes', () => {
    const source = workflow('.github/workflows/sdk-npm-publish.yml');

    expect(source).toContain("'operator/**'");
    expect(source).toContain("'packages/sdk/**'");
    expect(source).toContain("'packages/core/**'");
    expect(source).toContain("'packages/plugin/**'");
  });

  it('CI selects on client, SDK, core, plugin, and every other path it used to filter on', () => {
    const patterns = selectionPatterns('.github/workflows/ci.yml');
    const changedPaths = OPERATOR_CI_SELECTED_PATHS.map(changedPathFor);

    expect(patterns).toHaveLength(OPERATOR_CI_SELECTED_PATHS.length);
    expect(selectionOf(patterns, changedPaths)).toEqual(
      Object.fromEntries(changedPaths.map((path) => [path, true])),
    );
  });

  it('CI leaves trees outside the operator surface unselected', () => {
    const patterns = selectionPatterns('.github/workflows/ci.yml');
    const changedPaths = [
      'README.md',
      'contracts/src/claiming/ClaimRegistry.sol',
      'packages/indexer/src/index.ts',
      'docs/runbooks/hotfix.md',
      // `*` stops at a path separator, so a nested lookalike must not select.
      '.github/scripts/nested/operator-x.test.mjs',
    ];

    expect(selectionOf(patterns, changedPaths)).toEqual(
      Object.fromEntries(changedPaths.map((path) => [path, false])),
    );
  });

  it('CI and publish run the current npm-shaped private-runtime smoke', () => {
    const ci = workflow('.github/workflows/ci.yml');
    const publish = workflow('.github/workflows/npm-publish.yml');

    expect(ci).toContain('- run: node scripts/smoke-test-pack.mjs --output jinn-client.tgz');
    expect(ci).toContain('- run: yarn pack:smoke:private-runtime');
    expect(ci).not.toContain('- run: yarn pack -o jinn-client.tgz');
    expect(ci).not.toContain('working-directory: /tmp');

    const smoke = publish.indexOf('- run: yarn pack:smoke');
    const publishCanary = publish.indexOf('npm publish --access public --tag canary');
    expect(smoke).toBeGreaterThan(-1);
    expect(publishCanary).toBeGreaterThan(smoke);
  });

  it('keeps client CLI coverage and rejects layer binaries in the client tarball', () => {
    const smoke = workflow('operator/scripts/smoke-test-pack.mjs');

    expect(smoke).toContain("'jinn', '--help'");
    expect(smoke).toContain("'jinn', 'doctor', '--json'");
    expect(smoke).toContain('doctor.status === 50');
    expect(smoke).toContain("entry === 'package/dist/bin/jinn-layer.js'");
    expect(smoke).toContain("entry === 'package/dist/bin/jinn-distill-mcp.js'");
    expect(smoke).toContain(
      "entry.startsWith('package/plugins/local-trace-distiller')",
    );
    expect(smoke).not.toContain("'jinn-layer',");
  });

  it('executes the packed CLI from a Yarn 4 node-modules consumer', () => {
    const smoke = workflow('operator/scripts/smoke-test-pack.mjs');

    expect(smoke).toContain("packageManager: 'yarn@4.13.0'");
    expect(smoke).toContain('const bundledWorkspaceNames = JSON.parse(');
    expect(smoke).toContain('const bundledWorkspaceResolutions = Object.fromEntries(');
    expect(smoke).toContain("name.slice('@jinn-network/'.length)");
    expect(smoke).toContain("zod: 'npm:4.4.3'");
    expect(smoke).toContain("'nodeLinker: node-modules\\n'");
    expect(smoke).toContain("['yarn', 'install', '--no-immutable']");
    expect(smoke).toContain('yarn consumer exact installed jinn --help');
    expect(smoke).toContain('yarn consumer exact installed jinn scrub --help');
  });

  it('publishes exact-SHA SDK canaries before client canaries and validates gitHead', () => {
    const sdkPublish = workflow('.github/workflows/sdk-npm-publish.yml');
    const clientPublish = workflow('.github/workflows/npm-publish.yml');

    expect(sdkPublish).toContain('branches: [next]');
    expect(sdkPublish).toContain('${PACKAGE_VERSION}-canary.sha.${JINN_BUILD_COMMIT}');
    expect(sdkPublish).toContain('npm view "${PACKAGE_SPEC}" gitHead');
    expect(sdkPublish).toContain('steps.existing.outputs.published');
    expect(clientPublish).toContain('workflow_run:');
    expect(clientPublish).toContain('workflows: [SDK npm Publish]');
    expect(clientPublish).toContain("github.event.workflow_run.event == 'push'");
    expect(clientPublish).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(clientPublish).toContain('github.event.workflow_run.head_sha');
    expect(clientPublish).toContain('@jinn-network/sdk@${SDK_PACKAGE_VERSION}-canary.sha.${JINN_BUILD_COMMIT}');
    expect(clientPublish).toContain('${PACKAGE_VERSION}-canary.sha.${JINN_BUILD_COMMIT}');
    expect(clientPublish).toContain('npm view "${PACKAGE_SPEC}" gitHead');
    expect(clientPublish).toContain('steps.existing.outputs.published');
    expect(clientPublish).toContain(
      'external-consumer-acceptance.mjs --registry --sdk-spec "${SDK_SPEC}" --client-spec "${CLIENT_SPEC}"',
    );
  });

  it('publishes client canaries only with registry-resolvable bundled dependencies', () => {
    const resolveBundled = workflowStep(
      '.github/workflows/npm-publish.yml',
      'Resolve bundled dependency publications',
    );
    const patchCanary = workflowStep(
      '.github/workflows/npm-publish.yml',
      'Patch package version for canary publish',
    );

    expect(resolveBundled).toContain('@jinn-network/core@${CORE_VERSION}');
    expect(resolveBundled).toContain('@jinn-network/plugin@${PLUGIN_VERSION}');
    expect(resolveBundled).toContain('-canary.${SHORT_SHA}');
    expect(resolveBundled).toContain('npm view "${CORE_SPEC}" gitHead');
    expect(resolveBundled).toContain('npm view "${PLUGIN_SPEC}" gitHead');
    expect(resolveBundled).toContain('JINN_BUILD_COMMIT');
    expect(patchCanary).toContain('steps.bundled.outputs.core_version');
    expect(patchCanary).toContain('steps.bundled.outputs.plugin_version');
    expect(patchCanary).toContain("const corePath = '../packages/core/package.json'");
    expect(patchCanary).toContain("const pluginPath = '../packages/plugin/package.json'");
    expect(patchCanary).toContain('core.version =');
    expect(patchCanary).toContain('plugin.version =');
    // SDK is a bundledDependency. Rewriting packages/sdk version to
    // 0.2.0-canary.sha.<commit> without also pinning operator's declared
    // dependency makes pack:smoke fail in materialize-bundled-workspaces.
    expect(patchCanary).toContain("pkg.dependencies['@jinn-network/sdk'] = sdk.version");
    expect(patchCanary.indexOf("pkg.dependencies['@jinn-network/sdk'] = sdk.version")).toBeLessThan(
      patchCanary.lastIndexOf("fs.writeFileSync('package.json'"),
    );
  });

  it('runs postpublication registry acceptance through Yarn 4', () => {
    const acceptance = workflow('operator/scripts/external-consumer-acceptance.mjs');

    expect(acceptance).toContain("packageManager: 'yarn@4.13.0'");
    expect(acceptance).toContain("'nodeLinker: node-modules\\n'");
    expect(acceptance).toContain(
      "'corepack', ['yarn', 'install', '--no-immutable']",
    );
    expect(acceptance).toContain('registry Yarn consumer installed jinn tasks --help');
  });

  it('restarts the exact-SHA publish chain when either trusted-publisher workflow changes', () => {
    const sdkPublish = workflow('.github/workflows/sdk-npm-publish.yml');

    expect(sdkPublish).toContain("'.github/workflows/sdk-npm-publish.yml'");
    expect(sdkPublish).toContain("'.github/workflows/npm-publish.yml'");
  });

  it.each([
    [
      '.github/workflows/sdk-npm-publish.yml',
      'Validate canary gitHead',
    ],
    [
      '.github/workflows/npm-publish.yml',
      'Validate client canary gitHead',
    ],
  ])('%s allows a full minute for npm registry propagation', (path, stepName) => {
    const run = workflowStep(path, stepName);

    expect(run).toContain('for _ in $(seq 1 30); do');
    expect(run).toContain('sleep 2');
  });

  it('waits for the client canary archive before registry consumer acceptance', () => {
    const run = workflowStep(
      '.github/workflows/npm-publish.yml',
      'Wait for client canary tarball',
    );

    expect(run).toContain('for _ in $(seq 1 30); do');
    expect(run).toContain('npm pack --silent --pack-destination');
    expect(run).toContain('"${CLIENT_SPEC}"');
    expect(run).toContain('sleep 2');
  });

  it('validates source before canary rewriting and rechecks built layouts before packing', () => {
    const clientPublish = workflow('.github/workflows/npm-publish.yml');
    const typecheck = clientPublish.indexOf('- run: yarn typecheck');
    const test = clientPublish.indexOf('- run: yarn test');
    const patch = clientPublish.indexOf(
      '- name: Patch package version for canary publish',
    );
    const build = clientPublish.indexOf('- run: yarn build');
    const builtLayouts = clientPublish.indexOf(
      '- name: Verify build-dependent client layouts',
    );
    const pack = clientPublish.indexOf('- run: yarn pack:smoke');

    expect(typecheck).toBeGreaterThan(-1);
    expect(test).toBeGreaterThan(typecheck);
    expect(patch).toBeGreaterThan(test);
    expect(build).toBeGreaterThan(patch);
    expect(builtLayouts).toBeGreaterThan(build);
    expect(pack).toBeGreaterThan(builtLayouts);
  });

  it('preserves stable release/manual entry points and requires the manifest-derived SDK version', () => {
    const clientPublish = workflow('.github/workflows/npm-publish.yml');
    const sdkPublish = workflow('.github/workflows/sdk-npm-publish.yml');

    expect(clientPublish).toContain('release:');
    expect(clientPublish).toContain('workflow_dispatch:');
    expect(sdkPublish).toContain('release:');
    expect(clientPublish).toContain('npm view "@jinn-network/sdk@${EXPECTED_SDK}" version');
  });
});
