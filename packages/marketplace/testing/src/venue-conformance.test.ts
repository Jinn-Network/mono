// SPDX-License-Identifier: MIT

import { afterEach, describe } from "vitest";
import { createBaseVenue } from "@jinn-network/marketplace-venue-base";
import { describeBroadcastProfileConformance } from "./venue-broadcast-conformance.js";
import { describeLogSourceConformance } from "./venue-log-source-conformance.js";
import { describeVenueRevertClassification } from "./venue-fixtures.js";
import { describeForkVenueConformance } from "./venue-fork.js";
import { buildVenueSubjects, createBaseVenueClassifier, resetLogSourceFixture } from "./venue-subjects.js";

describe("venue-base conformance (design §6.6 -- the fresh implementation against the legacy oracles)", () => {
  describeVenueRevertClassification({
    classify: (error) => createBaseVenueClassifier()(error),
  });
  describeBroadcastProfileConformance(async () => buildVenueSubjects().broadcast());
  describeLogSourceConformance(async () => buildVenueSubjects().logSource());
  // The kit's "resumable" obligation calls `build()` twice within one test, sharing the chain
  // and state file it started with; every other test needs a genuinely fresh one.
  afterEach(() => { resetLogSourceFixture(); });
  describeForkVenueConformance(async (deployment) => buildVenueSubjects().fork(deployment, createBaseVenue));
});
