// SPDX-License-Identifier: Apache-2.0

/**
 * Public-entry type surface (issue #3609). Two halves, enforced separately. The type import and
 * the annotated binding below are checked by `yarn typecheck` (`tsconfig.json`, which includes
 * `src`), a CI step of its own -- `typecheck:tests` is scoped to the `test` directory and never
 * sees this file, so the type half does not run under a local `yarn test`. They fail if
 * `SupportedBundleFormat` leaves `src/index.ts`, or if it stops covering the members of the
 * re-exported `SUPPORTED_BUNDLE_FORMATS`. The source pin below is the vitest half: it fails if
 * the re-export line is deleted while a local alias keeps the name compiling.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { SUPPORTED_BUNDLE_FORMATS } from "./index.js";
import type { SupportedBundleFormat } from "./index.js";

const publicFormats: readonly SupportedBundleFormat[] = SUPPORTED_BUNDLE_FORMATS;

describe("public entry", () => {
  test("re-exports SupportedBundleFormat beside SUPPORTED_BUNDLE_FORMATS", () => {
    // The exported name only: the public entry is the subject, not the internal module it
    // happens to re-export from today.
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/export type \{[^}]*SupportedBundleFormat/);
  });
});
