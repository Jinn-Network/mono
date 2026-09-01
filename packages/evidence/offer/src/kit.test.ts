import { describeOfferRecordConformance } from "./testing.js";

// The package runs its own published conformance kit, exactly as a third-party producer or
// consumer would. A kit that only ever ran downstream could drift from this implementation.
describeOfferRecordConformance();
