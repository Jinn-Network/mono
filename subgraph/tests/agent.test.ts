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

describe("AgentCard handler", () => {
  afterEach(() => {
    clearStore();
  });

  test("creates Agent entity with documentType=adw:AgentCard", () => {
    const metadata: ethereum.Tuple[] = [
      kv("documentType", "adw:AgentCard"),
      kv("endpoint", "https://example.org/agents/1"),
      kv("ownerAddress", "0x1111111111111111111111111111111111111111"),
    ];
    const event = mockRegister(
      BigInt.fromI32(1),
      Address.fromString("0x1111111111111111111111111111111111111111"),
      "https://example.org/agents/1",
      metadata,
    );
    handleRegister(event);
    assert.entityCount("Agent", 1);
    assert.fieldEquals("Agent", "1", "documentType", "adw:AgentCard");
    assert.fieldEquals("Agent", "1", "agentURI", "https://example.org/agents/1");
  });

  test("writes per-tuple Metadata entities keyed by agentId-metadataKey", () => {
    const metadata: ethereum.Tuple[] = [
      kv("documentType", "adw:AgentCard"),
      kv("endpoint", "https://example.org/agents/2"),
    ];
    const event = mockRegister(
      BigInt.fromI32(2),
      Address.fromString("0x2222222222222222222222222222222222222222"),
      "https://example.org/agents/2",
      metadata,
    );
    handleRegister(event);
    assert.entityCount("Metadata", 2);
    assert.fieldEquals("Metadata", "2-endpoint", "metadataValueString", "https://example.org/agents/2");
  });

  test("skips event with no documentType and writes nothing", () => {
    const metadata: ethereum.Tuple[] = [
      kv("endpoint", "https://example.org/agents/3"),
    ];
    const event = mockRegister(
      BigInt.fromI32(3),
      Address.fromString("0x3333333333333333333333333333333333333333"),
      "https://example.org/agents/3",
      metadata,
    );
    handleRegister(event);
    assert.entityCount("Agent", 0);
  });
});
