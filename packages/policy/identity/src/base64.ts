// SPDX-License-Identifier: MIT

/**
 * Strict base64 decoding, shared by the two places this package accepts bytes inside a JSON
 * document: the DSSE envelope's payload and the resolved profile's sealed bytes.
 *
 * Strict matters. A lenient decoder accepts several spellings of one byte string — whitespace,
 * missing padding, alternate alphabets — and a digest computed over "whatever decoded" is a digest
 * over an input the sender cannot reproduce. One spelling, or a refusal.
 */

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Returns the decoded bytes, or `undefined` for anything that is not canonical base64. */
export function decodeStrictBase64(value: string): Uint8Array | undefined {
  if (!BASE64_PATTERN.test(value)) return undefined;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}
