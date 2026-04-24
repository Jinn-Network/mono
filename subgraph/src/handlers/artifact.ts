import { log } from "@graphprotocol/graph-ts";
import { Register } from "../../generated/IdentityRegistry/IdentityRegistry";
import { Agent, Metadata, Artifact, ExecutionEnvelope } from "../../generated/schema";
import { MetadataPair, getMetadataString } from "../lib/metadata";

export function handleArtifactImpl(event: Register, pairs: MetadataPair[]): void {
  const artifactCid = getMetadataString(pairs, "artifactCid");
  const parentEnvelopeCid = getMetadataString(pairs, "parentEnvelopeCid");

  if (artifactCid == null) {
    log.warning("adw:Artifact without artifactCid metadata — skipping agent {}", [event.params.agentId.toString()]);
    return;
  }

  if (parentEnvelopeCid == null) {
    log.warning("adw:Artifact {} without parentEnvelopeCid metadata — skipping", [artifactCid as string]);
    return;
  }

  const parent = ExecutionEnvelope.load(parentEnvelopeCid as string);
  if (parent == null) {
    log.warning(
      "Artifact {} references unknown parentEnvelopeCid {} — skipping",
      [artifactCid as string, parentEnvelopeCid as string],
    );
    return;
  }

  const agentId = event.params.agentId.toString();
  const agent = new Agent(agentId);
  agent.agentURI = event.params.agentURI;
  agent.owner = event.params.owner;
  agent.documentType = "adw:Artifact";
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

  const artifact = new Artifact(artifactCid as string);
  const artifactTypeStr = getMetadataString(pairs, "artifactType");
  artifact.artifactType = artifactTypeStr == null ? "unknown" : artifactTypeStr as string;
  artifact.parentEnvelope = parentEnvelopeCid as string;

  // Tags: Plan E emits comma-separated strings. Split on comma if present.
  // If Plan E emits JSON, this yields a single-element array containing raw
  // JSON — callers should detect and parse client-side.
  const tagsRaw = getMetadataString(pairs, "tags");
  if (tagsRaw != null) {
    artifact.tags = (tagsRaw as string).split(",");
  }

  artifact.agent = agentId;
  artifact.createdAtBlock = event.block.number;
  artifact.createdAtTx = event.transaction.hash;
  artifact.save();
}
