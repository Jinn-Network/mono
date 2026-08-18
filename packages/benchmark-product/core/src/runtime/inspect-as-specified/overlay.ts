/** Per-cell Inspect worker input: overlay the Task sampleId onto the shared template. */
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { sha256Hex } from "../../workspace/sealed-store.js";
import {
  InspectSelectionManifestSchema,
  InspectSelectionTemplateSchema,
  type InspectSelectionManifest,
  type InspectSelectionTemplate,
} from "../inspect/manifest.js";
import { sampleIdKey, type InspectAsSpecifiedSelectionManifest } from "./manifest.js";

export function overlayInspectCellManifest(
  template: InspectSelectionTemplate,
  sampleId: string | number,
): InspectSelectionManifest {
  const { sampleId: _ignored, ...restOptions } = template.runOptions;
  const orderedSampleSha256 = sha256Hex(canonicalJsonBytes({ sampleId } as never));
  return InspectSelectionManifestSchema.parse({
    ...template,
    runOptions: {
      ...restOptions,
      sampleId,
      maxSamples: 1,
    },
    task: {
      ...template.task,
      dataset: {
        ...template.task.dataset,
        selectedSampleId: sampleId,
        ...(template.runtime.execution === undefined ? {} : { orderedSampleSha256 }),
      },
    },
  });
}

export function overlayInspectAsSpecifiedCell(
  selection: InspectAsSpecifiedSelectionManifest,
  sampleId: string | number,
): InspectSelectionManifest {
  const allowed = new Set(selection.selectedSamples.map((sample) => sampleIdKey(sample.sampleId)));
  if (!allowed.has(sampleIdKey(sampleId))) {
    throw new TypeError("Inspect-as-specified cell sampleId is not in the sealed catalog slice");
  }
  return overlayInspectCellManifest(selection.inspect, sampleId);
}

export function stripInspectTemplateSampleId(manifest: InspectSelectionManifest): InspectSelectionTemplate {
  const { sampleId: _sampleId, ...runOptions } = manifest.runOptions;
  const { selectedSampleId: _selected, orderedSampleSha256: _ordered, ...dataset } = manifest.task.dataset;
  return InspectSelectionTemplateSchema.parse({
    ...manifest,
    runOptions,
    task: {
      ...manifest.task,
      dataset,
    },
  });
}
