import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Store } from '../../../src/store/store.js';
import {
  uploadArtifacts,
  walkArtifacts,
} from '../../../src/harnesses/engine/packaging.js';

const { uploadToIpfsMock } = vi.hoisted(() => ({
  uploadToIpfsMock: vi.fn(async () => 'bafy-donation-artifact'),
}));

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: uploadToIpfsMock,
  cidToDigestHex: vi.fn(),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function tarEntries(tarGz: Buffer): Record<string, Buffer> {
  const tar = gunzipSync(tarGz);
  const entries: Record<string, Buffer> = {};
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeOctal = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeOctal, 8);
    const start = offset + 512;
    entries[name] = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe('uploadArtifacts donation mode', () => {
  let store: Store;
  let workDir: string;

  beforeEach(() => {
    uploadToIpfsMock.mockClear();
    uploadToIpfsMock.mockResolvedValue('bafy-donation-artifact');
    store = new Store(':memory:');
    workDir = mkdtempSync(join(tmpdir(), 'jinn-donation-'));
  });

  afterEach(() => {
    store.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('scrubs before hashing, stores scrubbed bytes, and records IPFS source', async () => {
    const file = join(workDir, 'artifact.json');
    writeFileSync(file, JSON.stringify({
      message: 'built by adriano on 192.168.1.2',
      token: 'secret-value',
    }));

    const uploaded = await uploadArtifacts(
      [{ localPath: file, artifactType: 'design_document' }],
      {
        store,
        operatorEndpoint: 'https://op.example.com',
        defaultPriceUsdc: '0',
        perArtifactTypePrice: {},
        requestId: '0x' + 'a'.repeat(64),
        donation: {
          enabled: true,
          ipfsRegistryUrl: 'https://registry.example.com',
          scrub: { identity: { username: 'adriano' } },
        },
      },
    );

    expect(uploadToIpfsMock).toHaveBeenCalledOnce();
    const wrapper = uploadToIpfsMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(wrapper.schemaVersion).toBe('jinn.artifact.donation.v1');
    expect(wrapper.encoding).toBe('jinn.artifact.donation.v1');

    const scrubbedBytes = Buffer.from(wrapper.data as string, 'base64');
    const scrubbed = JSON.parse(scrubbedBytes.toString('utf8')) as Record<string, unknown>;
    expect(scrubbed.message).toBe('built by <USER> on <IPV4>');
    expect(scrubbed.token).toBe('<REDACTED>');

    const scrubbedSha = sha256Hex(scrubbedBytes);
    expect(wrapper.sha256).toBe(scrubbedSha);
    expect(uploaded[0]!.sha256).toBe(scrubbedSha);
    expect(uploaded[0]!.sources).toEqual([
      {
        kind: 'ipfs',
        cid: 'bafy-donation-artifact',
        sha256: scrubbedSha,
        encoding: 'jinn.artifact.donation.v1',
      },
    ]);

    const row = store.getServedArtifact(scrubbedSha);
    expect(row).not.toBeNull();
    expect(row!.content.equals(scrubbedBytes)).toBe(true);
  });

  it('fails publish when donation pinning fails', async () => {
    uploadToIpfsMock.mockRejectedValueOnce(new Error('pin failed'));
    const file = join(workDir, 'artifact.txt');
    writeFileSync(file, 'public artifact');

    await expect(
      uploadArtifacts(
        [{ localPath: file, artifactType: 'runtime_log' }],
        {
          store,
          operatorEndpoint: 'https://op.example.com',
          defaultPriceUsdc: '0',
          perArtifactTypePrice: {},
          requestId: '0x' + 'b'.repeat(64),
          donation: {
            enabled: true,
            ipfsRegistryUrl: 'https://registry.example.com',
          },
        },
      ),
    ).rejects.toThrow(/pin failed/);

    expect(store.listServedArtifactMetadata()).toEqual([]);
  });
});

describe('walkArtifacts donation scrub', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'jinn-donation-walk-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('scrubs system_snapshot members and excludes env, task checkouts, VCS data, dependencies, and caches', async () => {
    writeFileSync(join(workDir, 'notes.md'), 'hello adriano');
    writeFileSync(join(workDir, 'config.json'), JSON.stringify({ token: 'secret-value' }));
    writeFileSync(join(workDir, 'OUTPUTS.json'), JSON.stringify({ outputs: [] }));
    const envDir = join(workDir, 'env');
    mkdirSync(envDir);
    writeFileSync(join(envDir, 'API_TOKEN'), 'must-not-appear');
    mkdirSync(join(workDir, 'repo', '.git', 'objects'), { recursive: true });
    writeFileSync(join(workDir, 'repo', '.git', 'objects', 'pack'), 'git-object-pack');
    mkdirSync(join(workDir, 'repo', 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(workDir, 'repo', 'node_modules', 'pkg', 'index.js'), 'dependency');
    mkdirSync(join(workDir, 'repo', '.pytest_cache'), { recursive: true });
    writeFileSync(join(workDir, 'repo', '.pytest_cache', 'state'), 'cache');
    mkdirSync(join(workDir, 'repo', 'src'), { recursive: true });
    writeFileSync(join(workDir, 'repo', 'src', 'task-source.py'), 'print("task checkout")');

    const artifacts = await walkArtifacts(workDir, [], {
      scrub: { identity: { username: 'adriano' } },
    });
    const snapshot = artifacts.find((artifact) => artifact.artifactType === 'system_snapshot');
    expect(snapshot).toBeTruthy();

    const entries = tarEntries(readFileSync(snapshot!.localPath));
    expect(entries['env/API_TOKEN']).toBeUndefined();
    expect(entries['repo/.git/objects/pack']).toBeUndefined();
    expect(entries['repo/node_modules/pkg/index.js']).toBeUndefined();
    expect(entries['repo/.pytest_cache/state']).toBeUndefined();
    expect(entries['repo/src/task-source.py']).toBeUndefined();
    expect(Object.keys(entries).some((entry) => entry.startsWith('repo/'))).toBe(false);
    expect(entries['notes.md']!.toString('utf8')).toBe('hello <USER>');
    expect(entries['config.json']!.toString('utf8')).toContain('<REDACTED>');
    expect(Buffer.concat(Object.values(entries)).toString('utf8')).not.toContain('must-not-appear');
    expect(Buffer.concat(Object.values(entries)).toString('utf8')).not.toContain('git-object-pack');
    expect(Buffer.concat(Object.values(entries)).toString('utf8')).not.toContain('dependency');
    expect(Buffer.concat(Object.values(entries)).toString('utf8')).not.toContain('secret-value');
  });
});
