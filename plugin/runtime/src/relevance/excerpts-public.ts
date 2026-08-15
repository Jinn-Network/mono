// SPDX-License-Identifier: Apache-2.0
import type { ValidatedEvidenceResult } from "@jinn-network/evidence-retrieval";
import type { Sha256Digest } from "@jinn-network/evidence-repository";

import { excerptsFromSpans } from "./excerpts-local.js";
import { MAX_INDEXED_EXCERPTS, MAX_SUMMARY_CHARS, type IndexableExcerpt } from "./index-store.js";
import { extractArtifactText } from "./text.js";
import type { TraceSpanSource } from "./trace-decode-adapter.js";

export interface PublicExcerptOptions {
  readonly spanSource: TraceSpanSource;
  /** The record's declared native-trace format IRI, when it carries one. */
  readonly traceFormatIri?: string;
}

export interface PublicExcerptOutcome {
  readonly summary: string;
  readonly excerpts: readonly IndexableExcerpt[];
}

type HydratedArtifact = ValidatedEvidenceResult["artifacts"][number];

function hasRole(artifact: HydratedArtifact, role: string): boolean {
  return artifact.declaration.roles.includes(role);
}

function hydrated(artifact: HydratedArtifact): Uint8Array | undefined {
  return artifact.status === "verified" ? artifact.bytes : undefined;
}

/**
 * Excerpts for a mirrored public record. Preference order: decoded native-trace spans
 * (highest fidelity), then result artifacts (always present, format-independent). The
 * summary always comes from the task artifact — a public record's own declared task
 * statement, never text C6 synthesised.
 */
export function excerptsFromRetrieval(
  result: ValidatedEvidenceResult,
  options: PublicExcerptOptions,
): PublicExcerptOutcome {
  const artifacts = result.artifacts;

  const taskArtifact = artifacts.find((artifact) => hasRole(artifact, "task"));
  const taskBytes = taskArtifact === undefined ? undefined : hydrated(taskArtifact);
  const summary =
    taskBytes === undefined
      ? ""
      : extractArtifactText(taskBytes).split("\n")[0]?.slice(0, MAX_SUMMARY_CHARS).trim() ?? "";

  const traceArtifact = artifacts.find((artifact) => hasRole(artifact, "native-trace"));
  const traceBytes = traceArtifact === undefined ? undefined : hydrated(traceArtifact);
  if (traceArtifact !== undefined && traceBytes !== undefined) {
    const spans = options.spanSource.spansFor({
      ...(options.traceFormatIri === undefined ? {} : { formatIri: options.traceFormatIri }),
      bytes: traceBytes,
      nativeTraceDigest: traceArtifact.declaration.reference.digest as Sha256Digest,
      nativeTraceName: traceArtifact.declaration.entityId,
    });
    if (spans.length > 0) {
      const excerpts = excerptsFromSpans({
        spans,
        feedBytes: traceBytes,
        sourceEntityId: traceArtifact.declaration.entityId,
        sourceDigest: traceArtifact.declaration.reference.digest as Sha256Digest,
      });
      if (excerpts.length > 0) return { summary, excerpts };
    }
  }

  const excerpts: IndexableExcerpt[] = [];
  for (const artifact of artifacts) {
    if (excerpts.length >= MAX_INDEXED_EXCERPTS) break;
    if (!hasRole(artifact, "result")) continue;
    const bytes = hydrated(artifact);
    if (bytes === undefined) continue;
    const text = extractArtifactText(bytes, undefined).trim();
    if (text.length === 0) continue;
    excerpts.push({
      label: "note",
      sourceEntityId: artifact.declaration.entityId,
      sourceDigest: artifact.declaration.reference.digest as Sha256Digest,
      text,
    });
  }

  return { summary, excerpts };
}
