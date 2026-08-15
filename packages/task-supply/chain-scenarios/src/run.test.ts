// SPDX-License-Identifier: Apache-2.0

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemSupplyPool } from "@jinn-network/task-derivation";
import { goldenChainReceipt } from "@jinn-network/task-admission/testing";
import { describe, expect, it } from "vitest";

import type {
  ChainAdmissionReceiptV1,
  ChainAdmissionRefusalCode,
  ChainAdmissionResult,
} from "@jinn-network/task-admission";
import { lendingLifecycleTemplate } from "./families/lending-lifecycle.js";
import { createFixtureAddressLedger, type ScenarioAccountPort } from "./fixture-accounts.js";
import { documentDigest } from "./digest.js";
import type { ChainAdmissionPort, ChainAdmissionRequest } from "./run.js";
import { runChainScenarioDerivation } from "./run.js";
import {
  chainScenarioStrategy,
  type ChainScenarioInputs,
} from "./strategy.js";
import { buildFixtureDerivationEnvironment } from "./strategy.test.js";
import { syntheticProbeAddress } from "./template.js";

const decoder = new TextDecoder();

async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

interface StubChainAdmissionOptions {
  readonly refuse?: Record<string, ChainAdmissionRefusalCode>;
  readonly throwOn?: string;
  readonly receiptBindingOverrides?: {
    readonly taskDocumentDigest?: string;
    readonly evaluationSpecDigest?: string;
    readonly compositeRecordDigest?: string;
    readonly referenceScriptDigest?: string;
  };
}

interface StubChainAdmissionPort extends ChainAdmissionPort {
  readonly seen: ChainAdmissionRequest[];
  readonly published: string[];
}

function buildStubReceipt(
  request: ChainAdmissionRequest,
  overrides: StubChainAdmissionOptions["receiptBindingOverrides"] = {},
): ChainAdmissionReceiptV1 {
  const specDigest = documentDigest(request.candidate.evaluationSpecBytes);
  const referenceScriptDigest = (overrides.referenceScriptDigest
    ?? request.candidate.referenceScriptDigest) as `sha256:${string}`;
  const base = goldenChainReceipt();
  const referenceObservation = {
    ...base.observations.reference[0]!,
    appliedScriptDigest: referenceScriptDigest,
  };
  return {
    ...base,
    issuer: "urn:jinn:test:stub-chain-admission",
    task: {
      documentDigest: (overrides.taskDocumentDigest
        ?? request.candidate.taskDocumentDigest) as `sha256:${string}`,
      evaluationSpecDigest: (overrides.evaluationSpecDigest ?? specDigest) as `sha256:${string}`,
      statementDigest: request.candidate.statementDigest,
    },
    referenceScriptDigest,
    observations: {
      doNothing: base.observations.doNothing,
      reference: [referenceObservation, referenceObservation],
    },
    environment: {
      compositeRecordDigest: (overrides.compositeRecordDigest
        ?? request.environmentCompositeDigest) as `sha256:${string}`,
    },
    evalSemanticsVersion: request.candidate.evalSemanticsVersion,
  };
}

function createStubChainAdmissionPort(options: StubChainAdmissionOptions = {}): StubChainAdmissionPort {
  const seen: ChainAdmissionRequest[] = [];
  const published: string[] = [];
  let counter = 0;

  return {
    seen,
    published,
    async admit(request: ChainAdmissionRequest): Promise<ChainAdmissionResult> {
      seen.push(request);
      if (options.throwOn !== undefined && request.candidateId === options.throwOn) {
        throw new Error("admission port unavailable");
      }
      const refusalCode = options.refuse?.[request.candidateId];
      if (refusalCode !== undefined) {
        return { refusal: { code: refusalCode, detail: "scripted refusal" } };
      }
      return { receipt: buildStubReceipt(request, options.receiptBindingOverrides) };
    },
    async publishReceipt() {
      counter += 1;
      const digest = `sha256:${String(counter).padStart(64, "0")}` as const;
      published.push(digest);
      return { digest };
    },
  };
}

async function harness(admission = createStubChainAdmissionPort()) {
  const root = await mkdtemp(join(tmpdir(), "jinn-chain-run-"));
  let counter = 0;
  return {
    root,
    admission,
    deps: {
      admission,
      pool: createFilesystemSupplyPool({
        dir: join(root, "pool"),
        uniqueSuffix: () => `${(counter += 1)}`,
      }),
    },
  };
}

const env = buildFixtureDerivationEnvironment();

let accountCounter = 0x20;

function memoAccountPort(): ScenarioAccountPort {
  const byRole = new Map<string, string>();
  return async (request) => {
    let address = byRole.get(request.role);
    if (address === undefined) {
      address = syntheticProbeAddress(accountCounter++);
      byRole.set(request.role, address);
    }
    return { role: request.role, address };
  };
}

function freshAccountPort(): ScenarioAccountPort {
  return async (request) => ({
    role: request.role,
    address: syntheticProbeAddress(accountCounter++),
  });
}

const stableScenarioAccounts = memoAccountPort();

function scenarioInputs(
  parameterSets: readonly unknown[] = [{}],
  options?: {
    readonly ledger?: ReturnType<typeof createFixtureAddressLedger>;
    readonly accounts?: ScenarioAccountPort;
  },
): ChainScenarioInputs {
  return {
    template: lendingLifecycleTemplate as unknown as ChainScenarioInputs["template"],
    parameterSets,
    ledger: options?.ledger ?? createFixtureAddressLedger(),
    accounts: options?.accounts ?? freshAccountPort(),
  };
}

