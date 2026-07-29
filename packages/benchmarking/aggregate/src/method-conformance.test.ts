import { describeMethodRegistryConformance } from "@jinn-network/benchmarking-testing";
import { createMethodRegistry } from "./registry.js";

// The kit's RED-until-M3 driver (design §16, plan Task 2.4/3.3): greens here, over this
// package's real method registry, against the independently-computed fixtures in
// benchmarking-testing/fixtures/methods/*.json.
describeMethodRegistryConformance(createMethodRegistry());
