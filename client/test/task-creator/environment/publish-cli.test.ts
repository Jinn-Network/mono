// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { canonicalJson } from '../../../src/util/canonical-json.js';
import {
  ExternalCommandEnvironmentAttestor,
  parseEnvironmentPublicationCliConfig,
  runEnvironmentPublicationCli,
} from '../../../src/task-creator/environment/publish-cli.js';
import { parseEnvironmentPublicationCliArgs } from '../../../scripts/task-creator-environment-publish.js';
import {
  DockerBuildxEnvironmentBuilder,
  DockerImagePublisher,
  IpfsEnvironmentArtifactUploader,
  Syft131SpdxSbomGenerator,
  Trivy066SecretScanner,
} from '../../../src/task-creator/environment/adapters.js';
import {
  environmentAttestationMessageV1,
  hashTaskEnvironmentSpecV1,
  parseTaskEnvironmentSpecV1,
  verifyEnvironmentAttestationV1,
  type EnvironmentBuildRecipeV1,
  type TaskEnvironmentSpecV1,
} from '../../../src/task-creator/environment/contracts.js';
import { JINN_MONO_RECIPE_V1 } from '../../../src/task-creator/environment/recipes.js';

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

function config() {
  return {
    recipe: recipe(),
    ipfsRegistryUrl: 'https://registry.example',
    operatorSafe: '0x1111111111111111111111111111111111111111',
    signer: { command: '/usr/local/bin/jinn-environment-attestor' },
  };
}

function signedPublishedSpec(): TaskEnvironmentSpecV1 {
  const recipeValue = recipe();
  const unsigned = {
    schemaVersion: 'jinn.task-environment.v1' as const,
    source: recipeValue.source,
    inputs: recipeValue.inputRights.map((rights) => ({
      inputRef: rights.inputRef,
      sha256: SHA_A,
      rights,
    })),
    execution: {
      platform: recipeValue.platform,
      workspace: recipeValue.workspace,
      image: {
        reference: `ghcr.io/jinn-network/task-environment/jinn-mono@${SHA_B}`,
        digest: SHA_B,
      },
      testCommands: recipeValue.testCommands,
      parser: recipeValue.parser,
      timeoutSeconds: recipeValue.timeoutSeconds,
      environment: recipeValue.environment,
    },
    build: {
      recipeCid: 'bafy-recipe',
      recipeHash: SHA_A,
      provider: 'explicit' as const,
      providerId: recipeValue.recipeId,
      providerVersion: 'v1',
    },
    publication: {
      publicRepoVerifiedAt: '2026-07-13T00:00:00.000Z',
      rightsPolicyVersion: 'jinn.environment-publication-rights.v1',
      buildSmoke: 'pass' as const,
      imageSecretScan: 'pass' as const,
      sbomCid: 'bafy-sbom',
    },
  };
  return parseTaskEnvironmentSpecV1({
    ...unsigned,
    attestation: {
      scheme: 'eip191',
      algo: 'secp256k1',
      environmentHash: hashTaskEnvironmentSpecV1(unsigned as TaskEnvironmentSpecV1),
      operatorSafe: '0x1111111111111111111111111111111111111111',
      signer: '0x2222222222222222222222222222222222222222',
      signature: `0x${'3'.repeat(130)}`,
    },
  });
}

