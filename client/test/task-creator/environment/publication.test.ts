// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { parseTaskEnvironmentSpecV1, type EnvironmentBuildRecipeV1 } from '../../../src/task-creator/environment/contracts.js';
import {
  type BuiltEnvironment,
  type EnvironmentArtifactUploader,
  type EnvironmentAttestor,
  type EnvironmentBuilder,
  type EnvironmentImageScanner,
  type EnvironmentImagePublisher,
  type EnvironmentSbomGenerator,
  type GitHubRepositoryChecker,
} from '../../../src/task-creator/environment/interfaces.js';
import {
  DEFAULT_ENVIRONMENT_IMAGE_REPOSITORY,
  EnvironmentPublicationController,
} from '../../../src/task-creator/environment/publication.js';
import { renderDockerfile } from '../../../src/task-creator/environment/build.js';
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

const BUILT: BuiltEnvironment = {
  localImageTag: 'jinn-environment:local',
  localImageId: SHA_A,
  platform: 'linux/amd64',
  workspace: '/testbed',
  smoke: { status: 'pass', commands: recipe().smokeCommands },
};

function approvedFacts(input: { repo: string; baseCommit: string }) {
  return {
    inputRef: `git+https://github.com/${input.repo}.git#${input.baseCommit}`,
    locator: `github:${input.repo}`,
    visibility: 'public' as const,
    licenseSpdxId: 'Apache-2.0',
    evidenceRef: `https://api.github.com/repos/${input.repo}/license?ref=${input.baseCommit}`,
  };
}

function successDependencies(calls: string[]) {
  const builder: EnvironmentBuilder = {
    async build() { calls.push('build'); return BUILT; },
  };
  const scanner: EnvironmentImageScanner = {
    async scan() { calls.push('scan'); return { status: 'pass', report: { findings: [] } }; },
  };
  const sbomGenerator: EnvironmentSbomGenerator = {
    async generate() { calls.push('sbom'); return { document: { artifacts: [] } }; },
  };
  const publisher: EnvironmentImagePublisher = {
    async publish() {
      calls.push('publish');
      return {
        reference: `ghcr.io/jinn-network/task-environment/jinn-mono@${SHA_B}`,
        digest: SHA_B,
      };
    },
  };
  const uploader: EnvironmentArtifactUploader = {
    async upload(input) { calls.push(`upload:${input.kind}`); return { cid: `bafy-${input.kind}` }; },
  };
  const attestor: EnvironmentAttestor = {
    async attest(input) {
      calls.push('attest');
      return {
        scheme: 'eip191',
        algo: 'secp256k1',
        environmentHash: input.environmentHash,
        operatorSafe: '0x1111111111111111111111111111111111111111',
        signer: '0x2222222222222222222222222222222222222222',
        signature: `0x${'3'.repeat(130)}`,
      };
    },
  };
  const githubChecker: GitHubRepositoryChecker = {
    async check(input) { calls.push('rights'); return approvedFacts(input); },
  };
  return { builder, scanner, sbomGenerator, publisher, uploader, attestor, githubChecker };
}

