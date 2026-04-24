import { log, Bytes } from "@graphprotocol/graph-ts";
import { Register } from "../../generated/IdentityRegistry/IdentityRegistry";
import { Agent, Metadata, SourceBundle } from "../../generated/schema";
import { MetadataPair, getMetadataString, getMetadataBytes } from "../lib/metadata";

export function handleSourceBundleImpl(event: Register, pairs: MetadataPair[]): void {
  const bundleCid = getMetadataString(pairs, "sourceBundleCid");
  if (bundleCid == null) {
    log.warning("adw:SourceBundle without sourceBundleCid metadata — skipping agent {}", [event.params.agentId.toString()]);
    return;
  }

  const agentId = event.params.agentId.toString();
  const agent = new Agent(agentId);
  agent.agentURI = event.params.agentURI;
  agent.owner = event.params.owner;
  agent.documentType = "adw:SourceBundle";
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

  const bundle = new SourceBundle(bundleCid!);

  const measurementBytes = getMetadataBytes(pairs, "measurement");
  if (measurementBytes) {
    bundle.measurement = measurementBytes as Bytes;
  } else {
    bundle.measurement = Bytes.empty();
  }

  const buildRecipeKindStr = getMetadataString(pairs, "buildRecipeKind");
  if (buildRecipeKindStr) {
    bundle.buildRecipeKind = buildRecipeKindStr as string;
  } else {
    bundle.buildRecipeKind = "dockerfile";
  }

  const humanUrl = getMetadataString(pairs, "humanUrl");
  if (humanUrl != null) {
    bundle.humanUrl = humanUrl;
  }

  bundle.publishedBy = event.params.owner;
  bundle.agent = agentId;
  bundle.createdAtBlock = event.block.number;
  bundle.createdAtTx = event.transaction.hash;
  bundle.save();
}
