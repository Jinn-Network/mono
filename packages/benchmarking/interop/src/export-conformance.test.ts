import { describeExportConformance } from "@jinn-network/benchmarking-testing";
import { exportCroissant } from "./export/croissant.js";
import { exportMatrixProjection } from "./export/matrix-projection.js";
import { exportStaticBundle } from "./export/static-bundle.js";

describeExportConformance({
  matrixProjection: exportMatrixProjection,
  croissant: exportCroissant,
  staticBundle: exportStaticBundle,
});
