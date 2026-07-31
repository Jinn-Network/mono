import { ENVIRONMENT_RECORD_KIND } from "@jinn-network/environment-record";
import { assertRecordKindUri } from "@jinn-network/record-discovery-protocol";

// Validate the record package's own constant against discovery's authoritative record-kind
// grammar. The record package is tier 2 with zero Jinn dependencies, so it cannot perform
// this check itself; the leaf carries both edges and is the right place for it. The leaf
// never hardcodes a second copy of the string.
assertRecordKindUri(ENVIRONMENT_RECORD_KIND);

export { ENVIRONMENT_RECORD_KIND };
