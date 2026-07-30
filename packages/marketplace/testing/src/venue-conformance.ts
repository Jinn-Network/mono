// SPDX-License-Identifier: MIT

// The venue conformance kit (operator-daemon composition design §6.6). Subject-parameterized:
// this module imports nothing from `@jinn-network/marketplace-venue-base`, so the kit compiles
// and its fixtures are authoritative before the implementation exists.
export {
  VENUE_REVERT_FIXTURES,
  describeVenueRevertClassification,
} from "./venue-fixtures.js";
export type {
  VenueRevertClassification,
  VenueRevertClassifier,
  VenueRevertFixture,
} from "./venue-fixtures.js";
