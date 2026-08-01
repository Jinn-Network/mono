import { describe, expect, test } from "vitest";

import {
  TRAJECTORY_MEDIA_TYPE,
  TRAJECTORY_PROTOCOL,
  TRAJECTORY_RECORD_KIND,
  TRAJECTORY_VOCABULARY_PROFILE,
} from "./identifiers.js";
import { GEN_AI_ATTRIBUTES, JINN_ATTRIBUTES, OPERATION_NAMES, VOCABULARY_UPSTREAM } from "./vocabulary.js";

describe("identifiers", () => {
  test("the record kind follows the platform URI grammar", () => {
    expect(TRAJECTORY_RECORD_KIND).toMatch(
      /^https:\/\/jinn\.network\/records\/[a-z][a-z0-9-]*\/\d+\.\d+$/,
    );
  });

  test("the media type follows the vendor-tree grammar", () => {
    expect(TRAJECTORY_MEDIA_TYPE).toBe("application/vnd.jinn.trajectory.v1+json");
  });

  test("protocol and vocabulary profile are absolute Jinn URIs", () => {
    expect(TRAJECTORY_PROTOCOL).toBe("https://jinn.network/protocols/trajectory/1.0");
    expect(TRAJECTORY_VOCABULARY_PROFILE).toBe(
      "https://jinn.network/profiles/trajectory-vocabulary/1.0",
    );
  });
});

describe("vocabulary", () => {
  test("carries the renamed provider key, not the retired one", () => {
    expect(GEN_AI_ATTRIBUTES.providerName).toBe("gen_ai.provider.name");
    expect(Object.values(GEN_AI_ATTRIBUTES)).not.toContain("gen_ai.system");
  });

  test("uses the current token-usage keys", () => {
    expect(GEN_AI_ATTRIBUTES.inputTokens).toBe("gen_ai.usage.input_tokens");
    expect(GEN_AI_ATTRIBUTES.outputTokens).toBe("gen_ai.usage.output_tokens");
  });

  test("Jinn extension keys are namespaced", () => {
    for (const key of Object.values(JINN_ATTRIBUTES)) {
      expect(key.startsWith("jinn.")).toBe(true);
    }
  });

  test("operation names include the three this profile emits", () => {
    expect(OPERATION_NAMES.chat).toBe("chat");
    expect(OPERATION_NAMES.executeTool).toBe("execute_tool");
    expect(OPERATION_NAMES.invokeAgent).toBe("invoke_agent");
  });

  test("the upstream citation pins a commit and a snapshot date", () => {
    expect(VOCABULARY_UPSTREAM.repository).toBe(
      "https://github.com/open-telemetry/semantic-conventions-genai",
    );
    expect(VOCABULARY_UPSTREAM.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(VOCABULARY_UPSTREAM.commit).not.toBe("0".repeat(40));
    expect(VOCABULARY_UPSTREAM.snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(VOCABULARY_UPSTREAM.upstreamStability).toBe("development");
  });

  test("attribute maps are frozen", () => {
    expect(Object.isFrozen(GEN_AI_ATTRIBUTES)).toBe(true);
    expect(Object.isFrozen(JINN_ATTRIBUTES)).toBe(true);
  });
});
