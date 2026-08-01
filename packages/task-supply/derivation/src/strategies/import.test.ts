// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { sealEnvironmentRecord } from "@jinn-network/environment-record";
import { assertCandidate } from "../candidate.js";
import { DerivationError } from "../errors.js";
import { loadDerivationEnvironment } from "../strategy.js";
import {
  IMPORT_STRATEGY_ID,
  PERMISSIVE_LICENSE_ALLOWLIST,
  importStrategy,
  type ImportStrategyInputs,
  type UpstreamRebenchRow,
} from "./import.js";
import { buildFixtureEnvironmentRecordBody, buildFixtureRow } from "../testing-support.js";

const env = loadDerivationEnvironment(
  sealEnvironmentRecord(buildFixtureEnvironmentRecordBody() as never),
);

function inputs(rows: UpstreamRebenchRow[]): ImportStrategyInputs {
  return {
    rows,
    upstream: { dataset: "nebius/SWE-rebench", revision: "refs/convert/parquet-2026-05-01" },
    defaultTimeoutSeconds: 900,
    licensePolicy: { allow: PERMISSIVE_LICENSE_ALLOWLIST },
  };
}

async function collect(strategyInputs: ImportStrategyInputs, skipped: string[] = []) {
  const out = [];
  for await (const candidate of importStrategy.derive(
    { logger: { candidateSkipped: (e) => skipped.push(`${e.candidateId}:${e.reason}`), candidateRefused: () => {}, pairWritten: () => {} } },
    env,
    strategyInputs,
  )) {
    out.push(candidate);
  }
  return out;
}

describe("import strategy (design §7.2, v1's only member)", () => {
  it("declares a format-identity id, not a product name", () => {
    expect(IMPORT_STRATEGY_ID).toBe("import.swe-rebench.v1");
  });

  it("carries the statement verbatim and produces a valid candidate", async () => {
    const row = buildFixtureRow({ problem_statement: "  leading and trailing  \n\n" });
    const [candidate] = await collect(inputs([row]));
    expect(candidate!.statement).toBe("  leading and trailing  \n\n");
    expect(candidate!.provenance).toEqual({
      kind: "mined",
      upstream: {
        dataset: "nebius/SWE-rebench",
        revision: "refs/convert/parquet-2026-05-01",
        instanceId: row.instance_id,
      },
    });
    expect(() => assertCandidate(candidate!)).not.toThrow();
  });

  it("carries the gold patch as bytes and the test patch as digest-matched material", async () => {
    const row = buildFixtureRow();
    const [candidate] = await collect(inputs([row]));
    expect(new TextDecoder().decode(candidate!.goldPatch)).toBe(row.patch);
    expect(Buffer.from(candidate!.testMaterial[0]!.content, "base64").toString("utf8"))
      .toBe(row.test_patch);
  });

  it("skips a row whose repo or commit is not this record's environment", async () => {
    const skipped: string[] = [];
    const rows = [
      buildFixtureRow({ instance_id: "other__repo-1", repo: "other/repo" }),
      buildFixtureRow({ instance_id: "acme__widget-9", base_commit: "9".repeat(40) }),
    ];
    expect(await collect(inputs(rows), skipped)).toHaveLength(0);
    expect(skipped).toEqual([
      "other__repo-1:environment-row-mismatch",
      "acme__widget-9:environment-row-mismatch",
    ]);
  });

  it("filters on the caller's licence allowlist and never invents a default (D12)", async () => {
    const skipped: string[] = [];
    const rows = [
      buildFixtureRow({ instance_id: "acme__widget-a", license: "GPL-3.0-only" }),
      buildFixtureRow({ instance_id: "acme__widget-b", license: undefined }),
      buildFixtureRow({ instance_id: "acme__widget-c", license: "MIT" }),
    ];
    const kept = await collect(inputs(rows), skipped);
    expect(kept.map((candidate) => candidate.id)).toEqual(["acme__widget-c"]);
    expect(skipped).toEqual([
      "acme__widget-a:license-not-permitted",
      "acme__widget-b:license-undeclared",
    ]);
  });

  it("accepts a fallback licence only when the caller supplies one explicitly", async () => {
    const rows = [buildFixtureRow({ instance_id: "acme__widget-d", license: undefined })];
    const kept = await collect({ ...inputs(rows), fallbackLicense: "Apache-2.0" });
    expect(kept[0]!.rights.sourceLicense).toBe("Apache-2.0");
  });

  it("skips rows that cannot become a task: no statement, no gold, no fail-to-pass", async () => {
    const skipped: string[] = [];
    const rows = [
      buildFixtureRow({ instance_id: "acme__widget-e", problem_statement: "" }),
      buildFixtureRow({ instance_id: "acme__widget-f", patch: "" }),
      buildFixtureRow({ instance_id: "acme__widget-g", FAIL_TO_PASS: [] }),
      buildFixtureRow({ instance_id: "acme__widget-h", test_patch: "" }),
    ];
    expect(await collect(inputs(rows), skipped)).toHaveLength(0);
    expect(skipped).toEqual([
      "acme__widget-e:statement-empty",
      "acme__widget-f:gold-missing",
      "acme__widget-g:no-fail-to-pass",
      "acme__widget-h:test-material-missing",
    ]);
  });

  it("prefers the row's timeout and falls back to the caller's explicit default", async () => {
    const [withRowTimeout] = await collect(inputs([buildFixtureRow({ timeout: 1800 })]));
    expect(withRowTimeout!.timeout).toBe(1800);
    const [withDefault] = await collect(inputs([buildFixtureRow({ timeout: undefined })]));
    expect(withDefault!.timeout).toBe(900);
  });

  it("refuses, once and up front, an upstream label the record's lineage contradicts", async () => {
    const rows = [buildFixtureRow(), buildFixtureRow({ instance_id: "acme__widget-2" })];
    const contradicted = {
      ...inputs(rows),
      upstream: { dataset: "someone/else", revision: "refs/other" },
    };
    await expect(collect(contradicted)).rejects.toThrow(DerivationError);
    await expect(collect(contradicted)).rejects.toThrow(/lineage/);
  });

  it("imports against a record that carries no lineage at all", async () => {
    const { lineage: _lineage, ...withoutLineage } = buildFixtureEnvironmentRecordBody();
    const lineageless = loadDerivationEnvironment(sealEnvironmentRecord(withoutLineage as never));
    const out = [];
    for await (const candidate of importStrategy.derive(
      {},
      lineageless,
      inputs([buildFixtureRow()]),
    )) {
      out.push(candidate);
    }
    expect(out).toHaveLength(1);
  });

  it("accepts an async row source as well as a sync one", async () => {
    async function* rows() {
      yield buildFixtureRow();
    }
    const out = [];
    for await (const candidate of importStrategy.derive({}, env, {
      ...inputs([]),
      rows: rows(),
    })) {
      out.push(candidate);
    }
    expect(out).toHaveLength(1);
  });
});
