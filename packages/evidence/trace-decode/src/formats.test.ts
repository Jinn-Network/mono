import { describe, expect, test } from "vitest";

import {
  FORMAT_IDENTITIES,
  FORMAT_IRI_PATTERN,
  formatIdentity,
  formatIriForEnvelopeFormat,
  formatIriForLegacySourceFormat,
} from "./formats.js";

describe("format identity registry", () => {
  test("every entry's IRI follows the platform format grammar", () => {
    for (const entry of FORMAT_IDENTITIES) {
      expect(entry.formatIri).toMatch(FORMAT_IRI_PATTERN);
    }
  });

  test("format IRIs and envelope formats are both unique", () => {
    expect(new Set(FORMAT_IDENTITIES.map((entry) => entry.formatIri)).size).toBe(
      FORMAT_IDENTITIES.length,
    );
    expect(
      new Set(FORMAT_IDENTITIES.map((entry) => entry.envelopeFormat)).size,
    ).toBe(FORMAT_IDENTITIES.length);
  });

  test("maps every envelope format the local backend's launchers declare", () => {
    expect(formatIriForEnvelopeFormat("claude-code-stream-json")).toBe(
      "https://jinn.network/formats/claude-code-stream-json/v1",
    );
    expect(formatIriForEnvelopeFormat("hermes-json")).toBe(
      "https://jinn.network/formats/hermes-json/v1",
    );
    expect(formatIriForEnvelopeFormat("codex-exec-json")).toBe(
      "https://jinn.network/formats/codex-exec-json/v1",
    );
    expect(formatIriForEnvelopeFormat("cursor-agent-json")).toBe(
      "https://jinn.network/formats/cursor-agent-json/v1",
    );
  });

  test("reconciles the frozen parsers' divergent source-format names", () => {
    expect(formatIriForLegacySourceFormat("hermes-session-json")).toBe(
      "https://jinn.network/formats/hermes-json/v1",
    );
    expect(formatIriForLegacySourceFormat("claude-code-stream-json")).toBe(
      "https://jinn.network/formats/claude-code-stream-json/v1",
    );
    expect(formatIriForLegacySourceFormat("codex-exec-json")).toBe(
      "https://jinn.network/formats/codex-exec-json/v1",
    );
  });

  test("returns undefined for names nothing in the tree declares", () => {
    expect(formatIriForEnvelopeFormat("stub-envelope-v1")).toBeUndefined();
    expect(formatIriForLegacySourceFormat("cursor-sqlite")).toBeUndefined();
  });

  test("classifies the supervisor-facts format as not a harness trace", () => {
    const supervisorFacts = formatIdentity(
      "https://jinn.network/formats/backend-local-supervisor-facts/v1",
    );
    expect(supervisorFacts?.harnessTrace).toBe(false);
    expect(
      FORMAT_IDENTITIES.filter((entry) => entry.harnessTrace).length,
    ).toBeGreaterThanOrEqual(4);
  });

  test("every harness-trace entry declares a media type and a description", () => {
    for (const entry of FORMAT_IDENTITIES) {
      expect(entry.mediaType.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  test("lookup by IRI round-trips", () => {
    for (const entry of FORMAT_IDENTITIES) {
      expect(formatIdentity(entry.formatIri)).toBe(entry);
    }
    expect(formatIdentity("https://example.test/formats/nope/v1")).toBeUndefined();
  });
});
