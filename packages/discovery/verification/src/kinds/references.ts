// SPDX-License-Identifier: Apache-2.0

import { isRecordObject } from "../record-view.js";
import type { RecordReference } from "./kind.js";

/** `{ digest: { sha256 } }`, the in-toto ResourceDescriptor shape, as a reference. */
export function descriptorReference(
  value: unknown,
  field: string,
  path: string,
  mayBeUnavailable: boolean,
): readonly RecordReference[] {
  if (!isRecordObject(value) || !isRecordObject(value["digest"])) return [];
  const hex = value["digest"]["sha256"];
  if (typeof hex !== "string") return [];
  return [{
    digest: `sha256:${hex}`,
    field,
    path: `${path}/digest/sha256`,
    ...(mayBeUnavailable ? { mayBeUnavailable } : {}),
  }];
}

export function descriptorListReferences(
  value: unknown,
  field: string,
  path: string,
  mayBeUnavailable: boolean,
): readonly RecordReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => descriptorReference(entry, field, `${path}/${index}`, mayBeUnavailable));
}

/** A `sha256:<hex>` string as a reference. */
export function digestReference(
  value: unknown,
  field: string,
  path: string,
  mayBeUnavailable: boolean,
): readonly RecordReference[] {
  if (typeof value !== "string") return [];
  return [{ digest: value, field, path, ...(mayBeUnavailable ? { mayBeUnavailable } : {}) }];
}

export function digestListReferences(
  value: unknown,
  field: string,
  path: string,
  mayBeUnavailable: boolean,
): readonly RecordReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => digestReference(entry, field, `${path}/${index}`, mayBeUnavailable));
}
