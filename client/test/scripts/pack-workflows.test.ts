import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');

function workflow(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('packed client workflow coverage', () => {
  it('publishes client 0.2.1 with SDK 0.1.1 and wires the combined external consumer gate', () => {
    const packageJson = JSON.parse(workflow('client/package.json')) as {
      version: string;
      scripts: Record<string, string>;
    };
    const sdkPackageJson = JSON.parse(workflow('packages/sdk/package.json')) as {
      version: string;
    };

    expect(packageJson.version).toBe('0.2.1');
    expect(sdkPackageJson.version).toBe('0.1.1');
    expect(packageJson.scripts['consumer:acceptance']).toBe(
      'node scripts/external-consumer-acceptance.mjs',
    );
    expect(packageJson.scripts['pack:smoke']).toContain('yarn consumer:acceptance');
    expect(workflow('client/scripts/external-consumer-acceptance.mjs')).toContain(
      '--sdk-spec',
    );
  });

  it('vendors SDK fixtures alongside its public dist snapshot', () => {
    const vendorSdk = workflow('client/scripts/vendor-sdk.mjs');

    expect(vendorSdk).toContain("join(sdkRoot, 'fixtures')");
    expect(vendorSdk).toContain("join(targetRoot, 'fixtures')");
  });

  it.each(['.github/workflows/ci.yml', '.github/workflows/sdk-npm-publish.yml'])(
    '%s covers client, SDK, core, and plugin changes',
    (path) => {
      const source = workflow(path);
      expect(source).toContain("'client/**'");
      expect(source).toContain("'packages/sdk/**'");
      expect(source).toContain("'packages/core/**'");
      expect(source).toContain("'packages/plugin/**'");
    },
  );

  it('CI covers internal package changes on pull requests and pushes', () => {
    const ci = workflow('.github/workflows/ci.yml');

    expect(ci.match(/'packages\/core\/\*\*'/g)).toHaveLength(2);
    expect(ci.match(/'packages\/plugin\/\*\*'/g)).toHaveLength(2);
    expect(ci.match(/'packages\/sdk\/\*\*'/g)).toHaveLength(2);
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
    const smoke = workflow('client/scripts/smoke-test-pack.mjs');

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
    expect(clientPublish).toContain('@jinn-network/sdk@0.1.1-canary.sha.${JINN_BUILD_COMMIT}');
    expect(clientPublish).toContain('${PACKAGE_VERSION}-canary.sha.${JINN_BUILD_COMMIT}');
    expect(clientPublish).toContain('npm view "${PACKAGE_SPEC}" gitHead');
    expect(clientPublish).toContain('steps.existing.outputs.published');
    expect(clientPublish).toContain(
      'external-consumer-acceptance.mjs --registry --sdk-spec "${SDK_SPEC}" --client-spec "${CLIENT_SPEC}"',
    );
  });

  it('preserves stable release/manual entry points and requires SDK 0.1.1', () => {
    const clientPublish = workflow('.github/workflows/npm-publish.yml');
    const sdkPublish = workflow('.github/workflows/sdk-npm-publish.yml');

    expect(clientPublish).toContain('release:');
    expect(clientPublish).toContain('workflow_dispatch:');
    expect(sdkPublish).toContain('release:');
    expect(clientPublish).toContain('npm view @jinn-network/sdk@0.1.1 version');
  });
});
