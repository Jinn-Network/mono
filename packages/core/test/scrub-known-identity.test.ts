/**
 * Known-identity pack + non-address instance allowlist (#1971).
 *
 * Locked Q1: no address pass-allowlist — C1 still stubs every 0x+40.
 */

import { describe, expect, it } from 'vitest';
import {
  assembleKnownIdentity,
  buildSeedScrubPipeline,
  DEFAULT_KEY_POLICY,
  isAddressShaped,
  knownIdentityDetector,
  knownIdentityStage,
  runBench,
  syntheticFixtures,
} from '../src/scrub/index.js';

const PACK = {
  gitUserName: 'Synth Operator',
  gitUserEmail: 'synth.operator@example.com',
  homeUsername: 'synthuser',
  hostname: 'synth-laptop-01',
  ghLogin: 'synth_operator_handle',
} as const;

const FAKE_ADDRESS = `0x${'a'.repeat(40)}`;
const PROTOCOL_LOOKALIKE = `0x${'f'.repeat(40)}`;

describe('assembleKnownIdentity (#1971)', () => {
  it('fills pack gaps from injected env/homedir/hostname', () => {
    const assembled = assembleKnownIdentity({
      env: {
        GIT_AUTHOR_NAME: 'Env Name',
        GIT_AUTHOR_EMAIL: 'env@example.com',
        GH_USER: 'env_gh',
      },
      homedir: () => '/Users/envhome',
      hostname: () => 'env-host',
    });
    expect(assembled.pack).toEqual({
      gitUserName: 'Env Name',
      gitUserEmail: 'env@example.com',
      homeUsername: 'envhome',
      hostname: 'env-host',
      ghLogin: 'env_gh',
    });
  });

  it('injected pack wins over env fillers', () => {
    const assembled = assembleKnownIdentity({
      pack: { ghLogin: 'injected' },
      env: { GH_USER: 'env_gh' },
    });
    expect(assembled.pack.ghLogin).toBe('injected');
  });

  it('drops address-shaped pack values and allowlist entries (Q1)', () => {
    expect(isAddressShaped(FAKE_ADDRESS)).toBe(true);
    const assembled = assembleKnownIdentity({
      pack: { gitUserName: FAKE_ADDRESS, homeUsername: 'okuser' },
      allowlist: {
        entries: [
          {
            value: PROTOCOL_LOOKALIKE,
            kind: 'repo-slug',
            provenance: 'should-be-dropped',
          },
          {
            value: 'Jinn-Network/mono',
            kind: 'repo-slug',
            provenance: 'repo constants',
          },
        ],
      },
    });
    expect(assembled.pack.gitUserName).toBeUndefined();
    expect(assembled.pack.homeUsername).toBe('okuser');
    expect(assembled.allowlist.entries.some((e) => e.value === PROTOCOL_LOOKALIKE)).toBe(false);
    expect(assembled.allowlist.entries.some((e) => e.value === 'Jinn-Network/mono')).toBe(true);
    expect(assembled.allowlist.entries.some((e) => e.value === '127.0.0.1')).toBe(true);
  });
});

describe('known-identity pack redacts self-PII (#1971)', () => {
  it('exact-matches pack values at VERY_HIGH into B3/B4/D3/B1 stubs', async () => {
    const stage = knownIdentityStage(DEFAULT_KEY_POLICY, { pack: { ...PACK } });
    const result = await stage.scrub({
      content:
        `Author ${PACK.gitUserName} <${PACK.gitUserEmail}> on ${PACK.hostname}; ` +
        `user=${PACK.homeUsername} gh=${PACK.ghLogin}`,
    });
    const out = String(result.attributes.content);
    expect(out).not.toContain(PACK.gitUserName);
    expect(out).not.toContain(PACK.gitUserEmail);
    expect(out).not.toContain(PACK.hostname);
    expect(out).not.toContain(PACK.homeUsername);
    expect(out).not.toContain(PACK.ghLogin);
    expect(out).toContain('[NAME]');
    expect(out).toContain('[EMAIL]');
    expect(out).toContain('[HOSTNAME]');
    expect(out).toContain('[USERNAME]');
    expect(result.redactions.every((r) => r.stage === 'known-identity')).toBe(true);
  });

  it('does not match pack needles inside larger tokens', async () => {
    const stage = knownIdentityStage(DEFAULT_KEY_POLICY, {
      pack: { homeUsername: 'ann' },
    });
    const input = 'canonical naming stays intact';
    const result = await stage.scrub({ content: input });
    expect(result.attributes.content).toBe(input);
    expect(result.redactions).toHaveLength(0);
  });
});

