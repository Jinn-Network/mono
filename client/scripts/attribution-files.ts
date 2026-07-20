import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

import {
  parseAttributionEvidenceManifest,
  type AttributionEvidenceBundle,
} from '../src/eval/attribution-instrument.js';

export const MAX_PREREGISTRATION_BYTES = 1_000_000;
export const MAX_FACTS_BYTES = 64_000_000;
const MAX_EVIDENCE_MANIFEST_BYTES = 1_000_000;
const MAX_EVIDENCE_FILE_BYTES = 1_000_000;
export const MAX_AGGREGATE_EVIDENCE_BYTES = 64_000_000;

export function readBoundedRegularFileDescriptor(
  fd: number,
  initialSize: number,
  maximumBytes: number,
  label: string,
): Buffer {
  if (
    !Number.isSafeInteger(initialSize)
    || initialSize < 0
    || !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 0
  ) {
    throw new Error(`${label} has an invalid byte size`);
  }
  if (initialSize > maximumBytes) {
    throw new Error(`${label} exceeds the maximum byte size`);
  }

  const content = Buffer.allocUnsafe(initialSize);
  let offset = 0;
  while (offset < initialSize) {
    const bytesRead = readSync(fd, content, offset, initialSize - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }

  const growthProbe = Buffer.allocUnsafe(1);
  if (readSync(fd, growthProbe, 0, 1, null) !== 0) {
    throw new Error(`${label} grew while being read`);
  }
  return content.subarray(0, offset);
}

export function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  label: string,
): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
    return readBoundedRegularFileDescriptor(fd, stat.size, maximumBytes, label);
  } finally {
    closeSync(fd);
  }
}

export function readAttributionEvidenceBundle(
  path: string,
  maximumAggregateBytes = MAX_AGGREGATE_EVIDENCE_BYTES,
): AttributionEvidenceBundle {
  if (!Number.isSafeInteger(maximumAggregateBytes) || maximumAggregateBytes < 0) {
    throw new Error('aggregate evidence has an invalid maximum byte size');
  }
  const manifestPath = realpathSync(path);
  const manifest = readBoundedRegularFile(
    manifestPath,
    MAX_EVIDENCE_MANIFEST_BYTES,
    'evidence manifest',
  ).toString('utf8');
  const entries = parseAttributionEvidenceManifest(manifest);
  const root = dirname(manifestPath);
  const rootPrefix = `${root}${sep}`;
  let aggregateBytes = 0;
  const files = entries.map((entry) => {
    const requestedPath = resolve(root, entry.path);
    const actualPath = realpathSync(requestedPath);
    if (!actualPath.startsWith(rootPrefix)) {
      throw new Error(`evidence manifest path escapes its run directory: ${entry.path}`);
    }
    const remainingBytes = maximumAggregateBytes - aggregateBytes;
    let content: Buffer;
    try {
      content = readBoundedRegularFile(
        requestedPath,
        Math.min(MAX_EVIDENCE_FILE_BYTES, Math.max(remainingBytes, 0)),
        `evidence file ${entry.path}`,
      );
    } catch (error) {
      if (
        remainingBytes < MAX_EVIDENCE_FILE_BYTES
        && error instanceof Error
        && error.message.includes('exceeds the maximum byte size')
      ) {
        throw new Error('aggregate evidence exceeds the maximum byte size');
      }
      throw error;
    }
    aggregateBytes += content.length;
    if (aggregateBytes > maximumAggregateBytes) {
      throw new Error('aggregate evidence exceeds the maximum byte size');
    }
    return { path: entry.path, content };
  });
  return { manifest, files };
}
