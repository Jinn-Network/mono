// SPDX-License-Identifier: Apache-2.0

/**
 * Versioned, strict contracts for public-repository evaluator environments.
 *
 * These artifacts deliberately exclude gold patches and test-patch contents:
 * environment construction starts from the public base commit only.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod/v3';
import { verifyMessage, type Address, type Hex } from 'viem';
import { canonicalJson } from '../../util/canonical-json.js';

export const ENVIRONMENT_BUILD_REQUEST_V1 = 'jinn.environment-build-request.v1' as const;
export const ENVIRONMENT_BUILD_RECIPE_V1 = 'jinn.environment-build-recipe.v1' as const;
export const TASK_ENVIRONMENT_SPEC_V1 = 'jinn.task-environment.v1' as const;

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be sha256:<64 lowercase hex characters>');
const EthereumAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be an Ethereum address');
const CommitSchema = z.string().regex(/^[0-9a-f]{40}$/, 'must be a 40-character lowercase Git commit');
const NonEmptyString = z.string().min(1);
const EnvironmentVariableName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a shell environment variable name');

export const DigestQualifiedImageV1Schema = z.object({
  reference: NonEmptyString,
  digest: Sha256Schema,
}).strict().superRefine((image, ctx) => {
  const match = /@(?<digest>sha256:[0-9a-f]{64})$/.exec(image.reference);
  if (!match || match.groups?.['digest'] !== image.digest) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'image reference must be digest-qualified and match image.digest',
      path: ['reference'],
    });
  }
});

export const EnvironmentSourceV1Schema = z.object({
  repo: NonEmptyString,
  repoUrl: z.string().url(),
  baseCommit: CommitSchema,
}).strict();
export type EnvironmentSourceV1 = z.infer<typeof EnvironmentSourceV1Schema>;

/** A shell-free command representation executed relative to the workspace. */
export const CommandSpecSchema = z.object({
  bin: NonEmptyString,
  args: z.array(NonEmptyString),
  cwd: NonEmptyString.optional(),
  environment: z.record(EnvironmentVariableName, NonEmptyString).optional(),
}).strict();
export type CommandSpec = z.infer<typeof CommandSpecSchema>;

/**
 * A rights record belongs to exactly one disclosed input. An SPDX assertion is
 * still checked against repository metadata by the publication policy; an
 * explicit authorization can carry a repository-specific permission record.
 */
export const InputRightsRefV1Schema = z.union([
  z.object({
    inputRef: NonEmptyString,
    rightsRef: NonEmptyString,
    basis: z.literal('spdx'),
    spdxId: NonEmptyString,
  }).strict(),
  z.object({
    inputRef: NonEmptyString,
    rightsRef: NonEmptyString,
    basis: z.literal('authorization'),
    authorizationRef: NonEmptyString,
  }).strict(),
]);
export type InputRightsRefV1 = z.infer<typeof InputRightsRefV1Schema>;

/** Identity of parser code bound by the durable evaluator enable marker. */
export const TrustedParserIdentityV1Schema = z.object({
  id: NonEmptyString,
  version: NonEmptyString,
  digest: Sha256Schema,
  bundleId: NonEmptyString,
}).strict();
export type TrustedParserIdentityV1 = z.infer<typeof TrustedParserIdentityV1Schema>;

export const EnvironmentBuildRequestV1Schema = z.object({
  schemaVersion: z.literal(ENVIRONMENT_BUILD_REQUEST_V1),
  repo: NonEmptyString,
  repoUrl: z.string().url(),
  baseCommit: CommitSchema,
  language: NonEmptyString.optional(),
  workspaceHint: NonEmptyString.optional(),
  testPathHints: z.array(NonEmptyString),
  commandHints: z.array(NonEmptyString),
}).strict();
export type EnvironmentBuildRequestV1 = z.infer<typeof EnvironmentBuildRequestV1Schema>;

export const EnvironmentBuildRecipeV1Schema = z.object({
  schemaVersion: z.literal(ENVIRONMENT_BUILD_RECIPE_V1),
  recipeId: NonEmptyString,
  source: EnvironmentSourceV1Schema,
  platform: z.literal('linux/amd64'),
  baseImage: DigestQualifiedImageV1Schema,
  workspace: z.literal('/testbed'),
  installCommands: z.array(CommandSpecSchema).min(1),
  smokeCommands: z.array(CommandSpecSchema).min(1),
  testCommands: z.array(CommandSpecSchema).min(1),
  parser: TrustedParserIdentityV1Schema,
  inputRights: z.array(InputRightsRefV1Schema).min(1),
  timeoutSeconds: z.number().int().positive(),
  environment: z.record(NonEmptyString),
}).strict();
export type EnvironmentBuildRecipeV1 = z.infer<typeof EnvironmentBuildRecipeV1Schema>;

