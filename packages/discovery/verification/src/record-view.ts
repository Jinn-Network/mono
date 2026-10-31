// SPDX-License-Identifier: Apache-2.0

import { parseDsseEnvelope } from "@jinn-network/trust-core";
import type { DsseEnvelopeSignature } from "@jinn-network/trust-core";

/**
 * A record's bytes and what they say, read once. Nothing here is normalized: `document` is the raw
 * parse, because a schema parse can drop or default what the exact-encoding rule has to see.
 */
export interface RecordView {
  /** The exact bytes received: the record. */
  readonly bytes: Uint8Array;
  /** `JSON.parse` of `bytes`, or `undefined` when they are not JSON. */
  readonly parsed: unknown;
  /** What the record says: the decoded payload of a DSSE envelope, otherwise `parsed`. */
  readonly document: unknown;
  /** The bytes `document` was parsed from. */
  readonly documentBytes: Uint8Array;
  /** The envelope's `payloadType`, or a string one beside the other two members of a malformed one. */
  readonly payloadType?: string;
  /** Present when the envelope parsed. */
  readonly signatures?: readonly DsseEnvelopeSignature[];
  /** The three DSSE members are here, of whatever type, and they do not make a well-formed envelope. */
  readonly malformedEnvelope?: true;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

function isDsseShaped(value: unknown): value is { readonly payloadType: unknown } {
  return isRecordObject(value) && "payload" in value && "payloadType" in value && "signatures" in value;
}

export function readRecord(bytes: Uint8Array): RecordView {
  const parsed = parseJson(bytes);
  const view: RecordView = { bytes, parsed, document: parsed, documentBytes: bytes };
  if (!isDsseShaped(parsed)) return view;
  try {
    const envelope = parseDsseEnvelope(bytes);
    return {
      ...view,
      document: parseJson(envelope.payloadBytes),
      documentBytes: envelope.payloadBytes,
      payloadType: envelope.payloadType,
      signatures: envelope.signatures,
    };
  } catch {
    return { ...view, malformedEnvelope: true, ...(typeof parsed.payloadType === "string" ? { payloadType: parsed.payloadType } : {}) };
  }
}

export function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A top-level string member of the document, or `undefined`. */
export function documentField(view: RecordView, name: string): unknown {
  return isRecordObject(view.document) ? view.document[name] : undefined;
}
