// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";

// The recorder cases fsync real files, so a stalled disk can hold an ordinary case for several
// seconds. `vitest.config.ts` sets the limit those cases run under; this fails if it is dropped
// and the 5 second Vitest default comes back (#4982).
test("recorder cases run under a limit that outlasts a stalled disk", ({
  task,
}) => {
  expect(task.timeout).toBeGreaterThanOrEqual(30_000);
});
