import { describeExportConformance } from "@jinn-network/benchmarking-testing";
import { exportCroissant } from "./export/croissant.js";
import { exportEvalLog } from "./export/evallog.js";
import { exportStaticBundle } from "./export/static-bundle.js";

describeExportConformance({
  evalLog: exportEvalLog,
  croissant: exportCroissant,
  staticBundle: exportStaticBundle,
});
