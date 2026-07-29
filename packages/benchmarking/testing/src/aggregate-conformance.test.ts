import { BENCHMARKING_METHOD_REGISTRY } from "@jinn-network/benchmarking-aggregate";
import { describe } from "vitest";
import { describeMethodRegistryConformance } from "./method-conformance.js";
import type { MethodRegistry } from "./method-types.js";

/**
 * Program §7.25: the kit consumes its concrete subject, never vice versa. Stage 1 freezes the
 * strengthened oracle while stage 2 repairs aggregate; enable this suite in that stage.
 */
const describeAggregate = process.env["BENCHMARKING_AGGREGATE_CONFORMANCE"] === "1"
  ? describe
  : describe.skip;

describeAggregate("aggregate method conformance (enabled by review fix stage 2)", () => {
  // The kit lands before the repaired consumer. Keep the adapter compiling while the opt-in
  // runtime suite supplies the intentional RED proof against the previous aggregate surface.
  describeMethodRegistryConformance(BENCHMARKING_METHOD_REGISTRY as unknown as MethodRegistry);
});
