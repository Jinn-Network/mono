/**
 * The four shape-v2 keys M2 adds beside M1's dark sections (umbrella #2461, DR-2026-08-05):
 * `compositionMode` (the flip switch), `agentIri` (M1 finding 4), `ipfs.apiUrl`, `publicBaseUrl`.
 *
 * Same three properties M1's sections are held to: additive, absent-tolerant, and unable to
 * express "native on mainnet" — the refusal for that lives in the boot gate, not the loader.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  NativeAgentIriSchema,
  NativeCompositionModeSchema,
  NativeIpfsConfigSchema,
  NativePublicBaseUrlSchema,
} from '../../src/config/native-sections.js';

function writeConfig(extra: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'jinn-m2-config-'));
  const path = join(root, 'config.json');
  writeFileSync(path, JSON.stringify({
    network: 'testnet',
    rpcUrl: 'https://sepolia.base.org',
    configShapeVersion: 2,
    tasks: [],
    ...extra,
  }));
  return path;
}

describe('M2 fleet config keys', () => {
  it('are all absent-tolerant: a config that carries none of them loads unchanged', () => {
    const config = loadConfig(writeConfig({}));
    expect(config.compositionMode).toBeUndefined();
    expect(config.agentIri).toBeUndefined();
    expect(config.ipfs).toBeUndefined();
    expect(config.publicBaseUrl).toBeUndefined();
  });

  it('round-trip through the loader when set', () => {
    const config = loadConfig(writeConfig({
      compositionMode: 'native',
      agentIri: 'urn:jinn:operator:fleet-one',
      ipfs: { apiUrl: 'https://ipfs.example/' },
      publicBaseUrl: 'https://records.example/',
    }));
    expect(config.compositionMode).toBe('native');
    expect(config.agentIri).toBe('urn:jinn:operator:fleet-one');
    expect(config.ipfs).toEqual({ apiUrl: 'https://ipfs.example/' });
    expect(config.publicBaseUrl).toBe('https://records.example/');
  });

  it('accepts only the two composition modes composition-root.ts declares', () => {
    expect(NativeCompositionModeSchema.options).toEqual(['legacy', 'native']);
    expect(NativeCompositionModeSchema.safeParse('native-v1').success).toBe(false);
  });

  it('refuses a non-Agent-IRI agent', () => {
    expect(NativeAgentIriSchema.safeParse('urn:jinn:operator:fleet-one').success).toBe(true);
    expect(NativeAgentIriSchema.safeParse('').success).toBe(false);
    expect(NativeAgentIriSchema.safeParse('not an iri').success).toBe(false);
  });

  it('keeps ipfs strict and requires an absolute URL', () => {
    expect(NativeIpfsConfigSchema.safeParse({ apiUrl: 'https://ipfs.example' }).success).toBe(true);
    expect(NativeIpfsConfigSchema.safeParse({ apiUrl: '/api/v0' }).success).toBe(false);
    // `.strict()`: a typo inside a configured section refuses rather than being dropped.
    expect(NativeIpfsConfigSchema.safeParse({ apiUrl: 'https://x.example', apiURL: 'y' }).success)
      .toBe(false);
  });

  it('requires publicBaseUrl to be HTTP(S)', () => {
    expect(NativePublicBaseUrlSchema.safeParse('https://records.example').success).toBe(true);
    expect(NativePublicBaseUrlSchema.safeParse('ftp://records.example').success).toBe(false);
  });

  // DR-2026-08-05 decision 8, asserted over the DECLARATIONS rather than instances (M1 review
  // note 1's pattern): none of M2's keys can name a network, a chainId, or a contract, so no
  // config file can express "native on mainnet". That refusal lives in `assertNativeDeployment`.
  it('cannot express a network, chain, or contract', () => {
    expect(Object.keys(NativeIpfsConfigSchema.shape)).toEqual(['apiUrl']);
    expect(NativeCompositionModeSchema.options).not.toContain('mainnet');
    for (const schema of [NativeAgentIriSchema, NativePublicBaseUrlSchema]) {
      expect('shape' in schema).toBe(false);
    }
  });
});
