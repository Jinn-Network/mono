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

describe("Intent handler", () => {
  afterEach(() => {
    clearStore();
  });

  test("creates Intent keyed by intentCid, linked to backing Agent", () => {
    const metadata: ethereum.Tuple[] = [
      kv("documentType", "adw:Intent"),
      kv("intentCid", "bafyIntent1"),
      kv("kind", "portfolio.v0"),
      kv("creator", "0x3333333333333333333333333333333333333333"),
      kv("createdAt", "1700000000000"),
      kv("requestId", "0x" + "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"),
    ];
    const event = mockRegister(
      BigInt.fromI32(10),
      Address.fromString("0x3333333333333333333333333333333333333333"),
      "ipfs://bafyIntent1",
      metadata,
    );
    handleRegister(event);
    assert.entityCount("Intent", 1);
    assert.fieldEquals("Intent", "bafyIntent1", "kind", "portfolio.v0");
    assert.fieldEquals("Intent", "bafyIntent1", "agent", "10");
    assert.entityCount("Agent", 1);
    assert.fieldEquals("Agent", "10", "documentType", "adw:Intent");
  });

  test("skips event with missing intentCid metadata and does not write Agent", () => {
    const metadata: ethereum.Tuple[] = [
      kv("documentType", "adw:Intent"),
      kv("kind", "portfolio.v0"),
      // no intentCid
    ];
    const event = mockRegister(
      BigInt.fromI32(11),
      Address.fromString("0x3333333333333333333333333333333333333333"),
      "ipfs://...",
      metadata,
    );
    handleRegister(event);
    assert.entityCount("Intent", 0);
    assert.entityCount("Agent", 0);
  });

  test("writes default kind 'unknown' when kind metadata is absent", () => {
    const metadata: ethereum.Tuple[] = [
      kv("documentType", "adw:Intent"),
      kv("intentCid", "bafyIntent2"),
      // no kind
    ];
    const event = mockRegister(
      BigInt.fromI32(12),
      Address.fromString("0x4444444444444444444444444444444444444444"),
      "ipfs://bafyIntent2",
      metadata,
    );
    handleRegister(event);
    assert.entityCount("Intent", 1);
    assert.fieldEquals("Intent", "bafyIntent2", "kind", "unknown");
  });
});
