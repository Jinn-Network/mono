import { describeOrderingConformance } from "@jinn-network/benchmarking-testing";

/** M4 supplies leg (c) local append-order transcript; leg (b) remains marketplace (M7). */
describeOrderingConformance({
  localAppendOrder: { runAppendedBeforeCells: true },
});
