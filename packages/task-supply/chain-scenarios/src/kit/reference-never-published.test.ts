// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { lendingLifecycleTemplate } from "../families/lending-lifecycle.js";
import type { ScenarioTemplate } from "../template.js";
import { fixtureRoleAddress } from "../fixture-sources.js";
import { runChainScenarioDerivation } from "../run.js";
import { chainScenarioStrategy } from "../strategy.js";
import {
  fixtureEnvironment,
  inMemorySupplyPool,
  LENDING_PARAMS,
  scriptedAccountPort,
  stubChainAdmissionPort,
} from "../testing.js";
import { poolEntryManifestBytes } from "@jinn-network/task-derivation";

const FORBIDDEN = ["transactionIntent", "signedTransaction"];

function containsForbiddenPayload(text: string): string[] {
  return FORBIDDEN.filter((needle) => text.includes(needle));
}

describe("reference script never published", () => {
  it("keeps script content out of task, spec, manifest, and receipt artifacts", async () => {
    const env = fixtureEnvironment();
    const admission = stubChainAdmissionPort();
    const pool = inMemorySupplyPool();
    const summary = await runChainScenarioDerivation(
      { admission, pool },
      chainScenarioStrategy,
      env,
      {
        template: lendingLifecycleTemplate as unknown as ScenarioTemplate<never>,
        parameterSets: [LENDING_PARAMS],
        accounts: scriptedAccountPort([fixtureRoleAddress("a9")]),
      },
    );

    expect(summary.written).toHaveLength(1);
    const pair = summary.written[0]!;
    const entry = await pool.get(pair.taskDigest);
    expect(entry).toBeDefined();
    const manifestBytes = poolEntryManifestBytes(entry!);
    const receiptJson = JSON.stringify(admission.receipts[0]!);

    const offenders = [
      ...containsForbiddenPayload(new TextDecoder().decode(entry!.taskBytes)).map((s) => `task:${s}`),
      ...containsForbiddenPayload(new TextDecoder().decode(entry!.evaluationSpecBytes)).map((s) => `spec:${s}`),
      ...containsForbiddenPayload(new TextDecoder().decode(manifestBytes)).map((s) => `manifest:${s}`),
      ...containsForbiddenPayload(receiptJson).map((s) => `receipt:${s}`),
    ];
    expect(offenders).toStrictEqual([]);
  });
});
