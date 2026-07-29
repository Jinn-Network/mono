// @jinn-network/benchmarking-testing — the benchmarking conformance kit (design §16).
// Kit-before-implementation (program §7.6): these drivers + fixtures are the executable spec
// `aggregate`/`run`/`interop` green. See README.md for which drivers are live in this wave.

export { describeRecordConformance } from "./record-conformance.js";
export {
  benchmarkingFixtureUrl,
  listBenchmarkingFixtures,
  loadBenchmarkingFixtureBytes,
  loadBenchmarkingFixtureJson,
  loadBenchmarkingFixtureText,
} from "./fixtures.js";

export { describeMethodRegistryConformance } from "./method-conformance.js";
export type {
  ComputeAvailability,
  DeclarativeParameterSchema,
  Method,
  MethodComputeInput,
  MethodReferenceSet,
  MethodRegistry,
  ParameterValidationResult,
  VerdictRuleName,
} from "./method-types.js";

export { describeOrderingConformance } from "./ordering-conformance.js";
export type { OrderingLegs } from "./ordering-conformance.js";

export { describeAssemblyConformance } from "./assembly-types.js";
export type { AssembleMatrixFn } from "./assembly-types.js";

export { describeExportConformance } from "./export-types.js";
export type { Exporters } from "./export-types.js";
