// SPDX-License-Identifier: Apache-2.0

/**
 * Public, hermetic fixture declarations for the G0b portability proof.
 *
 * These are intentionally metadata and recipe bindings only: a fixture never
 * carries a gold patch.  Gold material stays in the local admission input,
 * while the test patch and evaluator contract are public row material.
 */

import { createHash } from 'node:crypto';
import {
  EnvironmentBuildRecipeV1Schema,
  type EnvironmentBuildRecipeV1,
} from '../environment/contracts.js';
import { JINN_MONO_RECIPE_V1, UNJS_DESTR_RECIPE_V1 } from '../environment/recipes.js';

export type PublicRepoProofFixture = {
  readonly id: 'jinn-mono' | 'unjs-destr';
  readonly repo: string;
  readonly baseCommit: string;
  readonly fixCommit: string;
  readonly instanceId: string;
  readonly language: 'typescript';
  readonly problemStatement: string;
  /** Synthetic names used solely to exercise the trusted parser contract. */
  readonly syntheticParserContractTests: readonly string[];
  /** Public paths represented by the synthetic parser-contract test patch. */
  readonly testPaths: readonly string[];
  /** Synthetic parser contract only; never a source-derived or live result. */
  readonly evidenceKind: 'synthetic-parser-contract';
};

/**
 * The real #1422 source identity. Unlike the parser-contract fixture below,
 * this identity becomes usable only with a generated differential-admission
 * receipt whose contents and bindings have been verified.
 */
export type JinnDifferentialProofSource = {
  readonly id: 'jinn-mono';
  readonly repo: 'Jinn-Network/mono';
  readonly baseCommit: 'ae8093a8848e70e581f46d66dcdb56789c0808a3';
  readonly fixCommit: 'ef9608876511b4dff000cda1537ff7c1a227677d';
  readonly instanceId: 'Jinn-Network__mono__echo-ef9608876511';
  readonly language: 'typescript';
  readonly testPaths: readonly [
    'operator/test/daemon/daemon-recovery-nonblocking.test.ts',
    'operator/test/harnesses/engine/recovery.test.ts',
  ];
  readonly evidenceKind: 'differential-admission-receipt-required';
};

export const JINN_MONO_DIFFERENTIAL_PROOF_SOURCE: JinnDifferentialProofSource = {
  id: 'jinn-mono',
  repo: 'Jinn-Network/mono',
  baseCommit: 'ae8093a8848e70e581f46d66dcdb56789c0808a3',
  fixCommit: 'ef9608876511b4dff000cda1537ff7c1a227677d',
  instanceId: 'Jinn-Network__mono__echo-ef9608876511',
  language: 'typescript',
  testPaths: [
    'operator/test/daemon/daemon-recovery-nonblocking.test.ts',
    'operator/test/harnesses/engine/recovery.test.ts',
  ],
  evidenceKind: 'differential-admission-receipt-required',
};

/**
 * G0b's first non-Rebench fixture identity.  The historical supplied commit
 * is a documentation-only change, so this declaration is deliberately a
 * synthetic parser-contract fixture rather than an assertion that it already
 * has live empirical F2P evidence. The live runbook requires a reviewed,
 * independently observed test patch before mint admission.
 */
export const JINN_MONO_VITEST_JSON_PARSER_CONTRACT_FIXTURE: PublicRepoProofFixture = {
  id: 'jinn-mono',
  repo: 'Jinn-Network/mono',
  baseCommit: 'c7701007c7c7c3b1005e263ce151adf700465b58',
  fixCommit: '5b76bade319857bd09a72c3c4aaf0949cfe078ee',
  instanceId: 'Jinn-Network__mono__echo-5b76bade3198',
  language: 'typescript',
  problemStatement: 'Vitest JSON parser-contract coverage; not empirical Jinn admission evidence.',
  syntheticParserContractTests: [
    'daemon recovery starts watchdog loops before recovery completes',
    'engine recovery reserves the request before duplicate scheduling',
  ],
  testPaths: [
    'operator/test/daemon/daemon-recovery-nonblocking.test.ts',
    'operator/test/harnesses/engine/recovery.test.ts',
  ],
  evidenceKind: 'synthetic-parser-contract',
};

/** Portable proof: the same trusted Vitest parser and recipe adapter. */
export const UNJS_DESTR_PUBLIC_REPO_PROOF: PublicRepoProofFixture = {
  id: 'unjs-destr',
  repo: 'unjs/destr',
  baseCommit: '37210516ccef951dcc870f17a5abee52122a3122',
  fixCommit: 'd9ba16d7ad5c3afb6d8c8e84f6d24dba616013fe',
  instanceId: 'unjs__destr__echo-d9ba16d7ad5c',
  language: 'typescript',
  problemStatement: 'Synthetic parser-contract fixture: parsing decimals and scientific notation.',
  syntheticParserContractTests: [
    'destr parses decimal values',
    'destr parses scientific notation values',
  ],
  testPaths: ['test/index.test.ts'],
  evidenceKind: 'synthetic-parser-contract',
};

/**
 * Resolve the existing approved explicit recipe against an immutable fixture
 * base commit.  Supplying a full SHA is intentional: prefix-only values can
 * never become evaluator-environment contracts.
 */
export function resolvePublicRepoProofRecipe(
  fixture: Pick<PublicRepoProofFixture, 'id' | 'repo' | 'baseCommit'>,
  baseCommit: string = fixture.baseCommit,
): EnvironmentBuildRecipeV1 {
  if (!/^[0-9a-f]{40}$/u.test(baseCommit)) {
    throw new Error('public-repository proof recipe requires a 40-hex base commit');
  }
  const preset = fixture.id === 'jinn-mono' ? JINN_MONO_RECIPE_V1 : UNJS_DESTR_RECIPE_V1;
  const { repo: expectedRepo, repoUrl, ...recipe } = preset;
  if (fixture.repo !== expectedRepo) throw new Error('public-repository proof fixture does not match its approved recipe');
  return EnvironmentBuildRecipeV1Schema.parse({
    ...recipe,
    source: { repo: fixture.repo, repoUrl, baseCommit },
    inputRights: preset.inputRights.map((rights) => ({
      ...rights,
      inputRef: rights.inputRef.replace('$baseCommit', baseCommit),
      rightsRef: rights.rightsRef.replace('$baseCommit', baseCommit),
    })),
  });
}

/** A deterministic non-secret digest for a hermetic mock-registry image. */
export function fixtureSha256(scope: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(scope).digest('hex')}`;
}
