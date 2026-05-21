import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538d0e9dae1f177b4dd056dbd8e1a6d69690' as const;

describe('claim-relayer config', () => {
  it('keeps the 2000 block batch default', () => {
    const config = loadConfig({
      JINN_CLAIM_RELAYER_PRIVATE_KEY: PRIVATE_KEY,
      JINN_CLAIM_RELAYER_L1_RPC_URL: 'https://l1.example/rpc',
      JINN_CLAIM_RELAYER_L2_RPC_URL: 'https://l2.example/rpc',
      JINN_CLAIM_RELAYER_START_BLOCK: '10',
      JINN_CLAIM_RELAYER_DISTRIBUTOR_ADDRESS: '0x2222222222222222222222222222222222222222',
      JINN_CLAIM_RELAYER_MOCK_MESSENGER_ADDRESS: '0x3333333333333333333333333333333333333333',
      JINN_CLAIM_RELAYER_TASK_CLAIM_EMITTER_ADDRESS: '0x4444444444444444444444444444444444444444',
    });

    expect(config.batchBlocks).toBe(2000n);
  });
});
