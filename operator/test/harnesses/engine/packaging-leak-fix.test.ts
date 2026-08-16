import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../src/store/store.js';
import { uploadArtifacts } from '../../../src/harnesses/engine/packaging.js';

const { uploadToIpfsMock } = vi.hoisted(() => ({
  uploadToIpfsMock: vi.fn(async () => {
    throw new Error('uploadArtifacts should NOT call uploadToIpfs in v0');
  }),
}));

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: uploadToIpfsMock,
  cidToDigestHex: vi.fn(),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

describe('uploadArtifacts (gating-leak-fix)', () => {
  let store: Store;
  let workDir: string;

  beforeEach(() => {
    store = new Store(':memory:');
    workDir = mkdtempSync(join(tmpdir(), 'jinn-test-'));
  });

  afterEach(() => {
    store.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writes content to served_artifacts and never calls uploadToIpfs', async () => {
    const file = join(workDir, 'sample.json');
    const bytes = Buffer.from(JSON.stringify({ value: 42 }), 'utf-8');
    writeFileSync(file, bytes);

    const uploaded = await uploadArtifacts(
      [{
        localPath: file,
        artifactType: 'output.prediction.v0',
        access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
      }],
      {
        store,
        operatorEndpoint: 'https://op.example.com',
        defaultPriceUsdc: '0',
        perArtifactTypePrice: {},
        requestId: '0x' + 'a'.repeat(64),
      },
    );

    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(uploaded[0].access.endpoint).toBe('https://op.example.com');
    expect(uploaded[0].access.priceUsdc).toBe('0');

    const row = store.getServedArtifact(uploaded[0].sha256);
    expect(row).not.toBeNull();
    expect(row!.content.equals(bytes)).toBe(true);
    expect(uploadToIpfsMock).not.toHaveBeenCalled();
  });

  it('throws if operatorEndpoint is missing and any artifact would be served', async () => {
    const file = join(workDir, 's.txt');
    writeFileSync(file, 'x');
    await expect(
      uploadArtifacts(
        [{ localPath: file, artifactType: 'design_document' }],
        {
          store,
          operatorEndpoint: '',
          defaultPriceUsdc: '0',
          perArtifactTypePrice: {},
          requestId: '0x' + 'a'.repeat(64),
        },
      ),
    ).rejects.toThrow(/operatorEndpoint/);
  });

  it('asserts gated content (priceUsdc > 0) is NOT uploaded to IPFS', async () => {
    // The mocked uploadToIpfs throws — if uploadArtifacts attempts to call it
    // the test fails. This locks in the spec invariant that gated artifact
    // bytes are written to served_artifacts, not pinned to IPFS.
    const file = join(workDir, 'gated.json');
    const bytes = Buffer.from(JSON.stringify({ secret: 'value' }), 'utf-8');
    writeFileSync(file, bytes);

    const uploaded = await uploadArtifacts(
      [{
        localPath: file,
        artifactType: 'output.prediction.v0',
        access: { endpoint: 'https://op.example.com', priceUsdc: '0.01' },
      }],
      {
        store,
        operatorEndpoint: 'https://op.example.com',
        defaultPriceUsdc: '0',
        perArtifactTypePrice: {},
        requestId: '0x' + 'b'.repeat(64),
      },
    );

    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].access.priceUsdc).toBe('0.01');

    const row = store.getServedArtifact(uploaded[0].sha256);
    expect(row).not.toBeNull();
    expect(row!.priceUsdc).toBe('0.01');
    expect(row!.content.equals(bytes)).toBe(true);
    expect(uploadToIpfsMock).not.toHaveBeenCalled();
  });
});
