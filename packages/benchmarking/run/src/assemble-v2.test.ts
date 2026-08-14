import {
  BENCHMARK_ACCOUNTING_PROCEDURE,
  BENCHMARK_ACCOUNTING_PROCEDURE_VERSION,
  BENCHMARKING_PROTOCOL,
  documentDigest,
  parseBenchmarkAccounting,
  parseMatrix,
  sealBenchmarkAccounting,
  sealRun,
} from "@jinn-network/benchmarking-records";
import { buildMiniatureAssemblyPorts } from "@jinn-network/benchmarking-testing";
import { describe, expect, test } from "vitest";
import { assembleMatrix, assembleMatrixV2 } from "./assemble.js";
import type { MatrixV2AssemblyPorts } from "./ports.js";
import { verifyMatrixV2 } from "./verify.js";

async function accountingInput(run: Awaited<ReturnType<typeof buildMiniatureAssemblyPorts>>["run"]) {
  const runDigest = sealRun(run).digest.slice("sha256:".length);
  const sealed = sealBenchmarkAccounting({
    protocol: BENCHMARKING_PROTOCOL,
    run: { name: "run", digest: { sha256: runDigest } },
    publisher: run.owner,
    publisherAuthority: { kind: "run-owner" },
    procedure: {
      id: BENCHMARK_ACCOUNTING_PROCEDURE,
      version: BENCHMARK_ACCOUNTING_PROCEDURE_VERSION,
    },
    scope: {
      streams: [{
        role: "https://spec.jinn.network/roles/benchmark-publisher-dispatches/v1",
        kind: "record-discovery",
        source: { agent: run.owner, name: "publication-v2-fixture" },
        through: { sequence: "0000000000000001", entry: `sha256:${"a".repeat(64)}` },
      }],
    },
    publicRegistration: { status: "post-hoc" },
    closeBoundary: { at: run.closeAt },
    cells: [],
  });
  return { bytes: sealed.bytes, record: parseBenchmarkAccounting(sealed.bytes) };
}

function v2Ports(
  ports: Awaited<ReturnType<typeof buildMiniatureAssemblyPorts>>["ports"],
  order: string[] = [],
): MatrixV2AssemblyPorts {
  return {
    ...ports,
    accountingVerification: {
      async verifyAccounting() {
        order.push("verification");
        return { ok: true };
      },
    },
    accountingCompleteness: {
      async verifyCompleteness() {
        order.push("completeness");
        return { ok: true };
      },
    },
  };
}

describe("Matrix assembly v2", () => {
  test("binds exact accounting bytes through the required Matrix extension and verification ports", async () => {
    const { bench, run, ports } = await buildMiniatureAssemblyPorts();
    const accounting = await accountingInput(run);
    const calls: string[] = [];
    const assembled = await assembleMatrixV2(bench, run, v2Ports(ports, calls), accounting);

    expect(calls).toEqual(["verification", "completeness"]);
    expect(assembled.record.assembly).toEqual({
      procedure: "jinn.benchmarking.assembly",
      version: "2.0",
    });
    expect((assembled.record as Record<string, unknown>)[
      "https://spec.jinn.network/extensions/benchmark-publication/v1"
    ]).toMatchObject({ accounting: { digest: { sha256: documentDigest(accounting.bytes).slice("sha256:".length) } } });
    await expect(verifyMatrixV2(
      parseMatrix(assembled.bytes),
      bench,
      run,
      v2Ports(ports),
      accounting,
      assembled.bytes,
    )).resolves.toEqual({ ok: true });
  });

  test("rejects accounting bound to another Run before calling accounting ports", async () => {
    const { bench, run, ports } = await buildMiniatureAssemblyPorts();
    const accounting = await accountingInput(run);
    const wrongDocument = structuredClone(accounting.record) as typeof accounting.record;
    wrongDocument.run.digest.sha256 = "f".repeat(64);
    const wrongSealed = sealBenchmarkAccounting(wrongDocument);
    const wrong = parseBenchmarkAccounting(wrongSealed.bytes);
    const calls: string[] = [];

    await expect(assembleMatrixV2(bench, run, v2Ports(ports, calls), {
      bytes: wrongSealed.bytes,
      record: wrong,
    })).rejects.toThrow("BenchmarkAccounting record does not match the sealed Run");
    expect(calls).toEqual([]);
  });

  test("verification rejects tampered exact accounting bytes", async () => {
    const { bench, run, ports } = await buildMiniatureAssemblyPorts();
    const accounting = await accountingInput(run);
    const assembled = await assembleMatrixV2(bench, run, v2Ports(ports), accounting);
    const tampered = new Uint8Array(accounting.bytes);
    tampered[0] = (tampered[0]! + 1) % 256;

    await expect(verifyMatrixV2(
      parseMatrix(assembled.bytes),
      bench,
      run,
      v2Ports(ports),
      { bytes: tampered, record: accounting.record },
      assembled.bytes,
    )).resolves.toMatchObject({ ok: false, check: "accounting-bytes" });
  });

  test("surfaces an injected accounting completeness failure without producing a Matrix", async () => {
    const { bench, run, ports } = await buildMiniatureAssemblyPorts();
    const accounting = await accountingInput(run);
    const v2 = v2Ports(ports);
    v2.accountingCompleteness = {
      async verifyCompleteness() {
        return { ok: false, detail: "scope incomplete" };
      },
    };

    await expect(assembleMatrixV2(bench, run, v2, accounting))
      .rejects.toThrow("scope incomplete");
  });

  test("v1 assembly remains byte-compatible and accepts no accounting ports", async () => {
    const { bench, run, ports, procedure, expectedBytes } = await buildMiniatureAssemblyPorts();
    const assembled = await assembleMatrix(bench, run, ports, procedure);
    expect(assembled.bytes).toEqual(expectedBytes);
    expect(assembled.record.assembly).toEqual(procedure);
  });
});
