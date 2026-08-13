import {
  documentDigest,
  readMatrixPublicationExtension,
  type BenchmarkRecord,
  type MatrixRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import {
  assembleMatrix,
  assembleMatrixV2,
  MatrixV2AssemblyError,
  type BenchmarkAccountingInput,
} from "./assemble.js";
import type { AssemblyPorts, AssemblyProcedure, MatrixV2AssemblyPorts } from "./ports.js";

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

/**
 * Verify an accounted Matrix procedure 2.0 record from exact Matrix and BenchmarkAccounting
 * bytes. V1 verification remains unchanged above; this path requires the v2 accounting ports.
 */
export async function verifyMatrixV2(
  matrix: MatrixRecord,
  bench: BenchmarkRecord,
  run: RunRecord,
  ports: MatrixV2AssemblyPorts,
  accountingInput: BenchmarkAccountingInput,
  matrixBytes: Uint8Array,
): Promise<VerifyMatrixResult> {
  if (!(matrixBytes instanceof Uint8Array) || matrixBytes.length === 0) {
    return {
      ok: false,
      check: "matrix-rederivation",
      detail: "exact matrix bytes are required for verifyMatrixV2",
    };
  }
  if (matrix.assembly.procedure !== "jinn.benchmarking.assembly" || matrix.assembly.version !== "2.0") {
    return {
      ok: false,
      check: "matrix-assembly-v2",
      detail: "verifyMatrixV2 requires jinn.benchmarking.assembly@2.0",
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
  try {
    const assembled = await assembleMatrixV2(bench, run, ports, accountingInput);
    let extension;
    try {
      extension = readMatrixPublicationExtension(matrix as Record<string, unknown>);
    } catch (error) {
      return {
        ok: false,
        check: "matrix-accounting-extension",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (extension === undefined) {
      return {
        ok: false,
        check: "matrix-accounting-extension",
        detail: "Matrix assembly v2 requires the benchmark-publication accounting extension",
      };
    }
    const accountingDigest = documentDigest(accountingInput.bytes).slice("sha256:".length);
    if (extension.accounting.digest.sha256 !== accountingDigest) {
      return {
        ok: false,
        check: "matrix-accounting-binding",
        detail: "Matrix accounting extension does not name the supplied exact BenchmarkAccounting bytes",
      };
    }
    const expectedDigest = documentDigest(matrixBytes);
    if (assembled.digest !== expectedDigest || !sameBytes(assembled.bytes, matrixBytes)) {
      return {
        ok: false,
        check: "matrix-rederivation",
        detail: `re-derived digest ${assembled.digest} !== received ${expectedDigest}`,
      };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof MatrixV2AssemblyError) {
      return { ok: false, check: error.check, detail: error.message };
    }
    throw error;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
