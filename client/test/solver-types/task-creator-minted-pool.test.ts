import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MintedPoolStore,
  computeMintedPoolRowV2Hash,
  loadMintedPoolTasks,
  mintedIpfsDatasetCid,
  parseMintedPoolArtifact,
  type MintedPoolRowV2,
} from '../../src/solver-types/_swe-rebench-v2-minted-pool.js';
import { EVAL_SEMANTICS_VERSION } from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';

describe('MintedPoolStore published artifact backfill', () => {
  it('back-fills ipfs dataset ref and loadMintedPoolTasks resolves it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minted-pool-'));
    try {
      const store = new MintedPoolStore({ stateDir: dir });
      await store.record('mint-1', {
        row: {
          instance_id: 'mint-1',
          repo: 'acme/widget',
          image_name: 'img:tag',
          FAIL_TO_PASS: ['t1'],
          PASS_TO_PASS: [],
          test_patch: '',
          install_config: { test_cmd: 'pytest', log_parser: 'parse_log_pytest' },
        },
        provenance: {
          synthetic: true,
          mintFamily: 'commit-echo',
          sourceLineageHash: 'sha256:abc',
        },
        admission: { scorable: true, reason: 'ok', checkedAt: new Date().toISOString() },
        hf_dataset: 'ipfs://local-minted-pending',
        hf_split: 'minted',
        mintedAt: new Date().toISOString(),
      }, EVAL_SEMANTICS_VERSION);

      if (process.platform !== 'win32') {
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
        expect((await stat(join(dir, 'minted-pool.json'))).mode & 0o777).toBe(0o600);
      }

      let tasks = await loadMintedPoolTasks(store, EVAL_SEMANTICS_VERSION);
      expect(tasks).toHaveLength(0);

      await store.setPublishedArtifact(EVAL_SEMANTICS_VERSION, 'bafytest', ['mint-1']);
      tasks = await loadMintedPoolTasks(store, EVAL_SEMANTICS_VERSION);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.hf_dataset).toBe(mintedIpfsDatasetCid('bafytest'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;
const ENVIRONMENT_HASH = `sha256:${'b'.repeat(64)}`;
const PARSER_DIGEST = `sha256:${'c'.repeat(64)}`;

function v2Row(): MintedPoolRowV2 {
  const row = {
    instance_id: 'jinn-network__mono__echo-123',
    repo: 'Jinn-Network/mono',
    base_commit: '1'.repeat(40),
    language: 'typescript',
    problem_statement: 'regression',
    image_name: `ghcr.io/jinn-network/task-environment@${IMAGE_DIGEST}`,
    FAIL_TO_PASS: ['test/a.ts > regression'],
    PASS_TO_PASS: ['test/a.ts > unaffected'],
    test_patch: 'diff --git a/test/a.ts b/test/a.ts',
    install_config: {
      install: ['yarn install --immutable'],
      test_cmd: ['yarn', 'vitest', 'run'],
      log_parser: 'vitest-json.v1',
    },
    rowHashVersion: 2 as const,
    environment: {
      environmentSpecCid: 'bafy-environment-spec',
      environmentHash: ENVIRONMENT_HASH,
      attestation: {
        scheme: 'eip191' as const,
        algo: 'secp256k1' as const,
        environmentHash: ENVIRONMENT_HASH,
        operatorSafe: `0x${'1'.repeat(40)}`,
        signer: `0x${'2'.repeat(40)}`,
        signature: `0x${'3'.repeat(130)}`,
      },
      parser: {
        id: 'vitest-json.v1',
        version: 'v1',
        digest: PARSER_DIGEST,
        bundleId: 'jinn.swe-rebench-v2.patch-bundle.v1',
      },
      image: {
        reference: `ghcr.io/jinn-network/task-environment@${IMAGE_DIGEST}`,
        digest: IMAGE_DIGEST,
      },
      platform: 'linux/amd64' as const,
    },
    publicRowHash: '' as `sha256:${string}`,
  } satisfies Omit<MintedPoolRowV2, 'publicRowHash'> & { publicRowHash: `sha256:${string}` };
  return { ...row, publicRowHash: computeMintedPoolRowV2Hash(row) };
}

describe('swe-rebench-v2 minted-pool.v2', () => {
  it('hashes public grading fields and environment bindings, not gold or transport fields', () => {
    const row = v2Row();
    const expected = computeMintedPoolRowV2Hash(row);

    expect(computeMintedPoolRowV2Hash({ ...row, hf_dataset: 'ipfs://other', hf_split: 'transport' } as MintedPoolRowV2)).toBe(expected);
    expect(computeMintedPoolRowV2Hash({ ...row, goldPatch: 'private gold patch' } as MintedPoolRowV2)).toBe(expected);
    expect(computeMintedPoolRowV2Hash({ ...row, test_patch: 'different public test patch' })).not.toBe(expected);
    expect(computeMintedPoolRowV2Hash({ ...row, environment: { ...row.environment, platform: 'linux/arm64' } as MintedPoolRowV2['environment'] })).not.toBe(expected);
  });

  it('hash-binds a hardened differential-admission receipt reference in v2 rows', () => {
    const row = v2Row();
    const hardened = {
      ...row,
      fix_commit: 'f'.repeat(40),
      differentialAdmission: {
        admissionPolicyVersion: 'swe-rebench-v2-differential-admission.v2',
        receiptCid: 'bafy-differential-receipt',
        receiptHash: `sha256:${'d'.repeat(64)}`,
      },
    };
    const changedReceipt = {
      ...hardened,
      differentialAdmission: {
        ...hardened.differentialAdmission,
        receiptHash: `sha256:${'e'.repeat(64)}`,
      },
    };
    const changedFixCommit = {
      ...hardened,
      fix_commit: 'e'.repeat(40),
    };
    const hash = computeMintedPoolRowV2Hash(hardened as MintedPoolRowV2);

    expect(computeMintedPoolRowV2Hash(changedReceipt as MintedPoolRowV2)).not.toBe(hash);
    expect(computeMintedPoolRowV2Hash(changedFixCommit as MintedPoolRowV2)).not.toBe(hash);
    expect(() => parseMintedPoolArtifact({
      schemaVersion: 'swe-rebench-v2-minted-pool.v2',
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      generatedAt: '2026-07-12T00:00:00.000Z',
      rows: [{ ...hardened, publicRowHash: hash }],
    })).not.toThrow();
  });

  it('parses both immutable v1 and strict v2 artifacts', () => {
    const v1 = parseMintedPoolArtifact({
      schemaVersion: 'swe-rebench-v2-minted-pool.v1',
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      generatedAt: '2026-07-10T00:00:00.000Z',
      rows: [{
        instance_id: 'legacy-1', repo: 'acme/legacy', image_name: 'legacy:tag',
        FAIL_TO_PASS: ['t'], PASS_TO_PASS: [], test_patch: '',
        install_config: { test_cmd: 'pytest', log_parser: 'parse_log_pytest' },
      }],
    });
    const v2 = parseMintedPoolArtifact({
      schemaVersion: 'swe-rebench-v2-minted-pool.v2',
      evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
      generatedAt: '2026-07-10T00:00:00.000Z',
      rows: [v2Row()],
    });

    expect(v1.schemaVersion).toBe('swe-rebench-v2-minted-pool.v1');
    expect(v2.schemaVersion).toBe('swe-rebench-v2-minted-pool.v2');
    expect(() => parseMintedPoolArtifact({ ...v2, rows: [{ ...v2.rows[0], publicRowHash: ENVIRONMENT_HASH }] })).toThrow(/publicRowHash/i);
    expect(() => parseMintedPoolArtifact({ ...v2, rows: [{ ...v2.rows[0], goldPatch: 'local-only' }] })).toThrow();
    const imageMismatch = { ...v2.rows[0]!, image_name: 'ghcr.io/jinn-network/other@sha256:' + 'd'.repeat(64) };
    expect(() => parseMintedPoolArtifact({
      ...v2,
      rows: [{ ...imageMismatch, publicRowHash: computeMintedPoolRowV2Hash(imageMismatch) }],
    })).toThrow(/image_name/i);
    const parserMismatch = {
      ...v2.rows[0]!,
      install_config: { ...v2.rows[0]!.install_config, log_parser: 'parse_log_pytest' },
    };
    expect(() => parseMintedPoolArtifact({
      ...v2,
      rows: [{ ...parserMismatch, publicRowHash: computeMintedPoolRowV2Hash(parserMismatch) }],
    })).toThrow(/log_parser/i);
  });

  it('keeps v1 publication references while v2 rows preserve their actual language', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minted-pool-v2-'));
    try {
      const store = new MintedPoolStore({ stateDir: dir });
      await store.record('legacy-1', {
        row: {
          instance_id: 'legacy-1', repo: 'acme/legacy', image_name: 'legacy:tag',
          FAIL_TO_PASS: ['t'], PASS_TO_PASS: [], test_patch: '',
          install_config: { test_cmd: 'pytest', log_parser: 'parse_log_pytest' },
        },
        provenance: { synthetic: true, mintFamily: 'commit-echo', sourceLineageHash: 'sha256:legacy' },
        admission: { scorable: true, reason: 'ok', checkedAt: new Date().toISOString() },
        hf_dataset: 'ipfs://local-minted-pending', hf_split: 'minted', mintedAt: new Date().toISOString(),
      }, EVAL_SEMANTICS_VERSION);
      await store.record(v2Row().instance_id, {
        row: v2Row(),
        rowHashVersion: 2,
        provenance: { synthetic: true, mintFamily: 'commit-echo', sourceLineageHash: 'sha256:v2' },
        admission: { scorable: true, reason: 'ok', checkedAt: new Date().toISOString() },
        hf_dataset: 'ipfs://local-minted-pending', hf_split: 'minted', mintedAt: new Date().toISOString(),
      }, EVAL_SEMANTICS_VERSION);

      await store.setPublishedArtifact(EVAL_SEMANTICS_VERSION, 'bafy-v1', ['legacy-1']);
      await store.setPublishedArtifact(EVAL_SEMANTICS_VERSION, 'bafy-v2', [v2Row().instance_id], { rowHashVersion: 2 });
      const tasks = await loadMintedPoolTasks(store, EVAL_SEMANTICS_VERSION);

      expect(await store.getPublishedArtifactCid(EVAL_SEMANTICS_VERSION, 1)).toBe('bafy-v1');
      expect(await store.getPublishedArtifactCid(EVAL_SEMANTICS_VERSION, 2)).toBe('bafy-v2');
      expect(tasks.find((task) => task.instance_id === v2Row().instance_id)?.language).toBe('typescript');
      expect(tasks.find((task) => task.instance_id === v2Row().instance_id)?.hf_dataset).toBe(mintedIpfsDatasetCid('bafy-v2'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('migrates legacy local state without losing its immutable v1 CID', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minted-pool-migrate-'));
    try {
      await writeFile(join(dir, 'minted-pool.json'), JSON.stringify({
        schemaVersion: 'swe-rebench-v2-minted-pool.v1',
        evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
        updatedAt: '2026-07-10T00:00:00.000Z',
        publishedArtifactCid: 'bafy-legacy-immutable',
        entries: {},
      }));
      const store = new MintedPoolStore({ stateDir: dir });

      expect(await store.getPublishedArtifactCid(EVAL_SEMANTICS_VERSION, 1)).toBe('bafy-legacy-immutable');
      await store.record('legacy-2', {
        row: {
          instance_id: 'legacy-2', repo: 'acme/legacy', image_name: 'legacy:tag',
          FAIL_TO_PASS: [], PASS_TO_PASS: [], test_patch: '',
          install_config: { test_cmd: 'pytest', log_parser: 'parse_log_pytest' },
        },
        provenance: { synthetic: true, mintFamily: 'commit-echo', sourceLineageHash: 'sha256:legacy-2' },
        admission: { scorable: true, reason: 'ok', checkedAt: new Date().toISOString() },
        hf_dataset: 'ipfs://local-minted-pending', hf_split: 'minted', mintedAt: new Date().toISOString(),
      }, EVAL_SEMANTICS_VERSION);

      const migrated = JSON.parse(await readFile(join(dir, 'minted-pool.json'), 'utf8'));
      expect(migrated.schemaVersion).toBe('swe-rebench-v2-minted-pool.v2');
      expect(migrated.publishedArtifactCids['1']).toBe('bafy-legacy-immutable');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
