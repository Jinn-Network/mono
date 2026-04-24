import { log, Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { Register } from "../../generated/IdentityRegistry/IdentityRegistry";
import { Agent, Metadata, ExecutionEnvelope, Intent, SourceBundle } from "../../generated/schema";
import { MetadataPair, getMetadataString, getMetadataBytes } from "../lib/metadata";
import { upsertKnowledgeTree } from "./knowledge-tree";

export function handleEnvelopeImpl(event: Register, pairs: MetadataPair[]): void {
  const envelopeCid = getMetadataString(pairs, "envelopeCid");
  const intentCid = getMetadataString(pairs, "intentCid");
  const role = getMetadataString(pairs, "role");
  const kind = getMetadataString(pairs, "kind");
  const evidenceTier = getMetadataString(pairs, "evidenceTier");

  if (
    envelopeCid == null ||
    intentCid == null ||
    role == null ||
    kind == null ||
    evidenceTier == null
  ) {
    log.warning(
      "adw:ExecutionEnvelope missing required metadata — skipping agent {}",
      [event.params.agentId.toString()],
    );
    return;
  }

  const intent = Intent.load(intentCid as string);
  if (intent == null) {
    log.warning(
      "ExecutionEnvelope {} references unknown intentCid {} — skipping",
      [envelopeCid as string, intentCid as string],
    );
    return;
  }

  let parentEnvelopeCid: string | null = null;
  if (role == "verdict") {
    parentEnvelopeCid = getMetadataString(pairs, "parentEnvelopeCid");
    if (parentEnvelopeCid == null) {
      log.warning("Verdict envelope {} without parentEnvelopeCid — skipping", [envelopeCid as string]);
      return;
    }
    const parent = ExecutionEnvelope.load(parentEnvelopeCid as string);
    if (parent == null) {
      log.warning(
        "Verdict envelope {} references unknown parentEnvelopeCid {} — skipping",
        [envelopeCid as string, parentEnvelopeCid as string],
      );
      return;
    }
  }

  // Write Agent + Metadata as usual
  const agentId = event.params.agentId.toString();
  const agent = new Agent(agentId);
  agent.agentURI = event.params.agentURI;
  agent.owner = event.params.owner;
  agent.documentType = "adw:ExecutionEnvelope";
  agent.createdAt = event.block.timestamp;
  agent.createdAtBlock = event.block.number;
  agent.createdAtTx = event.transaction.hash;
  agent.save();

  for (let i = 0; i < pairs.length; i++) {
    const m = new Metadata(agentId + "-" + pairs[i].metadataKey);
    m.agent = agentId;
    m.metadataKey = pairs[i].metadataKey;
    m.metadataValue = pairs[i].metadataValue;
    m.metadataValueString = pairs[i].metadataValue.toString();
    m.save();
  }

  const env = new ExecutionEnvelope(envelopeCid as string);
  env.kind = kind as string;
  env.role = role as string;
  env.evidenceTier = evidenceTier as string;
  env.intent = intentCid as string;

  if (role == "verdict" && parentEnvelopeCid != null) {
    env.parentEnvelope = parentEnvelopeCid;
  }

  // Use truthy check (not != null) for Bytes | null to avoid AS @operator crash
  const measurementBytes = getMetadataBytes(pairs, "measurement");
  if (measurementBytes) {
    env.measurement = measurementBytes as Bytes;
  }

  const participantStr = getMetadataString(pairs, "participant");
  if (participantStr) {
    env.participant = Address.fromString(participantStr as string);
  } else {
    env.participant = event.params.owner;
  }

  const generatedAtStr = getMetadataString(pairs, "generatedAt");
  if (generatedAtStr) {
    env.generatedAt = BigInt.fromString(generatedAtStr as string);
  } else {
    env.generatedAt = event.block.timestamp;
  }

  env.createdAtBlock = event.block.number;
  env.createdAtTx = event.transaction.hash;

  const sourceBundleCid = getMetadataString(pairs, "sourceBundleCid");
  if (sourceBundleCid != null && SourceBundle.load(sourceBundleCid as string) != null) {
    env.sourceBundle = sourceBundleCid;
  }

  env.agent = agentId;
  env.save();

  upsertKnowledgeTree(intentCid as string, role as string, evidenceTier as string, event.block.number);
}
