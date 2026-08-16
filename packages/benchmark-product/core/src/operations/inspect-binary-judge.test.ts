import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  sealBinaryJudgmentInstrument,
  type BinaryJudgmentInstrument,
} from "@jinn-network/task-execution-profiles";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { afterEach, describe, expect, test } from "vitest";
import { runCli } from "../cli/main.js";
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
import { bindInspectBinaryJudge } from "./inspect-binary-judge.js";

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

  test("exposes the same binding through the additive file-based CLI without launching the runtime", async () => {
    const { context, alpha, beta } = setup();
    const bindingPath = join(context.workspaceDir, "inspect-judge-binding.json");
    writeFileSync(bindingPath, JSON.stringify(binding(alpha, beta)));
    const result = await runCli([
      "runtime", "inspect", "bind-judge",
      "--workspace", context.workspaceDir,
      "--principal", context.principal,
      "--draft", "judge",
      "--file", bindingPath,
      "--json",
    ], { cwd: context.workspaceDir, clock: context.clock });
    expect(result.exitCode, result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      readonly ok: boolean;
      readonly result?: { readonly selectionManifestSha256?: string };
    };
    expect(envelope).toMatchObject({
      ok: true,
      result: { selectionManifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
    });
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
