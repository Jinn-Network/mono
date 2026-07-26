import { canonicalJsonBytes, copyBytes, decodeUtf8 } from "../bytes.js";
import { EvidenceDerivationError } from "../errors.js";
import { setJsonPointer } from "./json.js";

export function transformJsonlBytes(
  bytes: Uint8Array,
  replacements: ReadonlyMap<string, string>,
): Uint8Array {
  if (replacements.size === 0) return copyBytes(bytes);
  const source = decodeUtf8(bytes);
  const lines = source.split("\n");
  const values = lines.map((line, index) => {
    if (line.trim() === "") return null;
    try {
      return JSON.parse(line) as unknown;
    } catch (cause) {
      throw new EvidenceDerivationError(
        "STRUCTURED_ARTIFACT_INVALID",
        `Structured artifact is invalid at line ${index + 1}.`,
        { cause },
      );
    }
  });
  for (const [location, value] of replacements) {
    const [, lineText, ...segments] = location.split("/");
    const line = Number(lineText);
    const row = values[line];
    if (!Number.isInteger(line) || row === null || row === undefined) {
      throw new EvidenceDerivationError(
        "INTERNAL_FAILURE",
        "JSONL transformation coordinate does not resolve.",
      );
    }
    setJsonPointer(row, `/${segments.join("/")}`, value);
  }
  return new TextEncoder().encode(
    `${values
      .filter((value) => value !== null)
      .map((value) => new TextDecoder().decode(canonicalJsonBytes(value)))
      .join("\n")}\n`,
  );
}
