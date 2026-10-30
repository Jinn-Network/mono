// SPDX-License-Identifier: Apache-2.0

import { EVIDENCE_KINDS } from "./evidence.js";
import type { RecordKinds } from "./kind.js";
import { PROFILE_KINDS } from "./profiles.js";
import { TASK_EXECUTION_KINDS } from "./task-execution.js";
import { TRUST_KINDS } from "./trust.js";

/**
 * Every kind this package knows, keyed by the spec's type identifier. Add one by spreading this into
 * the `kinds` option. Record discovery's entries and heads are not here: a feed is verified as a
 * chain, by `@jinn-network/record-discovery-client`, and they report as unknown.
 */
export const defaultRecordKinds: RecordKinds = {
  ...TASK_EXECUTION_KINDS,
  ...EVIDENCE_KINDS,
  ...TRUST_KINDS,
  ...PROFILE_KINDS,
};

export { OBSERVATION_KIND } from "./task-execution.js";
export type { RecordAttribution, RecordKind, RecordKinds, RecordReference } from "./kind.js";
