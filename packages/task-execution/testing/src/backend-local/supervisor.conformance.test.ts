// SPDX-License-Identifier: Apache-2.0

import { foldAttemptRecord, reconcileAttempt, runCancellationLadder } from "@jinn-network/task-execution-supervisor";
import { describeAttemptSupervisorContract } from "./supervisor-contract.js";

describeAttemptSupervisorContract(() => ({
  reconcile(journal, reality) {
    const events = journal as Parameters<typeof foldAttemptRecord>[0];
    return { ...reconcileAttempt(foldAttemptRecord(events), {
      processAlive: reality["processAlive"] as boolean | undefined,
      shimAlive: reality["shimFingerprintPresent"] as boolean | undefined,
      outcomePresent: reality["outcomeFilePresent"] as boolean | undefined,
      nonceMatches: reality["nonceMatches"] as boolean | undefined,
      deliveryCheckpointPresent: reality["deliveryCheckpointPresent"] as boolean | undefined,
      shimFingerprintVerifiedSurvivorsAlive: reality["shimFingerprintVerifiedSurvivorsAlive"] as boolean | undefined,
    }) };
  },
  cancel() {
    return runCancellationLadder({}, { signalTerm: () => undefined, signalKill: () => undefined, isSubtreeEmpty: () => true, readOutcome: () => null, harvest: () => undefined }).then((result) => ({ ...result }));
  },
}));
