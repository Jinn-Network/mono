// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, copyBytes, decodeUtf8 } from "../bytes.js";
import { EvidenceDerivationError } from "../errors.js";
import { parseStrictJson } from "../strict-json.js";
import { setJsonPointer } from "./json.js";

export function transformJsonlBytes(
  bytes: Uint8Array,
  replacements: ReadonlyMap<string, string>,
): Uint8Array {
  let source: string;
  try {
    source = decodeUtf8(bytes);
  } catch (cause) {
    throw new EvidenceDerivationError(
      "STRUCTURED_ARTIFACT_INVALID",
      "Structured artifact is not valid UTF-8.",
      { cause },
    );
  }
  const lines = source.split("\n");
  const values = lines.map((line, index) => {
    if (line.trim() === "") return null;
    try {
      return parseStrictJson(
        line,
        `Structured artifact is invalid at line ${index + 1}.`,
        "STRUCTURED_ARTIFACT_INVALID",
      );
    } catch (cause) {
      throw new EvidenceDerivationError(
        "STRUCTURED_ARTIFACT_INVALID",
        `Structured artifact is invalid at line ${index + 1}.`,
        { cause },
      );
    }
  });
  if (replacements.size === 0) return copyBytes(bytes);
  for (const [location, value] of replacements) {
    const [, lineText, ...segments] = location.split("/");
    if (!/^(?:0|[1-9]\d*)$/u.test(lineText ?? "")) {
      throw new EvidenceDerivationError(
        "INTERNAL_FAILURE",
        "JSONL transformation coordinate does not resolve.",
      );
    }
    const line = Number(lineText);
    const row = values[line];
    if (!Number.isInteger(line) || row === null || row === undefined) {
      throw new EvidenceDerivationError(
        "INTERNAL_FAILURE",
        "JSONL transformation coordinate does not resolve.",
      );
    }
    values[line] = setJsonPointer(
      row,
      segments.length === 0 ? "" : `/${segments.join("/")}`,
      value,
    );
  }
  return new TextEncoder().encode(
    `${values
      .filter((value) => value !== null)
      .map((value) => new TextDecoder().decode(canonicalJsonBytes(value)))
      .join("\n")}\n`,
  );
}
