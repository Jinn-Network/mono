import { Register } from "../../generated/IdentityRegistry/IdentityRegistry";
import { Agent, Metadata } from "../../generated/schema";
import { MetadataPair } from "../lib/metadata";

export function handleAgentCardImpl(event: Register, pairs: MetadataPair[]): void {
  const agentId = event.params.agentId.toString();
  const agent = new Agent(agentId);
  agent.agentURI = event.params.agentURI;
  agent.owner = event.params.owner;
  agent.documentType = "adw:AgentCard";
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
}
