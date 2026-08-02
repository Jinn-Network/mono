/**
 * ICU-free case folding and token predicates.
 *
 * `toLowerCase`/`toUpperCase` consult Unicode case tables and `toLocaleLowerCase` consults the
 * host locale on top of that. Either can change between two hosts running identical code, and
 * a request key that folded case through them could change a sealed corpus's keys on an ICU
 * upgrade. HTTP method names, field names, URI schemes and hosts are ASCII by their own
 * grammars, so this module folds only `A-Z`/`a-z` and refuses anything outside ASCII where the
 * grammar allows the refusal.
 */

const UPPER_A = 0x41;
const UPPER_Z = 0x5a;
const LOWER_A = 0x61;
const LOWER_Z = 0x7a;
const CASE_DELTA = 0x20;

export function asciiLowercase(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    out += code >= UPPER_A && code <= UPPER_Z
      ? String.fromCharCode(code + CASE_DELTA)
      : value.charAt(index);
  }
  return out;
}

export function asciiUppercase(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    out += code >= LOWER_A && code <= LOWER_Z
      ? String.fromCharCode(code - CASE_DELTA)
      : value.charAt(index);
  }
  return out;
}

/** Every code point below U+0080, and non-empty. Bracketed IPv6 literals qualify. */
export function isAsciiHost(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

/**
 * RFC 9110 `token`, restricted to lowercase. Sealed field names are stored folded, so an
 * uppercase name in a sealed policy is a document error rather than something to fold silently.
 */
const LOWERCASE_TOKEN = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;

export function isHttpToken(value: string): boolean {
  return LOWERCASE_TOKEN.test(value);
}
