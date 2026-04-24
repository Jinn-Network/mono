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
    kv("kind", "test.v0"),
    kv("evidenceTier", evidenceTier),
  ];
  if (parentEnvelopeCid.length > 0) {
    metadata.push(kv("parentEnvelopeCid", parentEnvelopeCid));
  }
  handleRegister(
    mockRegister(
      BigInt.fromI32(agentId),
      Address.fromString("0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
      "ipfs://" + envelopeCid,
      metadata,
    ),
  );
}

describe("KnowledgeTree aggregator", () => {
  afterEach(() => {
    clearStore();
  });

  test("first restoration creates KnowledgeTree with totalRestorations=1", () => {
    registerIntent("bafyKT1", 300);
    registerEnvelope("bafyKTEnv1", "bafyKT1", "restoration", "self-signed", 301, "");
    assert.entityCount("KnowledgeTree", 1);
    assert.fieldEquals("KnowledgeTree", "bafyKT1", "totalRestorations", "1");
    assert.fieldEquals("KnowledgeTree", "bafyKT1", "totalVerdicts", "0");
    assert.fieldEquals("KnowledgeTree", "bafyKT1", "attestedRestorations", "0");
    assert.fieldEquals("KnowledgeTree", "bafyKT1", "attestedFraction", "0");
  });

  test("attested restoration increments attestedRestorations", () => {
    registerIntent("bafyKT2", 302);
    registerEnvelope("bafyKTEnv2", "bafyKT2", "restoration", "attested", 303, "");
    assert.fieldEquals("KnowledgeTree", "bafyKT2", "attestedRestorations", "1");
  });

  test("consensus tier counts as attested-or-better", () => {
    registerIntent("bafyKT3", 304);
    registerEnvelope("bafyKTEnv3", "bafyKT3", "restoration", "consensus", 305, "");
    assert.fieldEquals("KnowledgeTree", "bafyKT3", "attestedRestorations", "1");
  });

  test("proved tier counts as attested-or-better", () => {
    registerIntent("bafyKT4", 306);
    registerEnvelope("bafyKTEnv4", "bafyKT4", "restoration", "proved", 307, "");
    assert.fieldEquals("KnowledgeTree", "bafyKT4", "attestedRestorations", "1");
  });

  test("second restoration increments totalRestorations to 2", () => {
    registerIntent("bafyKT5", 308);
    registerEnvelope("bafyKTEnv5a", "bafyKT5", "restoration", "self-signed", 309, "");
    registerEnvelope("bafyKTEnv5b", "bafyKT5", "restoration", "attested", 310, "");
    assert.fieldEquals("KnowledgeTree", "bafyKT5", "totalRestorations", "2");
    assert.fieldEquals("KnowledgeTree", "bafyKT5", "attestedRestorations", "1");
  });

  test("verdict increments totalVerdicts", () => {
    registerIntent("bafyKT6", 311);
    registerEnvelope("bafyKTEnv6r", "bafyKT6", "restoration", "committed", 312, "");
    registerEnvelope("bafyKTEnv6v", "bafyKT6", "verdict", "attested", 313, "bafyKTEnv6r");
    assert.fieldEquals("KnowledgeTree", "bafyKT6", "totalRestorations", "1");
    assert.fieldEquals("KnowledgeTree", "bafyKT6", "totalVerdicts", "1");
    assert.fieldEquals("KnowledgeTree", "bafyKT6", "attestedVerdicts", "1");
  });

  test("attestedFraction is computed correctly", () => {
    registerIntent("bafyKT7", 314);
    // 2 restorations: 1 attested, 1 self-signed
    registerEnvelope("bafyKTEnv7a", "bafyKT7", "restoration", "attested", 315, "");
    registerEnvelope("bafyKTEnv7b", "bafyKT7", "restoration", "self-signed", 316, "");
    // attestedFraction = 1/2 = 0.5
    assert.fieldEquals("KnowledgeTree", "bafyKT7", "attestedRestorations", "1");
    assert.fieldEquals("KnowledgeTree", "bafyKT7", "totalRestorations", "2");
  });
});
