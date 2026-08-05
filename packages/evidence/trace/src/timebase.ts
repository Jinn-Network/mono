// SPDX-License-Identifier: Apache-2.0

export const TIMEBASES = ["source-epoch-ns", "synthetic-ordinal"] as const;
export type Timebase = (typeof TIMEBASES)[number];
