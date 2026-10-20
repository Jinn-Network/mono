import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as acceptance from '../../scripts/external-consumer-acceptance.mjs';

describe('external consumer acceptance helpers', () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // The registry acceptance runs the Yarn consumer in `<npm consumer>/yarn-consumer`, and the npm
  // consumer folder has its own package.json. This builds that layout around the script's writer.
  function nestedYarnConsumer(manifest: unknown) {
    const consumerRoot = mkdtempSync(join(tmpdir(), 'jinn-yarn-consumer-layout-'));
    scratchDirs.push(consumerRoot);
    writeFileSync(
      join(consumerRoot, 'package.json'),
      '{"name":"jinn-external-consumer","version":"1.0.0","private":true,"type":"module"}\n',
    );
    const yarnConsumerRoot = join(consumerRoot, 'yarn-consumer');
    acceptance.writeYarnConsumerProject!(yarnConsumerRoot, manifest);
    return { consumerRoot, yarnConsumerRoot };
  }

  it('defaults to local tarballs and requires exact registry package versions', () => {
    expect(acceptance.parseAcceptanceArgs).toBeTypeOf('function');
    expect(acceptance.parseAcceptanceArgs!([])).toEqual({ mode: 'local' });
    expect(acceptance.parseAcceptanceArgs!([
      '--registry',
      '--sdk-spec',
      '@jinn-network/sdk@0.1.1-canary.sha.0123456789abcdef0123456789abcdef01234567',
      '--client-spec',
      '@jinn-network/operator@0.2.1-canary.sha.0123456789abcdef0123456789abcdef01234567',
    ])).toEqual({
      mode: 'registry',
      sdkSpec: '@jinn-network/sdk@0.1.1-canary.sha.0123456789abcdef0123456789abcdef01234567',
      clientSpec: '@jinn-network/operator@0.2.1-canary.sha.0123456789abcdef0123456789abcdef01234567',
    });
    expect(() => acceptance.parseAcceptanceArgs!([
      '--registry',
      '--sdk-spec',
      '@jinn-network/sdk@canary',
      '--client-spec',
      '@jinn-network/operator@^0.2.1',
    ])).toThrow(/exact version/);
  });

  it('requires the installed CLI malformed-input probe to return invalid_invocation', () => {
    expect(acceptance.assertInvalidInvocation).toBeTypeOf('function');
    expect(() => acceptance.assertInvalidInvocation!(
      { status: 11, stdout: '{"code":"invalid_invocation"}\n', stderr: '' },
      'submit',
    )).not.toThrow();
    expect(() => acceptance.assertInvalidInvocation!(
      { status: 1, stdout: '{"code":"transient_error"}\n', stderr: '' },
      'observation',
    )).toThrow(/observation.*invalid_invocation/);
  });

  it('resolves manifest schema names through the public SDK modules', () => {
    const submitSchema = { safeParse: () => ({ success: true }) };
    const sessionSchema = { safeParse: () => ({ success: true }) };
    const commentParser = () => ({ receipt: {}, canonicalJson: '{}' });
    expect(acceptance.resolveFixtureSchema).toBeTypeOf('function');
    expect(acceptance.resolveFixtureSchema!(
      'jinn-task-submit-request.v1',
      { TaskSubmitRequestV1Schema: submitSchema },
      {},
    )).toBe(submitSchema);
    expect(acceptance.resolveFixtureSchema!(
      'jinn-autopilot-session.v1',
      { AutopilotSessionCapsuleSchema: sessionSchema },
      {},
    )).toBe(sessionSchema);
    expect(acceptance.resolveFixtureSchema!(
      'AutopilotAdoptionReceiptComment',
      { parseAutopilotAdoptionReceiptComment: commentParser },
      {},
    )).toBe(commentParser);
  });

  it('writes Yarn consumer dependencies as bare versions, not name@version descriptors', () => {
    expect(acceptance.yarnConsumerManifest!({
      sdkSpec: '@jinn-network/sdk@0.1.1-canary.sha.0123456789abcdef0123456789abcdef01234567',
      clientSpec: '@jinn-network/operator@0.2.1-canary.sha.0123456789abcdef0123456789abcdef01234567',
    })).toEqual({
      private: true,
      packageManager: 'yarn@4.13.0',
      dependencies: {
        '@jinn-network/sdk': '0.1.1-canary.sha.0123456789abcdef0123456789abcdef01234567',
        '@jinn-network/operator': '0.2.1-canary.sha.0123456789abcdef0123456789abcdef01234567',
      },
    });
  });

  it('writes the Yarn consumer as its own project: manifest, node-modules linker, empty lockfile', () => {
    const manifest = acceptance.yarnConsumerManifest!({
      sdkSpec: '@jinn-network/sdk@0.1.1-canary.sha.0123456789abcdef0123456789abcdef01234567',
      clientSpec: '@jinn-network/operator@0.2.1-canary.sha.0123456789abcdef0123456789abcdef01234567',
    });
    const { yarnConsumerRoot } = nestedYarnConsumer(manifest);

    expect(JSON.parse(readFileSync(join(yarnConsumerRoot, 'package.json'), 'utf8'))).toEqual(manifest);
    expect(readFileSync(join(yarnConsumerRoot, '.yarnrc.yml'), 'utf8')).toBe('nodeLinker: node-modules\n');
    expect(existsSync(join(yarnConsumerRoot, 'yarn.lock'))).toBe(true);
    expect(readFileSync(join(yarnConsumerRoot, 'yarn.lock'), 'utf8')).toBe('');
  });

  // Runs the real Yarn 4.13.0 (through Corepack) with an empty dependency list, so it needs no
  // registry access once Corepack has the pinned Yarn. Without the lockfile Yarn takes the npm
  // consumer folder above as the project root and refuses the nested folder (#5098).
  it('lets Yarn 4 resolve the nested Yarn consumer as its own project root', () => {
    const { consumerRoot, yarnConsumerRoot } = nestedYarnConsumer({
      private: true,
      packageManager: 'yarn@4.13.0',
      dependencies: {},
    });
    const yarnGlobalFolder = join(consumerRoot, 'yarn-global');
    mkdirSync(yarnGlobalFolder, { recursive: true });

    const result = spawnSync('corepack', ['yarn', 'install', '--no-immutable'], {
      cwd: yarnConsumerRoot,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
        YARN_ENABLE_TELEMETRY: '0',
        YARN_GLOBAL_FOLDER: yarnGlobalFolder,
        NO_COLOR: '1',
      },
    });
    const output = `${result.error?.message ?? ''}${result.stdout ?? ''}${result.stderr ?? ''}`;

    expect(output).not.toMatch(/doesn't seem to be part of the project/);
    expect(result.status, output).toBe(0);
  }, 150_000);
});
