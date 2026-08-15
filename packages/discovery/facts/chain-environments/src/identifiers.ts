import {
  CHAIN_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_KIND,
} from "@jinn-network/chain-environment-record";
import { INFORMATION_WORLD_KIND } from "@jinn-network/information-world";
import { assertRecordKindUri } from "@jinn-network/record-discovery-protocol";

// Validate the record package's own constants against discovery's authoritative record-kind
// grammar. The record package is tier 2 with zero Jinn dependencies, so it cannot perform this
// check itself; the leaf carries both edges and is the right place for it. The leaf never
// hardcodes a second copy of either string.
assertRecordKindUri(CHAIN_ENVIRONMENT_KIND);
assertRecordKindUri(CRYPTO_ENVIRONMENT_KIND);
assertRecordKindUri(INFORMATION_WORLD_KIND);

export { CHAIN_ENVIRONMENT_KIND, CRYPTO_ENVIRONMENT_KIND, INFORMATION_WORLD_KIND };
