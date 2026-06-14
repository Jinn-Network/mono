import { describe, it, expect } from 'vitest';
import { loadConfig, redactConfig } from '../src/config.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://user:secret@db.internal:5432/jinn',
  DATABASE_SCHEMA: 'jinn_indexer_v1',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadConfig({ DATABASE_SCHEMA: 'jinn_indexer_v1' })).toThrow(/DATABASE_URL/);
  });

  it('throws when DATABASE_SCHEMA is missing', () => {
    expect(() => loadConfig({ DATABASE_URL: BASE_ENV.DATABASE_URL })).toThrow(/DATABASE_SCHEMA/);
  });

  it('applies defaults for the optional worker knobs', () => {
    const config = loadConfig(BASE_ENV);
    expect(config.databaseUrl).toBe(BASE_ENV.DATABASE_URL);
    expect(config.databaseSchema).toBe('jinn_indexer_v1');
    expect(config.ipfsGateway).toBe('');
    expect(config.port).toBe(8738);
    expect(config.pollIntervalMs).toBe(10_000);
    expect(config.batchSize).toBe(25);
    expect(config.ipfsTimeoutMs).toBe(5000);
    expect(config.maxRetries).toBe(5);
  });

  it('reads the shared IPFS gateway env', () => {
    const config = loadConfig({ ...BASE_ENV, JINN_IPFS_GATEWAY_URL: 'https://my-gateway.example' });
    expect(config.ipfsGateway).toBe('https://my-gateway.example');
  });

  it('overrides knobs from JINN_ENRICHMENT_* env', () => {
    const config = loadConfig({
      ...BASE_ENV,
      JINN_ENRICHMENT_PORT: '9001',
      JINN_ENRICHMENT_POLL_INTERVAL_MS: '3000',
      JINN_ENRICHMENT_BATCH_SIZE: '50',
      JINN_ENRICHMENT_IPFS_TIMEOUT_MS: '8000',
      JINN_ENRICHMENT_MAX_RETRIES: '7',
    });
    expect(config.port).toBe(9001);
    expect(config.pollIntervalMs).toBe(3000);
    expect(config.batchSize).toBe(50);
    expect(config.ipfsTimeoutMs).toBe(8000);
    expect(config.maxRetries).toBe(7);
  });

  it('rejects non-numeric knob values', () => {
    expect(() => loadConfig({ ...BASE_ENV, JINN_ENRICHMENT_PORT: 'abc' })).toThrow(
      /JINN_ENRICHMENT_PORT/,
    );
  });
});

describe('redactConfig', () => {
  it('masks the DATABASE_URL credentials but keeps the host visible', () => {
    const redacted = redactConfig(loadConfig(BASE_ENV));
    const url = String(redacted.databaseUrl);
    expect(url).not.toContain('secret');
    expect(url).not.toContain('user');
    expect(url).toContain('db.internal');
  });

  it('does not leak the raw URL anywhere in the payload', () => {
    const redacted = redactConfig(loadConfig(BASE_ENV));
    expect(JSON.stringify(redacted)).not.toContain('secret');
  });
});
