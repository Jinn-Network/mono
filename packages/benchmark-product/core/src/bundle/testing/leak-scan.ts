// SPDX-License-Identifier: Apache-2.0

/**
 * Shared cold-bundle leak scan (#3063).
 *
 * A published bundle's bytes are dominated by base64: every signed record is a
 * DSSE envelope whose `payload` and signatures are base64, and several record
 * fields carry base64-encoded bytes directly. The leak patterns this scan
 * enforces are short, case-insensitive words, so applying them to the raw
 * base64 alphabet matches by chance -- a six-letter case-insensitive pattern
 * over ~100KB of base64 fires on the order of 1e-4 per run. That is what made
 * the P8 cold-bundle scan intermittently red on clean bundles.
 *
 * The leak targets are plain text: licensed dataset names and key-material
 * markers. This scanner therefore walks JSON structurally and decodes base64
 * rather than pattern-matching its alphabet:
 *
 * - a DSSE `payload` (and any `*Base64`-suffixed field) is decoded and its
 *   decoding rescanned, recursively -- a payload is usually itself JSON;
 * - a signature (`sig`) decodes to random bytes and carries no text;
 * - any other string long enough to be an unambiguous base64 blob (>= 64
 *   canonical standard-alphabet characters) is decoded the same way.
 *
 * Everything else -- object keys, ordinary string values, non-JSON files -- is
 * scanned as text exactly as before, so no plain-text leak escapes. The `_`
 * and `-` spellings of the key-material marker are outside the standard base64
 * alphabet and are therefore always text-scanned.
 *
 * Files that are not valid UTF-8 are skipped, as they were before (the previous
 * scan skipped any file containing a NUL byte).
 *
 * Residual: a leak word embedded in a >= 64-character run of pure base64
 * alphabet that is not itself decodable text would be missed. No bundle field
 * has that shape.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Licensed-dataset and key-material markers that must never reach a public bundle. */
export const BUNDLE_LEAK_PATTERN = /LoCoMo|licensed benchmark|api[_-]?key/iu;

/** A minimum length at which a standard-alphabet base64 string is unambiguous. */
const BLOB_MIN_LENGTH = 64;

export interface LeakFinding {
  /** Bundle-relative (or caller-supplied) path of the file the finding is in. */
  readonly path: string;
  /** `pattern` -- a licensed/key marker; `workspace-path` -- the local workspace leaked. */
  readonly kind: "pattern" | "workspace-path";
  /** Where in the file the text was found: `raw`, or a decode/field trail. */
  readonly where: string;
  /** The matched text, for a legible failure message. */
  readonly match: string;
}

/** Decodes canonical padded standard base64, or returns undefined. Deliberately strict: `Buffer`'s decoder is lenient. */
function decodeCanonicalBase64(value: string): Uint8Array | undefined {
  if (value.length === 0 || value.length % 4 !== 0) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  const buffer = Buffer.from(value, "base64");
  if (buffer.toString("base64") !== value) return undefined;
  return new Uint8Array(buffer);
}

/** Decodes UTF-8 bytes, or returns undefined when they are not valid UTF-8 text. */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function isBase64Field(key: string | undefined, isDsseEnvelope: boolean): boolean {
  if (key === undefined) return false;
  if (/base64$/i.test(key)) return true;
  return isDsseEnvelope && (key === "payload" || key === "sig");
}

class Scanner {
  readonly findings: LeakFinding[] = [];

  constructor(
    private readonly path: string,
    private readonly workspaceDir: string | undefined,
  ) {}

  /** Pattern-scans one piece of plain text. Workspace paths are checked per document, not here. */
  text(value: string, where: string): void {
    const match = BUNDLE_LEAK_PATTERN.exec(value);
    if (match !== null) this.findings.push({ path: this.path, kind: "pattern", where, match: match[0] });
  }

  /** Scans a text blob: structurally when it is JSON, as plain text otherwise. */
  document(value: string, where: string): void {
    const origin = where === "" ? "raw" : where;
    // The workspace-path check stays whole-document (raw text, and each decoded
    // payload): a local path is long, and base64 cannot spell one by chance.
    if (this.workspaceDir !== undefined && value.includes(this.workspaceDir)) {
      this.findings.push({ path: this.path, kind: "workspace-path", where: origin, match: this.workspaceDir });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      this.text(value, origin);
      return;
    }
    this.value(parsed, where, undefined);
  }

  private value(node: unknown, where: string, key: string | undefined, inDsse = false): void {
    if (typeof node === "string") {
      this.string(node, where, key, inDsse);
      return;
    }
    if (Array.isArray(node)) {
      for (const [index, entry] of node.entries()) this.value(entry, `${where}[${index}]`, key, inDsse);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    const isDsseEnvelope = typeof record["payloadType"] === "string"
      && typeof record["payload"] === "string"
      && Array.isArray(record["signatures"]);
    for (const [name, child] of Object.entries(record)) {
      this.text(name, `${where}.${name} (key)`);
      this.value(child, `${where}.${name}`, name, isDsseEnvelope || (inDsse && key === "signatures"));
    }
  }

  private string(value: string, where: string, key: string | undefined, inDsse: boolean): void {
    const named = isBase64Field(key, inDsse);
    if (!named && value.length < BLOB_MIN_LENGTH) {
      this.text(value, where);
      return;
    }
    const decoded = decodeCanonicalBase64(value);
    if (decoded === undefined) {
      // Not base64 after all (a long sentence, a path, a hex digest with an odd
      // length) -- scan it as the text it is.
      this.text(value, where);
      return;
    }
    const text = decodeUtf8(decoded);
    // Binary decodings (signatures, DER keys) carry no scannable text.
    if (text !== undefined) this.document(text, `${where} (base64)`);
  }
}

/** Scans one file's bytes for licensed-dataset markers and workspace-path leaks. */
export function findLeaks(
  bytes: Uint8Array,
  options: { readonly path: string; readonly workspaceDir?: string },
): LeakFinding[] {
  const text = decodeUtf8(bytes);
  if (text === undefined) return [];
  const scanner = new Scanner(options.path, options.workspaceDir);
  scanner.document(text, "");
  return scanner.findings;
}

function walkFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkFiles(join(dir, entry.name), relative));
    else out.push(relative);
  }
  return out;
}

/** Scans every file under a bundle directory. */
export function findBundleLeaks(bundleDir: string, workspaceDir?: string): LeakFinding[] {
  return walkFiles(bundleDir).flatMap((relative) =>
    findLeaks(readFileSync(join(bundleDir, relative)), { path: relative, workspaceDir }));
}
