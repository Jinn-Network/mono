// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  COMPATIBLE_RECORDER_VERSION,
  RECORDER_BRIDGE_METHODS,
  RECORDER_BRIDGE_PROTOCOL,
  RECORDER_BRIDGE_VERSION,
  type RecorderBridgeRequest,
} from "./protocol.js";

function installedPackageVersion(specifier: string): string {
  const entryUrl = import.meta.resolve(specifier);
  const packageJsonUrl = new URL("../package.json", entryUrl);
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(packageJsonUrl), "utf8"),
  ) as { readonly version?: string };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error(`${specifier} has no readable package.json version.`);
  }
  return pkg.version;
}

function ownPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(
    readFileSync(join(here, "..", "package.json"), "utf8"),
  ) as { readonly version?: string };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("execution-recorder-bridge has no readable package.json version.");
  }
  return pkg.version;
}

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

  test("RECORDER_BRIDGE_VERSION matches this package's own package.json version", () => {
    expect(RECORDER_BRIDGE_VERSION).toBe(ownPackageVersion());
  });

  test("COMPATIBLE_RECORDER_VERSION matches the installed @jinn-network/execution-recorder version, so hello cannot silently misreport", () => {
    expect(COMPATIBLE_RECORDER_VERSION).toBe(
      installedPackageVersion("@jinn-network/execution-recorder"),
    );
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