describe('instance allowlist suppresses non-address public values (#1971)', () => {
  it('passes loopback/reserved IPs and records allowlist-pass', async () => {
    const stage = knownIdentityStage(DEFAULT_KEY_POLICY, {});
    const input = 'Health check binds 127.0.0.1 and documents 0.0.0.0.';
    const result = await stage.scrub({ content: input });
    expect(result.attributes.content).toBe(input);
    expect(
      result.redactions.filter((r) => r.kind === 'allowlist-pass' && r.detail === 'loopback-ip')
        .length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      result.redactions.some((r) => r.kind === 'allowlist-pass' && r.detail === 'reserved-ip'),
    ).toBe(true);
  });

  it('redacts public IPs (D2) that are not allowlisted', async () => {
    const stage = knownIdentityStage(DEFAULT_KEY_POLICY, {});
    const result = await stage.scrub({ content: 'Peer at 203.0.113.10 replied.' });
    const out = String(result.attributes.content);
    expect(out).not.toContain('203.0.113.10');
    expect(out).toContain('[IP]');
  });

  it('repo-slug allowlist suppresses a colliding pack handle', async () => {
    const stage = knownIdentityStage(DEFAULT_KEY_POLICY, {
      pack: { ghLogin: 'Jinn-Network' },
      allowlist: {
        entries: [
          {
            value: 'Jinn-Network',
            kind: 'repo-slug',
            provenance: 'github.com/Jinn-Network/mono',
          },
        ],
      },
    });
    const input = 'Clone github.com/Jinn-Network/mono and join.';
    const result = await stage.scrub({ content: input });
    expect(String(result.attributes.content)).toContain('Jinn-Network');
    expect(result.redactions.some((r) => r.kind === 'allowlist-pass' && r.detail === 'repo-slug')).toBe(
      true,
    );
    expect(result.redactions.some((r) => r.kind === 'pii')).toBe(false);
  });
});

describe('addresses stay stubbed via C1 — no address allowlist (Q1)', () => {
  it('stubs protocol-lookalike and operator-lookalike addresses in the shared inventory', async () => {
    const pipeline = buildSeedScrubPipeline({
      knownIdentity: {
        pack: { ...PACK },
        allowlist: {
          entries: [
            {
              value: PROTOCOL_LOOKALIKE,
              kind: 'repo-slug',
              provenance: 'must-not-pass',
            },
          ],
        },
      },
    });
    const result = await pipeline.run({
      content: `Router ${PROTOCOL_LOOKALIKE}; operator ${FAKE_ADDRESS}; loopback 127.0.0.1`,
    });
    const out = String(result.attributes.content);
    expect(out).not.toContain(PROTOCOL_LOOKALIKE);
    expect(out).not.toContain(FAKE_ADDRESS);
    expect(out).toMatch(/\[ETH_ADDR_/);
    expect(out).toContain('127.0.0.1');
    expect(result.redactions.some((r) => r.detail === 'eth-address')).toBe(true);
    expect(result.redactions.some((r) => r.kind === 'allowlist-pass')).toBe(true);
  });
});

describe('shared inventory registration (#1971)', () => {
  it('registers known-identity in the seed inventory', () => {
    const names = buildSeedScrubPipeline().components.map((c) => c.name);
    expect(names).toEqual(['key-policy', 'plain-patterns', 'known-identity', 'secretlint']);
  });

  it('detector emits pack findings without mutating attributes', () => {
    const detector = knownIdentityDetector(DEFAULT_KEY_POLICY, { pack: { ...PACK } });
    const attrs = { content: `hi ${PACK.ghLogin}` };
    const findings = detector.detect(attrs);
    expect(attrs.content).toBe(`hi ${PACK.ghLogin}`);
    expect(findings.some((f) => f.class === 'B4' && f.confidence === 'VERY_HIGH')).toBe(true);
  });
});

describe('eval fixtures — self-handle exact match (#1971)', () => {
  it('B4-self-handle and D3-self-hostname recall at 1.0 with injected pack', async () => {
    const fixtures = syntheticFixtures().filter(
      (f) => f.id === 'B4-self-handle' || f.id === 'D3-self-hostname',
    );
    const report = await runBench(fixtures);
    expect(report.classes.B4?.recall).toBe(1);
    expect(report.classes.D3?.recall).toBe(1);
    expect(report.corruption.failures).toBe(0);
  });

  it('allowlist-loopback-survive stays byte-identical', async () => {
    const fixtures = syntheticFixtures().filter((f) => f.id === 'allowlist-loopback-survive');
    const report = await runBench(fixtures);
    expect(report.corruption.fixtures).toBe(1);
    expect(report.corruption.failures).toBe(0);
  });
});
