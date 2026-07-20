import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
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

export function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  label: string,
): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
    if (stat.size > maximumBytes) throw new Error(`${label} exceeds the maximum byte size`);
    const content = readFileSync(fd);
    if (content.length > maximumBytes) {
      throw new Error(`${label} grew beyond the maximum byte size while being read`);
    }
    return content;
  } finally {
    closeSync(fd);
  }
}

export function readAttributionEvidenceBundle(path: string): AttributionEvidenceBundle {
  const manifestPath = realpathSync(path);
  const manifest = readBoundedRegularFile(
    manifestPath,
    MAX_EVIDENCE_MANIFEST_BYTES,
    'evidence manifest',
  ).toString('utf8');
  const entries = parseAttributionEvidenceManifest(manifest);
  const root = dirname(manifestPath);
  const rootPrefix = `${root}${sep}`;
  const files = entries.map((entry) => {
    const requestedPath = resolve(root, entry.path);
    const actualPath = realpathSync(requestedPath);
    if (!actualPath.startsWith(rootPrefix)) {
      throw new Error(`evidence manifest path escapes its run directory: ${entry.path}`);
    }
    return {
      path: entry.path,
      content: readBoundedRegularFile(
        requestedPath,
        MAX_EVIDENCE_FILE_BYTES,
        `evidence file ${entry.path}`,
      ),
    };
  });
  return { manifest, files };
}
