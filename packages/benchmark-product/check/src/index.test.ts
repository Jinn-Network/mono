// SPDX-License-Identifier: Apache-2.0

/**
 * Public-entry type surface (issue #3609). The type import fails `yarn typecheck:tests` /
 * tsc if `SupportedBundleFormat` leaves `src/index.ts`; the source pin fails vitest if the
 * re-export line is deleted while a local alias keeps the name compiling.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { SUPPORTED_BUNDLE_FORMATS } from "./index.js";
import type { SupportedBundleFormat } from "./index.js";

type PublicFormatKey = SupportedBundleFormat;

const publicFormatKey: PublicFormatKey | undefined = undefined;

describe("public entry", () => {
  test("re-exports SupportedBundleFormat beside SUPPORTED_BUNDLE_FORMATS", () => {
    expect(SUPPORTED_BUNDLE_FORMATS.length).toBeGreaterThan(0);
    expect(publicFormatKey).toBeUndefined();
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/export type \{[^}]*SupportedBundleFormat[^}]*\} from "\.\/manifest\.js"/);
  });
});
