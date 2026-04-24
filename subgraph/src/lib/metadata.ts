import { Bytes } from "@graphprotocol/graph-ts";

export class MetadataPair {
  metadataKey: string;
  metadataValue: Bytes;

  constructor(key: string, value: Bytes) {
    this.metadataKey = key;
    this.metadataValue = value;
  }
}

export function getMetadataString(pairs: MetadataPair[], key: string): string | null {
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].metadataKey == key) {
      return pairs[i].metadataValue.toString();
    }
  }
  return null;
}

export function getMetadataBytes(pairs: MetadataPair[], key: string): Bytes | null {
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].metadataKey == key) {
      return pairs[i].metadataValue;
    }
  }
  return null;
}

// Minimal struct to match the generated event-tuple shape. The actual
// generated type lives under ./generated/IdentityRegistry/IdentityRegistry.ts
// and re-exports the struct; callers pass that through.
export class Entry {
  metadataKey: string;
  metadataValue: Bytes;

  constructor(key: string, value: Bytes) {
    this.metadataKey = key;
    this.metadataValue = value;
  }
}

/**
 * Convert the generated event's metadata tuple array to a flat MetadataPair[]
 * the handlers can read without repeatedly calling .toMap() at the graph-ts layer.
 */
export function toMetadataPairs(raw: Array<Entry>): MetadataPair[] {
  const out: MetadataPair[] = [];
  for (let i = 0; i < raw.length; i++) {
    out.push(new MetadataPair(raw[i].metadataKey, raw[i].metadataValue));
  }
  return out;
}