describe('task-creator environment publication CLI', () => {
  it('parses an optional output artifact alongside its required strict config', () => {
    expect(parseEnvironmentPublicationCliArgs([
      '--config', '/secure/publication.json',
      '--output', '/secure/environment.json',
    ])).toEqual({
      configPath: '/secure/publication.json',
      outputPath: '/secure/environment.json',
    });
  });

  it('preflights a strict config without creating a publication controller or side effect', async () => {
    let controllerCreated = false;

    const result = await runEnvironmentPublicationCli({
      rawConfig: config(),
      environment: {},
      controllerFactory() {
        controllerCreated = true;
        throw new Error('must not be constructed during preflight');
      },
    });

    expect(result).toEqual({
      mode: 'preflight',
      recipeId: 'jinn-mono.v1',
      source: { repo: 'Jinn-Network/mono', baseCommit: BASE_COMMIT },
    });
    expect(controllerCreated).toBe(false);
  });

  it('rejects an output path during preflight before creating a publication controller', async () => {
    let controllerCreated = false;

    await expect(runEnvironmentPublicationCli({
      rawConfig: config(),
      outputPath: '/tmp/must-not-be-written.json',
      environment: {},
      controllerFactory() {
        controllerCreated = true;
        throw new Error('must not be constructed during preflight');
      },
    })).rejects.toThrow(/output.*execute/i);

    expect(controllerCreated).toBe(false);
  });

  it('rejects secret-bearing config fields and malformed recipes before any controller is created', async () => {
    let controllerCreated = false;
    const factory = () => {
      controllerCreated = true;
      throw new Error('must not be constructed');
    };

    expect(() => parseEnvironmentPublicationCliConfig({ ...config(), privateKey: '0xdeadbeef' })).toThrow(/secret-bearing config/i);
    expect(() => parseEnvironmentPublicationCliConfig({ ...config(), registryCredentials: { token: 'nope' } })).toThrow(/secret-bearing config/i);
    expect(() => parseEnvironmentPublicationCliConfig({ ...config(), apiToken: 'nope' })).toThrow(/secret-bearing config/i);
    await expect(runEnvironmentPublicationCli({
      rawConfig: { ...config(), recipe: { ...recipe(), baseImage: { ...recipe().baseImage, reference: 'node:latest' } } },
      environment: { JINN_TASK_CREATOR_ENVIRONMENT_PUBLISH_EXECUTE: '1' },
      controllerFactory: factory,
    })).rejects.toThrow(/digest-qualified/i);
    expect(controllerCreated).toBe(false);
  });

  it('requires an absolute external signer command and invokes it with only the environment hash', async () => {
    expect(() => parseEnvironmentPublicationCliConfig({
      ...config(),
      signer: { command: './attestor' },
    })).toThrow(/absolute path/i);

    const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
    const calls: Array<{ command: string; args: string[]; options?: { env?: NodeJS.ProcessEnv } }> = [];
    const attestor = new ExternalCommandEnvironmentAttestor({
      command: '/usr/local/bin/jinn-environment-attestor',
      operatorSafe: '0x1111111111111111111111111111111111111111',
      commandRunner: async (command, args, options) => {
        calls.push({ command, args, ...(options ? { options } : {}) });
        const signature = await account.signMessage({ message: environmentAttestationMessageV1(SHA_A) });
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            scheme: 'eip191',
            algo: 'secp256k1',
            environmentHash: SHA_A,
            operatorSafe: '0x1111111111111111111111111111111111111111',
            signer: account.address,
            signature,
          }),
          stderr: '',
        };
      },
    });

    const attestation = await attestor.attest({ environmentHash: SHA_A });

    expect(calls.map(({ command, args }) => ({ command, args }))).toEqual([{
      command: '/usr/local/bin/jinn-environment-attestor',
      args: [SHA_A],
    }]);
    expect(calls[0]!.options?.env).toEqual(process.env.PATH === undefined ? {} : { PATH: process.env.PATH });
    expect(calls[0]!.options?.env).not.toHaveProperty('HOME');
    await expect(verifyEnvironmentAttestationV1(attestation)).resolves.toBe(true);
  });

  it('forms an actual execute-mode publication caller from the concrete adapter dependencies', async () => {
    let receivedDependencies: unknown;
    let publishedRecipe: unknown;
    const spec = signedPublishedSpec();
    const result = await runEnvironmentPublicationCli({
      rawConfig: config(),
      environment: { JINN_TASK_CREATOR_ENVIRONMENT_PUBLISH_EXECUTE: '1' },
      controllerFactory(dependencies) {
        receivedDependencies = dependencies;
        return {
          async publish(input: unknown) {
            publishedRecipe = input;
            return {
              spec,
              environmentCid: 'bafy-environment',
            };
          },
        };
      },
    });

    expect(receivedDependencies).toMatchObject({
      imageRepository: 'ghcr.io/jinn-network/task-environment',
      builder: expect.any(DockerBuildxEnvironmentBuilder),
      scanner: expect.any(Trivy066SecretScanner),
      sbomGenerator: expect.any(Syft131SpdxSbomGenerator),
      publisher: expect.any(DockerImagePublisher),
      uploader: expect.any(IpfsEnvironmentArtifactUploader),
      attestor: expect.any(ExternalCommandEnvironmentAttestor),
    });
    expect(publishedRecipe).toMatchObject({ recipeId: 'jinn-mono.v1', source: { baseCommit: BASE_COMMIT } });
    expect(result).toEqual({
      mode: 'published',
      environmentCid: 'bafy-environment',
      environmentHash: spec.attestation.environmentHash,
      imageReference: spec.execution.image.reference,
    });
  });

  it('atomically writes exact canonical signed spec bytes in execute mode', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'jinn-environment-publication-'));
    const outputPath = join(outputDirectory, 'nested', 'environment.json');
    const spec = signedPublishedSpec();
    try {
      const result = await runEnvironmentPublicationCli({
        rawConfig: config(),
        outputPath,
        environment: { JINN_TASK_CREATOR_ENVIRONMENT_PUBLISH_EXECUTE: '1' },
        controllerFactory() {
          return {
            async publish() {
              return {
                spec,
                environmentCid: 'bafy-final-environment',
              };
            },
          };
        },
      });

      expect(result).toEqual({
        mode: 'published',
        environmentCid: 'bafy-final-environment',
        environmentHash: spec.attestation.environmentHash,
        imageReference: spec.execution.image.reference,
      });
      expect(await readFile(outputPath, 'utf8')).toBe(canonicalJson(spec));
      expect(await readdir(dirname(outputPath))).toEqual(['environment.json']);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it('rejects a malformed controller spec before replacing an existing output artifact', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'jinn-environment-publication-'));
    const outputPath = join(outputDirectory, 'environment.json');
    const existingContents = 'previous-verified-environment-artifact';
    await writeFile(outputPath, existingContents, 'utf8');
    const spec = {
      ...signedPublishedSpec(),
      unexpected: 'must-not-be-serialized',
    } as unknown as TaskEnvironmentSpecV1;
    try {
      await expect(runEnvironmentPublicationCli({
        rawConfig: config(),
        outputPath,
        environment: { JINN_TASK_CREATOR_ENVIRONMENT_PUBLISH_EXECUTE: '1' },
        controllerFactory() {
          return {
            async publish() {
              return { spec, environmentCid: 'bafy-final-environment' };
            },
          };
        },
      })).rejects.toThrow(/unrecognized key/i);

      expect(await readFile(outputPath, 'utf8')).toBe(existingContents);
      expect(await readdir(outputDirectory)).toEqual(['environment.json']);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});
