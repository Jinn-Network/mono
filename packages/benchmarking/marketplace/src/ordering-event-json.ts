// SPDX-License-Identifier: MIT

import {
  serializeCanonicalJson,
  type JsonValue,
} from "@jinn-network/benchmarking-records";
import type { ObservationMarketplaceEvent } from "@jinn-network/marketplace-projector";
import { decodeUtf8Json } from "./canonical-bytes.js";
import { MarketplaceOrderingParseError } from "./ordering-record.js";

const DECIMAL_UINT = /^(0|[1-9][0-9]*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Encode projector events as I-JSON: bigint facts become decimal strings. */
export function marketplaceEventToJson(event: ObservationMarketplaceEvent): JsonValue {
  return toJsonValue(event);
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new MarketplaceOrderingParseError("event contains a non-I-JSON number");
    }
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((element) => toJsonValue(element));
  if (isRecord(value)) {
    const encoded: { [key: string]: JsonValue } = {};
    for (const [key, member] of Object.entries(value)) {
      if (member === undefined) continue;
      encoded[key] = toJsonValue(member);
    }
    return encoded;
  }
  throw new MarketplaceOrderingParseError("event contains a non-JSON value");
}

function reviveFacts(facts: unknown): Record<string, unknown> {
  if (!isRecord(facts)) throw new MarketplaceOrderingParseError("event facts must be an object");
  const revived: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(facts)) {
    revived[key] = typeof value === "string" && DECIMAL_UINT.test(value) ? BigInt(value) : value;
  }
  return revived;
}

export function serializeMarketplaceEvent(event: ObservationMarketplaceEvent): Uint8Array {
  return serializeCanonicalJson(marketplaceEventToJson(event));
}

export function parseMarketplaceEventBytes(bytes: Uint8Array): ObservationMarketplaceEvent {
  const parsed = decodeUtf8Json(bytes);
  if (!isRecord(parsed)) throw new MarketplaceOrderingParseError("event member is not JSON");
  if (typeof parsed.event !== "string") {
    throw new MarketplaceOrderingParseError("event member is missing event name");
  }
  if (!isRecord(parsed.derivation) || !isRecord(parsed.projection) || !isRecord(parsed.facts)) {
    throw new MarketplaceOrderingParseError("event member is missing derivation, projection, or facts");
  }
  return {
    ...parsed,
    facts: reviveFacts(parsed.facts),
  } as ObservationMarketplaceEvent;
}
