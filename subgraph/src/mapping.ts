import { log } from "@graphprotocol/graph-ts";
import { Register } from "../generated/IdentityRegistry/IdentityRegistry";
import {
  ValidationRequested,
  ValidationResponded,
} from "../generated/ValidationRegistry/ValidationRegistry";
import { MetadataPair, getMetadataString } from "./lib/metadata";
import { handleAgentCardImpl } from "./handlers/agent";
import { handleIntentImpl } from "./handlers/intent";
import { handleSourceBundleImpl } from "./handlers/source-bundle";
import { handleEnvelopeImpl } from "./handlers/envelope";
import { handleArtifactImpl } from "./handlers/artifact";
import {
  handleValidationRequestedImpl,
  handleValidationRespondedImpl,
} from "./handlers/validation";

export function handleRegister(event: Register): void {
  const rawMetadata = event.params.metadata;
  const pairs: MetadataPair[] = [];
  for (let i = 0; i < rawMetadata.length; i++) {
    pairs.push(new MetadataPair(rawMetadata[i].metadataKey, rawMetadata[i].metadataValue));
  }
  const documentType = getMetadataString(pairs, "documentType");
  if (documentType == null) {
    log.warning("Register with no documentType metadata — skipping agent {}", [event.params.agentId.toString()]);
    return;
  }
  if (documentType == "adw:AgentCard") {
    handleAgentCardImpl(event, pairs);
  } else if (documentType == "adw:Intent") {
    handleIntentImpl(event, pairs);
  } else if (documentType == "adw:SourceBundle") {
    handleSourceBundleImpl(event, pairs);
  } else if (documentType == "adw:ExecutionEnvelope") {
    handleEnvelopeImpl(event, pairs);
  } else if (documentType == "adw:Artifact") {
    handleArtifactImpl(event, pairs);
  } else {
    log.warning(
      "Unknown documentType {} — skipping agent {}",
      [documentType as string, event.params.agentId.toString()],
    );
  }
}

export function handleValidationRequested(event: ValidationRequested): void {
  handleValidationRequestedImpl(event);
}

export function handleValidationResponded(event: ValidationResponded): void {
  handleValidationRespondedImpl(event);
}
