/**
 * Restorer engine — workingDir provisioning + artifact walking + IPFS upload.
 *
 * §6.6 workdir layout, §5.3 artifact artifactType conventions.
 *
 * Responsibilities:
 *   1. Provision workingDir at PRE_SNAPSHOT time: write intent.json, env/ files,
 *      sessions/ dir.
 *   2. After impl returns: walk workingDir, read OUTPUTS.json (if present),
 *      compute sha256, upload each artifact to IPFS, return structured list.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, extname, isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { z } from 'zod';
import type { RestorationJob } from '../../types/desired-state.js';
import type { Artifact, OutputArtifact } from '../../types/portfolio.js';
import { uploadToIpfs } from '../../adapters/mech/ipfs.js';
import type { TrajectoryCollector } from '../../trajectory/collector.js';

// ── OUTPUTS.json schema ───────────────────────────────────────────────────────

const OutputEntrySchema = z.object({
  path: z.string(),
  artifactType: z.string(),
  metadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  access: z
    .object({
      kind: z.enum(['open', 'x402-gated']),
      endpoint: z.string().optional(),
      priceUsdc: z.string().optional(),
    })
    .optional(),
}).superRefine((val, ctx) => {
  if ('role' in val && !('artifactType' in val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "OUTPUTS.json field 'role' is renamed to 'artifactType' — update your outputs declaration",
    });
  }
});

const OutputsJsonSchema = z.object({
  outputs: z.array(OutputEntrySchema),
});

type OutputEntry = z.infer<typeof OutputEntrySchema>;

// ── Uploaded artifact ─────────────────────────────────────────────────────────

export interface UploadedArtifact extends Artifact {
  localPath: string;
}

// ── Deps injected by engine ───────────────────────────────────────────────────

export interface PackagingDeps {
  ipfsRegistryUrl: string;
  /**
   * Called after artifact registration is ready (after manifest CID is known).
   * The optional `parentManifestCid` is the IPFS CID of the enclosing manifest,
   * enabling back-pointer links per spec §6.1. Fire-and-forget is fine.
   */
  registerArtifact?: (artifact: {
    id: string;
    title: string;
    tags: string[];
    outcome: string;
    parentManifestCid?: string;
  }) => void;
  /**
   * Optional trajectory collector. When provided, a `jinn.artifact.emit` span
   * is added to the trajectory for each successfully uploaded artifact, and
   * `artifact.metadata.producedBy` is set to `{ spanId, trajectoryCid: '' }`.
   * The engine backfills `trajectoryCid` after `emitTrajectory` completes.
   */
  collector?: TrajectoryCollector;
}

// ── WorkingDir provisioning ───────────────────────────────────────────────────

/**
 * Provision the working directory at PRE_SNAPSHOT time.
 *
 * Creates:
 *   <workingDir>/intent.json     — canonical RestorationJob JSON
 *   <workingDir>/env/<VAR>       — one file per env var (mode 0600)
 *   <workingDir>/sessions/       — directory for session transcripts
 */
export function provisionWorkingDir(
  workingDir: string,
  intent: RestorationJob,
  envVars: Record<string, string> = {},
): void {
  mkdirSync(workingDir, { recursive: true, mode: 0o755 });

  // intent.json
  writeFileSync(join(workingDir, 'intent.json'), JSON.stringify(intent, null, 2), 'utf-8');

  // env/ directory — one file per var, mode 0600
  const envDir = join(workingDir, 'env');
  mkdirSync(envDir, { recursive: true, mode: 0o700 });
  for (const [name, value] of Object.entries(envVars)) {
    writeFileSync(join(envDir, name), value, { encoding: 'utf-8', mode: 0o600 });
  }

  // sessions/ directory
  mkdirSync(join(workingDir, 'sessions'), { recursive: true, mode: 0o755 });
}

/**
 * Provision the impl state directory on first invocation.
 * Never deleted by the engine — persistent across attempts.
 */
export function provisionImplStateDir(implStateDir: string): void {
  mkdirSync(implStateDir, { recursive: true, mode: 0o755 });
}

// ── Tarball helper ────────────────────────────────────────────────────────────

