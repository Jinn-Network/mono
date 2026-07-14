// SPDX-License-Identifier: Apache-2.0

/**
 * Hermetic oracle for the `vitest-json.v1` evaluator parser contract.  It
 * mirrors only the public JSON shape accepted by the signed upstream bundle;
 * production grading remains in the pinned evaluator bundle itself.
 */

import { deriveF2pP2pFromReports } from '../../solver-types/_swe-rebench-v2-empirical-tests.js';
import { commandSpecToEvaluatorCommand } from '../../solver-types/_swe-rebench-v2-harvest.js';
import { parseMintedEnvironmentBindingV1 } from '../../solver-types/_swe-rebench-v2-minted-pool.js';
import type { MintedEnvironmentBindingV1 } from '../../solver-types/_swe-rebench-v2-minted-pool.js';
import type { EnvironmentBuildRecipeV1 } from '../environment/contracts.js';
import {
  fixtureSha256,
  resolvePublicRepoProofRecipe,
  type PublicRepoProofFixture,
} from './public-repo-fixtures.js';

type VitestAssertion = {
  fullName: string;
  status: 'passed' | 'failed' | 'pending' | 'skipped' | 'todo';
};

export type ParsedVitestFixtureReport = {
  passed: string[];
  failed: string[];
};

export type PublicRepoFixtureRun = {
  proof: PublicRepoProofFixture;
  recipe: EnvironmentBuildRecipeV1;
  environment: MintedEnvironmentBindingV1;
  testPatch: string;
  installConfig: {
    install: string[];
    test_cmd: string[];
    log_parser: 'vitest-json.v1';
  };
  parity: ReturnType<typeof deriveF2pP2pFromReports>;
  verdicts: { empty: boolean; gold: boolean; broken: boolean };
};

/** Parse the stable assertion subset of Vitest’s JSON reporter output. */
export function parseVitestJsonV1(log: string): ParsedVitestFixtureReport {
  let report: unknown;
  for (let offset = 0; offset < log.length; offset += 1) {
    if (log[offset] !== '{') continue;
    try {
      const candidate = JSON.parse(log.slice(offset)) as unknown;
      if (isRecord(candidate) && Array.isArray(candidate['testResults'])) report = candidate;
    } catch {
      // Reporter output can be prefixed with runner diagnostics; continue
      // until we encounter a complete JSON object.
    }
  }
  if (!isRecord(report) || !Array.isArray(report['testResults'])) {
    throw new Error('vitest-json.v1: no Vitest JSON report found');
  }
  const passed: string[] = [];
  const failed: string[] = [];
  for (const suite of report['testResults']) {
    if (!isRecord(suite) || !Array.isArray(suite['assertionResults'])) continue;
    for (const assertion of suite['assertionResults']) {
      if (!isRecord(assertion) || typeof assertion['fullName'] !== 'string') continue;
      if (assertion['status'] === 'passed') passed.push(assertion['fullName']);
      if (assertion['status'] === 'failed') failed.push(assertion['fullName']);
    }
  }
  return { passed: [...new Set(passed)].sort(), failed: [...new Set(failed)].sort() };
}

/**
 * Build pure-data Vitest JSON parser-contract coverage. The mock registry
 * reference is digest-qualified and all three synthetic states are parsed
 * through the same trusted parser contract. This is not source-derived
 * empirical evidence and cannot admit, mint, or claim a Jinn task. No gold
 * patch is returned or serialized.
 */
export function runPublicRepoParityFixture(proof: PublicRepoProofFixture): PublicRepoFixtureRun {
  const recipe = resolvePublicRepoProofRecipe(proof);
  const imageDigest = fixtureSha256(`public-repo-fixture:image:${proof.id}`);
  const environmentHash = fixtureSha256(`public-repo-fixture:environment:${proof.id}`);
  const environment = parseMintedEnvironmentBindingV1({
    environmentSpecCid: `bafy-public-repo-${proof.id}-environment`,
    environmentHash,
    attestation: {
      scheme: 'eip191',
      algo: 'secp256k1',
      environmentHash,
      operatorSafe: `0x${'1'.repeat(40)}`,
      signer: `0x${'2'.repeat(40)}`,
      signature: `0x${'3'.repeat(130)}`,
    },
    parser: recipe.parser,
    image: {
      reference: `localhost:5000/jinn-task-environment/${proof.id}@${imageDigest}`,
      digest: imageDigest,
    },
    platform: 'linux/amd64',
  });
  const stable = 'public-repo fixture stable control';
  const empty = parseVitestJsonV1(vitestJson([
    ...proof.syntheticParserContractTests.map((fullName) => ({ fullName, status: 'failed' as const })),
    { fullName: stable, status: 'passed' as const },
  ]));
  const gold = parseVitestJsonV1(vitestJson([
    ...proof.syntheticParserContractTests.map((fullName) => ({ fullName, status: 'passed' as const })),
    { fullName: stable, status: 'passed' as const },
  ]));
  const broken = parseVitestJsonV1(vitestJson([
    ...proof.syntheticParserContractTests.map((fullName, index) => ({ fullName, status: index === 0 ? 'passed' as const : 'failed' as const })),
    { fullName: stable, status: 'passed' as const },
  ]));
  const allTests = [...proof.syntheticParserContractTests, stable];
  const parity = deriveF2pP2pFromReports(
    { ...empty, passed_match: false },
    { ...gold, passed_match: true },
    allTests,
  );
  const verdict = (report: ParsedVitestFixtureReport): boolean =>
    proof.syntheticParserContractTests.every((name) => report.passed.includes(name)) &&
    !report.failed.some((name) => allTests.includes(name));
  return {
    proof,
    recipe,
    environment,
    testPatch: publicTestPatch(proof.testPaths),
    installConfig: {
      install: recipe.installCommands.map(commandSpecToEvaluatorCommand),
      test_cmd: recipe.testCommands.map(commandSpecToEvaluatorCommand),
      log_parser: 'vitest-json.v1',
    },
    parity,
    verdicts: { empty: verdict(empty), gold: verdict(gold), broken: verdict(broken) },
  };
}

function vitestJson(assertionResults: VitestAssertion[]): string {
  return `Vitest fixture diagnostics\n${JSON.stringify({ testResults: [{ assertionResults }] })}`;
}

function publicTestPatch(paths: readonly string[]): string {
  return paths.map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}`).join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
