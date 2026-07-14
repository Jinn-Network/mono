import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MintedPoolStore,
  loadMintedPoolTasks,
  mintedIpfsDatasetCid,
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
