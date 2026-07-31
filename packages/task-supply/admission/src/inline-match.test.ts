import { describe, expect, it } from "vitest";
import { checkInlineEnvironmentMatch } from "./inline-match.js";
import { AdmissionRefusalError } from "./refusals.js";

const MANIFEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const OTHER = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const PARSER = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const RECORD_DIGEST = "sha256:4444444444444444444444444444444444444444444444444444444444444444";

const record = {
  image: {
    manifestDigest: MANIFEST,
    platform: "linux/amd64",
    reference: `ghcr.io/example/env@${MANIFEST}`,
  },
  parser: { id: "pytest-log", version: "3", digest: PARSER, uri: "https://example.test/parser" },
} as never;

function spec(familyBlock: Record<string, unknown>): unknown {
  return { family: "deterministic-process", familyBlock };
}

const inlineBlock = {
  image: { uri: `ghcr.io/example/env@${MANIFEST}`, digest: { sha256: MANIFEST.slice(7) } },
  platform: "linux/amd64",
  parser: { id: "pytest-log", version: "3", digest: PARSER },
  transitions: { failToPass: ["a"], passToPass: [] },
  timeout: 1800,
};

function refusalOf(run: () => unknown): { code: string; detail: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof AdmissionRefusalError) return error.refusal;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("checkInlineEnvironmentMatch", () => {
  it("passes and reports the fields it checked when the inline block equals the record", () => {
    expect(checkInlineEnvironmentMatch(record, spec(inlineBlock), RECORD_DIGEST)).toStrictEqual({
      fields: ["image", "parser", "platform"],
      specKeyPresent: false,
    });
  });

  it("MANDATORY ADVERSARIAL FIXTURE: refuses env-record-mismatch when the inline image differs", () => {
    const refusal = refusalOf(() => checkInlineEnvironmentMatch(
      record,
      spec({ ...inlineBlock, image: { uri: `ghcr.io/example/env@${OTHER}`, digest: { sha256: OTHER.slice(7) } } }),
      RECORD_DIGEST,
    ));
    expect(refusal.code).toBe("env-record-mismatch");
    expect(refusal.detail).toContain("inline image manifest digest");
  });

  it("refuses env-record-mismatch on a platform difference", () => {
    const refusal = refusalOf(() =>
      checkInlineEnvironmentMatch(record, spec({ ...inlineBlock, platform: "linux/arm64" }), RECORD_DIGEST));
    expect(refusal.code).toBe("env-record-mismatch");
    expect(refusal.detail).toContain("platform");
  });

  it.each([
    ["id", { id: "other-parser", version: "3", digest: PARSER }],
    ["version", { id: "pytest-log", version: "4", digest: PARSER }],
    ["digest", { id: "pytest-log", version: "3", digest: OTHER }],
  ])("refuses env-record-mismatch on a parser %s difference", (_field, parser) => {
    const refusal = refusalOf(() =>
      checkInlineEnvironmentMatch(record, spec({ ...inlineBlock, parser }), RECORD_DIGEST));
    expect(refusal.code).toBe("env-record-mismatch");
    expect(refusal.detail).toContain("parser");
  });

  it("refuses env-record-mismatch when the spec's environment-record key names another record", () => {
    const refusal = refusalOf(() => checkInlineEnvironmentMatch(
      record,
      spec({ ...inlineBlock, "network.jinn.environment.record": { digest: { sha256: OTHER.slice(7) } } }),
      RECORD_DIGEST,
    ));
    expect(refusal.code).toBe("env-record-mismatch");
    expect(refusal.detail).toContain("network.jinn.environment.record");
  });

  it("reports the environment-record key when it names the record admission was given", () => {
    const report = checkInlineEnvironmentMatch(
      record,
      spec({ ...inlineBlock, "network.jinn.environment.record": { digest: { sha256: RECORD_DIGEST.slice(7) } } }),
      RECORD_DIGEST,
    );
    expect(report.specKeyPresent).toBe(true);
  });

  it("DIGEST-CONFUSION FIXTURE: refuses a sha256:-prefixed value inside the inline DigestSet", () => {
    const refusal = refusalOf(() => checkInlineEnvironmentMatch(
      record,
      spec({ ...inlineBlock, image: { uri: `ghcr.io/example/env@${MANIFEST}`, digest: { sha256: MANIFEST } } }),
      RECORD_DIGEST,
    ));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("bare lowercase hex");
  });

  it("refuses an inline image whose reference and DigestSet disagree", () => {
    const refusal = refusalOf(() => checkInlineEnvironmentMatch(
      record,
      spec({ ...inlineBlock, image: { uri: `ghcr.io/example/env@${OTHER}`, digest: { sha256: MANIFEST.slice(7) } } }),
      RECORD_DIGEST,
    ));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("disagree");
  });

  it("refuses an inline image that carries no manifest digest at all", () => {
    const refusal = refusalOf(() => checkInlineEnvironmentMatch(
      record, spec({ ...inlineBlock, image: { uri: "ghcr.io/example/env:latest" } }), RECORD_DIGEST));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("manifest digest");
  });

  it("refuses a non-deterministic-process grader family", () => {
    const refusal = refusalOf(() => checkInlineEnvironmentMatch(
      record, { family: "model-graded", familyBlock: {} }, RECORD_DIGEST));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("deterministic-process");
  });

  it("refuses a malformed inline block", () => {
    const refusal = refusalOf(() =>
      checkInlineEnvironmentMatch(record, spec({ platform: "linux/amd64" }), RECORD_DIGEST));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("inline");
  });
});
