/** Explicit, digest-changing derivation of source intake into workspace-authored records. */

import { BENCHMARKING_PROTOCOL, parseBenchmark, sealBenchmark } from "@jinn-network/benchmarking-records";
import { TaskSpecificationSchema, sealTask } from "@jinn-network/task-execution-protocol";
import { sha256Hex } from "../workspace/sealed-store.js";

export const COLOPHON_DERIVATION_EXTENSION = "https://product.jinn.network/extensions/colophon-derivation/v1";

export interface AuthoredExactRecord {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

function parseTask(bytes: Uint8Array) {
  return TaskSpecificationSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}

export function deriveWorkspaceAuthoredTask(input: {
  readonly sourceBytes: Uint8Array;
  readonly author: string;
  readonly sourceKind: "bundled-sample" | "swe-bench-import" | "terminal-bench-2-1";
  readonly sourceReceiptSha256?: string;
}): AuthoredExactRecord {
  const sourceSha256 = sha256Hex(input.sourceBytes);
  const bytes = sealTask({
    ...parseTask(input.sourceBytes),
    author: input.author,
    [COLOPHON_DERIVATION_EXTENSION]: {
      transformation: "workspace-authored-derivation",
      sourceKind: input.sourceKind,
      sourceTask: { digest: { sha256: sourceSha256 } },
      ...(input.sourceReceiptSha256 === undefined ? {} : {
        sourceAdmissionReceipt: { digest: { sha256: input.sourceReceiptSha256 } },
      }),
    },
  });
  return { bytes, sha256: sha256Hex(bytes) };
}

export function deriveWorkspaceAuthoredBenchmark(input: {
  readonly sourceBytes: Uint8Array;
  readonly taskSha256s: readonly string[];
  readonly author: string;
}): AuthoredExactRecord {
  const source = parseBenchmark(input.sourceBytes);
  const bytes = sealBenchmark({
    ...source,
    protocol: BENCHMARKING_PROTOCOL,
    author: input.author,
    items: input.taskSha256s.map((sha256) => ({ task: { digest: { sha256 } } })),
    [COLOPHON_DERIVATION_EXTENSION]: {
      transformation: "workspace-authored-derivation",
      sourceBenchmark: { digest: { sha256: sha256Hex(input.sourceBytes) } },
    },
  }).bytes;
  return { bytes, sha256: sha256Hex(bytes) };
}
