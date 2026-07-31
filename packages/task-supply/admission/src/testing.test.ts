import { admitCandidate } from "./admit.js";
import { verifyDifferentialAdmissionReceiptV3 } from "./receipt.js";
import {
  describeTaskAdmissionConformance,
  goldenCandidate,
  goldenEnvironmentRecordBytes,
  goldenReceipt,
  mismatchedImageCandidate,
  scriptedRunner,
} from "./testing.js";

// The kit now carries the refusal-taxonomy sweep (every code reachable, and closed) and the
// receipt round-trip itself, so a consumer running it against a substituted `admitCandidate` is
// held to the same bar this package holds itself to.
describeTaskAdmissionConformance("in-package", {
  admitCandidate,
  goldenCandidate,
  goldenEnvironmentRecordBytes,
  goldenReceipt,
  mismatchedImageCandidate,
  scriptedRunner,
  verifyReceipt: verifyDifferentialAdmissionReceiptV3,
});
