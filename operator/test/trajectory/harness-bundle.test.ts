import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { assembleBundle } from '../../src/trajectory/harness-bundle.js';
import { EMPTY_BUNDLE_SHA256 } from '../../src/trajectory/schema.js';
import { HarnessBundleManifestSchema } from '../../src/trajectory/harness-bundle-schema.js';

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('assembleBundle', () => {
  let home: string;
  let repoRoot: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'asm-home-'));
    repoRoot = await mkdtemp(path.join(tmpdir(), 'asm-repo-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('returns included=false + EMPTY_BUNDLE_SHA256 when enabled=false', async () => {
    const result = await assembleBundle({
      tool: 'claude-code',
      home,
      repoRoot,
      allowedDirectories: [home],
      enabled: false,
      capturePath: 'A',
    });
    expect(result.included).toBe(false);
    expect(result.bundleSha256).toBe(EMPTY_BUNDLE_SHA256);
    expect(result.manifest).toBeNull();
    expect(result.files).toEqual([]);
  });

  it('returns included=false + EMPTY_BUNDLE_SHA256 when no candidates pass the allowedDirectories filter', async () => {
    // home contains the candidate paths; allowed dir is somewhere unrelated
    const otherDir = await mkdtemp(path.join(tmpdir(), 'asm-other-'));
    try {
      const result = await assembleBundle({
        tool: 'claude-code',
        home,
        repoRoot,
        allowedDirectories: [otherDir],
        enabled: true,
        capturePath: 'A',
      });
      expect(result.included).toBe(false);
      expect(result.bundleSha256).toBe(EMPTY_BUNDLE_SHA256);
      expect(result.manifest).toBeNull();
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it('returns included=true with one allowed file present on disk', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    const filePath = path.join(home, '.claude', 'CLAUDE.md');
    await writeFile(filePath, 'hello world\n');

    const result = await assembleBundle({
      tool: 'claude-code',
      home,
      repoRoot,
      allowedDirectories: [home],
      enabled: true,
      capturePath: 'A',
    });
    expect(result.included).toBe(true);
    expect(result.manifest).not.toBeNull();
    expect(result.files.length).toBe(1);
    expect(result.files[0].absolutePath).toBe(filePath);
    expect(result.files[0].relPath).toBe(path.join('.claude', 'CLAUDE.md'));
    expect(result.files[0].sha256).toBe(sha256Hex(Buffer.from('hello world\n', 'utf-8')));
    expect(result.files[0].bytes).toBe('hello world\n'.length);
    // Manifest validates against the zod schema.
    const parsed = HarnessBundleManifestSchema.safeParse(result.manifest);
    expect(parsed.success).toBe(true);
  });

  it('is deterministic — same input produces identical bundleSha256', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude', 'CLAUDE.md'), 'one\n');
    await writeFile(path.join(home, '.claude', 'settings.json'), '{"model":"x"}');

    const a = await assembleBundle({
      tool: 'claude-code',
      home,
      repoRoot,
      allowedDirectories: [home],
      enabled: true,
      capturePath: 'A',
    });
    const b = await assembleBundle({
      tool: 'claude-code',
      home,
      repoRoot,
      allowedDirectories: [home],
      enabled: true,
      capturePath: 'A',
    });
    expect(a.bundleSha256).toBe(b.bundleSha256);
    expect(a.manifest).toEqual(b.manifest);
  });

  it('silently skips non-existent candidate files', async () => {
    // Create only CLAUDE.md; settings.json is a candidate but absent.
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude', 'CLAUDE.md'), 'hi');

    const result = await assembleBundle({
      tool: 'claude-code',
      home,
      repoRoot,
      allowedDirectories: [home],
      enabled: true,
      capturePath: 'A',
    });
    expect(result.included).toBe(true);
    const paths = result.files.map((f) => f.absolutePath);
    expect(paths).toContain(path.join(home, '.claude', 'CLAUDE.md'));
    expect(paths).not.toContain(path.join(home, '.claude', 'settings.json'));
  });

  it('allowedDirectories filter excludes files outside any allowed root', async () => {
    // CLAUDE.md in home; another file in repoRoot. Only allow home.
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude', 'CLAUDE.md'), 'home');
    await writeFile(path.join(repoRoot, 'CLAUDE.md'), 'repo');

    const result = await assembleBundle({
      tool: 'claude-code',
      home,
      repoRoot,
      allowedDirectories: [home],
      enabled: true,
      capturePath: 'A',
    });
    expect(result.included).toBe(true);
    const paths = result.files.map((f) => f.absolutePath);
    expect(paths).toContain(path.join(home, '.claude', 'CLAUDE.md'));
    expect(paths).not.toContain(path.join(repoRoot, 'CLAUDE.md'));
  });

  it('canonicalises CRLF line endings to LF before hashing', async () => {
    // Two scenarios: CRLF-content vs LF-content with otherwise-identical bytes.
    const homeA = await mkdtemp(path.join(tmpdir(), 'asm-crlf-'));
    const homeB = await mkdtemp(path.join(tmpdir(), 'asm-lf-'));
    try {
      await mkdir(path.join(homeA, '.claude'), { recursive: true });
      await mkdir(path.join(homeB, '.claude'), { recursive: true });
      await writeFile(path.join(homeA, '.claude', 'CLAUDE.md'), 'a\r\nb\r\nc');
      await writeFile(path.join(homeB, '.claude', 'CLAUDE.md'), 'a\nb\nc');

      const a = await assembleBundle({
        tool: 'claude-code',
        home: homeA,
        allowedDirectories: [homeA],
        enabled: true,
        capturePath: 'A',
      });
      const b = await assembleBundle({
        tool: 'claude-code',
        home: homeB,
        allowedDirectories: [homeB],
        enabled: true,
        capturePath: 'A',
      });

      // Per-file sha256 should match (line endings normalised before hashing).
      expect(a.files[0].sha256).toBe(b.files[0].sha256);
      expect(a.files[0].bytes).toBe(b.files[0].bytes);
    } finally {
      await rm(homeA, { recursive: true, force: true });
      await rm(homeB, { recursive: true, force: true });
    }
  });

  it('sorts manifest.files by relPath regardless of discovery order', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    // Write z first then a — relies on the assembler sorting deterministically.
    await writeFile(path.join(home, '.claude', 'settings.json'), '{}');
    await writeFile(path.join(home, '.claude', 'CLAUDE.md'), 'hi');

    const result = await assembleBundle({
      tool: 'claude-code',
      home,
      allowedDirectories: [home],
      enabled: true,
      capturePath: 'A',
    });
    expect(result.included).toBe(true);
    expect(result.manifest).not.toBeNull();
    const manifestPaths = result.manifest!.files.map((f) => f.path);
    const sorted = [...manifestPaths].sort((a, b) => a.localeCompare(b));
    expect(manifestPaths).toEqual(sorted);
  });

  it('manifest.bundleSha256 = sha256 of canonical-JSON manifest with bundleSha256 zeroed (two-pass hashing)', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude', 'CLAUDE.md'), 'hi');

    const result = await assembleBundle({
      tool: 'claude-code',
      home,
      allowedDirectories: [home],
      enabled: true,
      capturePath: 'A',
    });
    expect(result.included).toBe(true);
    expect(result.manifest).not.toBeNull();
    // Re-derive: canonicalise manifest with bundleSha256='' and hash.
    const recomputed = sha256Hex(
      Buffer.from(JSON.stringify({ ...result.manifest, bundleSha256: '' }), 'utf-8'),
    );
    expect(result.bundleSha256).toBe(recomputed);
    expect(result.manifest!.bundleSha256).toBe(result.bundleSha256);
  });

  it('records tool.version when supplied', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude', 'CLAUDE.md'), 'hi');
    const result = await assembleBundle({
      tool: 'claude-code',
      toolVersion: '0.42.0',
      home,
      allowedDirectories: [home],
      enabled: true,
      capturePath: 'A',
    });
    expect(result.manifest!.tool.version).toBe('0.42.0');
  });

  it('records the capturePath on the manifest', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude', 'CLAUDE.md'), 'hi');
    const result = await assembleBundle({
      tool: 'claude-code',
      home,
      allowedDirectories: [home],
      enabled: true,
      capturePath: 'C',
    });
    expect(result.manifest!.capturePath).toBe('C');
  });
});
