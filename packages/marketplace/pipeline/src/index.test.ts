// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import * as pipeline from "./index.js";

describe("marketplace pipeline M0 scaffold", () => {
  test("exports no runtime surface before Milestone M6", () => {
    expect(Object.keys(pipeline)).toEqual([]);
  });
});