/**
 * Create a gzipped tar of the workingDir at the given output path.
 * Returns the output path.
 *
 * Uses native Node.js streams — no external binary required.
 *
 * DETERMINISM: uses epoch-0 mtime for all entries so the resulting tarball
 * is byte-for-byte identical across retries (same file contents → same CID).
 * The `excludeName` parameter is used to skip the tarball itself so it does
 * not include itself.
 */
async function createWorkdirTarball(
  workingDir: string,
  outputPath: string,
  excludeName?: string,
): Promise<string> {
  // Build a simple tar manually using Buffer operations to avoid spawning
  // external processes. For correctness and portability we use a pure-JS
  // approach: read all files, pack them into a POSIX tar, gzip the result.
  const entries: Array<{ relPath: string; content: Buffer }> = [];

  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        const relDir = relative(workingDir, full);
        // Security: exclude env/ and everything inside it — env/ contains
        // secrets written at mode 0o600 by provisionWorkingDir and must never
        // appear in a publicly-uploaded IPFS tarball. We check both "env" (the
        // directory itself at workingDir root) and any path that starts with
        // "env/" (nested contents, though the guard on the directory entry
        // below already handles recursion).
        if (relDir === 'env' || relDir.startsWith('env/') || relDir.startsWith('env\\')) continue;
        walk(full);
      } else if (st.isFile()) {
        const relPath = relative(workingDir, full);
        // Exclude the tarball itself to prevent self-inclusion
        if (excludeName && relPath === excludeName) continue;
        // Exclude anything inside env/ (belt-and-suspenders guard)
        if (relPath.startsWith('env/') || relPath.startsWith('env\\')) continue;
        const content = readFileSync(full);
        entries.push({ relPath, content });
      }
    }
  }

  walk(workingDir);

  // Build ustar-format tar in memory
  const blocks: Buffer[] = [];

  function padStr(s: string, len: number): Buffer {
    const buf = Buffer.alloc(len, 0);
    buf.write(s.slice(0, len), 'utf-8');
    return buf;
  }

  function octalField(n: number, len: number): Buffer {
    const s = n.toString(8).padStart(len - 1, '0') + ' ';
    return Buffer.from(s, 'ascii');
  }

  for (const { relPath, content } of entries) {
    const header = Buffer.alloc(512, 0);
    // name (100)
    padStr(relPath, 100).copy(header, 0);
    // mode (8)
    octalField(0o644, 8).copy(header, 100);
    // uid (8)
    octalField(0, 8).copy(header, 108);
    // gid (8)
    octalField(0, 8).copy(header, 116);
    // size (12)
    octalField(content.length, 12).copy(header, 124);
    // mtime (12) — fixed epoch 0 for deterministic/reproducible tarballs
    octalField(0, 12).copy(header, 136);
    // typeflag
    header[156] = 0x30; // '0' = regular file
    // magic
    Buffer.from('ustar  \0', 'ascii').copy(header, 257);

    // Compute checksum
    header.fill(0x20, 148, 156); // space out checksum field
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i];
    octalField(checksum, 8).copy(header, 148);

    blocks.push(header);

    // Content + padding to 512-byte boundary
    blocks.push(content);
    const remainder = content.length % 512;
    if (remainder > 0) {
      blocks.push(Buffer.alloc(512 - remainder, 0));
    }
  }

  // Two 512-byte zero blocks as end-of-archive marker
  blocks.push(Buffer.alloc(1024, 0));

  const tarData = Buffer.concat(blocks);

  // Gzip compress
  await pipeline(
    (async function* () { yield tarData; })(),
    createGzip(),
    createWriteStream(outputPath),
  );

  return outputPath;
}

// ── Path containment helper ───────────────────────────────────────────────────

/**
 * Returns true iff `candidate` resolves to a path strictly inside `workingDir`.
 * Rejects dotdot traversal, symlink escapes (after resolve), and paths that
 * are equal to workingDir itself (directories, not files).
 */
