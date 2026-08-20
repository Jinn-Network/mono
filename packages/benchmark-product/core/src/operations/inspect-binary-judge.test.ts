import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  sealBinaryJudgmentInstrument,
  type BinaryJudgmentInstrument,
} from "@jinn-network/task-execution-profiles";
import { cellKey, parseMatrix } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { afterEach, describe, expect, test } from "vitest";
import { runCli } from "../cli/main.js";
import { createSyntheticV4BundleFixture } from "../bundle/testing/v4-synthetic-fixture.js";
import {
  INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
  type InspectBinaryJudgeBindingRequest,
} from "../runtime/inspect/binary-judge-manifest.js";
import { inspectBinaryJudgeWorkerSha256 } from "../runtime/inspect/binary-judge.js";
import { inspectOciRunnerSha256 } from "../runtime/inspect/oci.js";
import { runtimeHostPath } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { createDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";
import { appendRunJournalEntry } from "../run/journal.js";
import { requireRunState } from "../run/state.js";
import { exportCompletenessCertification } from "../runtime/suite-protocol/comparability.js";
import { bindInspectBinaryJudge } from "./inspect-binary-judge.js";
import { exportDerivedBundle, selectMethod } from "./method.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const oracle = JSON.parse(readFileSync(new URL(
  "../../../../task-execution/profiles/fixtures/binary-judgment-request/golden/unicode-line-endings.json",
  import.meta.url,
), "utf8")) as { input: { instrument: BinaryJudgmentInstrument } };

function sourceDigest(name: "broker.py" | "model_provider.py"): string {
  return sha256Hex(new Uint8Array(readFileSync(new URL(`../runtime/inspect/${name}`, import.meta.url))));
}

function setup(): { readonly context: OperationContext; readonly alpha: ReturnType<typeof sealBinaryJudgmentInstrument>; readonly beta: ReturnType<typeof sealBinaryJudgmentInstrument> } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "colophon-inspect-binary-judge-"));
  roots.push(workspaceDir);
  const context = {
    workspaceDir,
    principal: "sponsor-1",
    clock: () => "2026-08-15T08:00:00.000Z",
  };
  expect(initWorkspace(context).ok).toBe(true);
  expect(createDraft(context, {
    draftId: "judge",
    name: "Judge benchmark",
    spec: { taskSet: { kind: "benchmark", benchmarkSha256: "f".repeat(64) } },
  }).ok).toBe(true);
  const alpha = sealBinaryJudgmentInstrument({ ...oracle.input.instrument, instrumentId: "alpha" });
  const beta = sealBinaryJudgmentInstrument({ ...oracle.input.instrument, instrumentId: "beta" });
  expect(putSealedBytes(workspaceDir, alpha.bytes)).toBe(alpha.digest.slice("sha256:".length));
  expect(putSealedBytes(workspaceDir, beta.bytes)).toBe(beta.digest.slice("sha256:".length));
  return { context, alpha, beta };
}

function binding(
  alpha: ReturnType<typeof sealBinaryJudgmentInstrument>,
  beta: ReturnType<typeof sealBinaryJudgmentInstrument>,
): InspectBinaryJudgeBindingRequest {
  const imageDigest = `sha256:${"a".repeat(64)}` as const;
  return {
    schema: "jinn.network/benchmark-product/inspect-binary-judge-binding-request/1",
    manifest: {
      schema: INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
      runtime: {
        imageDigest,
        platform: "linux/amd64",
        pythonVersion: "3.11.9",
        inspectVersion: "0.3.255",
        inspectEvalsVersion: "0.16.0",
        openaiSdkVersion: "2.53.0",
        runtimeHostSourceSha256: inspectOciRunnerSha256(),
        workerSourceSha256: inspectBinaryJudgeWorkerSha256(),
        brokerSourceSha256: sourceDigest("broker.py"),
        modelProviderSourceSha256: sourceDigest("model_provider.py"),
      },
      execution: {
        callsPerCell: 1,
        epochs: 1,
        inspectScorer: false,
        retries: 0,
        fallbacks: 0,
        tools: [],
        storage: false,
      },
      requirement: {
        key: BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
        valueShape: "sha256:<64-lowercase-hex>",
        comparison: "exact",
        location: "submission-effective-requirements",
      },
      arms: [
        {
          armId: "alpha",
          instrumentSha256: alpha.digest,
          model: "gpt-5.6-luna",
          generation: oracle.input.instrument.model.generation,
        },
        {
          armId: "beta",
          instrumentSha256: beta.digest,
          model: "gpt-5.6-luna",
          generation: oracle.input.instrument.model.generation,
        },
      ],
    },
    host: {
      kind: "oci",
      dockerPath: "/usr/local/bin/docker",
      imageDigest,
      platform: "linux/amd64",
      user: "65532:65532",
    },
  };
}

