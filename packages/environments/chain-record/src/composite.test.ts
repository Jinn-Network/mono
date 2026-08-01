import { describe, expect, test } from "vitest";

import { CHAIN_ENVIRONMENT_KIND, CRYPTO_ENVIRONMENT_KIND } from "./identifiers.js";
import { cryptoEnvironmentRecordDigest } from "./hashing.js";
import {
  CryptoEnvironmentRecordSchema,
  parseCryptoEnvironmentRecord,
  sealCryptoEnvironmentRecord,
} from "./composite.js";

const INFORMATION_KIND = "https://jinn.network/records/information-world/1.0";

const chainOnly = () => ({
  kind: CRYPTO_ENVIRONMENT_KIND,
  chainWorld: { kind: CHAIN_ENVIRONMENT_KIND, record: { name: "chain", digest: { sha256: "1".repeat(64) } } },
  informationWorlds: [],
  serviceRuntimes: [],
  composition: {
    originRouting: [],
    missPolicy: { mode: "declared-response", status: 404 },
    endpointAllowlist: [],
    requestBudget: { maxRequests: 0, maxResponseBytes: 0 },
  },
});

const withWorlds = () => ({
  ...chainOnly(),
  informationWorlds: [
    { id: "llama", kind: INFORMATION_KIND, record: { name: "llama", digest: { sha256: "2".repeat(64) } } },
    { id: "docs", kind: INFORMATION_KIND, record: { name: "docs", digest: { sha256: "3".repeat(64) } } },
  ],
  serviceRuntimes: [
    {
      id: "replay",
      family: "http-replay",
      version: "0.2.0",
      image: { manifestDigest: `sha256:${"4".repeat(64)}`, platform: "linux/amd64" },
    },
  ],
  composition: {
    originRouting: [
      { origin: "https://api.llama.fi", worldId: "llama", precedence: 0 },
      { origin: "https://docs.example.test", worldId: "docs", precedence: 0 },
    ],
    missPolicy: { mode: "declared-response", status: 404 },
    endpointAllowlist: ["https://api.llama.fi", "https://docs.example.test"],
    requestBudget: { maxRequests: 200, maxResponseBytes: 8_388_608 },
  },
});

const parse = (document: unknown) => CryptoEnvironmentRecordSchema.safeParse(document);
const messages = (document: unknown) =>
  (parse(document).error?.issues ?? []).map((issue) => issue.message).join(" | ");

describe("composite crypto environment record (§4.4)", () => {
  test("a chain-only world is a composite with an empty informationWorlds list", () => {
    expect(parse(chainOnly()).success).toBe(true);
  });

  test("accepts a composite carrying two information worlds and a pinned replay runtime", () => {
    expect(parse(withWorlds()).success).toBe(true);
  });

  test("chainWorld must be the chain kind, referenced by digest", () => {
    const wrongKind = chainOnly();
    (wrongKind.chainWorld as { kind: string }).kind = INFORMATION_KIND;
    expect(parse(wrongKind).success).toBe(false);

    const noDigest = chainOnly();
    wrongKind.chainWorld.kind = CHAIN_ENVIRONMENT_KIND;
    noDigest.chainWorld.record = { uri: "https://example.test/chain.json" } as never;
    expect(parse(noDigest).success).toBe(false);
  });

  test("an information world must not claim the chain kind", () => {
    const document = withWorlds();
    document.informationWorlds[0].kind = CHAIN_ENVIRONMENT_KIND;
    expect(parse(document).success).toBe(false);
  });

  test("world ids and service-runtime ids are unique", () => {
    const worlds = withWorlds();
    worlds.informationWorlds[1].id = "llama";
    expect(parse(worlds).success).toBe(false);

    const runtimes = withWorlds();
    runtimes.serviceRuntimes.push({ ...runtimes.serviceRuntimes[0] });
    expect(parse(runtimes).success).toBe(false);
  });

  test("a route must name a declared world", () => {
    const document = withWorlds();
    document.composition.originRouting[0].worldId = "absent";
    expect(parse(document).success).toBe(false);
  });

  test("a routed origin must be on the reachable-endpoint allowlist", () => {
    const document = withWorlds();
    document.composition.endpointAllowlist = ["https://docs.example.test"];
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("allowlist");
  });
});

// The reproducibility hazard §4.4 names: two corpora claiming one origin is not a merge.
describe("origin routing and precedence (§4.4, §5.1 step 6)", () => {
  test("accepts two worlds on one origin when precedence is declared and total", () => {
    const document = withWorlds();
    document.composition.originRouting = [
      { origin: "https://api.llama.fi", worldId: "llama", precedence: 0 },
      { origin: "https://api.llama.fi", worldId: "docs", precedence: 1 },
    ];
    document.composition.endpointAllowlist = ["https://api.llama.fi"];
    expect(parse(document).success).toBe(true);
  });

  test("refuses two worlds claiming one origin at the same precedence", () => {
    const document = withWorlds();
    document.composition.originRouting = [
      { origin: "https://api.llama.fi", worldId: "llama", precedence: 0 },
      { origin: "https://api.llama.fi", worldId: "docs", precedence: 0 },
    ];
    document.composition.endpointAllowlist = ["https://api.llama.fi"];
    expect(parse(document).success).toBe(false);
    expect(messages(document)).toContain("precedence");
  });

  test("refuses the same world routed twice for one origin", () => {
    const document = withWorlds();
    document.composition.originRouting = [
      { origin: "https://api.llama.fi", worldId: "llama", precedence: 0 },
      { origin: "https://api.llama.fi", worldId: "llama", precedence: 1 },
    ];
    document.composition.endpointAllowlist = ["https://api.llama.fi"];
    expect(parse(document).success).toBe(false);
  });
});

describe("the chain-only composite really has no information plane", () => {
  test("refuses routes with no information worlds", () => {
    const document = chainOnly();
    (document.composition as { originRouting: { origin: string; worldId: string; precedence: number }[] })
      .originRouting = [{ origin: "https://api.llama.fi", worldId: "llama", precedence: 0 }];
    expect(parse(document).success).toBe(false);
  });

  test("refuses a non-zero request budget with no information worlds", () => {
    const document = chainOnly();
    document.composition.requestBudget = { maxRequests: 10, maxResponseBytes: 1024 };
    expect(parse(document).success).toBe(false);
  });

  test("requires a positive request budget once worlds are composed", () => {
    const document = withWorlds();
    document.composition.requestBudget = { maxRequests: 0, maxResponseBytes: 0 };
    expect(parse(document).success).toBe(false);
  });
});

describe("sealing", () => {
  test("seals, re-parses, and re-seals to the same digest", () => {
    const once = sealCryptoEnvironmentRecord(withWorlds());
    const twice = sealCryptoEnvironmentRecord(parseCryptoEnvironmentRecord(once));
    expect(cryptoEnvironmentRecordDigest(twice)).toBe(cryptoEnvironmentRecordDigest(once));
  });

  test("a chain-only composite and a composed one are different records", () => {
    expect(cryptoEnvironmentRecordDigest(sealCryptoEnvironmentRecord(chainOnly())))
      .not.toBe(cryptoEnvironmentRecordDigest(sealCryptoEnvironmentRecord(withWorlds())));
  });

  test("re-canonicalized bytes do not present as the same record", () => {
    const pretty = new TextEncoder().encode(JSON.stringify(chainOnly(), null, 2));
    expect(() => parseCryptoEnvironmentRecord(pretty)).toThrow();
  });
});
