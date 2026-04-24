import { log, Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { Register } from "../../generated/IdentityRegistry/IdentityRegistry";
import { Agent, Intent, Metadata } from "../../generated/schema";
import { MetadataPair, getMetadataString } from "../lib/metadata";

export function handleIntentImpl(event: Register, pairs: MetadataPair[]): void {
  const intentCid = getMetadataString(pairs, "intentCid");
  if (intentCid == null) {
    log.warning("adw:Intent without intentCid metadata — skipping agent {}", [event.params.agentId.toString()]);
    return;
  }

  const agentId = event.params.agentId.toString();
  const agent = new Agent(agentId);
  agent.agentURI = event.params.agentURI;
  agent.owner = event.params.owner;
  agent.documentType = "adw:Intent";
  agent.createdAt = event.block.timestamp;
  agent.createdAtBlock = event.block.number;
  agent.createdAtTx = event.transaction.hash;
  agent.save();

  // Write metadata tuples
  for (let i = 0; i < pairs.length; i++) {
    const m = new Metadata(agentId + "-" + pairs[i].metadataKey);
    m.agent = agentId;
    m.metadataKey = pairs[i].metadataKey;
    m.metadataValue = pairs[i].metadataValue;
    m.metadataValueString = pairs[i].metadataValue.toString();
    m.save();
  }

  const intent = new Intent(intentCid as string);
  const kindStr = getMetadataString(pairs, "kind");
  intent.kind = kindStr == null ? "unknown" : kindStr as string;
  const creatorStr = getMetadataString(pairs, "creator");
  intent.creator = creatorStr == null
    ? event.params.owner
    : Address.fromString(creatorStr as string);
  const createdAtStr = getMetadataString(pairs, "createdAt");
  intent.createdAt = createdAtStr == null
    ? event.block.timestamp
    : BigInt.fromString(createdAtStr as string);
  const requestIdStr = getMetadataString(pairs, "requestId");
  intent.requestId = requestIdStr == null
    ? Bytes.empty()
    : Bytes.fromHexString(requestIdStr as string);
  intent.agent = agentId;
  intent.save();
}
