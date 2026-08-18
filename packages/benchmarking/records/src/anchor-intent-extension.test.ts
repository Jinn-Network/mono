import { describe, expect, test } from "vitest";
import {
  ANCHOR_INTENT_EXTENSION,
  BENCHMARK_PUBLICATION_EXTENSION,
} from "./identifiers.js";
import {
  RunAnchorIntentExtensionSchema,
  readRunAnchorIntentExtension,
  runAnchorIntentExtension,
  withRunAnchorIntentExtension,
} from "./anchor-intent-extension.js";

const RFC3161 = "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1";
const OPENTIMESTAMPS = "https://spec.jinn.network/trust/anchor-profiles/opentimestamps/v1";

describe("the anchor-intent extension key", () => {
  test("is the design §7.3 URI and is distinct from the publication extension", () => {
    expect(ANCHOR_INTENT_EXTENSION).toBe("https://spec.jinn.network/extensions/anchor-intent/v1");
    expect(ANCHOR_INTENT_EXTENSION).not.toBe(BENCHMARK_PUBLICATION_EXTENSION);
  });
});

describe("RunAnchorIntentExtensionSchema", () => {
  test("accepts a sorted, unique, non-empty provider list", () => {
    const parsed = runAnchorIntentExtension({ providers: [OPENTIMESTAMPS, RFC3161] });
    expect(parsed.providers).toEqual([OPENTIMESTAMPS, RFC3161]);
  });

  test("refuses an empty declaration — declaring nothing is not a declaration", () => {
    expect(RunAnchorIntentExtensionSchema.safeParse({ providers: [] }).success).toBe(false);
  });

  test("refuses an unsorted or duplicated provider list", () => {
    expect(RunAnchorIntentExtensionSchema.safeParse({ providers: [RFC3161, OPENTIMESTAMPS] }).success).toBe(false);
    expect(RunAnchorIntentExtensionSchema.safeParse({ providers: [RFC3161, RFC3161] }).success).toBe(false);
  });

  test("refuses a provider that is not an absolute IRI", () => {
    expect(RunAnchorIntentExtensionSchema.safeParse({ providers: ["rfc3161-tsa"] }).success).toBe(false);
  });

  test("refuses an endpoint smuggled in beside the providers", () => {
    // §7.3: profiles only, never endpoints. The object schema strips unknown keys, so the
    // assertion is that nothing survives, not that the parse throws.
    const parsed = runAnchorIntentExtension({ providers: [RFC3161], endpoint: "https://tsa.example/tsr" });
    expect(Object.keys(parsed)).toEqual(["providers"]);
  });
});

describe("withRunAnchorIntentExtension / readRunAnchorIntentExtension", () => {
  test("writes the declaration under the namespaced key and reads it back", () => {
    const record = { kind: "run", owner: "did:key:z" };
    const extended = withRunAnchorIntentExtension(record, { providers: [RFC3161] });
    expect(extended[ANCHOR_INTENT_EXTENSION]).toEqual({ providers: [RFC3161] });
    expect(readRunAnchorIntentExtension(extended)).toEqual({ providers: [RFC3161] });
  });

  test("leaves the source record untouched and coexists with the publication extension", () => {
    const record: Record<string, unknown> = {
      kind: "run",
      [BENCHMARK_PUBLICATION_EXTENSION]: { registrationArtifacts: [] },
    };
    const extended = withRunAnchorIntentExtension(record, { providers: [OPENTIMESTAMPS] });
    expect(record[ANCHOR_INTENT_EXTENSION]).toBeUndefined();
    expect(extended[BENCHMARK_PUBLICATION_EXTENSION]).toEqual({ registrationArtifacts: [] });
    expect(extended[ANCHOR_INTENT_EXTENSION]).toEqual({ providers: [OPENTIMESTAMPS] });
  });

  test("reads undefined from a record that declares nothing", () => {
    expect(readRunAnchorIntentExtension({ kind: "run" })).toBeUndefined();
  });

  test("refuses to write a declaration the schema rejects", () => {
    expect(() => withRunAnchorIntentExtension({}, { providers: [] })).toThrow();
  });

  test("refuses to read a malformed declaration rather than reporting none", () => {
    expect(() => readRunAnchorIntentExtension({ [ANCHOR_INTENT_EXTENSION]: { providers: "x" } })).toThrow();
  });
});
