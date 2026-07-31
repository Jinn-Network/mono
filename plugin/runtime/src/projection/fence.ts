// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

export const FENCE_PREFIX = "jinn-corpus-" as const;
export const QUOTE_PREFIX = "| " as const;

function hashFence(contents: readonly string[], salt: number): string {
  const hash = createHash("sha256");
  hash.update(`jinn.projection.fence:${salt}`);
  for (const content of contents) {
    hash.update(`\u0000${content.length}\u0000`);
    hash.update(content);
  }
  return `${FENCE_PREFIX}${hash.digest("hex").slice(0, 16)}`;
}

/**
 * A boundary marker the fenced content cannot forge, because it is derived from that
 * content. A fixed delimiter is breakable: a record carrying the closing marker escapes
 * the block and its remainder lands at the model's top level, where it reads as
 * instruction. The counter loop turns "practically impossible to collide" into
 * "guaranteed absent".
 */
export function deriveFence(contents: readonly string[]): string {
  for (let salt = 0; salt < 1_000; salt += 1) {
    const candidate = hashFence(contents, salt);
    if (!contents.some((content) => content.includes(candidate))) return candidate;
  }
  /* c8 ignore next */
  throw new Error("could not derive a fence absent from the projected content");
}

// C0 controls except tab and `\n` (the line separator), plus DEL.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F]/gu;

/**
 * Every line prefixed, so no corpus text ever occupies column 0 where a directive sits.
 * Carriage returns are normalised (a bare `\r` can hide a line from a reader that splits
 * on `\n`) and other control characters are dropped.
 */
export function quoteBlock(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .replace(CONTROL_CHARACTERS, "")
    .split("\n")
    .map((line) => `${QUOTE_PREFIX}${line}`)
    .join("\n");
}
