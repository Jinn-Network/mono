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
      expect(kind).toMatch(/^https:\/\/jinn\.network\/records\/[a-z0-9]+(?:-[a-z0-9]+)*\/\d+\.\d+$/);
    }
  });

  test("the blackhole egress policy id is a stable versioned identifier", () => {
    expect(BLACKHOLE_EGRESS_POLICY_ID).toBe("jinn.egress.blackhole/1");
  });
});
