// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  COMPATIBLE_RECORDER_VERSION,
  RECORDER_BRIDGE_METHODS,
  RECORDER_BRIDGE_PROTOCOL,
  RECORDER_BRIDGE_VERSION,
  type RecorderBridgeRequest,
} from "./protocol.js";

describe("Recorder Bridge protocol", () => {
  test("declares the versioned hello request", () => {
    expect(RECORDER_BRIDGE_PROTOCOL).toBe(
      "jinn.execution-recorder.bridge/v1",
    );
    expect(RECORDER_BRIDGE_VERSION).toBe("0.1.0");
    expect(COMPATIBLE_RECORDER_VERSION).toBe("0.1.0");

    const request: RecorderBridgeRequest = {
      protocol: RECORDER_BRIDGE_PROTOCOL,
      id: "request-1",
      method: "hello",
      params: {},
    };
    expect(request.method).toBe("hello");
  });

  test("declares the seven Recorder-mirroring methods", () => {
    expect(RECORDER_BRIDGE_METHODS).toEqual([
      "hello",
      "start",
      "resume",
      "captureInput",
      "captureRuntimeObservation",
      "attachNativeTrace",
      "finalize",
    ]);
  });
});