const EnvironmentInputV1Schema = z.object({
  inputRef: NonEmptyString,
  sha256: Sha256Schema,
  rights: InputRightsRefV1Schema,
}).strict().superRefine((input, ctx) => {
  if (input.inputRef !== input.rights.inputRef) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'rights.inputRef must bind the same inputRef',
      path: ['rights', 'inputRef'],
    });
  }
});

export const Eip191EnvironmentAttestationV1Schema = z.object({
  scheme: z.literal('eip191'),
  algo: z.literal('secp256k1'),
  environmentHash: Sha256Schema,
  operatorSafe: EthereumAddressSchema,
  signer: EthereumAddressSchema,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, 'must be a 65-byte hex signature'),
}).strict();
export type Eip191EnvironmentAttestationV1 = z.infer<typeof Eip191EnvironmentAttestationV1Schema>;

/** Domain-separated EIP-191 message for an immutable evaluator environment. */
export function environmentAttestationMessageV1(environmentHash: string): string {
  return `jinn.task-environment.v1:${environmentHash}`;
}

/**
 * Verify the signer named by a parsed attestation. This deliberately verifies
 * the hash-bound domain message rather than merely checking signature shape.
 */
export async function verifyEnvironmentAttestationV1(attestation: Eip191EnvironmentAttestationV1): Promise<boolean> {
  try {
    return await verifyMessage({
      address: attestation.signer as Address,
      message: environmentAttestationMessageV1(attestation.environmentHash),
      signature: attestation.signature as Hex,
    });
  } catch {
    return false;
  }
}

/** Structural schema used only while computing the non-self-referential hash. */
const TaskEnvironmentSpecV1BaseSchema = z.object({
  schemaVersion: z.literal(TASK_ENVIRONMENT_SPEC_V1),
  source: EnvironmentSourceV1Schema,
  inputs: z.array(EnvironmentInputV1Schema).min(1),
  execution: z.object({
    platform: z.literal('linux/amd64'),
    workspace: z.literal('/testbed'),
    image: DigestQualifiedImageV1Schema,
    testCommands: z.array(CommandSpecSchema).min(1),
    parser: TrustedParserIdentityV1Schema,
    timeoutSeconds: z.number().int().positive(),
    environment: z.record(NonEmptyString),
  }).strict(),
  build: z.object({
    recipeCid: NonEmptyString,
    recipeHash: Sha256Schema,
    provider: z.enum(['explicit', 'deterministic', 'agentic']),
    providerId: NonEmptyString,
    providerVersion: NonEmptyString,
  }).strict(),
  publication: z.object({
    publicRepoVerifiedAt: z.string().datetime(),
    rightsPolicyVersion: NonEmptyString,
    buildSmoke: z.literal('pass'),
    imageSecretScan: z.literal('pass'),
    sbomCid: NonEmptyString,
  }).strict(),
  attestation: Eip191EnvironmentAttestationV1Schema,
}).strict();
export type TaskEnvironmentSpecV1 = z.infer<typeof TaskEnvironmentSpecV1BaseSchema>;

/**
 * The signed hash covers only immutable build/publication bindings. The
 * verification timestamp is an observation, and the attestation would make a
 * self-referential signing payload, so neither is included.
 */
export function taskEnvironmentHashPayloadV1(spec: TaskEnvironmentSpecV1): object {
  return {
    source: spec.source,
    inputs: spec.inputs,
    execution: spec.execution,
    build: spec.build,
    publication: {
      rightsPolicyVersion: spec.publication.rightsPolicyVersion,
      buildSmoke: spec.publication.buildSmoke,
      imageSecretScan: spec.publication.imageSecretScan,
      sbomCid: spec.publication.sbomCid,
    },
  };
}

export function hashTaskEnvironmentSpecV1(spec: TaskEnvironmentSpecV1): `sha256:${string}` {
  const hex = createHash('sha256').update(canonicalJson(taskEnvironmentHashPayloadV1(spec))).digest('hex');
  return `sha256:${hex}`;
}

/**
 * Public task-environment parser. It binds the EIP-191 payload to the exact
 * canonical immutable environment body before consumers may trust the spec.
 */
export const TaskEnvironmentSpecV1Schema = TaskEnvironmentSpecV1BaseSchema.superRefine((spec, ctx) => {
  const expectedHash = hashTaskEnvironmentSpecV1(spec);
  if (spec.attestation.environmentHash !== expectedHash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'attestation.environmentHash must equal the canonical environment hash',
      path: ['attestation', 'environmentHash'],
    });
  }
});

export function parseTaskEnvironmentSpecV1(input: unknown): TaskEnvironmentSpecV1 {
  return TaskEnvironmentSpecV1Schema.parse(input);
}
