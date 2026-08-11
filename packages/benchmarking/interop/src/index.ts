// @jinn-network/benchmarking-interop — importers + exporters (design §6.5, §10.1–.2, §14.9).
// Depends on records + profiles + protocol only. Never imports benchmarking-run.

export {
  defineBenchmark,
  importSweBench,
} from "./import/swebench.js";
export type {
  DefineBenchmarkOptions,
  ImportedBenchmark,
  SealedTask,
  SweBenchRow,
} from "./import/swebench.js";

export { exportCroissant } from "./export/croissant.js";
export type { CroissantDocument, CroissantFileObject } from "./export/croissant.js";

export { exportMatrixProjection } from "./export/matrix-projection.js";
export type {
  EvidenceResolver,
  MatrixProjection,
  MatrixProjectionSample,
} from "./export/matrix-projection.js";

export { exportStaticBundle } from "./export/static-bundle.js";
export type { StaticBundle } from "./export/static-bundle.js";
