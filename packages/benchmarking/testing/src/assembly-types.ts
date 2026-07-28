import type { BenchmarkRecord, MatrixRecord, RunRecord } from "@jinn-network/benchmarking-records";

/**
 * The injected shape `benchmarking/run`'s `assembleMatrix` implements (design §8.3, program
 * §7.22: reads cell `attempt` fields from in-scope Submission/observation records, never
 * regenerates them). Frozen here so `run` (wave 2, M4) implements against a kit-owned type
 * rather than inventing its own; `describeAssemblyConformance` (below) is the driver that
 * exercises it against the miniature-run fixture once that fixture exists (M4territory — not
 * built in this wave, see this package's README).
 */
export type AssembleMatrixFn = (
  bench: BenchmarkRecord,
  run: RunRecord,
  injectedScope: unknown,
) => Promise<{ record: MatrixRecord; bytes: Uint8Array; digest: `sha256:${string}` }>;

/**
 * §16 assembly conformance (design §8.3): `assemble` MUST reproduce the miniature run's
 * byte-exact expected Matrix across every outcome, a replacement lineage, a multi-verdict cell,
 * and an asymmetry flag. Deferred to wave 2 (M4, `benchmarking/run`) along with the miniature-run
 * fixture itself — this wave (M1-M3) has no consumer to exercise it against, so the driver body
 * is intentionally a placeholder that fails loudly rather than silently reporting success.
 */
export function describeAssemblyConformance(_assemble: AssembleMatrixFn): void {
  throw new Error(
    "describeAssemblyConformance is not yet implemented: the miniature-run fixture (design §16) "
      + "is scoped to wave 2 (M4, benchmarking/run) — see this package's README.",
  );
}
