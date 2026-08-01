// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../canonical.js";
import type { Sha256Digest } from "../digest.js";
import { approvalHygieneTemplate } from "../families/approval-hygiene.js";
import { lendingLifecycleTemplate } from "../families/lending-lifecycle.js";
import { createFixtureAddressLedger } from "../fixture-accounts.js";
import { fixtureRoleAddress } from "../fixture-sources.js";
import { parameterize } from "../parameterize.js";
import {
  buildScenarioEvaluationSpec,
  buildSealedScenarioTask,
} from "../seal-pair.js";
import { sealReferenceScript } from "../solution-script.js";
import type { ChainDerivationEnvironment, ScenarioTemplate } from "../template.js";
import {
  APPROVAL_HYGIENE_PARAMS,
  approvalHygieneFixtureEnvironment,
  buildApprovalFixtureSource,
  buildLendingFixtureSource,
  describeChainScenarioConformance,
  fixtureEnvironment,
  LENDING_PARAMS,
  scriptedAccountPort,
} from "../testing.js";
import {
  sealChainEnvironmentRecord,
  sealCryptoEnvironmentRecord,
} from "@jinn-network/chain-environment-record";
import { poolEntryManifestBytes } from "@jinn-network/task-derivation";

const UPDATE = process.env["JINN_UPDATE_FIXTURES"] === "1";
const fixtures = (path: string) => new URL(`../../fixtures/${path}`, import.meta.url);

async function expectBytes(path: string, actual: Uint8Array): Promise<void> {
  const url = fixtures(path);
  if (UPDATE) {
    await mkdir(new URL(".", url), { recursive: true });
    await writeFile(url, actual);
    return;
  }
  expect(new Uint8Array(await readFile(url))).toEqual(actual);
}

async function expectText(path: string, actual: string): Promise<void> {
  const url = fixtures(path);
  if (UPDATE) {
    await mkdir(new URL(".", url), { recursive: true });
    await writeFile(url, actual, "utf8");
    return;
  }
  expect(await readFile(url, "utf8")).toBe(actual);
}

async function buildFamilyGoldenArtifacts(
  template: ScenarioTemplate<Record<string, unknown>>,
  params: Record<string, unknown>,
  env: ChainDerivationEnvironment,
  accountAddress: string,
) {
  const scenario = await parameterize(
    { ledger: createFixtureAddressLedger(), accounts: scriptedAccountPort([accountAddress]) },
    template,
    params,
    env,
  );
  const spec = buildScenarioEvaluationSpec(scenario, env);
  const task = buildSealedScenarioTask(scenario, env, spec.digest);
  const reference = sealReferenceScript(scenario.referenceScript);
  const entry = {
    taskDigest: task.digest,
    taskBytes: task.bytes,
    evaluationSpecDigest: spec.digest,
    evaluationSpecBytes: spec.bytes,
    receiptDigest: `sha256:${"7".repeat(64)}` as Sha256Digest,
    environmentRecordDigest: env.recordDigest,
    strategyId: "https://jinn.network/derivation-strategies/chain-scenarios/1",
    provenance: {
      kind: "synthetic" as const,
      sourceCommitment: scenario.sourceCommitment,
      lineage: scenario.lineage,
    },
    rights: { sourceLicense: scenario.rights.sourceLicense },
  };
  return { spec, task, reference, manifest: poolEntryManifestBytes(entry) };
}

describe("golden chain-scenario fixtures", () => {
  it("pins environment and family artifacts", async () => {
    const lendingSource = buildLendingFixtureSource();
    const lendingChainBytes = sealChainEnvironmentRecord(lendingSource.chain);
    const lendingCompositeBytes = sealCryptoEnvironmentRecord(lendingSource.composite);
    await expectText(
      "environment/record.source.json",
      `${serializeCanonicalJson(lendingSource.composite as never)}\n`,
    );
    await expectBytes("environment/record.sealed.json", lendingCompositeBytes);
    await expectBytes("environment/chain.sealed.json", lendingChainBytes);

    const approvalSource = buildApprovalFixtureSource();
    const approvalChainBytes = sealChainEnvironmentRecord(approvalSource.chain);
    const approvalCompositeBytes = sealCryptoEnvironmentRecord(approvalSource.composite);
    await expectBytes("environment/approval-record.sealed.json", approvalCompositeBytes);
    await expectBytes("environment/approval-chain.sealed.json", approvalChainBytes);

    const lendingEnv = fixtureEnvironment();
    const lending = await buildFamilyGoldenArtifacts(
      lendingLifecycleTemplate as unknown as ScenarioTemplate<Record<string, unknown>>,
      LENDING_PARAMS as Record<string, unknown>,
      lendingEnv,
      fixtureRoleAddress("a9"),
    );
    await expectBytes("golden/lending-lifecycle/task.bytes", lending.task.bytes);
    await expectBytes("golden/lending-lifecycle/evaluation-spec.bytes", lending.spec.bytes);
    await expectText("golden/lending-lifecycle/reference-script.digest", `${lending.reference.digest}\n`);
    await expectBytes("golden/lending-lifecycle/pool-manifest.bytes", lending.manifest);

    const approvalEnv = approvalHygieneFixtureEnvironment();
    const approval = await buildFamilyGoldenArtifacts(
      approvalHygieneTemplate as unknown as ScenarioTemplate<Record<string, unknown>>,
      APPROVAL_HYGIENE_PARAMS as Record<string, unknown>,
      approvalEnv,
      fixtureRoleAddress("b2"),
    );
    await expectBytes("golden/approval-hygiene/task.bytes", approval.task.bytes);
    await expectBytes("golden/approval-hygiene/evaluation-spec.bytes", approval.spec.bytes);
    await expectText("golden/approval-hygiene/reference-script.digest", `${approval.reference.digest}\n`);
    await expectBytes("golden/approval-hygiene/pool-manifest.bytes", approval.manifest);
  });
});

describeChainScenarioConformance("chain-scenarios kit");