describe('environment publication', () => {
  it('defaults publication to the singular GHCR task-environment repository', () => {
    expect(DEFAULT_ENVIRONMENT_IMAGE_REPOSITORY).toBe('ghcr.io/jinn-network/task-environment');
  });

  it('renders only the structured base recipe with an exact base checkout and clean verification', () => {
    const forbidden = {
      goldPatch: 'do-not-disclose-gold-patch',
      testPatch: 'do-not-disclose-test-patch',
      fixCommit: 'do-not-disclose-fix-commit',
    };
    const dockerfile = renderDockerfile(recipe());

    expect(dockerfile).toContain(
      'FROM --platform=linux/amd64 node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf',
    );
    expect(dockerfile).toContain(`git -C /testbed remote add origin 'https://github.com/Jinn-Network/mono.git'`);
    expect(dockerfile).toContain(`git -C /testbed fetch --depth=1 origin '${BASE_COMMIT}'`);
    expect(dockerfile).toContain(`git -C /testbed checkout --detach '${BASE_COMMIT}'`);
    expect(dockerfile).toContain("cd '/testbed' && 'corepack' 'enable'");
    expect(dockerfile).toContain("cd '/testbed/client' && 'yarn' 'vitest' '--version'");
    expect(dockerfile).toContain(`test \"$(git -C /testbed rev-parse HEAD)\" = '${BASE_COMMIT}'`);
    expect(dockerfile).toContain('git -C /testbed status --porcelain)');
    expect(dockerfile).not.toContain('--untracked-files=no');
    expect(() => renderDockerfile({ ...recipe(), ...forbidden } as unknown)).toThrow(/unrecognized key/i);
  });

  it.each([
    {
      name: 'a recipe whose declared source repository does not match the clone URL',
      altered: {
        source: {
          repo: 'Jinn-Network/mono',
          repoUrl: 'https://github.com/attacker/mirror.git',
          baseCommit: BASE_COMMIT,
        },
      },
      error: /canonical GitHub URL/i,
    },
    {
      name: 'a recipe without an exact input-rights binding for its declared source',
      altered: {
        inputRights: [{
          ...recipe().inputRights[0]!,
          inputRef: `git+https://github.com/unjs/destr.git#${BASE_COMMIT}`,
        }],
      },
      error: /exact source input-rights/i,
    },
  ])('rejects $name before build or rights lookup', async ({ altered, error }) => {
    const calls: string[] = [];
    const dependencies = successDependencies(calls);
    const controller = new EnvironmentPublicationController({
      ...dependencies,
      approvedBaseImages: [recipe().baseImage],
      clock: () => new Date('2026-07-10T10:00:00.000Z'),
    });

    await expect(controller.publish({ ...recipe(), ...altered } as EnvironmentBuildRecipeV1)).rejects.toThrow(error);

    expect(calls).toEqual([]);
  });

  it.each([
    {
      name: 'a mutable base-image reference',
      altered: { baseImage: { ...recipe().baseImage, reference: 'node:latest' } },
      error: /digest-qualified/i,
    },
    {
      name: 'a non-40-character base commit',
      altered: { source: { ...recipe().source, baseCommit: 'd'.repeat(39) } },
      error: /40-character lowercase Git commit/i,
    },
  ])('validates unknown runtime recipe input before rendering $name', ({ altered, error }) => {
    expect(() => renderDockerfile({ ...recipe(), ...altered } as unknown)).toThrow(error);
  });

  it('does not push or upload after a failed local secret scan', async () => {
    const calls: string[] = [];
    const dependencies = successDependencies(calls);
    dependencies.scanner = {
      async scan() { calls.push('scan'); return { status: 'fail', report: { findings: ['secret'] } }; },
    };
    const controller = new EnvironmentPublicationController({
      ...dependencies,
      approvedBaseImages: [recipe().baseImage],
      clock: () => new Date('2026-07-10T10:00:00.000Z'),
    });

    await expect(controller.publish(recipe())).rejects.toThrow(/secret scan/i);

    expect(calls).toEqual(['rights', 'build', 'scan']);
  });

  it.each([
    {
      name: 'a malformed digest that only appears to match its reference suffix',
      image: {
        reference: 'ghcr.io/jinn-network/task-environment/jinn-mono@sha256:not-a-real-digest',
        digest: 'sha256:not-a-real-digest',
      },
      error: /must be sha256/i,
    },
    {
      name: 'a digest-qualified image from a registry other than the requested repository',
      image: {
        reference: `registry.example/jinn-mono@${SHA_B}`,
        digest: SHA_B,
      },
      error: /requested image repository/i,
    },
  ])('rejects publisher output with $name before artifact disclosure', async ({ image, error }) => {
    const calls: string[] = [];
    const dependencies = successDependencies(calls);
    dependencies.publisher = {
      async publish() {
        calls.push('publish');
        return image as never;
      },
    };
    const controller = new EnvironmentPublicationController({
      ...dependencies,
      approvedBaseImages: [recipe().baseImage],
      clock: () => new Date('2026-07-10T10:00:00.000Z'),
    });

    await expect(controller.publish(recipe())).rejects.toThrow(error);

    expect(calls).toEqual(['rights', 'build', 'scan', 'sbom', 'publish']);
  });

  it('gates local build evidence before publishing and returns a valid digest-qualified attested spec', async () => {
    const calls: string[] = [];
    const dependencies = successDependencies(calls);
    const controller = new EnvironmentPublicationController({
      ...dependencies,
      approvedBaseImages: [recipe().baseImage],
      clock: () => new Date('2026-07-10T10:00:00.000Z'),
    });

    const published = await controller.publish(recipe());

    expect(calls).toEqual([
      'rights', 'build', 'scan', 'sbom', 'publish',
      'upload:recipe', 'upload:sbom', 'attest', 'upload:environment',
    ]);
    expect(published.environmentCid).toBe('bafy-environment');
    expect(parseTaskEnvironmentSpecV1(published.spec)).toEqual(published.spec);
    expect(published.spec.execution.image).toEqual({
      reference: `ghcr.io/jinn-network/task-environment/jinn-mono@${SHA_B}`,
      digest: SHA_B,
    });
    expect(published.spec.publication).toMatchObject({
      buildSmoke: 'pass',
      imageSecretScan: 'pass',
      sbomCid: 'bafy-sbom',
    });
  });

  it('returns the final environment CID rather than recipe or SBOM publication CIDs', async () => {
    const calls: string[] = [];
    const dependencies = successDependencies(calls);
    dependencies.uploader = {
      async upload(input) {
        calls.push(`upload:${input.kind}`);
        return {
          cid: {
            recipe: 'bafy-distinct-recipe',
            sbom: 'bafy-distinct-sbom',
            environment: 'bafy-distinct-environment',
          }[input.kind],
        };
      },
    };
    const controller = new EnvironmentPublicationController({
      ...dependencies,
      approvedBaseImages: [recipe().baseImage],
      clock: () => new Date('2026-07-10T10:00:00.000Z'),
    });

    const published = await controller.publish(recipe());

    expect(published.environmentCid).toBe('bafy-distinct-environment');
    expect(published.environmentCid).not.toBe(published.spec.build.recipeCid);
    expect(published.environmentCid).not.toBe(published.spec.publication.sbomCid);
  });
});
