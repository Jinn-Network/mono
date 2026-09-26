// SPDX-License-Identifier: Apache-2.0

/**
 * Public-entry type surface (issue #3609). Two halves, enforced separately. The type import and
 * the annotated binding below are checked by `yarn typecheck` (`tsconfig.json`, which includes
 * `src`); CI runs it for this package before `yarn test` -- `typecheck:tests` is scoped to the
 * `test` directory and never sees this file, so the type half does not run under a local
 * `yarn test`. They fail if `SupportedBundleFormat` leaves `src/index.ts`, or if it stops
 * covering the members of the re-exported `SUPPORTED_BUNDLE_FORMATS`. The source pin below is
 * the vitest half: it fails if the re-export line is deleted while a local alias keeps the name
 * compiling.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { SUPPORTED_BUNDLE_FORMATS } from "./index.js";
import type { SupportedBundleFormat } from "./index.js";

describe("public entry", () => {
  test("re-exports SupportedBundleFormat beside SUPPORTED_BUNDLE_FORMATS", () => {
    // The annotation is the type half, and the assertion keeps it live code: an unreferenced
    // binding reads as dead and is the obvious thing a later edit -- or `noUnusedLocals` --
    // deletes, taking the guard with it.
    const publicFormats: readonly SupportedBundleFormat[] = SUPPORTED_BUNDLE_FORMATS;
    expect(publicFormats.length).toBeGreaterThan(0);

    // Any re-export source: the public entry is the subject, not the internal module it happens
    // to re-export from today. The `from` clause stays required, because a bare
    // `export type { SupportedBundleFormat }` over a local alias is exactly the evasion this
    // pin exists to catch.
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/export type \{[^}]*SupportedBundleFormat[^}]*\} from "/);
  });
});
