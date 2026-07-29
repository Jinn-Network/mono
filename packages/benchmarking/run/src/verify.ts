import {
  documentDigest,
  type BenchmarkRecord,
  type MatrixRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import { assembleMatrix } from "./assemble.js";
import type { AssemblyPorts, AssemblyProcedure } from "./ports.js";

export type VerifyMatrixResult =
  | { ok: true }
  | { ok: false; check: string; detail: string };

/**
 * Tier-3 matrix verification (§10.1 op 6): always re-derive and byte-compare exact matrix
 * bytes (`matrix-rederivation`). Soft cell-count / runOutcome shortcuts are forbidden.
 * Trust joins run through `assembleMatrix` → `ports.trust`; optional signature port when present.
 */
export async function verifyMatrix(
  matrix: MatrixRecord,
  bench: BenchmarkRecord,
  run: RunRecord,
  ports: AssemblyPorts,
  procedure: AssemblyProcedure | undefined,
  matrixBytes: Uint8Array,
): Promise<VerifyMatrixResult> {
  void matrix;
  if (!(matrixBytes instanceof Uint8Array) || matrixBytes.length === 0) {
    return {
      ok: false,
      check: "matrix-rederivation",
      detail: "exact matrix bytes are required for verifyMatrix",
    };
  }

  if (ports.verifySignatures !== undefined) {
    const signature = await ports.verifySignatures.verifyMatrixAuthority(matrixBytes, run);
    if (!signature.ok) {
      return {
        ok: false,
        check: "matrix-authority",
        detail: signature.detail,
      };
    }
  }

  const assembled = await assembleMatrix(bench, run, ports, procedure);
  const expectedDigest = documentDigest(matrixBytes);
  if (assembled.digest !== expectedDigest) {
    return {
      ok: false,
      check: "matrix-rederivation",
      detail: `re-derived digest ${assembled.digest} !== received ${expectedDigest}`,
    };
  }
  if (assembled.bytes.length !== matrixBytes.length) {
    return {
      ok: false,
      check: "matrix-rederivation",
      detail: "re-derived matrix bytes diverge in length",
    };
  }
  for (let i = 0; i < assembled.bytes.length; i += 1) {
    if (assembled.bytes[i] !== matrixBytes[i]) {
      return {
        ok: false,
        check: "matrix-rederivation",
        detail: `re-derived matrix bytes diverge at offset ${i}`,
      };
    }
  }
  return { ok: true };
}
