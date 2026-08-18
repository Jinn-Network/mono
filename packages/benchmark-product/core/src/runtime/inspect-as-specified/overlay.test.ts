import { describe, expect, test } from "vitest";
import {
  INSPECT_SELECTION_SCHEMA,
  InspectSelectionManifestSchema,
  SUPPORTED_INSPECT_VERSION,
  SUPPORTED_INSPECT_WHEEL_SHA256,
} from "../inspect/manifest.js";
import { InspectAsSpecifiedSelectionManifestSchema } from "./manifest.js";
import { overlayInspectAsSpecifiedCell, overlayInspectCellManifest, stripInspectTemplateSampleId } from "./overlay.js";

const manifest = InspectSelectionManifestSchema.parse({
  schema: INSPECT_SELECTION_SCHEMA,
  runtime: {
    adapterVersion: "1",
    workerSha256: "c".repeat(64),
    inspectVersion: SUPPORTED_INSPECT_VERSION,
    inspectWheelSha256: SUPPORTED_INSPECT_WHEEL_SHA256,
    pythonVersion: "3.11.9",
    pythonExecutableSha256: "a".repeat(64),
    pythonEnvironmentSha256: "d".repeat(64),
    inspectDistributionSha256: "e".repeat(64),
  },
  task: {
    reference: "eval.py@hermetic",
    args: {},
    resolvedName: "hermetic",
    resolvedVersion: "1.0",
    resolvedSandbox: null,
    source: {
      kind: "project-file",
      path: "eval.py",
      sha256: "b".repeat(64),
      projectTreeSha256: "f".repeat(64),
    },
    dataset: { name: "hermetic", location: null, samples: 2, selectedSampleId: "alpha" },
  },
  arms: [
    { armId: "control", model: "mockllm/control" },
    { armId: "candidate", model: "mockllm/candidate" },
  ],
  scorer: { name: "match", passValue: "C", definition: { name: "match", options: {}, metrics: [] } },
  runOptions: { sampleId: "alpha", maxSamples: 1 },
});
const template = stripInspectTemplateSampleId(manifest);

describe("Inspect-as-specified cell overlay", () => {
  test("overlays a slash sample id onto the shared template", () => {
    const cell = overlayInspectCellManifest(template, "HumanEval/0");
    expect(cell.runOptions.sampleId).toBe("HumanEval/0");
    expect(cell.runOptions.maxSamples).toBe(1);
    expect(cell.task.dataset.selectedSampleId).toBe("HumanEval/0");
    expect(InspectSelectionManifestSchema.parse(cell).runOptions.sampleId).toBe("HumanEval/0");
  });

  test("refuses a sample id outside the sealed slice", () => {
    const selection = InspectAsSpecifiedSelectionManifestSchema.parse({
      schema: "jinn.network/benchmark-product/inspect-as-specified-selection/1",
      inspect: template,
      catalog: {
        sampleIds: ["HumanEval/0", "alpha"],
        snapshotSha256: "1".repeat(64),
        specifiedEpochs: 1,
        datasetName: "hermetic",
        datasetLocation: null,
        datasetSampleCount: 2,
      },
      coverage: "one_task",
      selectedSamples: [{ sampleId: "HumanEval/0" }],
      solver: "task-default",
      sampleLimit: null,
      suite: {
        schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
        protocol: "inspect-as-specified",
        coverage: "one_task",
        datasetId: "hermetic",
        datasetRevision: "1".repeat(64),
        selectedTaskNames: ["HumanEval/0"],
        datasetTaskCount: 2,
        replicates: 1,
        atifRequired: false,
        items: [{ taskName: "HumanEval/0", taskSha256: "2".repeat(64) }],
      },
    });
    expect(() => overlayInspectAsSpecifiedCell(selection, "alpha")).toThrow(/not in the sealed catalog slice/u);
    expect(overlayInspectAsSpecifiedCell(selection, "HumanEval/0").runOptions.sampleId).toBe("HumanEval/0");
  });
});
