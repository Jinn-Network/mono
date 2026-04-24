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
  const event = mockRegister(
    BigInt.fromI32(agentId),
    Address.fromString("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    "ipfs://" + intentCid,
    metadata,
  );
  handleRegister(event);
}

function registerEnvelope(
  envelopeCid: string,
  intentCid: string,
  role: string,
  evidenceTier: string,
  agentId: i32,
  parentEnvelopeCid: string,
): void {
  const metadata: ethereum.Tuple[] = [
    kv("documentType", "adw:ExecutionEnvelope"),
    kv("envelopeCid", envelopeCid),
    kv("intentCid", intentCid),
    kv("role", role),
    kv("kind", "restoration.v0"),
    kv("evidenceTier", evidenceTier),
  ];
  if (parentEnvelopeCid.length > 0) {
    metadata.push(kv("parentEnvelopeCid", parentEnvelopeCid));
  }
  const event = mockRegister(
    BigInt.fromI32(agentId),
    Address.fromString("0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
    "ipfs://" + envelopeCid,
    metadata,
  );
  handleRegister(event);
}

describe("ExecutionEnvelope handler", () => {
  afterEach(() => {
    clearStore();
  });

  test("restoration envelope happy path — creates envelope linked to intent", () => {
    registerIntent("bafyIntentA", 100);
    registerEnvelope("bafyEnvA1", "bafyIntentA", "restoration", "self-signed", 101, "");
    assert.entityCount("ExecutionEnvelope", 1);
    assert.fieldEquals("ExecutionEnvelope", "bafyEnvA1", "intent", "bafyIntentA");
    assert.fieldEquals("ExecutionEnvelope", "bafyEnvA1", "role", "restoration");
    assert.fieldEquals("ExecutionEnvelope", "bafyEnvA1", "evidenceTier", "self-signed");
  });

  test("restoration creates KnowledgeTree with totalRestorations=1", () => {
    registerIntent("bafyIntentB", 102);
    registerEnvelope("bafyEnvB1", "bafyIntentB", "restoration", "attested", 103, "");
    assert.entityCount("KnowledgeTree", 1);
    assert.fieldEquals("KnowledgeTree", "bafyIntentB", "totalRestorations", "1");
    assert.fieldEquals("KnowledgeTree", "bafyIntentB", "attestedRestorations", "1");
    assert.fieldEquals("KnowledgeTree", "bafyIntentB", "totalVerdicts", "0");
  });

  test("verdict links to parent restoration envelope", () => {
    registerIntent("bafyIntentC", 104);
    registerEnvelope("bafyEnvC1", "bafyIntentC", "restoration", "committed", 105, "");
    registerEnvelope("bafyEnvC2", "bafyIntentC", "verdict", "attested", 106, "bafyEnvC1");
    assert.entityCount("ExecutionEnvelope", 2);
    assert.fieldEquals("ExecutionEnvelope", "bafyEnvC2", "parentEnvelope", "bafyEnvC1");
    assert.fieldEquals("ExecutionEnvelope", "bafyEnvC2", "role", "verdict");
  });

  test("verdict with missing parent envelope is skipped", () => {
    registerIntent("bafyIntentD", 107);
    registerEnvelope("bafyEnvD1", "bafyIntentD", "verdict", "attested", 108, "bafyMissingParent");
    assert.entityCount("ExecutionEnvelope", 0);
  });

  test("envelope with unknown intentCid is skipped", () => {
    // No intent registered
    registerEnvelope("bafyEnvE1", "bafyMissingIntent", "restoration", "self-signed", 109, "");
    assert.entityCount("ExecutionEnvelope", 0);
    assert.entityCount("Agent", 0);
  });

  test("envelope missing required fields is skipped", () => {
    registerIntent("bafyIntentF", 110);
    // Missing envelopeCid
    const metadata: ethereum.Tuple[] = [
      kv("documentType", "adw:ExecutionEnvelope"),
      kv("intentCid", "bafyIntentF"),
      kv("role", "restoration"),
      kv("kind", "test.v0"),
      // no evidenceTier
    ];
    const event = mockRegister(
      BigInt.fromI32(111),
      Address.fromString("0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
      "ipfs://env",
      metadata,
    );
    handleRegister(event);
    assert.entityCount("ExecutionEnvelope", 0);
  });

  test("KnowledgeTree totalVerdicts increments on verdict", () => {
    registerIntent("bafyIntentG", 112);
    registerEnvelope("bafyEnvG1", "bafyIntentG", "restoration", "self-signed", 113, "");
    registerEnvelope("bafyEnvG2", "bafyIntentG", "verdict", "attested", 114, "bafyEnvG1");
    assert.fieldEquals("KnowledgeTree", "bafyIntentG", "totalRestorations", "1");
    assert.fieldEquals("KnowledgeTree", "bafyIntentG", "totalVerdicts", "1");
    assert.fieldEquals("KnowledgeTree", "bafyIntentG", "attestedVerdicts", "1");
  });
});
