import { describe, it, expect, beforeEach, vi } from 'vitest';
import { join } from 'path';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import YAML from 'yaml';
import { loadNodeConfig } from 'jinn-node/config/loader.js';

describe('loadNodeConfig', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'jinn-config-test-'));
    });

    it('loads config from jinn.yaml', () => {
        const yaml = YAML.stringify({
            chain: { chain_id: 100 },
        });
        writeFileSync(join(tmpDir, 'jinn.yaml'), yaml);
        const config = loadNodeConfig(tmpDir, {});
        expect(config.chain.chainId).toBe(100);
        expect(config.worker.pollBaseMs).toBe(30000); // default
    });

    it('auto-generates jinn.yaml when missing', () => {
        const config = loadNodeConfig(tmpDir, {});
        expect(config.worker.pollBaseMs).toBe(30000);
        expect(existsSync(join(tmpDir, 'jinn.yaml'))).toBe(true);
    });

    it('env vars override yaml values', () => {
        const yaml = YAML.stringify({
            chain: { chain_id: 8453 },
        });
        writeFileSync(join(tmpDir, 'jinn.yaml'), yaml);
        const config = loadNodeConfig(tmpDir, { CHAIN_ID: '100' });
        expect(config.chain.chainId).toBe(100);
    });

    it('fills defaults for missing sections', () => {
        writeFileSync(join(tmpDir, 'jinn.yaml'), '{}');
        const config = loadNodeConfig(tmpDir, {});
        expect(config.services.ponderUrl).toBe('https://indexer.jinn.network/graphql');
        expect(config.agent.sandbox).toBe('sandbox-exec');
        expect(config.blueprint.enableBeads).toBe(false);
    });

    it('returns frozen config', () => {
        const config = loadNodeConfig(tmpDir, {});
        expect(() => { (config as any).chain = {} }).toThrow();
        expect(() => { (config.chain as any).chainId = 0 }).toThrow();
    });

    it('transforms snake_case to camelCase', () => {
        const yaml = YAML.stringify({
            worker: { poll_base_ms: 5000 },
            dependencies: { stale_ms: 1000 },
        });
        writeFileSync(join(tmpDir, 'jinn.yaml'), yaml);
        const config = loadNodeConfig(tmpDir, {});
        expect(config.worker.pollBaseMs).toBe(5000);
        expect(config.dependencies.staleMs).toBe(1000);
    });

    it('throws a clear error on invalid YAML', () => {
        writeFileSync(join(tmpDir, 'jinn.yaml'), ': bad: [yaml');
        expect(() => loadNodeConfig(tmpDir, {})).toThrow();
    });
});
