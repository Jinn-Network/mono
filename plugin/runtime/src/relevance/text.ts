// SPDX-License-Identifier: Apache-2.0

/**
 * The keys whose values are worth indexing. Deliberately an allowlist rather than a
 * schema: the artifacts this reads belong to other components and to third parties, and
 * this component needs text to index, not structure. Order is the object's own key order,
 * which puts an invocation before its output — the way a human reads it.
 */
export const TEXT_BEARING_KEYS: readonly string[] = Object.freeze([
  "text",
  "content",
  "summary",
  "description",
  "message",
  "command",
  "args",
  "arguments",
  "input",
  "result",
  "output",
  "stdout",
  "stderr",
  "diff",
  "note",
]);

const TEXT_BEARING = new Set(TEXT_BEARING_KEYS);
const MAX_DEPTH = 3;

export function decodeUtf8Lossy(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Every string reachable from a text-bearing key within the depth budget. The budget is
 * what keeps an adversarially nested artifact from costing unbounded work.
 */
export function textBearingStrings(value: unknown, depth = 0): readonly string[] {
  if (depth > MAX_DEPTH) return [];
  if (value === null || typeof value !== "object") return [];

  const collected: string[] = [];
  const collectValue = (candidate: unknown, nextDepth: number): void => {
    if (typeof candidate === "string") {
      if (candidate.trim().length > 0) collected.push(candidate);
      return;
    }
    if (typeof candidate === "number" || typeof candidate === "boolean") {
      collected.push(String(candidate));
      return;
    }
    if (Array.isArray(candidate)) {
      for (const element of candidate) collectValue(element, nextDepth);
      return;
    }
    if (candidate !== null && typeof candidate === "object") {
      if (nextDepth > MAX_DEPTH) return;
      for (const nested of Object.values(candidate as Record<string, unknown>)) {
        collectValue(nested, nextDepth + 1);
      }
    }
  };

  if (Array.isArray(value)) {
    for (const element of value) collected.push(...textBearingStrings(element, depth + 1));
    return collected;
  }

  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (TEXT_BEARING.has(key)) {
      collectValue(member, depth + 1);
    } else if (member !== null && typeof member === "object") {
      collected.push(...textBearingStrings(member, depth + 1));
    }
  }
  return collected;
}

export function parseNdjsonLines(text: string): readonly unknown[] {
  const parsed: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      parsed.push(JSON.parse(trimmed));
    } catch {
      // A malformed line costs that line, never the artifact.
    }
  }
  return parsed;
}

/**
 * Text for indexing. JSON and NDJSON yield their text-bearing values; anything else — and
 * anything that fails to parse — is treated as prose. Never throws.
 */
export function extractArtifactText(bytes: Uint8Array, mediaType?: string): string {
  const raw = decodeUtf8Lossy(bytes);
  const declared = (mediaType ?? "").toLowerCase();

  if (declared.includes("ndjson") || declared.includes("jsonl")) {
    return parseNdjsonLines(raw).flatMap((line) => textBearingStrings(line)).join("\n");
  }

  if (declared.includes("json") || /^\s*[[{]/u.test(raw)) {
    try {
      const strings = textBearingStrings(JSON.parse(raw));
      if (strings.length > 0) return strings.join("\n");
      if (declared.includes("json")) return "";
    } catch {
      const lines = parseNdjsonLines(raw);
      if (lines.length > 1) {
        return lines.flatMap((line) => textBearingStrings(line)).join("\n");
      }
    }
  }

  return raw.trim();
}
