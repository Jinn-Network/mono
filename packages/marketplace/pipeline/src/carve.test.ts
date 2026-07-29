// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  carveOwnerForFailed,
  TASK_ENGINE_CARVE,
  TASK_ENGINE_FAILED_CARVE,
} from "./carve.js";

describe("TASK_ENGINE_CARVE", () => {
  test("matches the design §9 disposition table exactly", () => {
    expect(TASK_ENGINE_CARVE).toEqual({
      DISCOVERED: "pipeline",
      CLAIMED: "pipeline",
      WAITING: "pipeline",
      PRE_SNAPSHOT: "embedded-backend",
      RUNNING: "embedded-backend",
      POST_SNAPSHOT: "embedded-backend",
      PACKAGING: "embedded-backend",
      DELIVERING: "binding",
      COMPLETE: "binding",
      AWAITING_ADOPTION: "application",
      CLAIMING_DELIVERY: "application",
      RACE_LOST: "binding",
    });
  });

  test("splits FAILED by backend-vs-venue cause instead of flattening states", () => {
    expect(TASK_ENGINE_FAILED_CARVE).toEqual({
      backend: "embedded-backend",
      venue: "binding",
    });
    expect(carveOwnerForFailed("backend")).toBe("embedded-backend");
    expect(carveOwnerForFailed("venue")).toBe("binding");
  });
});
