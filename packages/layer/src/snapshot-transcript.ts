/**
 * system_snapshot extraction — donation unwrap + ustar read + transcript
 * lookup (issue #1472, spec §8).
 *
 * The engine tars each solve's working dir into a `system_snapshot` artifact
 * (hand-rolled POSIX ustar + gzip, `operator/src/harnesses/engine/packaging.ts`
 * `createWorkdirTarball`) and publishes it donation-wrapped
 * (`jinn.artifact.donation.v1`: JSON with base64 `data`). Inside is the
 * harness's raw stdout transcript (`.claude-code/stdout.jsonl`,
 * `.codex-code/stdout.jsonl`) — the solve's actual reasoning, which
 * `jinn.trajectory.v1` does NOT carry (2 artifact.emit spans only; #1473
 * tracks fixing that at solve time).
 *
 * `unwrapDonation` mirrors the module-private `decodeDonationArtifact`
 * (`@jinn-network/core/corpus-read`) and additionally verifies the decoded
 * bytes hash to the declared sha256 (tamper check). The ustar reader mirrors
 * the writer: regular files only, names ≤100 chars, no PAX/GNU extensions —
 * a malformed header ends iteration rather than throwing. Decompression is
 * bomb-guarded via zlib's `maxOutputLength`.
 */

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  ClaudeCodeStreamJsonParser,
  CodexExecJsonParser,
  type TranscriptSpanInput,
} from '@jinn-network/core/trajectory';

const DONATION_ENCODING = 'jinn.artifact.donation.v1';

/** Gzip-bomb guard: snapshots observed live are ≤ ~300 KB compressed. */
export const MAX_SNAPSHOT_DECOMPRESSED_BYTES = 32 * 1024 * 1024;

export interface TarEntry {
  name: string;
  bytes: Buffer;
}

export interface SolveTranscript {
  harness: 'claude-code' | 'codex';
  jsonl: string;
}

/** Transcript locations the learner adapters write under the workingDir. */
const TRANSCRIPT_PATHS: Array<{ suffix: string; harness: SolveTranscript['harness'] }> = [
  { suffix: '.claude-code/stdout.jsonl', harness: 'claude-code' },
  { suffix: '.codex-code/stdout.jsonl', harness: 'codex' },
  // .hermes-agent/stdout.log is a ~1KB plain-text log — no decision path; skipped.
];

/**
 * Decode a `jinn.artifact.donation.v1` wrapper to its raw bytes. Throws on a
 * non-donation shape, a declared-sha mismatch against `expectedSha256`, or
 * decoded bytes that do not hash to the declared sha (tamper check — parity
 * plus-one with corpus/acquire.ts `decodeDonationArtifact`).
 */
export function unwrapDonation(raw: unknown, expectedSha256: string): Buffer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('donation artifact payload is not an object');
  }
  const record = raw as Record<string, unknown>;
  if (record['schemaVersion'] !== DONATION_ENCODING || record['encoding'] !== DONATION_ENCODING) {
    throw new Error('donation artifact payload has unexpected encoding');
  }
  if (record['sha256'] !== expectedSha256) {
    throw new Error('donation artifact sha256 does not match requested artifact');
  }
  if (typeof record['data'] !== 'string') {
    throw new Error('donation artifact payload is missing base64 data');
  }
  const bytes = Buffer.from(record['data'], 'base64');
  const computed = createHash('sha256').update(bytes).digest('hex');
  if (computed !== expectedSha256) {
    throw new Error('donation artifact bytes do not hash to the declared sha256');
  }
  return bytes;
}

/**
 * Gunzip (bomb-guarded) + read a POSIX ustar archive into entries. Regular
 * files only; a malformed/truncated header or size field ends iteration
 * (best-effort read of what is intact, never an infinite loop).
 */
export function untarGz(tarGz: Buffer): TarEntry[] {
  const tar = gunzipSync(tarGz, { maxOutputLength: MAX_SNAPSHOT_DECOMPRESSED_BYTES });
  const entries: TarEntry[] = [];
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break; // end-of-archive zero block
    const sizeField = tar
      .subarray(off + 124, off + 136)
      .toString('utf8')
      .replace(/\0.*$/, '')
      .trim();
    const size = parseInt(sizeField, 8);
    if (!Number.isFinite(size) || size < 0) break; // malformed header — stop
    const typeflag = String.fromCharCode(tar[off + 156] ?? 48);
    const bodyStart = off + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > tar.length) break; // truncated body — stop
    if (typeflag === '0' || typeflag === '\0') {
      entries.push({ name, bytes: tar.subarray(bodyStart, bodyEnd) });
    }
    off = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** Locate the solve transcript among snapshot entries, or null if absent. */
export function findSolveTranscript(entries: TarEntry[]): SolveTranscript | null {
  for (const { suffix, harness } of TRANSCRIPT_PATHS) {
    const entry = entries.find((e) => e.name === suffix || e.name.endsWith(`/${suffix}`));
    if (entry) return { harness, jsonl: entry.bytes.toString('utf8') };
  }
  return null;
}

/**
 * End-to-end: donation wrapper JSON → the solve transcript, or null when the
 * snapshot carries none (hermes, or transcript-less). Throws on unwrap /
 * decompression failures — the caller treats any throw as "no enrichment".
 */
export function extractSnapshotTranscript(
  wrapper: unknown,
  expectedSha256: string,
): SolveTranscript | null {
  const bytes = unwrapDonation(wrapper, expectedSha256);
  return findSolveTranscript(untarGz(bytes));
}

/** Parse snapshot stdout with the same canonical typed-span parser as the live path. */
export function parseSolveTranscript(
  transcript: SolveTranscript,
): TranscriptSpanInput[] {
  const parser = transcript.harness === 'claude-code'
    ? new ClaudeCodeStreamJsonParser()
    : new CodexExecJsonParser();
  return parser.parseText(transcript.jsonl);
}
