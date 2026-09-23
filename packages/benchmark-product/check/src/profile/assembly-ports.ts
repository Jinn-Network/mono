import { verify as cryptoVerify, type KeyObject } from "node:crypto";
import type { RunRecord } from "@jinn-network/benchmarking-records";
import { localAssemblyPorts, type LocalCellPinningEvidence } from "@jinn-network/benchmarking-local";
import type { AssemblyPorts, InScopeCell } from "@jinn-network/benchmarking-run";
import { dssePreAuthEncoding, parseDsseEnvelope } from "@jinn-network/trust-core";
import { venueIsolationPostureForPolicy } from "./isolation.js";
import type { LocalAdmissionReceiptFact } from "./admission-receipts.js";

export interface AssemblyPublicKeyRecord { readonly keyId: string; readonly publicKey: KeyObject; }
export interface BuildAssemblyPortsFromFactsInput {
  readonly runRecord: RunRecord;
  readonly cells: readonly InScopeCell[];
  readonly owner: string;
  readonly runCancelled: boolean;
  readonly receiptsByTaskDigest: ReadonlyMap<string, LocalAdmissionReceiptFact>;
  readonly resolveBytes: (digest: string) => Uint8Array;
  readonly evaluatorKeys: () => ReadonlyMap<string, AssemblyPublicKeyRecord>;
}

function resolveEvaluatorClaim(resolveBytes: (digest: string) => Uint8Array, evidenceRef: unknown, loadKeys: () => ReadonlyMap<string, AssemblyPublicKeyRecord>): string | "unresolved" {
  try {
    const ref = evidenceRef as { claim?: unknown; verdictDigest?: unknown } | undefined;
    if (typeof ref?.claim !== "string" || typeof ref.verdictDigest !== "string" || !ref.verdictDigest.startsWith("sha256:")) return "unresolved";
    const key = loadKeys().get(ref.claim);
    if (key === undefined) return "unresolved";
    const envelope = parseDsseEnvelope(resolveBytes(ref.verdictDigest.slice("sha256:".length)));
    const preAuth = Buffer.from(dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes));
    return envelope.signatures.some((signature) => signature.keyid === key.keyId && cryptoVerify(null, preAuth, key.publicKey, Buffer.from(signature.sig, "base64"))) ? ref.claim : "unresolved";
  } catch { return "unresolved"; }
}

/** Reconstructs the Matrix verifier ports exclusively from authenticated bundle facts. */
export function buildAssemblyPortsFromFacts(input: BuildAssemblyPortsFromFactsInput): AssemblyPorts {
  const baseline = input.runRecord.policy.submissionBaseline as Record<string, unknown>;
  const isolation = venueIsolationPostureForPolicy(baseline.isolationPolicy);
  return localAssemblyPorts({
    inputScope: { cellsForRun: () => [...input.cells], ...(input.runCancelled ? { runCancelled: true } : {}) },
    pinning: {
      submissionBaseline: baseline,
      isolationInventory: isolation.inventory,
      evidenceFor: (cellKey) => {
        const cell = input.cells.find((candidate) => candidate.cellKey === cellKey);
        if (cell === undefined || cell.dispatches === 0) return { dispatches: 0 };
        const evidence = cell.evidenceRef as LocalCellPinningEvidence | undefined;
        return evidence === undefined ? { dispatches: cell.dispatches } : { ...evidence, dispatches: cell.dispatches };
      },
    },
    admission: { receiptFor: (cell) => input.receiptsByTaskDigest.get(cell.taskDigest) },
    cost: { costFor: () => undefined, latencyFor: () => undefined },
    trust: { resolveAgent: async (ref) => (ref as { role?: unknown } | undefined)?.role === "solver" ? input.owner : (ref as { role?: unknown } | undefined)?.role === "evaluator" ? resolveEvaluatorClaim(input.resolveBytes, ref, input.evaluatorKeys) : "unresolved" },
  });
}
