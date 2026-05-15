import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { getRule, type SnapshotRule } from './harness-bundle-rules/types.js';
// Side-effect imports register each rule into the central registry.
import './harness-bundle-rules/claude-code.js';
import './harness-bundle-rules/codex.js';
import './harness-bundle-rules/gemini-cli.js';
import './harness-bundle-rules/cursor.js';
import './harness-bundle-rules/aider.js';
import './harness-bundle-rules/continue.js';

import { EMPTY_BUNDLE_SHA256 } from './schema.js';
import type { HarnessBundleManifest } from './harness-bundle-schema.js';

export interface AssembleInput {
  tool: SnapshotRule['tool'];
  /** Optional executor version, recorded as tool.version on the manifest. */
  toolVersion?: string;
  /** Operator's home directory (typically `os.homedir()`). */
  home: string;
  /** Optional repo root, used by repo-local rules (Cursor, repoRoot CLAUDE.md, etc.). */
  repoRoot?: string;
  /**
   * Absolute paths that the operator has allowed the collector to read.
   * Only candidate paths under one of these roots are admitted.
   */
  allowedDirectories: string[];
  /** captures.harnessBundle.enabled (per spec §2.1 config). */
  enabled: boolean;
  /** Capture-path code (A/B/C/D), recorded on the manifest. */
  capturePath: 'A' | 'B' | 'C' | 'D';
}

export interface AssembledFile {
  /** Absolute on-disk path the assembler read. */
  absolutePath: string;
  /** Path within the bundle (relative to `home`). */
  relPath: string;
  /** Canonicalised file content (CRLF→LF). */
  content: Buffer;
  /** sha256 of the canonical content. */
  sha256: string;
  /** Byte length of the canonical content. */
  bytes: number;
}

export interface AssembleOutput {
  /** false when no bundle was produced (opt-out or no admitted files). */
  included: boolean;
  /** sha256 of the canonical manifest (with bundleSha256 zeroed during hashing). */
  bundleSha256: string;
  /** Manifest mirroring the bundle's per-file inventory; null when included=false. */
  manifest: HarnessBundleManifest | null;
  /** Canonicalised file payloads, sorted by relPath. */
  files: AssembledFile[];
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Returns true if `candidate` lies inside (or equals) any of the supplied
 * allowed roots. Path comparison is exact-match-or-prefix-with-separator.
 */
function isUnderAllowedRoot(candidate: string, roots: string[]): boolean {
  return roots.some(
    (root) => candidate === root || candidate.startsWith(root + path.sep),
  );
}

/**
 * Canonicalise file content for stable hashing across platforms:
 * normalise CRLF and lone CR to LF. This means a Windows-checked-out
 * file and a Unix-checked-out file with the same logical content
 * produce the same sha256 — and therefore the same bundle hash.
 */
function canonicaliseContent(raw: Buffer): Buffer {
  const text = raw.toString('utf-8');
  const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return Buffer.from(normalised, 'utf-8');
}

/**
 * Assemble the harness bundle for one capture.
 *
 * The bundle is the operator's resolved harness configuration at session
 * capture time. Its deterministic sha256 becomes `executor.codeDigest` on
 * the capture envelope, making the capture replayable: a third party can
 * fetch the bundle, reconstitute the harness, and reproduce the result.
 *
 * Determinism contract (per spec §3.1, §3.2):
 *   - Files canonicalised (CRLF→LF) before hashing.
 *   - Per-file shas computed from canonical bytes.
 *   - manifest.files sorted by relPath (locale-sensitive but locale-agnostic
 *     for ASCII paths, which is what we expect).
 *   - bundleSha256 = sha256(JSON.stringify(manifest with bundleSha256='')).
 *     Two-pass: hash the zeroed manifest, then write the result back.
 *
 * Opt-out and empty-bundle semantics:
 *   - enabled=false → included=false, bundleSha256=EMPTY_BUNDLE_SHA256.
 *   - enabled=true but no candidates pass the allowedDirectories filter or
 *     all candidates are missing on disk → included=false,
 *     bundleSha256=EMPTY_BUNDLE_SHA256, manifest=null. The capture envelope
 *     signals opt-out by ABSENCE of the harness-bundle artifact, not by
 *     publishing an empty manifest.
 */
export async function assembleBundle(input: AssembleInput): Promise<AssembleOutput> {
  if (!input.enabled) {
    return {
      included: false,
      bundleSha256: EMPTY_BUNDLE_SHA256,
      manifest: null,
      files: [],
    };
  }

  const rule = getRule(input.tool);
  const candidates = await rule.candidatePaths({
    home: input.home,
    repoRoot: input.repoRoot,
  });

  // Apply allowedDirectories filter.
  const allowed = candidates.filter((p) =>
    isUnderAllowedRoot(p, input.allowedDirectories),
  );

  // Read each allowed file; silently skip missing ones.
  const files: AssembledFile[] = [];
  for (const abs of allowed) {
    let raw: Buffer;
    try {
      raw = await readFile(abs);
    } catch {
      continue;
    }
    const canonical = canonicaliseContent(raw);
    const sha = sha256Hex(canonical);
    const relPath = path.relative(input.home, abs);
    files.push({
      absolutePath: abs,
      relPath,
      content: canonical,
      sha256: sha,
      bytes: canonical.length,
    });
  }

  // Deterministic order for stable bundle hashing.
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  if (files.length === 0) {
    return {
      included: false,
      bundleSha256: EMPTY_BUNDLE_SHA256,
      manifest: null,
      files: [],
    };
  }

  // Two-pass hashing: build manifest with bundleSha256='', hash the
  // canonical-JSON of that, then assign the result back.
  const manifest: HarnessBundleManifest = {
    schemaVersion: 'harness-bundle.v1',
    bundleSha256: '',
    capturePath: input.capturePath,
    tool: { name: input.tool, version: input.toolVersion },
    files: files.map((f) => ({
      path: f.relPath,
      sha256: f.sha256,
      bytes: f.bytes,
    })),
  };

  const canonicalJson = JSON.stringify({ ...manifest, bundleSha256: '' });
  const bundleSha = sha256Hex(Buffer.from(canonicalJson, 'utf-8'));
  manifest.bundleSha256 = bundleSha;

  return {
    included: true,
    bundleSha256: bundleSha,
    manifest,
    files,
  };
}
