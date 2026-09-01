// SPDX-License-Identifier: MIT

import { OFFER_RECORD_KIND } from "@jinn-network/evidence-offer";
import { assertRecordKindUri } from "@jinn-network/record-discovery-protocol";

// Validate the record package's own constant against discovery's authoritative record-kind
// grammar. `@jinn-network/evidence-offer` deliberately takes no discovery dependency, so it
// cannot perform this check itself; the leaf carries both edges and is the right place for
// it. The leaf never hardcodes a second copy of the string.
assertRecordKindUri(OFFER_RECORD_KIND);

export { OFFER_RECORD_KIND };
