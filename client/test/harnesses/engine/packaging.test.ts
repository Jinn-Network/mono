import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import {
  provisionWorkingDir,
  provisionImplStateDir,
  walkArtifacts,
  uploadArtifacts,
} from '../../../src/harnesses/engine/packaging.js';
import type { Task } from '../../../src/types/task.js';
import { TrajectoryCollector } from '../../../src/trajectory/collector.js';
import { Store } from '../../../src/store/store.js';

function mkPkgDeps(extra: { collector?: TrajectoryCollector } = {}) {
  return {
    store: new Store(':memory:'),
    operatorEndpoint: 'https://op.test',
    defaultPriceUsdc: '0',
    perArtifactTypePrice: {} as Record<string, string>,
    requestId: '0x' + 'a'.repeat(64),
    ...extra,
  };
}

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn().mockResolvedValue('bafyartifact123'),
}));

/**
 * Extract file paths from a gzipped tar buffer using raw ustar header parsing.
 * Returns the set of relative paths stored in the archive.
 */
function listTarPaths(tarGzBuffer: Buffer): Set<string> {
  const tar = gunzipSync(tarGzBuffer);
  const paths = new Set<string>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const nameBytes = tar.slice(offset, offset + 100);
    // Find null terminator
    let end = nameBytes.indexOf(0);
    if (end === -1) end = 100;
    const name = nameBytes.toString('utf-8', 0, end);
    if (name === '') break; // End-of-archive zero block
    // Read size from octal field at offset+124, 12 bytes
    const sizeStr = tar.toString('ascii', offset + 124, offset + 136).replace(/\0/g, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    paths.add(name);
    // Advance: 512 (header) + ceil(size/512)*512 (content blocks)
    const contentBlocks = Math.ceil(size / 512);
    offset += 512 + contentBlocks * 512;
  }
  return paths;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mkTmp(): string {
  const dir = join(tmpdir(), `pkg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanTmp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

const sampleTask: Task = {
  id: 'req-001',
  description: 'Test task',
  solverType: 'portfolio.v0',
  spec: {},
  window: { startTs: 1000, endTs: 2000 },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('provisionWorkingDir', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmp(); });
  afterEach(() => cleanTmp(tmp));

  it('creates task.json with serialised Task', () => {
    const workingDir = join(tmp, 'work');
    provisionWorkingDir(workingDir, sampleTask);
    const taskJson = JSON.parse(readFileSync(join(workingDir, 'task.json'), 'utf-8'));
    expect(taskJson.id).toBe('req-001');
    expect(taskJson.description).toBe('Test task');
  });

  it('creates sessions/ directory', () => {
    const workingDir = join(tmp, 'work');
    provisionWorkingDir(workingDir, sampleTask);
    expect(existsSync(join(workingDir, 'sessions'))).toBe(true);
  });

  it('creates env/ directory', () => {
    const workingDir = join(tmp, 'work');
    provisionWorkingDir(workingDir, sampleTask);
    expect(existsSync(join(workingDir, 'env'))).toBe(true);
  });

  it('writes env var files', () => {
    const workingDir = join(tmp, 'work');
    provisionWorkingDir(workingDir, sampleTask, { MY_VAR: 'secret', ANOTHER: 'value' });
    expect(readFileSync(join(workingDir, 'env', 'MY_VAR'), 'utf-8')).toBe('secret');
    expect(readFileSync(join(workingDir, 'env', 'ANOTHER'), 'utf-8')).toBe('value');
  });

  it('is idempotent when called twice', () => {
    const workingDir = join(tmp, 'work');
    provisionWorkingDir(workingDir, sampleTask);
    provisionWorkingDir(workingDir, sampleTask); // Should not throw
    expect(existsSync(join(workingDir, 'task.json'))).toBe(true);
  });

  it('writes env var files with mode 0600', () => {
    const workingDir = join(tmp, 'work');
    provisionWorkingDir(workingDir, sampleTask, { SECRET_KEY: 'hunter2', API_TOKEN: 'tok123' });
    const secretStats = statSync(join(workingDir, 'env', 'SECRET_KEY'));
    const tokenStats = statSync(join(workingDir, 'env', 'API_TOKEN'));
    // On Unix: mode & 0o777 gives the permission bits; env files must be owner-read-write only.
    expect(secretStats.mode & 0o777).toBe(0o600);
    expect(tokenStats.mode & 0o777).toBe(0o600);
  });
});

describe('provisionImplStateDir', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmp(); });
  afterEach(() => cleanTmp(tmp));

  it('creates the directory', () => {
    const implDir = join(tmp, 'impl', 'my-impl');
    provisionImplStateDir(implDir);
    expect(existsSync(implDir)).toBe(true);
  });

  it('is idempotent', () => {
    const implDir = join(tmp, 'impl', 'my-impl');
    provisionImplStateDir(implDir);
    provisionImplStateDir(implDir); // Should not throw
    expect(existsSync(implDir)).toBe(true);
  });
});

describe('walkArtifacts', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmp(); });
  afterEach(() => cleanTmp(tmp));

  function makeWorkdir(): string {
    const workDir = join(tmp, 'workdir');
    mkdirSync(workDir, { recursive: true });
    mkdirSync(join(workDir, 'sessions'), { recursive: true });
    mkdirSync(join(workDir, 'env'), { recursive: true });
    return workDir;
  }

  it('returns system_snapshot tarball when no files present', async () => {
    const workDir = makeWorkdir();
    const artifacts = await walkArtifacts(workDir);
    // Should have at least the system_snapshot tarball
    const snapshot = artifacts.find((a) => a.artifactType === 'system_snapshot');
    expect(snapshot).toBeDefined();
  });

  it('discovers session transcripts by default', async () => {
    const workDir = makeWorkdir();
    writeFileSync(join(workDir, 'sessions', 'session-1.jsonl'), '{"msg":"hello"}');
    const artifacts = await walkArtifacts(workDir);
    const session = artifacts.find((a) => a.artifactType === 'session_transcript');
    expect(session).toBeDefined();
    expect(session!.localPath).toContain('session-1.jsonl');
    expect(session!.access?.priceUsdc).toBe('0');
  });

  it('discovers markdown files at root as design_document', async () => {
    const workDir = makeWorkdir();
    writeFileSync(join(workDir, 'PLAN.md'), '# Plan');
    const artifacts = await walkArtifacts(workDir);
    const doc = artifacts.find((a) => a.artifactType === 'design_document');
    expect(doc).toBeDefined();
    expect(doc!.localPath).toContain('PLAN.md');
  });

  it('discovers log files in logs/', async () => {
    const workDir = makeWorkdir();
    mkdirSync(join(workDir, 'logs'), { recursive: true });
    writeFileSync(join(workDir, 'logs', 'run.log'), 'log line');
    const artifacts = await walkArtifacts(workDir);
    const log = artifacts.find((a) => a.artifactType === 'runtime_log');
    expect(log).toBeDefined();
    expect(log!.localPath).toContain('run.log');
  });

  it('uses OUTPUTS.json when present, ignoring defaults', async () => {
    const workDir = makeWorkdir();
    writeFileSync(join(workDir, 'sessions', 'session-1.jsonl'), 'data');
    writeFileSync(join(workDir, 'my-file.txt'), 'content');
    const outputs = { outputs: [{ path: 'my-file.txt', artifactType: 'generated_file' }] };
    writeFileSync(join(workDir, 'OUTPUTS.json'), JSON.stringify(outputs));

    const artifacts = await walkArtifacts(workDir);
    // Only declared artifact + snapshot tarball
    const declared = artifacts.filter((a) => a.artifactType === 'generated_file');
    expect(declared).toHaveLength(1);
    // session_transcript should NOT appear (OUTPUTS.json takes over)
    const session = artifacts.filter((a) => a.artifactType === 'session_transcript');
    expect(session).toHaveLength(0);
  });

  it('includes impl-provided OutputArtifacts (relative path)', async () => {
    const workDir = makeWorkdir();
    writeFileSync(join(workDir, 'custom.json'), '{}');
    const artifacts = await walkArtifacts(workDir, [
      // impl must supply relative paths; absolute paths are rejected
      { path: 'custom.json', artifactType: 'execution_log', tags: ['custom'] },
    ]);
    const custom = artifacts.find((a) => a.artifactType === 'execution_log');
    expect(custom).toBeDefined();
    expect(custom!.tags).toContain('custom');
  });

  it('rejects impl artifact with dotdot traversal path', async () => {
    const workDir = makeWorkdir();
    // Write a file in a sibling directory to verify the traversal would reach it
    const artifacts = await walkArtifacts(workDir, [
      { path: '../../../etc/passwd', artifactType: 'execution_log' },
    ]);
    // Should be skipped — traversal detected
    const found = artifacts.find((a) => a.artifactType === 'execution_log');
    expect(found).toBeUndefined();
  });

  it('rejects impl artifact with absolute path', async () => {
    const workDir = makeWorkdir();
    const artifacts = await walkArtifacts(workDir, [
      { path: '/etc/passwd', artifactType: 'execution_log' },
    ]);
    // Should be skipped — absolute paths rejected
    const found = artifacts.find((a) => a.artifactType === 'execution_log');
    expect(found).toBeUndefined();
  });

  it('rejects OUTPUTS.json entry with dotdot traversal path', async () => {
    const workDir = makeWorkdir();
    const outputs = { outputs: [{ path: '../../../etc/passwd', artifactType: 'stolen' }] };
    writeFileSync(join(workDir, 'OUTPUTS.json'), JSON.stringify(outputs));
    const artifacts = await walkArtifacts(workDir);
    const found = artifacts.find((a) => a.artifactType === 'stolen');
    expect(found).toBeUndefined();
  });

  it('gracefully handles missing OUTPUTS.json paths', async () => {
    const workDir = makeWorkdir();
    const outputs = { outputs: [{ path: 'nonexistent.txt', artifactType: 'generated_file' }] };
    writeFileSync(join(workDir, 'OUTPUTS.json'), JSON.stringify(outputs));
    // Should not throw — just skips missing paths
    const artifacts = await walkArtifacts(workDir);
    const generated = artifacts.filter((a) => a.artifactType === 'generated_file');
    expect(generated).toHaveLength(0);
  });

  it('handles invalid OUTPUTS.json gracefully (falls back to defaults)', async () => {
    const workDir = makeWorkdir();
    writeFileSync(join(workDir, 'sessions', 'session-1.jsonl'), 'data');
    writeFileSync(join(workDir, 'OUTPUTS.json'), 'not-json{{{');
    // Should warn but not throw; falls back to default discovery
    const artifacts = await walkArtifacts(workDir);
    const session = artifacts.find((a) => a.artifactType === 'session_transcript');
    expect(session).toBeDefined();
  });
});

// ── Tarball env/ exclusion (security, finding #11) ───────────────────────────

describe('system_snapshot tarball excludes non-donation execution data', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmp(); });
  afterEach(() => cleanTmp(tmp));

  it('does NOT include env secrets, task checkouts, VCS data, dependencies, or caches in the produced tarball', async () => {
    const workDir = join(tmp, 'workdir');
    mkdirSync(workDir, { recursive: true });
    mkdirSync(join(workDir, 'env'), { recursive: true });
    mkdirSync(join(workDir, 'work'), { recursive: true });
    mkdirSync(join(workDir, 'sessions'), { recursive: true });
    mkdirSync(join(workDir, 'repo', '.git', 'objects', 'pack'), { recursive: true });
    mkdirSync(join(workDir, 'repo', 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(workDir, 'repo', '.pytest_cache'), { recursive: true });
    mkdirSync(join(workDir, 'repo', 'src'), { recursive: true });

    // Secret file (mode 0600 — env vars written by provisionWorkingDir)
    writeFileSync(join(workDir, 'env', 'SECRET_KEY'), 'hunter2', { mode: 0o600 });
    writeFileSync(join(workDir, 'env', 'API_TOKEN'), 'tok123', { mode: 0o600 });
    writeFileSync(join(workDir, 'repo', '.git', 'objects', 'pack', 'pack-1.pack'), 'git pack');
    writeFileSync(join(workDir, 'repo', 'node_modules', 'pkg', 'index.js'), 'dependency');
    writeFileSync(join(workDir, 'repo', '.pytest_cache', 'state'), 'cache');
    writeFileSync(join(workDir, 'repo', 'src', 'task-source.py'), 'print("task checkout")');

    // Normal file that SHOULD be in the tarball
    writeFileSync(join(workDir, 'work', 'normal.json'), '{"result":true}');

    const artifacts = await walkArtifacts(workDir);
    const snapshot = artifacts.find((a) => a.artifactType === 'system_snapshot');
    expect(snapshot).toBeDefined();

    // Read the produced tarball and list its contents
    const tarGzBuffer = readFileSync(snapshot!.localPath);
    const paths = listTarPaths(tarGzBuffer);

    // Secrets must NOT appear
    expect([...paths].some((p) => p.startsWith('env/'))).toBe(false);
    expect([...paths].some((p) => p === 'env/SECRET_KEY')).toBe(false);
    expect([...paths].some((p) => p === 'env/API_TOKEN')).toBe(false);
    expect([...paths].some((p) => p.includes('/.git/') || p.startsWith('.git/'))).toBe(false);
    expect([...paths].some((p) => p.includes('/node_modules/') || p.startsWith('node_modules/'))).toBe(false);
    expect([...paths].some((p) => p.includes('/.pytest_cache/') || p.startsWith('.pytest_cache/'))).toBe(false);
    expect([...paths].some((p) => p.startsWith('repo/'))).toBe(false);

    // Normal file must still be present
    expect([...paths].some((p) => p.includes('normal.json'))).toBe(true);
  });

  it('env/ exclusion survives provisionWorkingDir (integration)', async () => {
    const workDir = join(tmp, 'workdir2');
    const intent: Task = { id: 'test', description: 'Test' };
    provisionWorkingDir(workDir, intent, { API_KEY: 'supersecret' });

    const artifacts = await walkArtifacts(workDir);
    const snapshot = artifacts.find((a) => a.artifactType === 'system_snapshot');
    expect(snapshot).toBeDefined();

    const tarGzBuffer = readFileSync(snapshot!.localPath);
    const paths = listTarPaths(tarGzBuffer);

    // API_KEY file written by provisionWorkingDir must not appear in the tarball
    expect([...paths].some((p) => p.startsWith('env/'))).toBe(false);
  });
});

// ── uploadArtifacts — trajectory collector integration (Task 16) ──────────────

describe('uploadArtifacts — trajectory collector', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmp(); });
  afterEach(() => cleanTmp(tmp));

  it('emits a jinn.artifact.emit span per uploaded artifact when collector is provided', async () => {
    const workDir = join(tmp, 'work');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'result.json'), '{"ok":true}');
    writeFileSync(join(workDir, 'notes.md'), '# Notes');

    const collector = new TrajectoryCollector({ taskCid: 'bafy-task', runId: 'run-1' });
    const deps = mkPkgDeps({ collector });

    const artifacts = await uploadArtifacts(
      [
        { localPath: join(workDir, 'result.json'), artifactType: 'generated_file' },
        { localPath: join(workDir, 'notes.md'), artifactType: 'design_document' },
      ],
      deps,
    );

    // Two artifacts → two spans
    const { spans } = collector.snapshot();
    const emitSpans = spans.filter((s) => s.attributes['jinn.span.kind'] === 'jinn.artifact.emit');
    expect(emitSpans).toHaveLength(2);

    // Each span carries a sha256 attribute (cid attribute removed in
    // jinn-mono-vy37.1.2 — artifacts are no longer pinned to IPFS).
    const sha256Hex = emitSpans.map((s) => s.attributes['jinn.artifact.sha256']);
    expect(sha256Hex.every((c) => typeof c === 'string' && /^[0-9a-f]{64}$/.test(c as string))).toBe(true);

    const typeAttrs = emitSpans.map((s) => s.attributes['jinn.artifact.artifactType']);
    expect(typeAttrs).toContain('generated_file');
    expect(typeAttrs).toContain('design_document');

    // sha256 attribute must be a hex string
    const sha256Attrs = emitSpans.map((s) => s.attributes['jinn.artifact.sha256']);
    expect(sha256Attrs.every((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h as string))).toBe(true);

    // The returned artifacts must have producedBy back-refs
    expect(artifacts).toHaveLength(2);
    for (const art of artifacts) {
      const pb = (art.metadata as Record<string, unknown> | undefined)?.['producedBy'];
      expect(pb).toBeDefined();
      expect(typeof (pb as Record<string, unknown>)['spanId']).toBe('string');
      expect((pb as Record<string, unknown>)['trajectoryCid']).toBe('');
    }
  });

  it('does NOT emit spans when no collector is provided', async () => {
    const workDir = join(tmp, 'work2');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'out.txt'), 'data');

    const artifacts = await uploadArtifacts(
      [{ localPath: join(workDir, 'out.txt'), artifactType: 'generated_file' }],
      mkPkgDeps(),
    );

    // No producedBy metadata when collector is absent
    expect(artifacts).toHaveLength(1);
    expect((artifacts[0]!.metadata as Record<string, unknown> | undefined)?.['producedBy']).toBeUndefined();
  });

  it('each span spanId matches the producedBy.spanId on the corresponding artifact', async () => {
    const workDir = join(tmp, 'work3');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'a.txt'), 'aaa');
    writeFileSync(join(workDir, 'b.txt'), 'bbb');

    const collector = new TrajectoryCollector({ taskCid: 'bafy-task', runId: 'run-x' });
    const artifacts = await uploadArtifacts(
      [
        { localPath: join(workDir, 'a.txt'), artifactType: 'execution_log' },
        { localPath: join(workDir, 'b.txt'), artifactType: 'execution_log' },
      ],
      mkPkgDeps({ collector }),
    );

    const { spans } = collector.snapshot();
    const emitSpans = spans.filter((s) => s.attributes['jinn.span.kind'] === 'jinn.artifact.emit');
    expect(emitSpans).toHaveLength(2);

    // Order must be preserved: first artifact → first emit span
    for (let i = 0; i < artifacts.length; i++) {
      const pb = (artifacts[i]!.metadata as Record<string, unknown>)['producedBy'] as Record<string, unknown>;
      expect(pb['spanId']).toBe(emitSpans[i]!.spanId);
    }
  });

  it('preserves existing metadata alongside producedBy', async () => {
    const workDir = join(tmp, 'work4');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'file.txt'), 'data');

    const collector = new TrajectoryCollector({ taskCid: 'bafy-task', runId: 'run-y' });
    const artifacts = await uploadArtifacts(
      [{ localPath: join(workDir, 'file.txt'), artifactType: 'generated_file', metadata: { custom: 'value' } }],
      mkPkgDeps({ collector }),
    );

    expect(artifacts).toHaveLength(1);
    const meta = artifacts[0]!.metadata as Record<string, unknown>;
    // Original metadata key preserved
    expect(meta['custom']).toBe('value');
    // producedBy added alongside
    expect(meta['producedBy']).toBeDefined();
  });
});
