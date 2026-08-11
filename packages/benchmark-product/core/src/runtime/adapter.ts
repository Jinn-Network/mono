/**
 * Runtime-neutral boundary for evaluation authoring/execution stacks.
 *
 * The Benchmark Product lifecycle sees only a digest-bound selection and the generic Run
 * requirements it contributes. Runtime-specific task, scorer, sandbox, and log semantics stay
 * behind adapters. The native implementation remains the compatibility/reference adapter.
 */

import type { EvaluationRuntimeBinding } from "../domain/draft.js";
import { refuse } from "../errors.js";
import {
  createLocalVenue,
  VENUE_ISOLATION_POLICY,
  type LocalVenue,
  type LocalVenueOptions,
} from "../venue/venue.js";
import { INSPECT_ADAPTER_ID } from "./inspect/manifest.js";

export const NATIVE_RUNTIME_ADAPTER_ID = "jinn-native";

export interface RuntimeAdapterSummary {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly selectionRequired: boolean;
}

export interface EvaluationRuntimeAdapter {
  readonly summary: RuntimeAdapterSummary;
  readonly nativeArtifactPublication: "not-applicable" | "explicit-consent";
  submissionBaseline(binding: EvaluationRuntimeBinding | undefined): Readonly<Record<string, unknown>>;
}

const nativeAdapter: EvaluationRuntimeAdapter = {
  summary: {
    id: NATIVE_RUNTIME_ADAPTER_ID,
    label: "Built-in native",
    available: true,
    selectionRequired: false,
  },
  nativeArtifactPublication: "not-applicable",
  submissionBaseline: () => ({ isolationPolicy: VENUE_ISOLATION_POLICY }),
};

const inspectAdapter: EvaluationRuntimeAdapter = {
  summary: {
    id: INSPECT_ADAPTER_ID,
    label: "Inspect",
    available: true,
    selectionRequired: true,
  },
  nativeArtifactPublication: "explicit-consent",
  // Runtime identity is already transitively sealed by Benchmark -> Task -> selection manifest.
  // The venue still discloses the same process-isolation policy as the compatibility runtime.
  submissionBaseline: () => ({ isolationPolicy: VENUE_ISOLATION_POLICY }),
};

const ADAPTERS = new Map<string, EvaluationRuntimeAdapter>([
  [nativeAdapter.summary.id, nativeAdapter],
  [inspectAdapter.summary.id, inspectAdapter],
]);

function adapterFor(binding: EvaluationRuntimeBinding | undefined): EvaluationRuntimeAdapter {
  const adapterId = binding?.adapterId ?? NATIVE_RUNTIME_ADAPTER_ID;
  const adapter = ADAPTERS.get(adapterId);
  if (adapter === undefined) {
    refuse("venue-unavailable", "spec.evaluationRuntime.adapterId", `evaluation runtime adapter \"${adapterId}\" is not installed`);
  }
  return adapter;
}

export function listRuntimeAdapters(): readonly RuntimeAdapterSummary[] {
  return [...ADAPTERS.values()].map((adapter) => adapter.summary);
}

export function runtimeSubmissionBaseline(
  binding?: EvaluationRuntimeBinding,
): Readonly<Record<string, unknown>> {
  return adapterFor(binding).submissionBaseline(binding);
}

export function runtimeNativeArtifactPublicationPolicy(
  binding?: EvaluationRuntimeBinding,
): EvaluationRuntimeAdapter["nativeArtifactPublication"] {
  return adapterFor(binding).nativeArtifactPublication;
}

/** Runtime-neutral venue construction used by preview, quote, launch, resume, and cancel. */
export function createRuntimeVenue(
  binding: EvaluationRuntimeBinding | undefined,
  options: Omit<LocalVenueOptions, "evaluationRuntime">,
): LocalVenue {
  // Resolve first so unknown adapters fail at the shared operation boundary.
  adapterFor(binding);
  return createLocalVenue({ ...options, ...(binding === undefined ? {} : { evaluationRuntime: binding }) });
}
