import {
  assert,
  describe,
  test,
  clearStore,
  afterEach,
} from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { handleRegister, handleValidationRequested, handleValidationResponded } from "../src/mapping";
import { mockRegister, kv, mockValidationRequested, mockValidationResponded } from "./helpers";

// Create a bytes32 value we'll use as the envelope CID in validation events
// It needs to match the hex string used to look up ExecutionEnvelope entities.
const ENVELOPE_CID_HEX = "0x" + "aa".repeat(32);
const ENVELOPE_CID_BYTES = Bytes.fromHexString(ENVELOPE_CID_HEX);

function registerIntentAndEnvelope(): void {
  // Register Intent
  const intentMetadata: ethereum.Tuple[] = [
    kv("documentType", "adw:Intent"),
    kv("intentCid", "bafyValIntent1"),
    kv("kind", "test.v0"),
  ];
  handleRegister(
    mockRegister(
      BigInt.fromI32(400),
      Address.fromString("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      "ipfs://bafyValIntent1",
      intentMetadata,
    ),
  );

  // Register Envelope with id = ENVELOPE_CID_HEX (using envelopeCid metadata key)
  const envMetadata: ethereum.Tuple[] = [
    kv("documentType", "adw:ExecutionEnvelope"),
    kv("envelopeCid", ENVELOPE_CID_HEX),
    kv("intentCid", "bafyValIntent1"),
    kv("role", "restoration"),
    kv("kind", "test.v0"),
    kv("evidenceTier", "attested"),
  ];
  handleRegister(
    mockRegister(
      BigInt.fromI32(401),
      Address.fromString("0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
      "ipfs://env",
      envMetadata,
    ),
  );
}

const REQUEST_ID = Bytes.fromHexString("0x" + "bb".repeat(32));
const RESPONSE_ID = Bytes.fromHexString("0x" + "cc".repeat(32));
const CHALLENGER = Address.fromString("0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD");
const VALIDATOR = Address.fromString("0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE");

describe("Validation Registry handlers", () => {
  afterEach(() => {
    clearStore();
  });

  test("ValidationRequested creates ValidationRequest linked to envelope", () => {
    registerIntentAndEnvelope();
    const event = mockValidationRequested(REQUEST_ID, CHALLENGER, ENVELOPE_CID_BYTES, "attestation");
    handleValidationRequested(event);
    assert.entityCount("ValidationRequest", 1);
    assert.fieldEquals("ValidationRequest", REQUEST_ID.toHexString(), "envelope", ENVELOPE_CID_HEX);
    assert.fieldEquals("ValidationRequest", REQUEST_ID.toHexString(), "scope", "attestation");
  });

  test("ValidationRequested for unknown envelope is skipped", () => {
    const unknownCid = Bytes.fromHexString("0x" + "ff".repeat(32));
    const event = mockValidationRequested(REQUEST_ID, CHALLENGER, unknownCid, "attestation");
    handleValidationRequested(event);
    assert.entityCount("ValidationRequest", 0);
  });

  test("ValidationResponded creates ValidationResponse linked to request", () => {
    registerIntentAndEnvelope();
    // Create request first
    handleValidationRequested(
      mockValidationRequested(REQUEST_ID, CHALLENGER, ENVELOPE_CID_BYTES, "attestation"),
    );
    // Now respond
    handleValidationResponded(
      mockValidationResponded(RESPONSE_ID, REQUEST_ID, VALIDATOR, "valid", "all checks passed"),
    );
    assert.entityCount("ValidationResponse", 1);
    assert.fieldEquals("ValidationResponse", RESPONSE_ID.toHexString(), "overall", "valid");
    assert.fieldEquals("ValidationResponse", RESPONSE_ID.toHexString(), "request", REQUEST_ID.toHexString());
    assert.fieldEquals("ValidationResponse", RESPONSE_ID.toHexString(), "validator", VALIDATOR.toHexString());
  });

  test("ValidationResponded with no matching request is skipped", () => {
    const unknownReqId = Bytes.fromHexString("0x" + "ee".repeat(32));
    handleValidationResponded(
      mockValidationResponded(RESPONSE_ID, unknownReqId, VALIDATOR, "valid", ""),
    );
    assert.entityCount("ValidationResponse", 0);
  });

  test("ValidationRequest response field updated after ValidationResponded", () => {
    registerIntentAndEnvelope();
    handleValidationRequested(
      mockValidationRequested(REQUEST_ID, CHALLENGER, ENVELOPE_CID_BYTES, "reproducible-build"),
    );
    handleValidationResponded(
      mockValidationResponded(RESPONSE_ID, REQUEST_ID, VALIDATOR, "invalid", "build mismatch"),
    );
    assert.fieldEquals("ValidationRequest", REQUEST_ID.toHexString(), "response", RESPONSE_ID.toHexString());
  });
});
