// SPDX-License-Identifier: Apache-2.0

import { validateExecutionEvidence } from "@jinn-network/evidence-protocol";

import type { BareSha256Hex, RepositorySha256Digest } from "./digests.js";
import {
  LINKAGE_MODES,
  TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
  type LinkageMode,
} from "./identifiers.js";

type JsonEntity = Record<string, unknown> & { "@id": string; "@type": unknown };

export type ExecutionLinkageFailure = {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
};

export type ExecutionLinkageSuccess = {
  readonly ok: true;
  readonly nativeTraceHex: BareSha256Hex;
  readonly nativeTraceEntity: JsonEntity;
};

export type ExecutionLinkageResult = ExecutionLinkageSuccess | ExecutionLinkageFailure;

const C1_PROPERTY_VALUE_KEYS = ["@type", "propertyID", "value"] as const;

function entityTypes(entity: JsonEntity): readonly string[] {
  const type = entity["@type"];
  if (type === undefined) return [];
  return Array.isArray(type) ? type.map(String) : [String(type)];
}

function hasType(entity: JsonEntity, type: string): boolean {
  return entityTypes(entity).includes(type);
}

function refId(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "@id" in value) {
    const id = (value as { "@id": unknown })["@id"];
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

function collectSubjectOfTraceIds(value: unknown): readonly string[] | "malformed" {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const ids: string[] = [];
    for (const entry of value) {
      const id = refId(entry);
      if (id === undefined) return "malformed";
      ids.push(id);
    }
    return ids;
  }
  const id = refId(value);
  return id === undefined ? "malformed" : [id];
}

function identifierEntries(entity: JsonEntity): readonly JsonEntity[] {
  const identifier = entity["identifier"];
  if (identifier === undefined) return [];
  const entries = Array.isArray(identifier) ? identifier : [identifier];
  return entries.filter(
    (entry): entry is JsonEntity =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

function isCompleteC1ForwardLink(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const object = entry as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== C1_PROPERTY_VALUE_KEYS.length) return false;
  for (const key of C1_PROPERTY_VALUE_KEYS) {
    if (!keys.includes(key)) return false;
  }
  if (object["@type"] !== "PropertyValue") return false;
  if (object["propertyID"] !== TRAJECTORY_RECORD_IDENTIFIER_PROPERTY) return false;
  if (typeof object["value"] !== "string" || !/^sha256:[0-9a-f]{64}$/.test(object["value"])) {
    return false;
  }
  return true;
}

function c1ForwardLinkCandidates(entity: JsonEntity): readonly JsonEntity[] {
  return identifierEntries(entity).filter(
    (identifier) => identifier["propertyID"] === TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
  );
}

function validateC1ForwardLinks(
  entity: JsonEntity,
): { readonly ok: true; readonly links: readonly JsonEntity[] } | ExecutionLinkageFailure {
  const candidates = c1ForwardLinkCandidates(entity);
  for (const candidate of candidates) {
    if (!isCompleteC1ForwardLink(candidate)) {
      return {
        ok: false,
        code: "l3-forward-link-malformed",
        message: "C1 trajectory forward link must be a complete PropertyValue shape",
      };
    }
  }
  return { ok: true, links: candidates.filter(isCompleteC1ForwardLink) };
}

export function resolvePrimaryNativeTrace(
  executionRecordBytes: Uint8Array,
): ExecutionLinkageResult {
  const report = validateExecutionEvidence(executionRecordBytes);
  if (!report.conforms || !report.value) {
    return {
      ok: false,
      code: "l3-execution-nonconforming",
      message: "execution record does not conform to Execution Evidence protocol",
    };
  }

  const graph = report.value["@graph"] as JsonEntity[];
  const byId = new Map(graph.map((entity) => [entity["@id"], entity]));

  const roots = graph.filter((entity) => entity["@id"] === "./" && hasType(entity, "Dataset"));
  if (roots.length !== 1) {
    return {
      ok: false,
      code: "l3-execution-nonconforming",
      message: "execution record has no unique root Dataset",
    };
  }

  const mentionedIds = roots[0]!["mentions"];
  const mentionList = Array.isArray(mentionedIds)
    ? mentionedIds
    : mentionedIds === undefined
      ? []
      : [mentionedIds];
  const mentionedRefIds = mentionList.flatMap((entry) => {
    const id = refId(entry);
    return id === undefined ? [] : [id];
  });

  const executions = mentionedRefIds
    .map((id) => byId.get(id))
    .filter((entity): entity is JsonEntity => entity !== undefined)
    .filter((entity) => hasType(entity, "CreateAction") && hasType(entity, "prov:Activity"));

  if (mentionedRefIds.length !== 1 || executions.length !== 1) {
    return {
      ok: false,
      code: "l3-execution-nonconforming",
      message: "execution record has no unique primary Execution",
    };
  }

  const execution = executions[0]!;
  const subjectRefs = collectSubjectOfTraceIds(execution["subjectOf"]);
  if (subjectRefs === "malformed" || subjectRefs.length === 0) {
    return {
      ok: false,
      code: "l3-native-trace-missing",
      message: "primary Execution has no subjectOf native trace",
    };
  }
  const uniqueRefs = new Set(subjectRefs);
  if (uniqueRefs.size !== 1) {
    return {
      ok: false,
      code: "l3-native-trace-missing",
      message: "primary Execution subjectOf must resolve to exactly one native trace",
    };
  }

  const traceId = subjectRefs[0]!;
  const trace = byId.get(traceId);
  if (trace === undefined || !hasType(trace, "File")) {
    return {
      ok: false,
      code: "l3-native-trace-missing",
      message: "primary native trace must be a File entity",
    };
  }

  const sha256 = trace["sha256"];
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    return {
      ok: false,
      code: "l3-native-trace-mismatch",
      message: "native trace sha256 is malformed",
    };
  }

  return { ok: true, nativeTraceHex: sha256 as BareSha256Hex, nativeTraceEntity: trace };
}

