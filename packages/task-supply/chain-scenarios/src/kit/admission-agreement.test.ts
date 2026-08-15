// SPDX-License-Identifier: Apache-2.0

import { admitChainCandidate } from "@jinn-network/task-admission";
import { describe, expect, it } from "vitest";

import { digestsEqual } from "../digest.js";
import { lendingLifecycleTemplate } from "../families/lending-lifecycle.js";
import { createFixtureAddressLedger } from "../fixture-accounts.js";
import { fixtureRoleAddress } from "../fixture-sources.js";
import { parameterize } from "../parameterize.js";
import {
  buildScenarioEvaluationSpec,
  buildSealedScenarioTask,
} from "../seal-pair.js";
import { sealReferenceScript } from "../solution-script.js";
import {
  baselineObservation,
  chainObservationFromCanonical,
  fixtureEnvironment,
  LENDING_PARAMS,
  predicateBlockFromTemplate,
  referenceObservation,
  scriptedAccountPort,
} from "../testing.js";

describe("chain admission agreement", () => {
  it("admits a real candidate and binds the receipt to this sealed pair", async () => {
    const env = fixtureEnvironment();
    const scenario = await parameterize(
      {
        ledger: createFixtureAddressLedger(),
        accounts: scriptedAccountPort([fixtureRoleAddress("a9")]),
      },
      lendingLifecycleTemplate,
      LENDING_PARAMS,
      env,
    );
    const spec = buildScenarioEvaluationSpec(scenario, env);
    const task = buildSealedScenarioTask(scenario, env, spec.digest);
    const reference = sealReferenceScript(scenario.referenceScript);
    const block = predicateBlockFromTemplate(lendingLifecycleTemplate, env, LENDING_PARAMS);

    const result = await admitChainCandidate(
      {
        issuer: "urn:jinn:test:chain-scenarios-kit",
        observeChain: async (request) => {
          const canonical = request.script.kind === "reference"
            ? referenceObservation()
            : baselineObservation();
          const applied = request.script.kind === "reference" ? reference.digest : null;
          return chainObservationFromCanonical(canonical, block, applied);
        },
      },
      {
        taskDocumentDigest: task.digest as `sha256:${string}`,
        statementDigest: scenario.sourceCommitment as `sha256:${string}`,
        referenceScriptDigest: reference.digest as `sha256:${string}`,
        evaluationSpecBytes: spec.bytes,
        evalSemanticsVersion: scenario.predicateBlock.predicateSemanticsVersion,
      },
      env.recordDigest as `sha256:${string}`,
    );

    if (!("receipt" in result)) {
      throw new Error(`expected receipt, got refusal: ${JSON.stringify(result.refusal)}`);
    }
    expect(digestsEqual(result.receipt.task.documentDigest, task.digest)).toBe(true);
    expect(digestsEqual(result.receipt.task.evaluationSpecDigest, spec.digest)).toBe(true);
    expect(digestsEqual(result.receipt.environment.compositeRecordDigest, env.recordDigest)).toBe(true);
    expect(digestsEqual(result.receipt.referenceScriptDigest, reference.digest)).toBe(true);
  });
});
