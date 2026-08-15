// SPDX-License-Identifier: MIT

export const EVIDENCE_PROJECTOR_VERSION = "1.0.0" as const;

export const CATALOG_RELATIONSHIP_PREDICATES = [
  "about",
  "agent",
  "conformsTo",
  "creator",
  "environment",
  "hasPart",
  "instrument",
  "jinn:dispositionCount",
  "license",
  "mentions",
  "object",
  "prov:wasDerivedFrom",
  "prov:wasGeneratedBy",
  "provider",
  "resourceUsage",
  "result",
  "softwareRequirements",
  "subjectOf",
] as const;
