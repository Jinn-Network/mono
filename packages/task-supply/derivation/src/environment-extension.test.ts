// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { DeterministicProcessBlockSchema } from "@jinn-network/task-execution-profiles";
import {
  ENVIRONMENT_RECORD_EXTENSION_KEY,
  buildEnvironmentRecordExtension,
  readEnvironmentRecordExtension,
} from "./environment-extension.js";
import { DerivationError } from "./errors.js";

const HEX = "c".repeat(64);
const RECORD_DIGEST = `sha256:${HEX}` as const;

function blockWith(extras: Record<string, unknown>): Record<string, unknown> {
  return {
    image: {
      name: "environment-image",
      uri: "registry.example/repo@sha256:" + "d".repeat(64),
      digest: { sha256: "d".repeat(64) },
    },
    platform: "linux/amd64",
    workspace: {},
    testMaterial: [
      { name: "test-patch", mediaType: "text/x-diff", content: "ZGlmZg==", accessClass: "public" },
    ],
    parser: { id: "pytest", version: "1", digest: `sha256:${"e".repeat(64)}` },
    transitions: { failToPass: ["t::a"], passToPass: ["t::b"] },
    timeout: 900,
    ...extras,
  };
}

describe("environment-record extension key (design §7.2)", () => {
  it("is the exact string the program pins", () => {
    expect(ENVIRONMENT_RECORD_EXTENSION_KEY).toBe("network.jinn.environment.record");
  });

  it("passes the family block's namespaced-extras rule", () => {
    const block = blockWith({
      [ENVIRONMENT_RECORD_EXTENSION_KEY]: buildEnvironmentRecordExtension(RECORD_DIGEST),
    });
    expect(DeterministicProcessBlockSchema.safeParse(block).success).toBe(true);
  });

  it("shows why the namespaced form is required: a bare key is rejected", () => {
    const block = blockWith({ environmentRecord: { digest: { sha256: HEX } } });
    const result = DeterministicProcessBlockSchema.safeParse(block);
    expect(result.success).toBe(false);
  });

  it("carries bare hex, never a prefixed digest — the confusion fixture", () => {
    expect(buildEnvironmentRecordExtension(RECORD_DIGEST)).toEqual({ digest: { sha256: HEX } });
    expect(() => buildEnvironmentRecordExtension(HEX)).toThrow(DerivationError);
  });

  it("round-trips back to the prefixed record digest", () => {
    const block = blockWith({
      [ENVIRONMENT_RECORD_EXTENSION_KEY]: buildEnvironmentRecordExtension(RECORD_DIGEST),
    });
    expect(readEnvironmentRecordExtension(block)).toBe(RECORD_DIGEST);
  });

  it("refuses to read a prefixed value smuggled into the DigestSet", () => {
    const block = blockWith({
      [ENVIRONMENT_RECORD_EXTENSION_KEY]: { digest: { sha256: RECORD_DIGEST } },
    });
    expect(() => readEnvironmentRecordExtension(block)).toThrow(DerivationError);
  });

  it("refuses a block that carries no extension at all", () => {
    expect(() => readEnvironmentRecordExtension(blockWith({}))).toThrow(DerivationError);
  });
});
