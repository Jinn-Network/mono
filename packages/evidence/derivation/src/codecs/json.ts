// SPDX-License-Identifier: Apache-2.0

import { bytesEqual, canonicalJsonBytes, copyBytes, decodeUtf8 } from "../bytes.js";
import { EvidenceDerivationError } from "../errors.js";
import { parseStrictJson } from "../strict-json.js";

function unescapePointer(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function setJsonPointer(
  root: unknown,
  pointer: string,
  value: string,
): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) {
    throw new EvidenceDerivationError(
      "INTERNAL_FAILURE",
      "Transformation pointer does not resolve.",
    );
  }
  const segments = pointer
    .split("/")
    .slice(1)
    .map(unescapePointer);
  let parent: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (!parent || typeof parent !== "object") {
      throw new EvidenceDerivationError(
        "INTERNAL_FAILURE",
        "Transformation pointer does not resolve.",
      );
    }
    parent = (parent as Record<string, unknown>)[segment];
  }
  const key = segments.at(-1);
  if (key === undefined || !parent || typeof parent !== "object") {
    throw new EvidenceDerivationError(
      "INTERNAL_FAILURE",
      "Transformation pointer does not resolve.",
    );
  }
  (parent as Record<string, unknown>)[key] = value;
  return root;
}

export function transformJsonBytes(
  bytes: Uint8Array,
  replacements: ReadonlyMap<string, string>,
): Uint8Array {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(
      decodeUtf8(bytes),
      "Structured artifact is invalid or ambiguous.",
      "STRUCTURED_ARTIFACT_INVALID",
    );
  } catch (cause) {
    throw new EvidenceDerivationError(
      "STRUCTURED_ARTIFACT_INVALID",
      "Structured artifact is invalid.",
      { cause },
    );
  }
  if (replacements.size === 0) return copyBytes(bytes);
  for (const [pointer, value] of replacements) {
    parsed = setJsonPointer(parsed, pointer, value);
  }
  const transformed = canonicalJsonBytes(parsed);
  return bytesEqual(bytes, transformed) ? copyBytes(bytes) : transformed;
}
