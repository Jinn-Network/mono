import { describe, it, expect } from 'vitest';
import { resolveEnvOverrides } from 'jinn-node/config/aliases.js';

describe('resolveEnvOverrides', () => {
    it('maps CHAIN_ID to chain.chain_id', () => {
        const overrides = resolveEnvOverrides({ CHAIN_ID: '8453' });
        expect(overrides.chain?.chain_id).toBe('8453');
    });

    it('maps WORKER_STAKING_CONTRACT to staking.contract', () => {
        const overrides = resolveEnvOverrides({ WORKER_STAKING_CONTRACT: '0xabc' });
        expect(overrides.staking?.contract).toBe('0xabc');
    });

    it('maps WORKER_POLL_BASE_MS to worker.poll_base_ms', () => {
        const overrides = resolveEnvOverrides({ WORKER_POLL_BASE_MS: '15000' });
        expect(overrides.worker?.poll_base_ms).toBe('15000');
    });

    it('canonical name takes priority over legacy alias', () => {
        const overrides = resolveEnvOverrides({
            WORKER_STAKING_CONTRACT: '0xcanonical',
            STAKING_CONTRACT: '0xlegacy',
        });
        expect(overrides.staking?.contract).toBe('0xcanonical');
    });

    it('maps WORKSTREAM_FILTER to array', () => {
        const overrides = resolveEnvOverrides({
            WORKSTREAM_FILTER: '0xabc,0xdef',
        });
        expect(overrides.filtering?.workstreams).toEqual(['0xabc', '0xdef']);
    });

    it('ignores empty env values', () => {
        const overrides = resolveEnvOverrides({ CHAIN_ID: '', WORKER_POLL_BASE_MS: '' });
        expect(overrides.chain?.chain_id).toBeUndefined();
    });

    it('maps blueprint env vars', () => {
        const overrides = resolveEnvOverrides({
            BLUEPRINT_ENABLE_BEADS: 'true',
            BLUEPRINT_BUILDER_DEBUG: '1',
        });
        expect(overrides.blueprint?.enable_beads).toBe('true');
        expect(overrides.blueprint?.debug).toBe('1');
    });
});
