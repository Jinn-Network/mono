/**
 * The ceremony's surgical config write-back (spec/2026-08-07-native-identity-ceremony.md §4.1
 * step 7). Five keys, merged onto whatever the operator already had.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  NativeIdentityWriteError,
  planNativeIdentityWriteBack,
  writeNativeIdentityConfig,
  type NativeIdentityWriteBack,
} from '../../src/config/write-native-identity.js';

const GENESIS = `sha256:${'a'.repeat(64)}` as const;
const AGENT = 'urn:uuid:00000000-0000-4000-8000-00000000000a';
const ADMISSION = 'urn:uuid:00000000-0000-4000-8000-00000000000b';

function values(overrides: Partial<NativeIdentityWriteBack> = {}): NativeIdentityWriteBack {
  return {
    agentIri: AGENT,
    admissionAgent: ADMISSION,
    identityStores: { requester: '/abs/requester.enc.json', solver: '/abs/solver.enc.json' },
    trustRootsPath: '/abs/trust.json',
    trustPolicyGenesisDigest: GENESIS,
    ...overrides,
  };
}

function scratch(initial?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'write-native-identity-'));
  const configPath = join(dir, 'config.json');
  if (initial !== undefined) writeFileSync(configPath, JSON.stringify(initial, null, 2));
  return configPath;
}

describe('writeNativeIdentityConfig', () => {
  it('creates a config file that did not exist, carrying only the identity keys', () => {
    const configPath = scratch();
    const result = writeNativeIdentityConfig({ configPath, values: values() });

    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual([
      'admissionAgent', 'agentIri', 'identityStores', 'trustPolicyGenesisDigest', 'trustRootsPath',
    ]);
    expect(result.backupPath).toBeUndefined();
    expect(result.replaced).toEqual([]);
  });

  /**
   * A `config.json` carries harness settings, joined SolverNets, tasks and hand-edits. The ceremony
   * merges over the PARSED JSON rather than re-serializing a validated config, so anything the
   * loader tolerates but does not model survives.
   */
  it('preserves every unrelated key, including ones no schema models', () => {
    const configPath = scratch({
      rpcUrl: ['https://a.example', 'https://b.example'],
      tasks: [{ id: 'keep-me', spec: { nested: { deeply: true } } }],
      joinedSolverNets: { 'bafy...': { name: 'demo', roles: ['solving'] } },
      anUndocumentedOperatorKey: { still: 'here' },
    });
    writeNativeIdentityConfig({ configPath, values: values() });

    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(config.rpcUrl).toEqual(['https://a.example', 'https://b.example']);
    expect(config.tasks).toEqual([{ id: 'keep-me', spec: { nested: { deeply: true } } }]);
    expect(config.joinedSolverNets).toEqual({ 'bafy...': { name: 'demo', roles: ['solving'] } });
    expect(config.anUndocumentedOperatorKey).toEqual({ still: 'here' });
  });

  it('backs the file up before replacing an existing value', () => {
    const configPath = scratch({ agentIri: 'urn:uuid:00000000-0000-4000-8000-0000000000ff' });
    const result = writeNativeIdentityConfig({ configPath, values: values() });

    expect(result.replaced).toContain('agentIri');
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);
    const backup = JSON.parse(readFileSync(result.backupPath!, 'utf-8')) as Record<string, unknown>;
    expect(backup.agentIri).toBe('urn:uuid:00000000-0000-4000-8000-0000000000ff');
  });

  it('reports an unchanged key as neither written nor replaced', () => {
    const configPath = scratch();
    writeNativeIdentityConfig({ configPath, values: values() });
    const second = writeNativeIdentityConfig({ configPath, values: values() });
    expect(second.written).toEqual([]);
    expect(second.replaced).toEqual([]);
  });

  /**
   * `join --role-sets requester,solver` provisions no admission custody, so it must not claim an
   * admission authority: the runtime refuses an admissionAgent with no store behind it.
   */
  it('never writes admissionAgent when the ceremony provisioned no admission family', () => {
    const configPath = scratch();
    const result = writeNativeIdentityConfig({
      configPath,
      values: { ...values(), admissionAgent: undefined },
    });
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(config.admissionAgent).toBeUndefined();
    expect(result.written).not.toContain('admissionAgent');
  });

  it('leaves an existing admissionAgent alone rather than deleting it', () => {
    const configPath = scratch({ admissionAgent: ADMISSION });
    writeNativeIdentityConfig({ configPath, values: { ...values(), admissionAgent: undefined } });
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(config.admissionAgent).toBe(ADMISSION);
  });

  /** An operator who provisions evaluator custody later keeps the families init already wrote. */
  it('merges identityStores per family instead of replacing the object', () => {
    const configPath = scratch({
      identityStores: { requester: '/old/requester.enc.json', evaluator: '/abs/evaluator.enc.json' },
    });
    writeNativeIdentityConfig({ configPath, values: values() });
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(config.identityStores).toEqual({
      requester: '/abs/requester.enc.json',
      solver: '/abs/solver.enc.json',
      evaluator: '/abs/evaluator.enc.json',
    });
  });

  it('reports the deploy-config the ceremony cannot supply', () => {
    const configPath = scratch({ ipfs: { apiUrl: 'http://127.0.0.1:5001' } });
    const result = writeNativeIdentityConfig({ configPath, values: values() });
    expect(result.outstanding).toEqual(['publicBaseUrl', 'recordSources']);
  });

  it('reports nothing outstanding once the operator has authored the deploy-config', () => {
    const configPath = scratch({
      ipfs: { apiUrl: 'http://127.0.0.1:5001' },
      publicBaseUrl: 'https://operator.example',
      recordSources: [{ role: 'requester', agent: AGENT, name: 'a', baseUrl: 'https://a.example' }],
    });
    expect(writeNativeIdentityConfig({ configPath, values: values() }).outstanding).toEqual([]);
  });

  /** Refusing beats merging into a file we cannot faithfully round-trip. */
  it('refuses a config file that is not valid JSON rather than overwriting it', () => {
    const configPath = scratch();
    writeFileSync(configPath, '{ this is not json');
    expect(() => writeNativeIdentityConfig({ configPath, values: values() }))
      .toThrow(NativeIdentityWriteError);
    expect(readFileSync(configPath, 'utf-8')).toBe('{ this is not json');
  });

  it('refuses a config file that is a JSON array', () => {
    const configPath = scratch([1, 2, 3]);
    expect(() => writeNativeIdentityConfig({ configPath, values: values() }))
      .toThrow(/not a JSON object/u);
  });

  it('leaves no temp file behind', () => {
    const configPath = scratch({ rpcUrl: 'https://a.example' });
    writeNativeIdentityConfig({ configPath, values: values() });
    const entries = readdirSync(join(configPath, '..'));
    expect(entries.filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });
});

describe('planNativeIdentityWriteBack', () => {
  it('computes the same key sets without touching the file', () => {
    const configPath = scratch({ rpcUrl: 'https://a.example' });
    const before = readFileSync(configPath, 'utf-8');
    const plan = planNativeIdentityWriteBack({ configPath, values: values() });

    expect(plan.written.sort()).toEqual([
      'admissionAgent', 'agentIri', 'identityStores', 'trustPolicyGenesisDigest', 'trustRootsPath',
    ]);
    expect(plan.outstanding).toEqual(['ipfs.apiUrl', 'publicBaseUrl', 'recordSources']);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('reports an already-provisioned config as changing nothing', () => {
    const configPath = scratch();
    writeNativeIdentityConfig({ configPath, values: values() });
    expect(planNativeIdentityWriteBack({ configPath, values: values() }).written).toEqual([]);
  });
});
