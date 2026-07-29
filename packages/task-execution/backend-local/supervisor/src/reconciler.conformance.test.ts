// SPDX-License-Identifier: Apache-2.0

import { describeAttemptSupervisorContract } from "@jinn-network/task-execution-testing/backend-local";
import { foldAttemptRecord } from "./attempt-record.js";
import { runCancellationLadder } from "./cancellation.js";
import { reconcileAttempt } from "./reconciler.js";

describeAttemptSupervisorContract(() => ({
  reconcile(journal, reality) {
    const events = journal as Parameters<typeof foldAttemptRecord>[0];
    const record = foldAttemptRecord(events);
    return { ...reconcileAttempt(record, {
      processAlive: reality["processAlive"] as boolean | undefined,
      shimAlive: reality["shimFingerprintPresent"] as boolean | undefined,
      outcomePresent: reality["outcomeFilePresent"] as boolean | undefined,
      nonceMatches: reality["nonceMatches"] as boolean | undefined,
      deliveryCheckpointPresent: reality["deliveryCheckpointPresent"] as boolean | undefined,
      shimFingerprintVerifiedSurvivorsAlive: reality["shimFingerprintVerifiedSurvivorsAlive"] as boolean | undefined,
    }) };
  },
  cancel() {
    return runCancellationLadder({}, {
      signalTerm: () => undefined, signalKill: () => undefined, isSubtreeEmpty: () => true,
      readOutcome: () => null, harvest: () => undefined,
    }).then((result) => ({ ...result }));
  },
}));
