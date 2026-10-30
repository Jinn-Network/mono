// SPDX-License-Identifier: Apache-2.0

const WHITESPACE = new Set([" ", "\n", "\r", "\t"]);

function endOfString(text: string, start: number): number {
  let index = start + 1;
  while (text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
  return index + 1;
}

function isFollowedByColon(text: string, start: number): boolean {
  let index = start;
  while (WHITESPACE.has(text[index] ?? "")) index += 1;
  return text[index] === ":";
}

/**
 * The first thing in `text` that I-JSON (RFC 7493) forbids and `JSON.parse` lets through: a repeated
 * object member, a number no IEEE 754 double can hold, or an unpaired surrogate. `text` must already
 * have parsed as JSON. A scan rather than a walk of the parsed value, because the parse has already
 * thrown away the first member of a repeated pair.
 */
export function iJsonViolation(text: string): string | undefined {
  // One entry per open container: an object's member names, or `undefined` for an array.
  const open: (Set<string> | undefined)[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (character === '"') {
      const end = endOfString(text, index);
      const token = text.slice(index, end);
      const value = token.includes("\\") ? JSON.parse(token) as string : token.slice(1, -1);
      if (/\p{Cs}/u.test(value)) return `the string ${token} holds an unpaired surrogate`;
      const members = open.at(-1);
      if (members !== undefined && isFollowedByColon(text, end)) {
        if (members.has(value)) return `the member ${token} is repeated`;
        members.add(value);
      }
      index = end;
    } else if (character === "{" || character === "[") {
      open.push(character === "{" ? new Set() : undefined);
      index += 1;
    } else if (character === "}" || character === "]") {
      open.pop();
      index += 1;
    } else if (character === "-" || (character >= "0" && character <= "9")) {
      let end = index + 1;
      while (end < text.length && /[0-9eE+.-]/u.test(text[end]!)) end += 1;
      const token = text.slice(index, end);
      if (!Number.isFinite(Number(token))) return `the number ${token} is outside what a double can hold`;
      index = end;
    } else {
      index += 1;
    }
  }
  return undefined;
}
