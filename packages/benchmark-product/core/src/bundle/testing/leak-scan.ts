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
 * - a DSSE `payload` is decoded and its decoding rescanned, recursively -- a
 *   payload is usually itself JSON -- as is any `*Base64`-suffixed field;
 * - a DSSE signature (`sig`) decodes to random bytes and carries no text.
 *
 * A published bundle also carries base64 outside JSON, and more of it than the
 * records carry: `index.html`, `badge.svg`, and `social-card.svg` each inline
 * three woff2 fonts as `data:font/woff2;base64,...` -- ~132KB of base64 per
 * asset file, ~398KB per bundle -- and the Colophon mark rides a
 * `data:image/svg+xml;base64,` URI. A base64 data URI is therefore treated the
 * way a named field is, wherever it appears: its blob is decoded and the
 * decoding rescanned, while its `data:<media-type>;base64,` prefix and every
 * surrounding byte still read as text.
 *
 * Those two carriers -- the named field and the base64 data URI -- are the whole
 * of what is exempted from the text scan. A schema or asset that adds a carrier
 * some other way does not become unsafe: it merely scans that carrier's
 * alphabet again, and can regain the exemption by taking the `*Base64` suffix
 * or the data-URI spelling. Everything else -- object keys, ordinary string
 * values, non-JSON files -- is scanned as text exactly as before, so no
 * plain-text leak escapes: a value is never skipped on the strength of merely
 * looking like base64.
 *
 * A binary file -- one containing a NUL byte -- is not structured text to walk,
 * but it still carries plain text: a `.eval` Inspect log is a ZIP, and a ZIP
 * stores its entry names uncompressed, so `samples/LoCoMo_qa_001.json` is
 * readable in its raw bytes. Such a file is therefore decoded lossily and
 * pattern-scanned whole, exactly as the v4 producer closure scanned every
 * published byte. Chance matches are not the concern there that they are in
 * base64: over uniform bytes a six-letter case-insensitive pattern fires on the
 * order of 1e-14, against 1e-4 over the 64-character base64 alphabet.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Licensed-dataset and key-material markers that must never reach a public bundle. */
export const BUNDLE_LEAK_PATTERN = /LoCoMo|licensed benchmark|api[_-]?key/iu;

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

/**
 * Decodes base64 in either the standard or the URL-safe alphabet, padded or
 * not -- every spelling a DSSE envelope may carry, per `trust-core`'s
 * `decodeBase64Strict` -- or returns undefined. It goes one step beyond that
 * decoder in also requiring the value to re-encode to itself, because `Buffer`'s
 * own decoder is lenient about trailing bits. That extra strictness costs no
 * sensitivity: a value it rejects is text-scanned instead, which is what a
 * non-base64 value deserves anyway.
 */
function decodeCanonicalBase64(value: string): Uint8Array | undefined {
  if (!/^(?:[A-Za-z0-9+/]+|[A-Za-z0-9_-]+)={0,2}$/.test(value)) return undefined;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, "");
  if (standard.length % 4 === 1) return undefined;
  const buffer = Buffer.from(standard, "base64");
  if (buffer.toString("base64").replace(/=+$/, "") !== standard) return undefined;
  return new Uint8Array(buffer);
}

/**
 * Reads bytes as text, or returns undefined for binary. The NUL test and the
 * lenient (replacement-character) decode are both deliberate: they are exactly
 * what the previous whole-file scan did, so no file it read is skipped here.
 */
function readText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  return Buffer.from(bytes).toString("utf8");
}

/**
 * A `data:<media-type>[;parameter=value...];base64,<blob>` run. The blob's
 * character class stops at the delimiters a data URI is embedded behind -- `)`
 * in a CSS `url(...)`, a quote in markup -- so only the blob is captured.
 */
const DATA_URI_BASE64 = /(data:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[^;,]*)*;base64,)([A-Za-z0-9+/=_-]+)/gu;

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

  /**
   * Pattern-scans one piece of plain text. A base64 data URI in it is decoded
   * and its decoding rescanned, exactly as a named base64 field is; only the
   * blob is withheld from the text scan, so the URI's own media type and every
   * surrounding byte still read. Workspace paths are checked per document, not
   * here -- and against the raw document, before any blob is withheld.
   */
  text(value: string, where: string): void {
    const blobs: string[] = [];
    const scannable = value.replace(DATA_URI_BASE64, (_match, prefix: string, blob: string) => {
      blobs.push(blob);
      return prefix;
    });
    const match = BUNDLE_LEAK_PATTERN.exec(scannable);
    if (match !== null) this.findings.push({ path: this.path, kind: "pattern", where, match: match[0] });
    for (const [index, blob] of blobs.entries()) {
      const trail = `${where} (data URI ${index})`;
      const decoded = decodeCanonicalBase64(blob);
      // Not canonical base64 after all -- scan the blob as text, as any other
      // value that fails to decode is. Its `data:` prefix is already consumed,
      // so this cannot re-enter the data-URI branch.
      if (decoded === undefined) {
        this.text(blob, trail);
        continue;
      }
      const text = readText(decoded);
      // Binary decodings -- a woff2 font, a PNG -- carry no scannable text.
      if (text !== undefined) this.document(text, `${trail} base64`);
    }
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
    this.value(parsed, origin, undefined);
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
    const decoded = isBase64Field(key, inDsse) ? decodeCanonicalBase64(value) : undefined;
    if (decoded === undefined) {
      // Not a base64 field, or not canonical base64 after all -- scan the text.
      this.text(value, where);
      return;
    }
    const text = readText(decoded);
    // Binary decodings (signatures, DER keys) carry no scannable text.
    if (text !== undefined) this.document(text, `${where} (base64)`);
  }
}

/** Scans one file's bytes for licensed-dataset markers and workspace-path leaks. */
export function findLeaks(
  bytes: Uint8Array,
  options: { readonly path: string; readonly workspaceDir?: string },
): LeakFinding[] {
  const text = readText(bytes);
  const scanner = new Scanner(options.path, options.workspaceDir);
  // A lossy decode never absorbs an ASCII run -- no continuation byte is ASCII
  // -- so a plain-text marker or workspace path in a binary file still reads.
  scanner.document(text ?? Buffer.from(bytes).toString("utf8"), text === undefined ? "raw (binary)" : "");
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
