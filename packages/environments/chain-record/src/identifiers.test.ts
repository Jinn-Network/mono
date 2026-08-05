import { describe, expect, test } from "vitest";

import {
  BLACKHOLE_EGRESS_POLICY_ID,
  CHAIN_ENVIRONMENT_KIND,
  CHAIN_ENVIRONMENT_MEDIA_TYPE,
  CHAIN_ENVIRONMENT_SCHEMA_ID,
  CRYPTO_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_MEDIA_TYPE,
  CRYPTO_ENVIRONMENT_SCHEMA_ID,
} from "./identifiers.js";

// DUAL-ACCEPT (DR-2026-08-04 transition window): canonical
// `https://spec.jinn.network/records/<segment>/v<major>` and the legacy
// `https://jinn.network/records/<segment>/<major>.<minor>` this constant still
// spells. Reference implementation: packages/discovery/protocol/src/origins.ts.
// Component C2 narrows this to the canonical arm once the re-seal has landed.
const RECORD_KIND_GRAMMAR = /^https:\/\/(?:spec\.)?jinn\.network\/records\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:v[1-9]\d*|\d+\.\d+)$/;

describe("pinned identifiers (design §4.1, §14)", () => {
  test("the kind URIs are exactly the design's strings", () => {
    expect(CHAIN_ENVIRONMENT_KIND).toBe("https://jinn.network/records/chain-environment/1.0");
    expect(CRYPTO_ENVIRONMENT_KIND).toBe("https://jinn.network/records/crypto-environment/1.0");
  });

  test("the media types are exactly the design's strings", () => {
    expect(CHAIN_ENVIRONMENT_MEDIA_TYPE).toBe("application/vnd.jinn.chain-environment.v1+json");
    expect(CRYPTO_ENVIRONMENT_MEDIA_TYPE).toBe("application/vnd.jinn.crypto-environment.v1+json");
  });

  test("schema ids hang off their kind URIs", () => {
    expect(CHAIN_ENVIRONMENT_SCHEMA_ID).toBe(`${CHAIN_ENVIRONMENT_KIND}/schema`);
    expect(CRYPTO_ENVIRONMENT_SCHEMA_ID).toBe(`${CRYPTO_ENVIRONMENT_KIND}/schema`);
  });

  // Mirrored here because this package declares no Jinn dependency and so cannot call
  // discovery's own `assertRecordKindUri`; the facts leaf does that for real (Task 17).
  test("both kinds satisfy discovery's record-kind URI grammar", () => {
    for (const kind of [CHAIN_ENVIRONMENT_KIND, CRYPTO_ENVIRONMENT_KIND]) {
      expect(kind).toMatch(RECORD_KIND_GRAMMAR);
    }
  });

  test("the blackhole egress policy id is a stable versioned identifier", () => {
    expect(BLACKHOLE_EGRESS_POLICY_ID).toBe("jinn.egress.blackhole/1");
  });

  // The mirrored grammar must already accept the spelling the re-seal will mint, because
  // C1's wave flips this package's constants and nothing else may need to move with them.
  // No constant here uses the canonical arm yet, so only this asserts it.
  test("the mirrored grammar accepts the canonical re-seal spelling", () => {
    expect("https://spec.jinn.network/records/chain-environment/v1").toMatch(RECORD_KIND_GRAMMAR);
    expect("https://spec.jinn.network/records/chain-environment/v2").toMatch(RECORD_KIND_GRAMMAR);
    expect("https://jinn.network/records/chain-environment/1.0").toMatch(RECORD_KIND_GRAMMAR);
    for (const rejected of [
      "https://spec.jinn.network/records/chain-environment/v0",
      "https://spec.jinn.network/records/chain-environment/1",
      "https://spec.jinn.network/records/chain-environment/v1/facts/v1",
      "https://evil.jinn.network/records/chain-environment/v1",
      "https://jinn.network.evil.example/records/chain-environment/v1",
    ]) {
      expect(rejected).not.toMatch(RECORD_KIND_GRAMMAR);
    }
  });
});
