// SPDX-License-Identifier: Apache-2.0

/**
 * The runtime's own version, reported in every health report and matched against
 * `package.json` by `health.test.ts`. Declared as a literal rather than imported from the
 * manifest so the published bundle needs no JSON module resolution and no filesystem read.
 */
export const RUNTIME_VERSION = "0.1.0";
