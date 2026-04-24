import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { newMockEvent } from "matchstick-as/assembly/index";
import { Register } from "../generated/IdentityRegistry/IdentityRegistry";
import {
  ValidationRequested,
  ValidationResponded,
} from "../generated/ValidationRegistry/ValidationRegistry";

export function mockRegister(
  agentId: BigInt,
  owner: Address,
  agentURI: string,
  metadata: ethereum.Tuple[],
): Register {
  const mock = changetype<Register>(newMockEvent());
  mock.parameters = new Array();
  mock.parameters.push(new ethereum.EventParam("agentId", ethereum.Value.fromUnsignedBigInt(agentId)));
  mock.parameters.push(new ethereum.EventParam("owner", ethereum.Value.fromAddress(owner)));
  mock.parameters.push(new ethereum.EventParam("agentURI", ethereum.Value.fromString(agentURI)));
  mock.parameters.push(new ethereum.EventParam("metadata", ethereum.Value.fromTupleArray(metadata)));
  return mock;
}

export function kv(key: string, value: string): ethereum.Tuple {
  const t = new ethereum.Tuple();
  t.push(ethereum.Value.fromString(key));
  t.push(ethereum.Value.fromBytes(Bytes.fromUTF8(value)));
  return t;
}

export function mockValidationRequested(
  requestId: Bytes,
  challenger: Address,
  envelopeCid: Bytes,
  scope: string,
): ValidationRequested {
  const mock = changetype<ValidationRequested>(newMockEvent());
  mock.parameters = new Array();
  mock.parameters.push(new ethereum.EventParam("requestId", ethereum.Value.fromFixedBytes(requestId)));
  mock.parameters.push(new ethereum.EventParam("challenger", ethereum.Value.fromAddress(challenger)));
  mock.parameters.push(new ethereum.EventParam("envelopeCid", ethereum.Value.fromFixedBytes(envelopeCid)));
  mock.parameters.push(new ethereum.EventParam("scope", ethereum.Value.fromString(scope)));
  return mock;
}

export function mockValidationResponded(
  responseId: Bytes,
  requestId: Bytes,
  validator: Address,
  overall: string,
  detail: string,
): ValidationResponded {
  const mock = changetype<ValidationResponded>(newMockEvent());
  mock.parameters = new Array();
  mock.parameters.push(new ethereum.EventParam("responseId", ethereum.Value.fromFixedBytes(responseId)));
  mock.parameters.push(new ethereum.EventParam("requestId", ethereum.Value.fromFixedBytes(requestId)));
  mock.parameters.push(new ethereum.EventParam("validator", ethereum.Value.fromAddress(validator)));
  mock.parameters.push(new ethereum.EventParam("overall", ethereum.Value.fromString(overall)));
  mock.parameters.push(new ethereum.EventParam("detail", ethereum.Value.fromString(detail)));
  return mock;
}