function isInsideWorkingDir(workingDir: string, candidate: string): boolean {
  const wd = resolve(workingDir);
  const c = resolve(candidate);
  const rel = relative(wd, c);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// ── sha256 helper ─────────────────────────────────────────────────────────────

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ── Artifact walking ──────────────────────────────────────────────────────────

/**
 * Walk the working directory and collect declared + default artifacts.
 *
 * Priority: OUTPUTS.json overrides defaults. After collecting declared entries,
 * we also always add a tarball of the full workingDir as `system_snapshot`.
 */
export async function walkArtifacts(
  workingDir: string,
  implArtifacts: OutputArtifact[] = [],
): Promise<Array<{ localPath: string; artifactType: string; metadata?: Record<string, unknown>; tags?: string[]; access?: { kind: 'open' | 'x402-gated'; endpoint?: string; priceUsdc?: string } }>> {
  const result: Array<{
    localPath: string;
    artifactType: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    access?: { kind: 'open' | 'x402-gated'; endpoint?: string; priceUsdc?: string };
  }> = [];

  // 1. Check for OUTPUTS.json
  const outputsJsonPath = join(workingDir, 'OUTPUTS.json');
  let usedOutputsJson = false;
  if (existsSync(outputsJsonPath)) {
    try {
      const raw = JSON.parse(readFileSync(outputsJsonPath, 'utf-8'));
      const parsed = OutputsJsonSchema.parse(raw);
      for (const entry of parsed.outputs) {
        const fullPath = join(workingDir, entry.path);
        if (!isInsideWorkingDir(workingDir, fullPath)) {
          console.warn(`[restorer-engine] OUTPUTS.json path traversal detected (skipped): ${entry.path}`);
          continue;
        }
        if (existsSync(fullPath) && statSync(fullPath).isFile()) {
          result.push({
            localPath: fullPath,
            artifactType: entry.artifactType,
            metadata: entry.metadata,
            tags: entry.tags,
            access: entry.access,
          });
        }
      }
      usedOutputsJson = true;
    } catch (err) {
      console.warn(`[restorer-engine] OUTPUTS.json parse failed (ignored): ${err instanceof Error ? err.message : err}`);
    }
  }
  if (!usedOutputsJson) {
    // 2. Apply impl-provided OutputArtifact entries
    for (const art of implArtifacts) {
      // Reject absolute paths outright — impl must use workingDir-relative paths
      if (isAbsolute(art.path)) {
        console.warn(`[restorer-engine] impl artifact absolute path rejected (skipped): ${art.path}`);
        continue;
      }
      const fullPath = join(workingDir, art.path);
      if (!isInsideWorkingDir(workingDir, fullPath)) {
        console.warn(`[restorer-engine] impl artifact path traversal detected (skipped): ${art.path}`);
        continue;
      }
      if (existsSync(fullPath) && statSync(fullPath).isFile()) {
        result.push({
          localPath: fullPath,
          artifactType: art.artifactType,
          metadata: art.metadata,
          tags: art.tags,
          access: art.access,
        });
      }
    }

    // 3. Apply default conventions for files not already declared
    const declared = new Set(result.map((r) => r.localPath));

    // sessions/ → session_transcript
    const sessionsDir = join(workingDir, 'sessions');
    if (existsSync(sessionsDir)) {
      for (const name of readdirSync(sessionsDir)) {
        const full = join(sessionsDir, name);
        if (statSync(full).isFile() && !declared.has(full)) {
          result.push({ localPath: full, artifactType: 'session_transcript', access: { kind: 'open' } });
        }
      }
    }

    // Markdown files at root → design_document
    const rootFiles = readdirSync(workingDir);
    for (const name of rootFiles) {
      const full = join(workingDir, name);
      if (
        statSync(full).isFile() &&
        extname(name).toLowerCase() === '.md' &&
        !declared.has(full)
      ) {
        result.push({ localPath: full, artifactType: 'design_document', access: { kind: 'open' } });
      }
    }

    // logs/ → runtime_log
    const logsDir = join(workingDir, 'logs');
    if (existsSync(logsDir)) {
      for (const name of readdirSync(logsDir)) {
        const full = join(logsDir, name);
        if (statSync(full).isFile() && !declared.has(full)) {
          result.push({ localPath: full, artifactType: 'runtime_log', access: { kind: 'open' } });
        }
      }
    }
  }

  // 4. Always add system_snapshot tarball of the full workingDir.
  // Deterministic filename inside workingDir so retries produce the same CID.
  const SNAPSHOT_FILENAME = 'system_snapshot.tar.gz';
  const tarballPath = join(workingDir, SNAPSHOT_FILENAME);
  try {
    await createWorkdirTarball(workingDir, tarballPath, SNAPSHOT_FILENAME);
    result.push({
      localPath: tarballPath,
      artifactType: 'system_snapshot',
      metadata: { description: 'Full workingDir snapshot' },
      access: { kind: 'open' },
    });
  } catch (err) {
    console.warn(`[restorer-engine] workingDir tarball creation failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }

  return result;
}

// ── Upload pipeline ───────────────────────────────────────────────────────────

/**
 * Upload all collected artifacts to IPFS — NO registration.
 *
 * Returns an array of `UploadedArtifact` (= Artifact + localPath).
 * Registration is deferred until the manifest CID is known; call
 * `registerArtifacts(uploaded, parentManifestCid, deps)` afterwards.
 */
export async function uploadArtifacts(
  artifacts: Array<{
    localPath: string;
    artifactType: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    access?: { kind: 'open' | 'x402-gated'; endpoint?: string; priceUsdc?: string };
  }>,
  deps: PackagingDeps,
): Promise<UploadedArtifact[]> {
  const results: UploadedArtifact[] = [];

  for (const art of artifacts) {
    try {
      const content = readFileSync(art.localPath);
      const hash = sha256Hex(content);

      // Upload raw bytes as base64-encoded JSON envelope so IPFS receives JSON
      // (consistent with how other uploads work via uploadToIpfs).
      const envelope = {
        artifactType: art.artifactType,
        sha256: hash,
        data: content.toString('base64'),
      };

      const cid = await uploadToIpfs(deps.ipfsRegistryUrl, envelope);

      const uploaded: UploadedArtifact = {
        cid,
        sha256: hash,
        artifactType: art.artifactType,
        metadata: art.metadata,
        tags: art.tags,
        access: art.access,
        localPath: art.localPath,
      };

      // Forward linkage: emit a jinn.artifact.emit span and attach a producedBy
      // back-reference so readers can look up which span produced this artifact.
      // trajectoryCid is unknown at packaging time — the engine backfills it after
      // emitTrajectory completes (Task 16 backward linkage).
      if (deps.collector) {
        const nowNano = String(BigInt(Date.now()) * 1_000_000n);
        const span = deps.collector.addSpan({
          name: 'artifact.emit',
          kind: 'INTERNAL',
          startTimeUnixNano: nowNano,
          endTimeUnixNano: nowNano,
          attributes: {
            'jinn.span.kind': 'jinn.artifact.emit',
            'jinn.artifact.cid': cid,
            'jinn.artifact.artifactType': art.artifactType,
            'jinn.artifact.sha256': hash,
          },
          events: [],
          status: { code: 'OK' },
        });
        uploaded.metadata = {
          ...uploaded.metadata,
          producedBy: { spanId: span.spanId, trajectoryCid: '' },
        };
      }

      results.push(uploaded);
    } catch (err) {
      console.error(`[restorer-engine] artifact upload failed for ${art.localPath}: ${err instanceof Error ? err.message : err}`);
      // Non-fatal: continue with remaining artifacts
    }
  }

  return results;
}

/**
 * Register already-uploaded artifacts with a back-pointer to the parent manifest CID.
 *
 * Call this AFTER the manifest has been assembled, signed, and uploaded so that
 * `parentManifestCid` is known (spec §6.1 requirement). Fire-and-forget.
 */
export function registerArtifacts(
  uploaded: UploadedArtifact[],
  parentManifestCid: string,
  deps: PackagingDeps,
): void {
  if (!deps.registerArtifact) return;
  for (const art of uploaded) {
    deps.registerArtifact({
      id: art.cid,
      title: art.localPath.split('/').pop() ?? art.cid,
      tags: art.tags ?? [art.artifactType],
      outcome: 'uploaded',
      parentManifestCid,
    });
  }
}
