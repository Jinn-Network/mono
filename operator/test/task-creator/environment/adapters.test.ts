// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  environmentAttestationMessageV1,
  verifyEnvironmentAttestationV1,
  type EnvironmentBuildRecipeV1,
} from '../../../src/task-creator/environment/contracts.js';
import type { BuiltEnvironment } from '../../../src/task-creator/environment/interfaces.js';
import { JINN_MONO_RECIPE_V1 } from '../../../src/task-creator/environment/recipes.js';
import {
  DockerBuildxEnvironmentBuilder,
  DockerImagePublisher,
  Eip191EnvironmentAttestor,
  IpfsEnvironmentArtifactUploader,
  localIsolatedDockerConfigFilesystem,
  Syft131SpdxSbomGenerator,
  Trivy066SecretScanner,
} from '../../../src/task-creator/environment/adapters.js';

const SHA_A = `sha256:${'a'.repeat(64)}` as const;
const SHA_B = `sha256:${'b'.repeat(64)}` as const;
const BASE_COMMIT = 'c'.repeat(40);

function recipe(): EnvironmentBuildRecipeV1 {
  const { repo: _repo, repoUrl: _repoUrl, ...preset } = JINN_MONO_RECIPE_V1;
  return {
    ...preset,
    source: {
      repo: 'Jinn-Network/mono',
      repoUrl: 'https://github.com/Jinn-Network/mono.git',
      baseCommit: BASE_COMMIT,
    },
    inputRights: preset.inputRights.map((right) => ({
      ...right,
      inputRef: right.inputRef.replace('$baseCommit', BASE_COMMIT),
      rightsRef: right.rightsRef.replace('$baseCommit', BASE_COMMIT),
    })),
  };
}

const BUILT: BuiltEnvironment = {
  localImageTag: 'jinn-environment:local',
  localImageId: SHA_A,
  platform: 'linux/amd64',
  workspace: '/testbed',
  smoke: { status: 'pass', commands: recipe().smokeCommands },
};

function successfulContext() {
  return {
    async create() {
      return {
        path: '/tmp/jinn-environment-context',
        async writeFile() {},
        async dispose() {},
      };
    },
  };
}

function successfulArchive() {
  return {
    async create() {
      return {
        archivePath: '/tmp/jinn-environment-output/image.tar',
        metadataPath: '/tmp/jinn-environment-output/metadata.json',
        async assertReady() {},
        async dispose() {},
      };
    },
  };
}

