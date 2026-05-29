/**
 * Unit tests for the pure debug-report assembler and the hand-rolled USTAR
 * tar writer (issue #420 §2). No daemon, no HTTP — just assemble + archive.
 */
import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { writeTarGz, readTarEntries } from '../../src/observability/tar.js';
import { assembleDebugReport } from '../../src/observability/debug-report-assemble.js';

describe('writeTarGz / readTarEntries — minimal USTAR round-trip', () => {
  it('round-trips a set of files', async () => {
    const files = [
      { name: 'a.txt', content: Buffer.from('hello a') },
      { name: 'nested/b.json', content: Buffer.from('{"k":1}') },
      { name: 'c.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ];
    const gz = await writeTarGz(files);
    const tar = gunzipSync(gz);
    // USTAR magic at offset 257 of the first header block.
    expect(tar.subarray(257, 262).toString('latin1')).toBe('ustar');
    const entries = readTarEntries(tar);
    expect(entries.map((e) => e.name).sort()).toEqual(['a.txt', 'c.png', 'nested/b.json']);
    const a = entries.find((e) => e.name === 'a.txt');
    expect(a?.content.toString()).toBe('hello a');
    const b = entries.find((e) => e.name === 'nested/b.json');
    expect(b?.content.toString()).toBe('{"k":1}');
    const c = entries.find((e) => e.name === 'c.png');
    expect(Array.from(c?.content ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('produces a tar whose total length is a multiple of 512', async () => {
    const gz = await writeTarGz([{ name: 'x', content: Buffer.from('y') }]);
    const tar = gunzipSync(gz);
    expect(tar.length % 512).toBe(0);
  });

  it('handles empty file content', async () => {
    const gz = await writeTarGz([{ name: 'empty.txt', content: Buffer.alloc(0) }]);
    const entries = readTarEntries(gunzipSync(gz));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content.length).toBe(0);
  });
});

describe('assembleDebugReport — pure bundle assembly', () => {
  const baseInput = {
    status: { network: 'testnet', daemon: { running: true } },
    config: { network: 'testnet', rpcUrl: 'https://rpc.example.com' },
    configProvenance: { configLoaded: true, envOverrides: {} },
    activityEvents: [{ id: 1, kind: 'startup', ts: '2026-05-20T00:00:00Z' }],
    logFiles: [] as Array<{ name: string; content: Buffer }>,
    daemonVersion: '0.1.6',
  };

  it('returns a gzip buffer that decompresses to a tar with the expected files', async () => {
    const gz = await assembleDebugReport(baseInput);
    const entries = readTarEntries(gunzipSync(gz));
    const names = entries.map((e) => e.name);
    expect(names.some((n) => n.endsWith('status.json'))).toBe(true);
    expect(names.some((n) => n.endsWith('config.json'))).toBe(true);
    expect(names.some((n) => n.endsWith('config-provenance.json'))).toBe(true);
    expect(names.some((n) => n.endsWith('activity-events.json'))).toBe(true);
    expect(names.some((n) => n.endsWith('redaction-report.md'))).toBe(true);
    expect(names.some((n) => n.endsWith('bundle-meta.json'))).toBe(true);
  });

  it('includes a screenshot when supplied', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const gz = await assembleDebugReport({ ...baseInput, screenshotPng: png });
    const entries = readTarEntries(gunzipSync(gz));
    const shot = entries.find((e) => e.name.endsWith('dashboard-screenshot.png'));
    expect(shot).toBeDefined();
    expect(Array.from(shot!.content)).toEqual(Array.from(png));
    expect(entries.some((e) => e.name.endsWith('screenshot-unavailable.txt'))).toBe(false);
  });

  it('emits screenshot-unavailable.txt when no screenshot is supplied', async () => {
    const gz = await assembleDebugReport(baseInput);
    const entries = readTarEntries(gunzipSync(gz));
    expect(entries.some((e) => e.name.endsWith('screenshot-unavailable.txt'))).toBe(true);
    expect(entries.some((e) => e.name.endsWith('dashboard-screenshot.png'))).toBe(false);
  });

  it('redacts planted secrets across every bundled JSON file', async () => {
    const gz = await assembleDebugReport({
      ...baseInput,
      status: { network: 'testnet', apiToken: 'PLANTED-status-secret' },
      config: {
        network: 'testnet',
        rpcUrl: 'https://rpc.example.com/v3/PLANTEDrpcKey999',
        ui: { token: 'PLANTED-ui-token' },
      },
      activityEvents: [{ id: 1, kind: 'tick_error', detail: '0x' + 'aa'.repeat(32) }],
    });
    const tar = gunzipSync(gz).toString('latin1');
    expect(tar).not.toContain('PLANTED-status-secret');
    expect(tar).not.toContain('PLANTED-ui-token');
    expect(tar).not.toContain('PLANTEDrpcKey999');
    expect(tar).not.toContain('0x' + 'aa'.repeat(32));
  });

  it('places all files under a single timestamped directory', async () => {
    const gz = await assembleDebugReport(baseInput);
    const entries = readTarEntries(gunzipSync(gz));
    const roots = new Set(entries.map((e) => e.name.split('/')[0]));
    expect(roots.size).toBe(1);
    expect([...roots][0]).toMatch(/^jinn-debug-report-/);
  });
});
