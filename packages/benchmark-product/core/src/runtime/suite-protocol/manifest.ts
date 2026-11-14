/** Product-owned suite protocol selection. TB 2.1, TB 3.0, and DeepSWE v1.1 bind via Harbor/Pier profiles; Verified, APEX-SWE-dev, and Inspect eval bind via their own selection manifests. */
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { SuiteProtocolSelectionSchema, type SuiteProtocolSelection } from "@colophon-claims/check";
import { sha256Hex } from "../../workspace/sealed-store.js";

// The coverage rule lives in the checker, which recomputes a declaring bundle's coverage word from
// its selected names (`@colophon-claims/check`, `profile/suite-coverage.ts`). Re-exported here so
// every producer in this package keeps importing it from the suite-protocol module and runs the
// one implementation the checker runs.
export { coverageFromSelectedNames, namedSliceTaskNames } from "@colophon-claims/check";
export type { SuiteCoverage } from "@colophon-claims/check";

// The schemas live in the checker, which parses the exact suite object a declaring bundle carries
// (`suite-comparability`, issue #4759). Re-exported here for the same reason as above.
export {
  SUITE_PROTOCOL_PROFILE,
  SUITE_PROTOCOL_SELECTION_ROLE,
  SUITE_PROTOCOL_SELECTION_SCHEMA,
  TerminalBench21SuiteProtocolSelectionSchema,
  TerminalBench30SuiteProtocolSelectionSchema,
  SwebenchVerifiedSuiteProtocolSelectionSchema,
  ApexAgentsSuiteProtocolSelectionSchema,
  ApexSweDevSuiteProtocolSelectionSchema,
  DeepSweV11SuiteProtocolSelectionSchema,
  InspectEvalSuiteProtocolSelectionSchema,
  SuiteProtocolSelectionSchema,
} from "@colophon-claims/check";
export type {
  SuiteProtocolSelection,
  TerminalBench21SuiteProtocolSelection,
  TerminalBench30SuiteProtocolSelection,
  SwebenchVerifiedSuiteProtocolSelection,
  ApexAgentsSuiteProtocolSelection,
  ApexSweDevSuiteProtocolSelection,
  DeepSweV11SuiteProtocolSelection,
  InspectEvalSuiteProtocolSelection,
} from "@colophon-claims/check";

export function suiteProtocolSelectionBytes(value: SuiteProtocolSelection): Uint8Array {
  return canonicalJsonBytes(SuiteProtocolSelectionSchema.parse(value) as never);
}

export function suiteProtocolSelectionSha256(value: SuiteProtocolSelection): string {
  return sha256Hex(suiteProtocolSelectionBytes(value));
}
