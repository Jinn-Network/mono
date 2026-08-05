// SPDX-License-Identifier: Apache-2.0
import {
  GEN_AI_ATTRIBUTES,
  JINN_ATTRIBUTES,
  STATUS_CODE,
  type Span,
} from "@jinn-network/evidence-trace";
import type { Sha256Digest } from "@jinn-network/evidence-repository";

import { MAX_INDEXED_EXCERPTS, type IndexableExcerpt } from "./index-store.js";
import { decodeUtf8Lossy, parseNdjsonLines, textBearingStrings } from "./text.js";

export interface SpanExcerptInput {
  readonly spans: readonly Span[];
  /** The digest-bound native trace: spans give structure, these bytes give the words. */
  readonly feedBytes: Uint8Array;
  readonly sourceEntityId: string;
  readonly sourceDigest: Sha256Digest;
}

export function spanAttribute(span: Span, key: string): string | undefined {
  for (const attribute of span.attributes) {
    if (attribute.key !== key) continue;
    const value = attribute.value as {
      readonly stringValue?: string;
      readonly intValue?: string;
      readonly boolValue?: boolean;
      readonly doubleValue?: string;
    };
    if (value.stringValue !== undefined) return value.stringValue;
    if (value.intValue !== undefined) return value.intValue;
    if (value.doubleValue !== undefined) return value.doubleValue;
    if (value.boolValue !== undefined) return String(value.boolValue);
    return undefined;
  }
  return undefined;
}

function sourceOrdinal(span: Span): number | undefined {
  const raw = spanAttribute(span, JINN_ATTRIBUTES.sourceOrdinal);
  if (raw === undefined) return undefined;
  const ordinal = Number.parseInt(raw, 10);
  return Number.isInteger(ordinal) && ordinal >= 0 ? ordinal : undefined;
}

function isToolSpan(span: Span): boolean {
  return spanAttribute(span, GEN_AI_ATTRIBUTES.toolName) !== undefined;
}

function lineText(line: unknown): string {
  return textBearingStrings(line).join("\n").trim();
}

function hasDiff(line: unknown): boolean {
  return (
    line !== null &&
    typeof line === "object" &&
    typeof (line as { readonly diff?: unknown }).diff === "string"
  );
}

/**
 * Deterministic excerpt selection over the trace's spans, in span order. Selects
 * never paraphrases. Same *function* as the frozen reference's step selection
 * (`packages/plugin/src/schemas/knowledge-packet.ts` — read, never copied), re-derived
 * against stack-native span structure.
 */
export function excerptsFromSpans(input: SpanExcerptInput): readonly IndexableExcerpt[] {
  const lines = parseNdjsonLines(decodeUtf8Lossy(input.feedBytes));
  if (lines.length === 0 || input.spans.length === 0) return [];

  const attribute = (
    label: IndexableExcerpt["label"],
    text: string,
  ): IndexableExcerpt | undefined =>
    text.length === 0
      ? undefined
      : {
          label,
          sourceEntityId: input.sourceEntityId,
          sourceDigest: input.sourceDigest,
          text,
        };

  const excerpts: IndexableExcerpt[] = [];
  const push = (candidate: IndexableExcerpt | undefined): void => {
    if (candidate !== undefined && excerpts.length < MAX_INDEXED_EXCERPTS) {
      excerpts.push(candidate);
    }
  };

  const resolved = input.spans.flatMap((span) => {
    const ordinal = sourceOrdinal(span);
    if (ordinal === undefined || ordinal >= lines.length) return [];
    return [{ span, line: lines[ordinal] }];
  });

  const failureIndex = resolved.findIndex(
    (entry) => isToolSpan(entry.span) && entry.span.status.code === STATUS_CODE.ERROR,
  );
  if (failureIndex >= 0) {
    push(attribute("failure", lineText(resolved[failureIndex]!.line)));
    const fix = resolved
      .slice(failureIndex + 1)
      .find((entry) => isToolSpan(entry.span) && entry.span.status.code === STATUS_CODE.OK);
    if (fix !== undefined) push(attribute("fix", lineText(fix.line)));
  }

  const passing = resolved.filter(
    (entry) => isToolSpan(entry.span) && entry.span.status.code === STATUS_CODE.OK,
  );
  const lastPassing = passing[passing.length - 1];
  if (lastPassing !== undefined) push(attribute("command", lineText(lastPassing.line)));

  const diffEntry = resolved.find((entry) => hasDiff(entry.line));
  if (diffEntry !== undefined) push(attribute("diff", lineText(diffEntry.line)));

  if (excerpts.length === 0) {
    const assistant =
      resolved.find(
        (entry) => spanAttribute(entry.span, JINN_ATTRIBUTES.turnRole) === "assistant",
      ) ?? resolved.find((entry) => spanAttribute(entry.span, JINN_ATTRIBUTES.turnRole) !== undefined);
    if (assistant !== undefined) push(attribute("note", lineText(assistant.line)));
  }

  return excerpts;
}
