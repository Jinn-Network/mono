// SPDX-License-Identifier: Apache-2.0

import {
  ENVIRONMENT_BUILD_RECIPE_V1,
  EnvironmentBuildRecipeV1Schema,
  type EnvironmentBuildRecipeV1,
  type EnvironmentBuildRequestV1,
  type InputRightsRefV1,
  type TrustedParserIdentityV1,
} from './contracts.js';
import type { EnvironmentRecipeResolver } from './resolver.js';

const EVALUATOR_BUNDLE_DIGEST = 'sha256:06a35a7340ec64d3de8f2990a02bb3024aeaec47dca838dbeacb6bd19a165cbd' as const;

/** Bound to the patch bundle whose durable enable self-test registers this parser. */
export const TRUSTED_VITEST_JSON_PARSER_V1: TrustedParserIdentityV1 = {
  id: 'vitest-json.v1',
  version: 'v1',
  digest: EVALUATOR_BUNDLE_DIGEST,
  bundleId: 'jinn.swe-rebench-v2.patch-bundle.v1',
};

type EnvironmentRecipePresetV1 = Omit<EnvironmentBuildRecipeV1, 'source'> & {
  readonly repo: string;
  readonly repoUrl: string;
};

export const JINN_MONO_RECIPE_V1: EnvironmentRecipePresetV1 = {
  schemaVersion: ENVIRONMENT_BUILD_RECIPE_V1,
  recipeId: 'jinn-mono.v1',
  repo: 'Jinn-Network/mono',
  repoUrl: 'https://github.com/Jinn-Network/mono.git',
  platform: 'linux/amd64',
  baseImage: {
    reference: 'node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf',
    digest: 'sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf',
  },
  workspace: '/testbed',
  installCommands: [
    { bin: 'apt-get', args: ['update'] },
    { bin: 'apt-get', args: ['install', '-y', '--no-install-recommends', 'python3', 'make', 'g++'] },
    { bin: 'corepack', args: ['enable'] },
    { bin: 'yarn', args: ['install', '--immutable'], cwd: 'operator' },
  ],
  smokeCommands: [{ bin: 'yarn', args: ['vitest', '--version'], cwd: 'operator' }],
  testCommands: [{ bin: 'yarn', args: ['vitest', 'run', '--reporter=json', '--outputFile=/tmp/vitest-results.json'], cwd: 'operator' }],
  parser: TRUSTED_VITEST_JSON_PARSER_V1,
  inputRights: [sourceRights('Jinn-Network/mono', 'Apache-2.0')],
  timeoutSeconds: 300,
  environment: { CI: '1' },
};

export const UNJS_DESTR_RECIPE_V1: EnvironmentRecipePresetV1 = {
  schemaVersion: ENVIRONMENT_BUILD_RECIPE_V1,
  recipeId: 'unjs-destr.v1',
  repo: 'unjs/destr',
  repoUrl: 'https://github.com/unjs/destr.git',
  platform: 'linux/amd64',
  baseImage: {
    reference: 'node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0',
    digest: 'sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0',
  },
  workspace: '/testbed',
  installCommands: [
    { bin: 'corepack', args: ['enable'] },
    { bin: 'pnpm', args: ['install', '--frozen-lockfile'] },
  ],
  smokeCommands: [{ bin: 'pnpm', args: ['exec', 'vitest', '--version'] }],
  testCommands: [{ bin: 'pnpm', args: ['exec', 'vitest', 'run', '--reporter=json', '--outputFile=/tmp/vitest-results.json'] }],
  parser: TRUSTED_VITEST_JSON_PARSER_V1,
  inputRights: [sourceRights('unjs/destr', 'MIT')],
  timeoutSeconds: 300,
  environment: { CI: '1' },
};

export const APPROVED_BASE_IMAGES: readonly { reference: string; digest: string }[] = [
  JINN_MONO_RECIPE_V1.baseImage,
  UNJS_DESTR_RECIPE_V1.baseImage,
];

/** Resolve the approved Jinn recipe at one immutable pre-fix source commit. */
export function resolveJinnMonoRecipeV1(baseCommit: string): EnvironmentBuildRecipeV1 {
  if (!/^[0-9a-f]{40}$/u.test(baseCommit)) {
    throw new Error('Jinn environment recipe requires a 40-hex base commit');
  }
  const { repo, repoUrl, ...recipe } = JINN_MONO_RECIPE_V1;
  return EnvironmentBuildRecipeV1Schema.parse({
    ...recipe,
    source: { repo, repoUrl, baseCommit },
    inputRights: JINN_MONO_RECIPE_V1.inputRights.map((rights) => ({
      ...rights,
      inputRef: rights.inputRef.replace('$baseCommit', baseCommit),
      rightsRef: rights.rightsRef.replace('$baseCommit', baseCommit),
    })),
  });
}

/** Ordered explicit repository configuration. It always outranks later discovery resolvers. */
export function createPresetEnvironmentRecipeResolvers(): EnvironmentRecipeResolver[] {
  return [new ExplicitPresetResolver(JINN_MONO_RECIPE_V1), new ExplicitPresetResolver(UNJS_DESTR_RECIPE_V1)];
}

class ExplicitPresetResolver implements EnvironmentRecipeResolver {
  readonly id: string;
  readonly version = 'v1';

  constructor(private readonly preset: EnvironmentRecipePresetV1) {
    this.id = preset.recipeId;
  }

  async supports(request: EnvironmentBuildRequestV1): Promise<{ supported: true; confidence: 'explicit' } | { supported: false; reason: string }> {
    return request.repo === this.preset.repo && request.repoUrl === this.preset.repoUrl
      ? { supported: true, confidence: 'explicit' }
      : { supported: false, reason: 'repository does not match explicit recipe' };
  }

  async resolve(request: EnvironmentBuildRequestV1): Promise<EnvironmentBuildRecipeV1> {
    if (request.repo !== this.preset.repo || request.repoUrl !== this.preset.repoUrl) {
      throw new Error(`explicit recipe ${this.id} does not support ${request.repo}`);
    }
    const { repo: _repo, repoUrl: _repoUrl, ...recipe } = this.preset;
    return {
      ...recipe,
      source: {
        repo: request.repo,
        repoUrl: request.repoUrl,
        baseCommit: request.baseCommit,
      },
      inputRights: this.preset.inputRights.map((rights) => ({
        ...rights,
        inputRef: rights.inputRef.replace('$baseCommit', request.baseCommit),
        rightsRef: rights.rightsRef.replace('$baseCommit', request.baseCommit),
      })),
    };
  }
}

function sourceRights(repo: string, spdxId: string): InputRightsRefV1 {
  return {
    inputRef: `git+https://github.com/${repo}.git#$baseCommit`,
    rightsRef: `https://api.github.com/repos/${repo}/license?ref=$baseCommit`,
    basis: 'spdx',
    spdxId,
  };
}
