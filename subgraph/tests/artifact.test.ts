import {
  assert,
  describe,
  test,
  clearStore,
  afterEach,
} from "matchstick-as/assembly/index";
import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts";
import { handleRegister } from "../src/mapping";
import { mockRegister, kv } from "./helpers";

function registerIntent(intentCid: string, agentId: i32): void {
  const metadata: ethereum.Tuple[] = [
    kv("documentType", "adw:Intent"),
    kv("intentCid", intentCid),
    kv("kind", "test.v0"),
  ];
  handleRegister(
    mockRegister(
      BigInt.fromI32(agentId),
      Address.fromString("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      "ipfs://" + intentCid,
      metadata,
    ),
  );
}

function registerEnvelope(envelopeCid: string, intentCid: string, agentId: i32): void {
  const metadata: ethereum.Tuple[] = [
    kv("documentType", "adw:ExecutionEnvelope"),
    kv("envelopeCid", envelopeCid),
    kv("intentCid", intentCid),
    kv("role", "restoration"),
    kv("kind", "test.v0"),
    kv("evidenceTier", "self-signed"),
  ];
  handleRegister(
    mockRegister(
      BigInt.fromI32(agentId),
      Address.fromString("0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
      "ipfs://" + envelopeCid,
      metadata,
    ),
  );
}

describe("Artifact handler", () => {
  afterEach(() => {
    clearStore();
  });

  test("creates Artifact linked to parent ExecutionEnvelope", () => {
    registerIntent("bafyIntentArt1", 200);
    registerEnvelope("bafyEnvArt1", "bafyIntentArt1", 201);
    const metadata: ethereum.Tuple[] = [
      kv("documentType", "adw:Artifact"),
      kv("artifactCid", "bafyArt1"),
      kv("parentEnvelopeCid", "bafyEnvArt1"),
      kv("artifactType", "trajectory"),
    ];
    handleRegister(
      mockRegister(
        BigInt.fromI32(202),
        Address.fromString("0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"),
        "ipfs://bafyArt1",
        metadata,
      ),
    );
    assert.entityCount("Artifact", 1);
    assert.fieldEquals("Artifact", "bafyArt1", "parentEnvelope", "bafyEnvArt1");
    assert.fieldEquals("Artifact", "bafyArt1", "artifactType", "trajectory");
  });

  test("artifact with missing parentEnvelopeCid is skipped", () => {
    const metadata: ethereum.Tuple[] = [
      kv("documentType", "adw:Artifact"),
      kv("artifactCid", "bafyArt2"),
      kv("artifactType", "log"),
      // no parentEnvelopeCid
    ];
    handleRegister(
      mockRegister(
        BigInt.fromI32(203),
        Address.fromString("0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"),
        "ipfs://bafyArt2",
        metadata,
      ),
    );
    assert.entityCount("Artifact", 0);
    assert.entityCount("Agent", 0);
  });

  test("artifact referencing unknown parent envelope is skipped", () => {
    const metadata: ethereum.Tuple[] = [
      kv("documentType", "adw:Artifact"),
      kv("artifactCid", "bafyArt3"),
      kv("parentEnvelopeCid", "bafyMissingEnvelope"),
      kv("artifactType", "evidence"),
    ];
    handleRegister(
      mockRegister(
        BigInt.fromI32(204),
        Address.fromString("0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"),
        "ipfs://bafyArt3",
        metadata,
      ),
    );
    assert.entityCount("Artifact", 0);
    assert.entityCount("Agent", 0);
  });

  test("artifact with tags splits on comma", () => {
    registerIntent("bafyIntentArt4", 205);
    registerEnvelope("bafyEnvArt4", "bafyIntentArt4", 206);
    const metadata: ethereum.Tuple[] = [
      kv("documentType", "adw:Artifact"),
      kv("artifactCid", "bafyArt4"),
      kv("parentEnvelopeCid", "bafyEnvArt4"),
      kv("artifactType", "log"),
      kv("tags", "gpu,inference,base-sepolia"),
    ];
    handleRegister(
      mockRegister(
        BigInt.fromI32(207),
        Address.fromString("0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"),
        "ipfs://bafyArt4",
        metadata,
      ),
    );
    assert.entityCount("Artifact", 1);
    assert.fieldEquals("Artifact", "bafyArt4", "artifactType", "log");
  });
});
