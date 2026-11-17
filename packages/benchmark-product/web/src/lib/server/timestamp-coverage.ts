import "server-only";

import type { RunVerifyResult } from "@colophon-claims/core";

/** The timestamp coverage outcomes core's `run.verify` reports, read from core's own result type so
 * the verification card's names for them fail to compile when core gains an outcome (issue #5313).
 * A module that names core is server-only; the card is a client component and imports this
 * type-only, so nothing of it reaches the browser bundle. */
export type TimestampCoverageOutcome = NonNullable<RunVerifyResult["anchors"]>["subjects"][number]["outcome"];
