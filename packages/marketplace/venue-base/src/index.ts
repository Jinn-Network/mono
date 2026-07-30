// SPDX-License-Identifier: MIT

// @jinn-network/marketplace-venue-base -- public surface. Populated task by task; the facade
// `createBaseVenue` (Task 17) is the supported composition surface (program §5).
export type { BaseVenueConfig } from "./config.js";
export { VENUE_STATE_SCHEMA_VERSION, VenueStateError, openVenueState } from "./state/database.js";
export type { VenueStateDatabase } from "./state/database.js";
