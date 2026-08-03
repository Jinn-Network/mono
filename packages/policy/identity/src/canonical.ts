// SPDX-License-Identifier: MIT

/**
 * I-JSON + RFC 8785 (JCS) canonicalization — substrate §4.1 step 5, §5.1.
 *
 * One recursive writer produces the canonical text directly, carrying the document path so every
 * I-JSON refusal names the member that caused it rather than the whole document. The three rules
 * that make sealed bytes reproducible across runtimes, and the reason each exists:
 *
 * - **Members sort by UTF-16 code unit**, which is what JCS specifies and what a code *point*
 *   sorter gets wrong for exactly one class of key (`￿` versus a surrogate pair). The
 *   `tuple/golden/utf16-code-unit-ordering` fixture is that class.
 * - **Numbers are integers only.** A fractional value would serialize through a
 *   shortest-round-trip algorithm whose output is language-dependent, so two honest derivers on
 *   two runtimes could emit different bytes for one value. `-0` is refused separately: it is a
 *   distinct JavaScript value that serializes as `0`, i.e. a digest collision reachable from
 *   ordinary JSON input.
 * - **Strings are Unicode scalar sequences.** ES2019 well-formed `JSON.stringify` escapes a lone
 *   surrogate as `\udXXX`, so the bytes round-trip through JavaScript and through nothing else.
 *
 * FINDING F10 (README): an object member whose value is `undefined` is **omitted** (the
 * `packages/benchmarking/records` precedent, mirroring `JSON.stringify`, so an omitted optional
 * field and an explicit-`undefined` one seal identically); an `undefined` **array element** is
 * refused, because there is no key to omit it by and JCS has no undefined token. Because omission
 * is the rule, `assertValidTuple` rejects an explicitly-`undefined` core axis separately — see
 * `tuple.ts`.
 *
 * Four structural refusals exist because the alternative is a **digest collision reachable from
 * ordinary input**, not because the shapes are exotic:
 *
 * - **Non-plain objects.** A `Date`, `Map`, `Set`, `RegExp`, class instance, or boxed primitive
 *   has no own enumerable members, so a writer that walks own keys emits `{}` for all of them:
 *   two different instants seal to one digest, and a policy identity stops naming one treatment.
 *   The prototype must be `Object.prototype` or `null`.
 * - **Sparse arrays.** `[1, , 3]` has a hole at index 1. A writer that maps over elements skips
 *   holes and renders them as nothing, emitting `[1,,3]` — bytes `JSON.parse` rejects. A sealed
 *   document nobody can parse is worse than a refused one.
 * - **Symbol keys and non-enumerable members.** Both are invisible to a `JSON.stringify`-shaped
 *   walk and visible to a reader of the object: the same disagreement in a different spelling.
 * - **Cycles.** Refused, so the caller gets a typed refusal rather than a `RangeError`.
 *
 * One thing this canonicalizer cannot defend against, stated so nobody assumes it does: an
 * accessor member is read exactly once, here, and a getter that returns something different on
 * the next read makes the sealed bytes disagree with the object the caller still holds. Seal
 * plain data.
 */

import { childPath, refuse } from "./errors.js";

const encoder = new TextEncoder();

/**
 * UTF-16 code-unit ordering — JCS's member order, and locale-independent by construction.
 * JavaScript's relational operators on strings already compare code units; the point of naming
 * the comparator is that `localeCompare` and `Intl.Collator` do not, and would make a sealed
 * digest depend on the host's ICU data.
 */
export function compareCodeUnitStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** True when `text` contains no unpaired surrogate, i.e. is a Unicode scalar sequence. */
function isWellFormed(text: string): boolean {
  // `String.prototype.isWellFormed` is ES2024; the manual scan keeps the ES2022 target honest.
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (unit > 0xdbff) return false; // a trailing surrogate with no leading one
    const next = text.charCodeAt(index + 1);
    if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
    index += 1; // consume the well-formed pair
  }
  return true;
}

/** Refuses a string that cannot survive a strict UTF-8 encoder in another language. */
export function assertIJsonString(value: string, path: string): void {
  if (!isWellFormed(value)) {
    refuse("invalid-document", path, "string contains an unpaired surrogate");
  }
}

function writeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    refuse("invalid-document", path, "number must be finite (I-JSON admits no NaN or Infinity)");
  }
  if (!Number.isInteger(value)) {
    refuse("invalid-document", path, "number must be an exact integer (I-JSON)");
  }
  if (!Number.isSafeInteger(value)) {
    refuse("invalid-document", path, "integer exceeds the I-JSON safe range");
  }
  if (Object.is(value, -0)) {
    refuse("invalid-document", path, "negative zero is a distinct value that seals as 0");
  }
  return String(value);
}

function write(value: unknown, path: string, ancestors: ReadonlySet<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return writeNumber(value, path);
    case "string":
      assertIJsonString(value, path);
      // JCS defers to the ECMAScript `JSON.stringify` string production, so this IS the rule.
      return JSON.stringify(value);
    case "object":
      break;
    default:
      refuse("invalid-document", path, `value of type ${typeof value} is not JSON`);
  }

  const container = value as object;
  if (ancestors.has(container)) {
    refuse("invalid-document", path, "cyclic values are not representable as JSON");
  }
  const nested = new Set(ancestors).add(container);

  if (Array.isArray(value)) {
    const elements: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const elementPath = childPath(path, index);
      // A hole is not `undefined` stored at the index — it is the absence of the index. Checked
      // first, and with `in` rather than a value comparison, because reading a hole yields
      // `undefined` and the two cases deserve different messages.
      if (!(index in value)) {
        refuse("invalid-document", elementPath, "sparse arrays are not representable as JSON");
      }
      if (value[index] === undefined) {
        refuse(
          "invalid-document",
          elementPath,
          "array element is undefined; JCS has no undefined token and there is no key to omit it by",
        );
      }
      elements.push(write(value[index], elementPath, nested));
    }
    return `[${elements.join(",")}]`;
  }

  const prototype = Object.getPrototypeOf(container);
  if (prototype !== Object.prototype && prototype !== null) {
    refuse("invalid-document", path, "non-plain objects are not representable as JSON");
  }
  if (Object.getOwnPropertySymbols(container).length > 0) {
    refuse("invalid-document", path, "symbol-keyed members are not representable as JSON");
  }

  const record = value as Record<string, unknown>;
  const names = Object.getOwnPropertyNames(record);
  if (names.length !== Object.keys(record).length) {
    refuse("invalid-document", path, "non-enumerable members are not representable as JSON");
  }

  const members: string[] = [];
  for (const key of names.sort(compareCodeUnitStrings)) {
    const member = record[key];
    if (member === undefined) continue; // F10: omitted, exactly as `JSON.stringify` would
    const memberPath = childPath(path, key);
    assertIJsonString(key, memberPath);
    members.push(`${JSON.stringify(key)}:${write(member, memberPath, nested)}`);
  }
  return `{${members.join(",")}}`;
}

/** The canonical text of any I-JSON value. Refuses fail-closed on every non-I-JSON member. */
export function canonicalJsonText(value: unknown): string {
  return write(value, "", new Set());
}

/** The canonical text's UTF-8 encoding — the bytes that get digested and signed. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalJsonText(value));
}

/**
 * Structural equality by canonical form. Used where two values must be "the same value" without
 * either being a sealed document — the requirements merge, and the parent-reference duplicate
 * check.
 */
export function canonicallyEqual(left: unknown, right: unknown): boolean {
  return canonicalJsonText(left) === canonicalJsonText(right);
}
