import {
  assert,
  describe,
  test,
  clearStore,
  afterEach,
} from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { handleRegister } from "../src/mapping";
import { mockRegister, kv } from "./helpers";

describe("SourceBundle handler", () => {
  afterEach(() => {
    clearStore();
  });

  test("creates SourceBundle keyed by sourceBundleCid", () => {
    const measurementHex = "0x" + "ab".repeat(32);
    const metadata: ethereum.Tuple[] = [
      kv("documentType", "adw:SourceBundle"),
      kv("sourceBundleCid", "bafyBundle1"),
      kv("measurement", measurementHex),
      kv("buildRecipeKind", "dockerfile"),
      kv("humanUrl", "https://github.com/jinn/agent"),
    ];
    const event = mockRegister(
      BigInt.fromI32(20),
      Address.fromString("0x5555555555555555555555555555555555555555"),
      "ipfs://bafyBundle1",
      metadata,
    );
    handleRegister(event);
    assert.entityCount("SourceBundle", 1);
    assert.fieldEquals("SourceBundle", "bafyBundle1", "buildRecipeKind", "dockerfile");
    assert.fieldEquals("SourceBundle", "bafyBundle1", "humanUrl", "https://github.com/jinn/agent");
    assert.fieldEquals("SourceBundle", "bafyBundle1", "agent", "20");
  });

  test("defaults buildRecipeKind to dockerfile when absent", () => {
    const metadata: ethereum.Tuple[] = [
      kv("documentType", "adw:SourceBundle"),
      kv("sourceBundleCid", "bafyBundle2"),
    ];
    const event = mockRegister(
      BigInt.fromI32(21),
      Address.fromString("0x5555555555555555555555555555555555555555"),
      "ipfs://bafyBundle2",
      metadata,
    );
    handleRegister(event);
    assert.entityCount("SourceBundle", 1);
    assert.fieldEquals("SourceBundle", "bafyBundle2", "buildRecipeKind", "dockerfile");
  });

  test("skips event with missing sourceBundleCid and writes nothing", () => {
    const metadata: ethereum.Tuple[] = [
      kv("documentType", "adw:SourceBundle"),
      kv("buildRecipeKind", "nix"),
    ];
    const event = mockRegister(
      BigInt.fromI32(22),
      Address.fromString("0x5555555555555555555555555555555555555555"),
      "ipfs://...",
      metadata,
    );
    handleRegister(event);
    assert.entityCount("SourceBundle", 0);
    assert.entityCount("Agent", 0);
  });

  test("writes Agent and Metadata entities", () => {
    const metadata: ethereum.Tuple[] = [
      kv("documentType", "adw:SourceBundle"),
      kv("sourceBundleCid", "bafyBundle3"),
    ];
    const event = mockRegister(
      BigInt.fromI32(23),
      Address.fromString("0x5555555555555555555555555555555555555555"),
      "ipfs://bafyBundle3",
      metadata,
    );
    handleRegister(event);
    assert.entityCount("Agent", 1);
    assert.fieldEquals("Agent", "23", "documentType", "adw:SourceBundle");
    assert.entityCount("Metadata", 2); // documentType + sourceBundleCid
  });
});
