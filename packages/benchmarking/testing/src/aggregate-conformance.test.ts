import { BENCHMARKING_METHOD_REGISTRY } from "@jinn-network/benchmarking-aggregate";
import { describeMethodRegistryConformance } from "./method-conformance.js";

/**
 * Program §7.25: the kit consumes its concrete subject, never vice versa. This is an ordinary,
 * mandatory testing-package suite: no environment opt-in may make M1–M3 conformance vacuous.
 */
describeMethodRegistryConformance(BENCHMARKING_METHOD_REGISTRY);