export function verifyExecutionLinkage(
  executionRecordBytes: Uint8Array,
  attestedNativeTraceHex: BareSha256Hex,
  trajectoryDigest: RepositorySha256Digest,
  linkageMode: LinkageMode,
): { readonly code?: string; readonly message?: string } {
  if (!(LINKAGE_MODES as readonly string[]).includes(linkageMode)) {
    return { code: "l3-linkage-mode-invalid", message: "linkageMode is not a closed attested value" };
  }

  const resolved = resolvePrimaryNativeTrace(executionRecordBytes);
  if (!resolved.ok) {
    return { code: resolved.code, message: resolved.message };
  }

  if (resolved.nativeTraceHex !== attestedNativeTraceHex) {
    return {
      code: "l3-native-trace-mismatch",
      message: "attested native trace digest does not match primary Execution subjectOf trace",
    };
  }

  const forwardLinkValidation = validateC1ForwardLinks(resolved.nativeTraceEntity);
  if (!forwardLinkValidation.ok) {
    return { code: forwardLinkValidation.code, message: forwardLinkValidation.message };
  }
  const forwardLinks = forwardLinkValidation.links;

  if (linkageMode === "sealed-parent") {
    if (forwardLinks.length > 0) {
      return {
        code: "l3-forward-link-present",
        message: "sealed-parent linkage must not carry a C1 Trajectory forward link on the native trace",
      };
    }
    return {};
  }

  if (forwardLinks.length === 0) {
    return { code: "l3-forward-link-missing", message: "trajectory forward link is missing" };
  }
  if (forwardLinks.length > 1) {
    return {
      code: "l3-forward-link-duplicate",
      message: "trajectory forward link is duplicated on native-trace entity",
    };
  }

  const value = forwardLinks[0]!["value"];
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    return { code: "l3-forward-link-mismatch", message: "trajectory forward link value is malformed" };
  }
  if (value !== trajectoryDigest) {
    return {
      code: "l3-forward-link-mismatch",
      message: "trajectory forward link value does not match attestation subject",
    };
  }

  return {};
}
