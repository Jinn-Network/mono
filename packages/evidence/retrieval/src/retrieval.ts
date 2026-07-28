import type {
  CreateEvidenceRetrievalOptions,
  EvidenceRetrieval,
} from "./contracts.js";
import { EvidenceRetrievalError } from "./errors.js";
import { retrieveKnownReference } from "./known-reference.js";
import { resolveHardLimits } from "./operation.js";
import { queryEvidence } from "./query.js";

export function createEvidenceRetrieval(
  options: CreateEvidenceRetrievalOptions,
): EvidenceRetrieval {
  if (!options.locator || !options.locationPolicy || !options.repositoryResolver) {
    throw new EvidenceRetrievalError(
      "HOST_MISCONFIGURED",
      "locator, locationPolicy, and repositoryResolver are required.",
    );
  }
  const dependencies = Object.freeze({
    locator: options.locator,
    locationPolicy: options.locationPolicy,
    repositoryResolver: options.repositoryResolver,
    hardLimits: resolveHardLimits(options.hardLimits),
  });
  const facade: EvidenceRetrieval = {
    retrieve: (input, operationOptions) =>
      retrieveKnownReference(dependencies, input, operationOptions),
    query: (input, operationOptions) =>
      queryEvidence(dependencies, input, operationOptions),
  };
  return Object.freeze(facade);
}
