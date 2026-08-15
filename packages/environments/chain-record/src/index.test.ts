import { describe, expect, test } from "vitest";

import * as api from "./index.js";

/** Program §3, "CE1 produces". Renaming any of these is a program-plan amendment. */
const PINNED = [
  "CHAIN_ENVIRONMENT_KIND",
  "CHAIN_ENVIRONMENT_MEDIA_TYPE",
  "CRYPTO_ENVIRONMENT_KIND",
  "CRYPTO_ENVIRONMENT_MEDIA_TYPE",
  "sealChainEnvironmentRecord",
  "parseChainEnvironmentRecord",
  "chainEnvironmentRecordDigest",
  "sealCryptoEnvironmentRecord",
  "parseCryptoEnvironmentRecord",
  "cryptoEnvironmentRecordDigest",
  "bareHexDigest",
] as const;

describe("public surface", () => {
  test("exports every pinned name from the program plan", () => {
    for (const name of PINNED) expect(api, name).toHaveProperty(name);
  });

  test("exports the block schemas consumers validate against", () => {
    for (const name of [
      "ChainEnvironmentRecordSchema", "CryptoEnvironmentRecordSchema", "ChainRuntimeSchema",
      "ChainSourceAnchorSchema", "ChainStateMaterializationSchema", "ChainFixturesSchema",
      "DeterminismControlsSchema", "CapabilityEnvelopeSchema", "VerificationContractSchema",
      "CompositionSchema", "WorldReferenceSchema", "InformationWorldReferenceSchema",
      "ServiceRuntimeSchema", "ChainSolutionScriptSchema", "ResourceDescriptorSchema",
      "DigestPinnedDescriptorSchema",
    ]) {
      expect(api, name).toHaveProperty(name);
    }
  });

  test("exports the closed vocabularies and the pinned constants", () => {
    for (const name of [
      "RUNTIME_FAMILIES", "CLOSURE_CLASSES", "FIDELITY_CLASSES", "CONSTRUCTION_METHODS",
      "DURABLE_SUPPLY_CLOSURE_CLASS", "FIXTURE_MODULE_KINDS", "MINING_MODES", "RESET_MECHANISMS",
      "FINALITY_POLICIES", "SOLUTION_OPERATION_KINDS", "MINIMUM_VERIFICATION_RUNS",
      "BLACKHOLE_EGRESS_POLICY_ID", "CHAIN_SOLUTION_MEDIA_TYPE", "WELL_KNOWN_DEV_ADDRESSES",
      "CHAIN_ENVIRONMENT_SCHEMA_ID", "CRYPTO_ENVIRONMENT_SCHEMA_ID",
    ]) {
      expect(api, name).toHaveProperty(name);
    }
  });

  test("exports the sealing primitives and the digest-conversion pair", () => {
    for (const name of [
      "serializeCanonicalJson", "compareCodeUnitStrings", "sha256Hex", "sealedRecordDigest",
      "prefixedDigest", "InvalidDocumentError", "sealWithSchema", "parseExactWithSchema",
      "isNamespacedExtensionKey", "topLevelRecordSchema", "anchorAuthenticityBoundOf",
      "isWellKnownDevAddress", "sealChainSolutionScript", "parseChainSolutionScript",
    ]) {
      expect(api, name).toHaveProperty(name);
    }
  });

  test("the two seal functions return bytes whose digests differ by kind", () => {
    // Minimal-but-real: a chain-only composite needs nothing but its own block.
    const composite = api.sealCryptoEnvironmentRecord({
      kind: api.CRYPTO_ENVIRONMENT_KIND,
      chainWorld: {
        kind: api.CHAIN_ENVIRONMENT_KIND,
        record: { name: "chain", digest: { sha256: "1".repeat(64) } },
      },
      informationWorlds: [],
      serviceRuntimes: [],
      composition: {
        originRouting: [],
        missPolicy: { mode: "declared-response", status: 404 },
        endpointAllowlist: [],
        requestBudget: { maxRequests: 0, maxResponseBytes: 0 },
      },
    });
    expect(composite).toBeInstanceOf(Uint8Array);
    expect(api.cryptoEnvironmentRecordDigest(composite)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("does not leak the testing kit or the fixture loaders through the root entrypoint", () => {
    expect(api).not.toHaveProperty("describeChainEnvironmentRecordConformance");
    expect(api).not.toHaveProperty("loadChainGoldenBytes");
  });

  test("the ports module contributes types only, so no port value appears on the surface", () => {
    for (const name of ["ChainMaterializer", "ProbeExecutor", "ScriptReplayer"]) {
      expect(api, name).not.toHaveProperty(name);
    }
  });
});