describe("bindInspectBinaryJudge", () => {
  test("keeps the imported benchmark arm-neutral and binds exact instrument scalars per arm", () => {
    const { context, alpha, beta } = setup();
    const selected = bindInspectBinaryJudge(context, { draftId: "judge", binding: binding(alpha, beta) });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.result.draft.spec.taskSet).toEqual({
      kind: "benchmark",
      benchmarkSha256: "f".repeat(64),
    });
    expect(selected.result.draft.spec.arms).toEqual([
      {
        armId: "alpha",
        pinning: {
          harness: { id: "inspect-ai-judge", version: "1" },
          model: { id: "gpt-5.6-luna" },
          [BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY]: alpha.digest,
        },
      },
      {
        armId: "beta",
        pinning: {
          harness: { id: "inspect-ai-judge", version: "1" },
          model: { id: "gpt-5.6-luna" },
          [BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY]: beta.digest,
        },
      },
    ]);
    expect(selected.result.draft.spec.evaluationRuntime).toEqual({
      adapterId: "inspect-binary-judge",
      selectionManifestSha256: selected.result.selectionManifestSha256,
      isolationPolicy: "oci-container",
    });
    expect(getSealedBytes(context.workspaceDir, selected.result.selectionManifestSha256))
      .toEqual(canonicalJsonBytes(binding(alpha, beta).manifest));
    expect(JSON.parse(readFileSync(
      runtimeHostPath(context.workspaceDir, selected.result.selectionManifestSha256),
      "utf8",
    ))).toEqual(binding(alpha, beta).host);
  });

  test("rejects host, source, inventory, and instrument identity drift without running Docker or a provider", () => {
    const { context, alpha, beta } = setup();
    const valid = binding(alpha, beta);
    for (const candidate of [
      {
        ...valid,
        host: { ...valid.host, imageDigest: `sha256:${"d".repeat(64)}` },
      },
      {
        ...valid,
        manifest: { ...valid.manifest, runtime: { ...valid.manifest.runtime, brokerSourceSha256: "e".repeat(64) } },
      },
      {
        ...valid,
        manifest: { ...valid.manifest, arms: [...valid.manifest.arms].reverse() },
      },
    ] as const) {
      const result = bindInspectBinaryJudge(context, { draftId: "judge", binding: candidate as never });
      expect(result.ok).toBe(false);
    }

    const wrongIdentity = sealBinaryJudgmentInstrument({
      ...oracle.input.instrument,
      instrumentId: "not-alpha",
    });
    putSealedBytes(context.workspaceDir, wrongIdentity.bytes);
    const identityDrift = {
      ...valid,
      manifest: {
        ...valid.manifest,
        arms: [
          { ...valid.manifest.arms[0]!, instrumentSha256: wrongIdentity.digest },
          valid.manifest.arms[1]!,
        ],
      },
    };
    const rejected = bindInspectBinaryJudge(context, {
      draftId: "judge",
      binding: identityDrift,
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("the judge binding as a method-operand file citizen (§8.1)", () => {
  test("binds byte-identically through the method operand", async () => {
    const { context: contextA, alpha: alphaA, beta: betaA } = setup();
    const { context: contextB, alpha: alphaB, beta: betaB } = setup();

    const direct = bindInspectBinaryJudge(contextA, { draftId: "judge", binding: binding(alphaA, betaA) });
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;

    const bindingPath = join(contextB.workspaceDir, "inspect-judge-binding.json");
    writeFileSync(bindingPath, JSON.stringify(binding(alphaB, betaB)));
    const cli = await runCli([
      "method", bindingPath,
      "--workspace", contextB.workspaceDir,
      "--principal", contextB.principal,
      "--draft", "judge",
      "--json",
    ], { cwd: contextB.workspaceDir, clock: contextB.clock });
    expect(cli.exitCode, cli.stderr).toBe(0);
    const envelope = JSON.parse(cli.stdout) as {
      readonly ok: boolean;
      readonly result?: {
        readonly selectionManifestSha256?: string;
        readonly draft?: { readonly spec: { readonly arms: unknown; readonly evaluationRuntime: unknown } };
      };
    };
    expect(envelope.ok).toBe(true);
    const viaFile = envelope.result;
    if (viaFile === undefined || viaFile.selectionManifestSha256 === undefined || viaFile.draft === undefined) {
      throw new Error("expected a successful method-bind result");
    }

    expect(viaFile.selectionManifestSha256).toBe(direct.result.selectionManifestSha256);
    expect(viaFile.draft.spec.arms).toEqual(direct.result.draft.spec.arms);
    expect(viaFile.draft.spec.evaluationRuntime).toEqual(direct.result.draft.spec.evaluationRuntime);

    expect(getSealedBytes(contextB.workspaceDir, viaFile.selectionManifestSha256))
      .toEqual(getSealedBytes(contextA.workspaceDir, direct.result.selectionManifestSha256));

    expect(JSON.parse(readFileSync(
      runtimeHostPath(contextB.workspaceDir, viaFile.selectionManifestSha256),
      "utf8",
    ))).toEqual(JSON.parse(readFileSync(
      runtimeHostPath(contextA.workspaceDir, direct.result.selectionManifestSha256),
      "utf8",
    )));
  });

  test("reports the judge binding as a custom non-catalog method", async () => {
    const { context, alpha, beta } = setup();
    const bindingPath = join(context.workspaceDir, "inspect-judge-binding.json");
    writeFileSync(bindingPath, JSON.stringify(binding(alpha, beta)));

    const direct = await selectMethod(context, { draftId: "judge", ref: bindingPath, cwd: context.workspaceDir });
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(direct.result.documentKind).toBe("inspect-binary-judge");
    expect(direct.result.official).toBe(false);
    expect(direct.result.catalogId).toBeUndefined();
    expect(direct.result.suiteProtocolSha256).toBeUndefined();

    const cli = await runCli([
      "method", bindingPath,
      "--workspace", context.workspaceDir,
      "--principal", context.principal,
      "--draft", "judge",
    ], { cwd: context.workspaceDir, clock: context.clock });
    expect(cli.exitCode, cli.stderr).toBe(0);
    expect(cli.stdout).toBe(`bound custom inspect-binary-judge method ${direct.result.selectionManifestSha256} for draft judge\n`);
  });

  test("refuses every selection flag on a judge binding file", async () => {
    const { context, alpha, beta } = setup();
    const bindingPath = join(context.workspaceDir, "inspect-judge-binding.json");
    writeFileSync(bindingPath, JSON.stringify(binding(alpha, beta)));

    const flagCases: readonly (readonly [string, string])[] = [
      ["--slice", "1"],
      ["--ids", "x"],
      ["--n", "1"],
      ["--host", join(context.workspaceDir, "host.json")],
    ];
    for (const [flag, value] of flagCases) {
      const cli = await runCli([
        "method", bindingPath,
        "--workspace", context.workspaceDir,
        "--principal", context.principal,
        "--draft", "judge",
        flag, value,
        "--json",
      ], { cwd: context.workspaceDir, clock: context.clock });
      expect(cli.exitCode, `${flag}: ${cli.stdout}${cli.stderr}`).toBe(2);
      const envelope = JSON.parse(cli.stdout) as { readonly ok: boolean; readonly error?: { readonly code?: string } };
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe("invalid-invocation");
    }
  });
});

describe("derived Inspect View export wiring for the judge lane (§8.2)", () => {
  test("a judge draft with no sealed Run still refuses", () => {
    const { context, alpha, beta } = setup();
    const bound = bindInspectBinaryJudge(context, { draftId: "judge", binding: binding(alpha, beta) });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const exported = exportDerivedBundle(context, { draftId: "judge", armId: "alpha" });
    expect(exported.ok).toBe(false);
    if (exported.ok) return;
    expect(exported.error.code).toBe("not-found");
    expect(exported.error.detail).toMatch(/quote the draft first/u);
  });

  test("a judge draft exports through exportDerivedBundle as shape inspect-view, mode inspection-upload, with the forked sentence and the scoreless-transcripts caveat", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "colophon-inspect-binary-judge-export-"));
    roots.push(workspaceDir);
    const fixture = await createSyntheticV4BundleFixture({ workspaceDir, truthAdmission: "operator-only" });
    const context: OperationContext = {
      workspaceDir,
      principal: "synthetic-operator",
      clock: () => "2026-08-19T00:00:00.000Z",
    };
    const logBytes = new TextEncoder().encode("fake-judge-eval-log");
    const logSha256 = putSealedBytes(workspaceDir, logBytes);
    appendRunJournalEntry(workspaceDir, fixture.draftId, {
      kind: "delivery",
      at: "2026-08-19T00:00:01.000Z",
      cellKey: cellKey(fixture.taskSha256s[0]!, "alpha", 1),
      dispatch: 1,
      attempt: "urn:jinn:attempt:judge-export-1",
      deliverySha256: "9".repeat(64),
      outputs: [{ name: "inspect-log", sha256: logSha256 }],
    });

    const exported = exportDerivedBundle(context, { draftId: fixture.draftId, armId: "alpha" });
    expect(exported.ok, JSON.stringify(exported)).toBe(true);
    if (!exported.ok) return;
    if (exported.result.shape !== "inspect-view") throw new Error(`expected shape inspect-view, got ${exported.result.shape}`);
    expect(exported.result.mode).toBe("inspection-upload");
    expect(exported.result.logCount).toBe(1);
    // §8.2 clause 2: the certification line is first, rendering the sealed Matrix's own
    // completeness — never recomputed, never consulting suiteQuote on the judge lane.
    const judgeRunState = requireRunState(workspaceDir, fixture.draftId);
    const judgeMatrix = judgeRunState.matrixSha256 === undefined
      ? undefined
      : parseMatrix(getSealedBytes(workspaceDir, judgeRunState.matrixSha256));
    expect(exported.result.instructions.split("\n")[0]).toBe(exportCompletenessCertification({
      runSha256: judgeRunState.runSha256!,
      completeness: judgeMatrix?.completeness,
    }));
    expect(exported.result.instructions).toContain(
      "This run's method is a custom judge binding, not an Inspect eval selection, so this package wears no suite name.",
    );
    expect(exported.result.instructions).toContain(
      "These .eval logs carry the judge's transcripts, not its verdicts; the verdicts are in the sealed Report and the published bundle.",
    );
    expect(exported.result.instructions).not.toContain("This run matches Inspect eval execution settings");

    const onDisk = readFileSync(join(exported.result.exportDir, "INSTRUCTIONS.txt"), "utf8");
    expect(onDisk).toBe(`${exported.result.instructions}\n`);
    expect(onDisk).not.toContain("This run matches Inspect eval execution settings");
  });
});