describe('local environment adapters', () => {
  it('creates a credential-free Docker config with only approved plugin discovery', async () => {
    const config = await localIsolatedDockerConfigFilesystem.create();
    try {
      const parsed = JSON.parse(await readFile(`${config.path}/config.json`, 'utf8')) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual(['cliPluginsExtraDirs']);
      expect(parsed.cliPluginsExtraDirs).toEqual(expect.arrayContaining([
        expect.stringMatching(/cli-plugins$/),
      ]));
      expect(parsed).not.toHaveProperty('auths');
      expect(parsed).not.toHaveProperty('credsStore');
      expect(parsed).not.toHaveProperty('credHelpers');
      expect(parsed).not.toHaveProperty('currentContext');
    } finally {
      await config.dispose();
    }
  });

  it('resolves the active daemon before isolation and pins it to build, load, and inspect', async () => {
    const events: string[] = [];
    const calls: Array<{ args: string[]; options?: { env?: NodeJS.ProcessEnv } }> = [];
    const builder = new DockerBuildxEnvironmentBuilder({
      commandRunner: async (_bin, args, options) => {
        events.push(args.slice(0, 2).join(' '));
        calls.push({ args, ...(options ? { options } : {}) });
        if (args[0] === 'context') {
          return { exitCode: 0, stdout: JSON.stringify('unix:///tmp/active-docker.sock'), stderr: '' };
        }
        if (args[0] === 'image' && args[1] === 'load') {
          return { exitCode: 0, stdout: 'Loaded image: jinn-environment:local\n', stderr: '' };
        }
        if (args[0] === 'image' && args[1] === 'inspect') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ Id: SHA_A, Os: 'linux', Architecture: 'amd64' }),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      temporaryContexts: successfulContext(),
      temporaryArchives: successfulArchive(),
      isolatedDockerConfigs: {
        async create() {
          events.push('isolated-config');
          return { path: '/tmp/jinn-empty-docker-config', async dispose() {} };
        },
      },
      localImageTag: () => 'jinn-environment:local',
    });

    await builder.build(recipe());

    expect(events).toEqual(['context inspect', 'isolated-config', 'buildx build', 'image load', 'image inspect']);
    for (const call of calls.slice(1)) {
      expect(call.options?.env?.DOCKER_HOST).toBe('unix:///tmp/active-docker.sock');
      expect(call.options?.env).not.toHaveProperty('DOCKER_CONFIG', process.env['DOCKER_CONFIG']);
      expect(call.options?.env).not.toHaveProperty('DOCKER_AUTH_CONFIG');
    }
  });

  it('builds only a Dockerfile context for linux/amd64 and inspects the local image', async () => {
    const calls: Array<{ bin: string; args: string[]; options?: { env?: NodeJS.ProcessEnv } }> = [];
    const files = new Map<string, string>();
    let disposed = false;
    let disposedDockerConfig = false;
    let disposedArchive = false;
    const builder = new DockerBuildxEnvironmentBuilder({
      commandRunner: async (bin, args, options) => {
        calls.push({ bin, args, ...(options ? { options } : {}) });
        if (args[0] === 'image' && args[1] === 'load') {
          return { exitCode: 0, stdout: 'Loaded image: jinn-environment:local\n', stderr: '' };
        }
        if (args[0] === 'image' && args[1] === 'inspect') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Id: SHA_A,
              Os: 'linux',
              Architecture: 'amd64',
              RepoDigests: [`jinn-environment@${SHA_B}`],
            }),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      temporaryContexts: {
        async create() {
          return {
            path: '/tmp/jinn-environment-context',
            async writeFile(name, content) { files.set(name, content); },
            async dispose() { disposed = true; },
          };
        },
      },
      isolatedDockerConfigs: {
        async create() {
          return {
            path: '/tmp/jinn-empty-docker-config',
            async dispose() { disposedDockerConfig = true; },
          };
        },
      },
      temporaryArchives: {
        async create() {
          return {
            archivePath: '/tmp/jinn-environment-output/image.tar',
            metadataPath: '/tmp/jinn-environment-output/metadata.json',
            async assertReady() {},
            async dispose() { disposedArchive = true; },
          };
        },
      },
      resolveDockerEndpoint: async () => 'unix:///tmp/jinn-docker.sock',
      localImageTag: () => 'jinn-environment:local',
    });

    const built = await builder.build(recipe());

    expect(files.size).toBe(1);
    expect(files.get('Dockerfile')).toContain(`https://github.com/Jinn-Network/mono.git`);
    expect(files.get('Dockerfile')).toContain(BASE_COMMIT);
    expect(disposed).toBe(true);
    expect(disposedArchive).toBe(true);
    expect(disposedDockerConfig).toBe(true);
    expect(calls.map(({ bin, args }) => ({ bin, args }))).toEqual([
      {
        bin: 'docker',
        args: [
          'buildx', 'build', '--platform', 'linux/amd64',
          '--output', 'type=docker,dest=/tmp/jinn-environment-output/image.tar',
          '--metadata-file', '/tmp/jinn-environment-output/metadata.json',
          '--tag', 'jinn-environment:local',
          '--file', '/tmp/jinn-environment-context/Dockerfile', '/tmp/jinn-environment-context',
        ],
      },
      {
        bin: 'docker',
        args: ['image', 'load', '--input', '/tmp/jinn-environment-output/image.tar'],
      },
      {
        bin: 'docker',
        args: ['image', 'inspect', 'jinn-environment:local', '--format', '{{json .}}'],
      },
    ]);
    expect(calls[0]!.args).not.toContain('--load');
    expect(calls[0]!.args).not.toContain('--push');
    expect(calls[0]!.args).not.toContain('--secret');
    expect(calls[0]!.args).not.toContain('--build-arg');
    expect(calls[0]!.options?.env).toMatchObject({
      DOCKER_CONFIG: '/tmp/jinn-empty-docker-config',
      HOME: '/tmp/jinn-empty-docker-config',
      DOCKER_HOST: 'unix:///tmp/jinn-docker.sock',
    });
    expect(calls[0]!.options?.env).not.toHaveProperty('DOCKER_AUTH_CONFIG');
    expect(calls[0]!.options?.env).not.toHaveProperty('DOCKER_CERT_PATH');
    expect(calls[0]!.options?.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(calls[0]!.options?.env).not.toHaveProperty('AWS_ACCESS_KEY_ID');
    expect(calls[1]!.options?.env).toBe(calls[0]!.options?.env);
    expect(calls[2]!.options?.env).toBe(calls[0]!.options?.env);
    expect(built).toMatchObject({
      localImageTag: 'jinn-environment:local',
      localImageId: SHA_A,
      localImageDigest: SHA_B,
      platform: 'linux/amd64',
      workspace: '/testbed',
    });
  });

  it('fails closed when Docker reports a non-amd64 local image', async () => {
    const builder = new DockerBuildxEnvironmentBuilder({
      commandRunner: async (_bin, args) => args[0] === 'image' && args[1] === 'load'
        ? { exitCode: 0, stdout: 'Loaded image: jinn-environment:local\n', stderr: '' }
        : args[0] === 'image' && args[1] === 'inspect'
        ? { exitCode: 0, stdout: JSON.stringify({ Id: SHA_A, Os: 'linux', Architecture: 'arm64' }), stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
      temporaryContexts: {
        async create() {
          return {
            path: '/tmp/jinn-environment-context',
            async writeFile() {},
            async dispose() {},
          };
        },
      },
      temporaryArchives: successfulArchive(),
      resolveDockerEndpoint: async () => 'unix:///tmp/jinn-docker.sock',
      localImageTag: () => 'jinn-environment:local',
    });

    await expect(builder.build(recipe())).rejects.toThrow(/linux\/amd64/i);
  });

  it('fails closed when the exported Docker archive is missing or empty', async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const builder = new DockerBuildxEnvironmentBuilder({
      commandRunner: async (bin, args) => {
        calls.push({ bin, args });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      temporaryContexts: successfulContext(),
      temporaryArchives: {
        async create() {
          return {
            archivePath: '/tmp/jinn-environment-output/image.tar',
            metadataPath: '/tmp/jinn-environment-output/metadata.json',
            async assertReady() { throw new Error('Docker archive is missing or empty'); },
            async dispose() {},
          };
        },
      },
      resolveDockerEndpoint: async () => 'unix:///tmp/jinn-docker.sock',
    });

    await expect(builder.build(recipe())).rejects.toThrow(/archive is missing or empty/i);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ args: expect.arrayContaining(['--output', 'type=docker,dest=/tmp/jinn-environment-output/image.tar']) });
  });

  it('fails closed when Docker cannot load the exported archive', async () => {
    const builder = new DockerBuildxEnvironmentBuilder({
      commandRunner: async (_bin, args) => args[0] === 'image' && args[1] === 'load'
        ? { exitCode: 1, stdout: '', stderr: 'archive rejected' }
        : { exitCode: 0, stdout: '', stderr: '' },
      temporaryContexts: successfulContext(),
      temporaryArchives: successfulArchive(),
      resolveDockerEndpoint: async () => 'unix:///tmp/jinn-docker.sock',
    });

    await expect(builder.build(recipe())).rejects.toThrow(/Docker image load failed.*archive rejected/i);
  });

  it('fails closed when Docker loads an unexpected tag from the archive', async () => {
    const builder = new DockerBuildxEnvironmentBuilder({
      commandRunner: async (_bin, args) => args[0] === 'image' && args[1] === 'load'
        ? { exitCode: 0, stdout: 'Loaded image: unexpected:tag\n', stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
      temporaryContexts: successfulContext(),
      temporaryArchives: successfulArchive(),
      resolveDockerEndpoint: async () => 'unix:///tmp/jinn-docker.sock',
      localImageTag: () => 'jinn-environment:local',
    });

    await expect(builder.build(recipe())).rejects.toThrow(/expected tag/i);
  });

  it('cleans every temporary resource even when an earlier cleanup fails', async () => {
    const disposed: string[] = [];
    const builder = new DockerBuildxEnvironmentBuilder({
      commandRunner: async (_bin, args) => args[0] === 'image' && args[1] === 'load'
        ? { exitCode: 1, stdout: '', stderr: 'archive rejected' }
        : { exitCode: 0, stdout: '', stderr: '' },
      temporaryContexts: {
        async create() {
          return {
            path: '/tmp/jinn-environment-context',
            async writeFile() {},
            async dispose() { disposed.push('context'); throw new Error('context cleanup failed'); },
          };
        },
      },
      temporaryArchives: {
        async create() {
          return {
            archivePath: '/tmp/jinn-environment-output/image.tar',
            metadataPath: '/tmp/jinn-environment-output/metadata.json',
            async assertReady() {},
            async dispose() { disposed.push('archive'); },
          };
        },
      },
      isolatedDockerConfigs: {
        async create() {
          return {
            path: '/tmp/jinn-empty-docker-config',
            async dispose() { disposed.push('config'); },
          };
        },
      },
      resolveDockerEndpoint: async () => 'unix:///tmp/jinn-docker.sock',
    });

    await expect(builder.build(recipe())).rejects.toThrow(/cleanup failed/i);
    expect(disposed).toEqual(['context', 'archive', 'config']);
  });

  it('runs pinned local Trivy JSON and reports discovered secrets without pushing', async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const scanner = new Trivy066SecretScanner({
      commandRunner: async (bin, args) => {
        calls.push({ bin, args });
        if (bin === 'docker') {
          return { exitCode: 0, stdout: JSON.stringify({ Id: SHA_A, Os: 'linux', Architecture: 'amd64' }), stderr: '' };
        }
        if (args[0] === '--version') return { exitCode: 0, stdout: 'Version: 0.66.0', stderr: '' };
        return {
          exitCode: 0,
          stdout: JSON.stringify({ Results: [{ Target: 'image', Secrets: [{ RuleID: 'aws-access-key' }] }] }),
          stderr: '',
        };
      },
    });

    const result = await scanner.scan(BUILT);

    expect(calls.map(({ bin, args }) => ({ bin, args }))).toEqual([
      { bin: 'docker', args: ['image', 'inspect', BUILT.localImageTag, '--format', '{{json .}}'] },
      { bin: 'trivy', args: ['--version'] },
      { bin: 'trivy', args: ['image', '--scanners', 'secret', '--format', 'json', '--quiet', SHA_A] },
    ]);
    expect(result.status).toBe('fail');
    expect(calls.some((call) => call.bin === 'docker' && call.args.includes('push'))).toBe(false);
  });

  it('fails closed when a Trivy command fails', async () => {
    const scanner = new Trivy066SecretScanner({
      commandRunner: async (bin, args) => bin === 'docker'
        ? { exitCode: 0, stdout: JSON.stringify({ Id: SHA_A, Os: 'linux', Architecture: 'amd64' }), stderr: '' }
        : args[0] === '--version'
        ? { exitCode: 0, stdout: 'Version: 0.66.0', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'unable to scan' },
    });

    await expect(scanner.scan(BUILT)).rejects.toThrow(/trivy scan failed/i);
  });

  it('runs pinned Syft SPDX JSON and rejects invalid tool output', async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const generator = new Syft131SpdxSbomGenerator({
      commandRunner: async (bin, args) => {
        calls.push({ bin, args });
        if (bin === 'docker') {
          return { exitCode: 0, stdout: JSON.stringify({ Id: SHA_A, Os: 'linux', Architecture: 'amd64' }), stderr: '' };
        }
        if (args[0] === '--version') return { exitCode: 0, stdout: 'syft 1.31.0', stderr: '' };
        return { exitCode: 0, stdout: JSON.stringify({ spdxVersion: 'SPDX-2.3', packages: [] }), stderr: '' };
      },
    });

    await expect(generator.generate(BUILT)).resolves.toEqual({
      document: { spdxVersion: 'SPDX-2.3', packages: [] },
    });
    expect(calls).toEqual([
      { bin: 'docker', args: ['image', 'inspect', BUILT.localImageTag, '--format', '{{json .}}'] },
      { bin: 'syft', args: ['--version'] },
      { bin: 'syft', args: ['scan', SHA_A, '--output', 'spdx-json'] },
    ]);
  });

  it('tags and pushes a local amd64 image through Docker credential config and returns its remote digest', async () => {
    const calls: Array<{ bin: string; args: string[]; options?: unknown }> = [];
    const publisher = new DockerImagePublisher({
      commandRunner: async (bin, args, options) => {
        calls.push({ bin, args, ...(options ? { options } : {}) });
        if (args[0] === 'image') {
          return { exitCode: 0, stdout: JSON.stringify({ Id: SHA_A, Os: 'linux', Architecture: 'amd64' }), stderr: '' };
        }
        return args[0] === 'push'
          ? { exitCode: 0, stdout: `digest: ${SHA_B} size: 1234`, stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const published = await publisher.publish({
      image: BUILT,
      repository: 'ghcr.io/jinn-network/task-environment',
    });

    expect(calls).toEqual([
      {
        bin: 'docker',
        args: ['image', 'inspect', BUILT.localImageTag, '--format', '{{json .}}'],
      },
      {
        bin: 'docker',
        args: ['tag', SHA_A, 'ghcr.io/jinn-network/task-environment:aaaaaaaaaaaa'],
      },
      {
        bin: 'docker',
        args: ['push', 'ghcr.io/jinn-network/task-environment:aaaaaaaaaaaa'],
      },
    ]);
    expect(published).toEqual({
      reference: `ghcr.io/jinn-network/task-environment@${SHA_B}`,
      digest: SHA_B,
    });
    expect(calls[0]).not.toHaveProperty('options');
  });

  it('rejects an absent immutable ID and a local tag retargeted to a different image', async () => {
    const absentId = new Trivy066SecretScanner({
      commandRunner: async () => ({ exitCode: 0, stdout: JSON.stringify({ Results: [] }), stderr: '' }),
    });
    await expect(absentId.scan({ ...BUILT, localImageId: undefined })).rejects.toThrow(/immutable local image ID/i);

    const calls: Array<{ bin: string; args: string[] }> = [];
    const retargeted = new Syft131SpdxSbomGenerator({
      commandRunner: async (bin, args) => {
        calls.push({ bin, args });
        return { exitCode: 0, stdout: JSON.stringify({ Id: SHA_B, Os: 'linux', Architecture: 'amd64' }), stderr: '' };
      },
    });
    await expect(retargeted.generate(BUILT)).rejects.toThrow(/does not match immutable local image ID/i);
    expect(calls).toEqual([
      { bin: 'docker', args: ['image', 'inspect', BUILT.localImageTag, '--format', '{{json .}}'] },
    ]);
  });

  it('uses the existing IPFS JSON uploader and an injected EIP-191 signer', async () => {
    const uploads: unknown[] = [];
    const uploader = new IpfsEnvironmentArtifactUploader({
      registryUrl: 'https://registry.example',
      uploadJson: async (url, document) => {
        uploads.push({ url, document });
        return 'bafy-environment';
      },
    });
    const messages: unknown[] = [];
    const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
    const attestor = new Eip191EnvironmentAttestor({
      operatorSafe: '0x1111111111111111111111111111111111111111',
      signer: {
        address: account.address,
        async signMessage(input) {
          messages.push(input);
          return account.signMessage(input);
        },
      },
    });

    await expect(uploader.upload({ kind: 'environment', document: { schemaVersion: 'v1' } })).resolves.toEqual({
      cid: 'bafy-environment',
    });
    const attestation = await attestor.attest({ environmentHash: SHA_A });
    expect(attestation).toMatchObject({
      scheme: 'eip191',
      environmentHash: SHA_A,
      operatorSafe: '0x1111111111111111111111111111111111111111',
      signer: account.address,
    });
    expect(uploads).toEqual([{ url: 'https://registry.example', document: { schemaVersion: 'v1' } }]);
    expect(messages).toEqual([{ message: environmentAttestationMessageV1(SHA_A) }]);
    await expect(verifyEnvironmentAttestationV1(attestation)).resolves.toBe(true);
  });
});
