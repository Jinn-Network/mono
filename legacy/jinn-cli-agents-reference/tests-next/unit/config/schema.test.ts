import { describe, it, expect } from 'vitest';
import { configSchema, type RawNodeConfig } from 'jinn-node/config/schema.js';

describe('configSchema', () => {
    it('parses a minimal valid config with defaults', () => {
        const result = configSchema.parse({
            chain: { chain_id: 8453 },
        });
        expect(result.chain.chain_id).toBe(8453);
        expect(result.worker.poll_base_ms).toBe(30000);
        expect(result.blueprint.enable_beads).toBe(false);
        expect(result.filtering.workstreams).toEqual([]);
    });

    it('accepts fully empty input and fills all defaults', () => {
        const result = configSchema.parse({});
        expect(result.worker.poll_base_ms).toBe(30000);
        expect(result.agent.sandbox).toBe('sandbox-exec');
        expect(result.services.ponder_url).toBe('https://indexer.jinn.network/graphql');
        expect(result.logging.level).toBe('info');
    });

    it('rejects invalid sandbox value', () => {
        expect(() => configSchema.parse({
            chain: { chain_id: 8453 },
            agent: { sandbox: 'invalid' },
        })).toThrow();
    });

    it('coerces string numbers to numbers', () => {
        const result = configSchema.parse({
            chain: { chain_id: '8453' },
            worker: { poll_base_ms: '15000' },
        });
        expect(result.chain.chain_id).toBe(8453);
        expect(result.worker.poll_base_ms).toBe(15000);
    });

    it('coerces string booleans', () => {
        const result = configSchema.parse({
            worker: { auto_restake: 'false' },
            blueprint: { enable_beads: 'true' },
        });
        expect(result.worker.auto_restake).toBe(false);
        expect(result.blueprint.enable_beads).toBe(true);
    });

    it('validates logging level enum', () => {
        const result = configSchema.parse({
            logging: { level: 'debug' },
        });
        expect(result.logging.level).toBe('debug');

        expect(() => configSchema.parse({
            logging: { level: 'verbose' },
        })).toThrow();
    });

    it('preserves overridden defaults', () => {
        const result = configSchema.parse({
            worker: { poll_base_ms: 5000, poll_max_ms: 60000 },
            dependencies: { stale_ms: 1000, redispatch: true },
        });
        expect(result.worker.poll_base_ms).toBe(5000);
        expect(result.worker.poll_max_ms).toBe(60000);
        expect(result.worker.poll_backoff_factor).toBe(1.5); // still default
        expect(result.dependencies.stale_ms).toBe(1000);
        expect(result.dependencies.redispatch).toBe(true);
    });
});
