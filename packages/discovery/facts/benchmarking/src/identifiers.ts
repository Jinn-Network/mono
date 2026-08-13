import {
  BENCHMARK_ACCOUNTING_RECORD_KIND,
  BENCHMARK_RECORD_KIND,
  MATRIX_RECORD_KIND,
  REPORT_RECORD_KIND,
  REPORT_V2_RECORD_KIND,
  RUN_RECORD_KIND,
} from "@jinn-network/benchmarking-records";
import { assertRecordKindUri } from "@jinn-network/record-discovery-protocol";

// Re-export the four benchmarking record-kind URIs after validating each
// against discovery's authoritative grammar (plan Task 6.1 / Finding F1).
// The leaf never hardcodes a second copy of these strings.

assertRecordKindUri(BENCHMARK_RECORD_KIND);
assertRecordKindUri(RUN_RECORD_KIND);
assertRecordKindUri(MATRIX_RECORD_KIND);
assertRecordKindUri(REPORT_RECORD_KIND);
assertRecordKindUri(REPORT_V2_RECORD_KIND);
assertRecordKindUri(BENCHMARK_ACCOUNTING_RECORD_KIND);

export {
  BENCHMARK_ACCOUNTING_RECORD_KIND,
  BENCHMARK_RECORD_KIND,
  MATRIX_RECORD_KIND,
  REPORT_RECORD_KIND,
  REPORT_V2_RECORD_KIND,
  RUN_RECORD_KIND,
};
