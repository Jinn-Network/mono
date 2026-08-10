// SPDX-License-Identifier: Apache-2.0

/**
 * Exact-source policy for the first real Jinn differential admission proof.
 *
 * This is deliberately narrower than the generic public-repository
 * environment contract. A valid signature only proves who signed an artifact;
 * it does not make an arbitrary recipe or signer suitable evidence for the
 * reviewed Jinn source. Operators must provide the approved attester pair for
 * the proof they intend to create or verify.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../../util/canonical-json.js';
import {
  ENVIRONMENT_BUILD_RECIPE_V1,
  type EnvironmentBuildRecipeV1,
  type TaskEnvironmentSpecV1,
} from './contracts.js';
import { resolveJinnMonoRecipeV1 } from './recipes.js';

export interface JinnDifferentialAttesterPolicyV1 {
  /** Operator-safe/signer pairs explicitly approved for the reviewed Jinn proof. */
  approvedAttesters: readonly {
    operatorSafe: string;
    signer: string;
  }[];
}

/** Parse externally governed address pairs without ever accepting a signer implicitly. */
export function parseJinnDifferentialAttesterPolicyV1(
  values: readonly string[] | undefined,
  optionName = '--approved-attester',
): JinnDifferentialAttesterPolicyV1 {
  if (!values?.length) {
    const action = optionName.startsWith('--') ? 'pass' : 'set';
    throw new Error(`${action} ${optionName} <operatorSafe:signer>; the Jinn differential proof has no implicit attester trust`);
  }
  const approvedAttesters = values.map((value) => {
    const match = /^(0x[0-9a-fA-F]{40}):(0x[0-9a-fA-F]{40})$/u.exec(value);
    if (!match) throw new Error(`${optionName} must be operatorSafe:signer Ethereum addresses`);
    return { operatorSafe: match[1]!, signer: match[2]! };
  });
  return { approvedAttesters };
}

/**
 * Canonical build-recipe digest used by the environment publication contract.
 * Keep this here rather than trusting a CID, which names transport rather than
 * the immutable recipe content.
 */
export function hashEnvironmentBuildRecipeV1(recipe: EnvironmentBuildRecipeV1): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(canonicalJson({ schemaVersion: ENVIRONMENT_BUILD_RECIPE_V1, recipe }))
    .digest('hex')}`;
}

/**
 * Require the exact explicit Jinn recipe and an independently approved
 * attester. The caller already determines that the source is the one reviewed
 * Jinn proof; generic public repositories must not call this policy.
 */
export function assertJinnDifferentialEnvironmentPolicyV1(
  environment: TaskEnvironmentSpecV1,
  policy: JinnDifferentialAttesterPolicyV1 | undefined,
): void {
  const recipe = resolveJinnMonoRecipeV1(environment.source.baseCommit);
  if (
    environment.build.provider !== 'explicit' ||
    environment.build.providerId !== recipe.recipeId ||
    environment.build.providerVersion !== 'v1'
  ) {
    throw new Error('Jinn differential proof environment must use the canonical explicit Jinn recipe provider');
  }
  if (environment.build.recipeHash !== hashEnvironmentBuildRecipeV1(recipe)) {
    throw new Error('Jinn differential proof environment recipe hash does not bind resolveJinnMonoRecipeV1(baseCommit)');
  }
  if (canonicalJson(environment.execution.testCommands) !== canonicalJson(recipe.testCommands)) {
    throw new Error('Jinn differential proof environment test-command template does not match the canonical Jinn recipe');
  }
  if (
    environment.execution.platform !== recipe.platform ||
    environment.execution.workspace !== recipe.workspace ||
    canonicalJson(environment.execution.parser) !== canonicalJson(recipe.parser) ||
    canonicalJson(environment.execution.environment) !== canonicalJson(recipe.environment) ||
    environment.execution.timeoutSeconds !== recipe.timeoutSeconds
  ) {
    throw new Error('Jinn differential proof environment execution contract does not match the canonical Jinn recipe');
  }
  if (!policy?.approvedAttesters.length) {
    throw new Error('Jinn differential proof requires an explicit policy-approved environment attester');
  }
  const attestation = environment.attestation;
  if (!policy.approvedAttesters.some((approved) =>
    approved.operatorSafe.toLowerCase() === attestation.operatorSafe.toLowerCase() &&
    approved.signer.toLowerCase() === attestation.signer.toLowerCase(),
  )) {
    throw new Error('Jinn differential proof environment attester/signer is not policy-approved');
  }
}