describe("runChainScenarioDerivation", () => {
  it("writes an admitted pair to the pool with synthetic provenance and lineage", async () => {
    const { deps } = await harness();
    const summary = await runChainScenarioDerivation(
      deps,
      chainScenarioStrategy,
      env,
      scenarioInputs(),
    );

    expect(summary.written).toHaveLength(1);
    expect(summary.refused).toHaveLength(0);
    expect(summary.failed).toHaveLength(0);

    const entry = await deps.pool.get(summary.written[0]!.taskDigest);
    expect(entry!.provenance).toEqual({
      kind: "synthetic",
      sourceCommitment: expect.stringMatching(/^sha256:/),
      lineage: expect.objectContaining({
        templateId: lendingLifecycleTemplate.id,
        environmentRecordDigest: env.recordDigest,
      }),
    });
  });

  it("summarizes a refusal and keeps going", async () => {
    const [firstCandidate] = await collectAsync(
      chainScenarioStrategy.derive({}, env, scenarioInputs([{}])),
    );
    const admission = createStubChainAdmissionPort({
      refuse: { [firstCandidate!.id]: "do-nothing-satisfies" },
    });
    const { deps } = await harness(admission);
    const summary = await runChainScenarioDerivation(
      deps,
      chainScenarioStrategy,
      env,
      scenarioInputs([{}, { borrowAmount: "2" }]),
    );

    expect(summary.written).toHaveLength(1);
    expect(summary.refused).toEqual([
      { candidateId: firstCandidate!.id, code: "do-nothing-satisfies" },
    ]);
    expect(await deps.pool.list()).toHaveLength(1);
  });

  it.each([
    ["task document", { taskDocumentDigest: `sha256:${"a".repeat(64)}` }],
    ["evaluation spec", { evaluationSpecDigest: `sha256:${"b".repeat(64)}` }],
    ["composite record", { compositeRecordDigest: `sha256:${"c".repeat(64)}` }],
  ])(
    "refuses to write a pair whose receipt is about another %s",
    async (_what, receiptBindingOverrides) => {
      const admission = createStubChainAdmissionPort({ receiptBindingOverrides });
      const { deps } = await harness(admission);
      const summary = await runChainScenarioDerivation(
        deps,
        chainScenarioStrategy,
        env,
        scenarioInputs(),
      );
      expect(summary.written).toHaveLength(0);
      expect(summary.failed[0]!.reason).toBe("receipt-mismatch");
      expect(await deps.pool.list()).toHaveLength(0);
      expect(admission.published).toHaveLength(0);
    },
  );

  it("refuses to write a pair whose receipt names a different reference script", async () => {
    const admission = createStubChainAdmissionPort({
      receiptBindingOverrides: { referenceScriptDigest: `sha256:${"d".repeat(64)}` },
    });
    const { deps } = await harness(admission);
    const summary = await runChainScenarioDerivation(
      deps,
      chainScenarioStrategy,
      env,
      scenarioInputs(),
    );
    expect(summary.written).toHaveLength(0);
    expect(summary.failed[0]!.reason).toBe("receipt-mismatch");
    expect(admission.published).toHaveLength(0);
  });

  it("never writes the reference script into the pool", async () => {
    const { deps } = await harness();
    const summary = await runChainScenarioDerivation(
      deps,
      chainScenarioStrategy,
      env,
      scenarioInputs(),
    );
    const entry = await deps.pool.get(summary.written[0]!.taskDigest);
    const bytes = decoder.decode(entry!.taskBytes) + decoder.decode(entry!.evaluationSpecBytes);
    expect(bytes).not.toContain("transactionIntent");
    expect(bytes).not.toContain("signedTransaction");
  });

  it("reports the receipt the pool RECORDED, not the one this run published", async () => {
    const { deps, admission } = await harness();
    const parameterSets = [{}];
    const first = await runChainScenarioDerivation(
      deps,
      chainScenarioStrategy,
      env,
      scenarioInputs(parameterSets, { accounts: stableScenarioAccounts }),
    );
    const second = await runChainScenarioDerivation(
      deps,
      chainScenarioStrategy,
      env,
      scenarioInputs(parameterSets, {
        ledger: createFixtureAddressLedger(),
        accounts: stableScenarioAccounts,
      }),
    );

    expect(admission.published).toEqual([
      first.written[0]!.receiptDigest,
      expect.stringMatching(/^sha256:/),
    ]);
    const entry = await deps.pool.get(second.written[0]!.taskDigest);
    expect(second.written[0]!.receiptDigest).toBe(entry!.receiptDigest);
    expect(second.written[0]!.receiptDigest).toBe(first.written[0]!.receiptDigest);
  });

  it("propagates a port outage instead of turning it into a summary full of failures", async () => {
    const candidates = await collectAsync(
      chainScenarioStrategy.derive({}, env, scenarioInputs()),
    );
    const admission = createStubChainAdmissionPort({ throwOn: candidates[0]!.id });
    const { deps } = await harness(admission);
    await expect(
      runChainScenarioDerivation(deps, chainScenarioStrategy, env, scenarioInputs()),
    ).rejects.toThrow(/admission port unavailable/);
  });
});
