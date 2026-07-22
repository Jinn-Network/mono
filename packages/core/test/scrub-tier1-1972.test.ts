/**
 * Tier-1 deterministic detectors + reject-publish classes (#1972).
 */

import { describe, expect, it } from 'vitest';
import {
  buildSeedScrubPipeline,
  buildLayer2ScrubPipeline,
  DEFAULT_KEY_POLICY,
  classifyKey,
  RejectPublishError,
  assertNoRejectPublish,
  applyDispositions,
  rejectClassesDetector,
  urlCredentialsDetector,
  checksummedInstrumentsDetector,
  ipAddressDetector,
  gitleaksDetector,
  luhnOk,
  ibanMod97Ok,
  classifyIpv4,
  loadGitleaksPack,
} from '../src/scrub/index.js';
import type { Finding } from '../src/scrub/finding.js';

const PRIV = 'b'.repeat(64);
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('reject-publish classes A4/A5 (#1972)', () => {
  it('aborts loudly on 64-hex private-key material in key context (A4)', async () => {
    await expect(
      buildSeedScrubPipeline().run({
        content: `wallet private key: ${PRIV}`,
      }),
    ).rejects.toThrow(RejectPublishError);

    await expect(
      buildSeedScrubPipeline().run({
        content: `wallet private key: ${PRIV}`,
      }),
    ).rejects.toThrow(/reject-publish: scrub class A4/);
  });

  it('aborts loudly on a BIP-39 12-word mnemonic run (A4)', async () => {
    await expect(
      buildSeedScrubPipeline().run({ content: `phrase: ${MNEMONIC}` }),
    ).rejects.toThrow(/scrub class A4/);
  });

  it('aborts loudly on an env-block dump (A5)', async () => {
    const block = ['FOO=1', 'BAR=2', 'BAZ=secret'].join('\n');
    await expect(
      buildSeedScrubPipeline().run({ 'tool.output': `env:\n${block}\nend` }),
    ).rejects.toThrow(/scrub class A5/);
  });

  it('does not reject GIT_CONFIG tutorial env lines (A5 carve-out, #2005)', async () => {
    const block = [
      'export GIT_CONFIG_GLOBAL=/dev/null',
      'export GIT_CONFIG_SYSTEM=/dev/null',
      'export GIT_CONFIG_NOSYSTEM=1',
      'export GIT_CONFIG_COUNT=2',
      'export GIT_CONFIG_KEY_0=credential.helper',
      'export GIT_CONFIG_VALUE_0=',
      'export GIT_CONFIG_KEY_1=core.askPass',
      'export GIT_CONFIG_VALUE_1=/attempt/askpass',
    ].join('\n');
    const result = await buildSeedScrubPipeline().run({
      'tool.output': `Isolate git credentials:\n${block}\n`,
    });
    expect(result.rejected).toBeFalsy();
    expect(String(result.attributes['tool.output'])).toContain('GIT_CONFIG_KEY_0=credential.helper');
  });

  it('still rejects a synthetic multi-line secret env dump after GIT_CONFIG carve-out (#2005)', async () => {
    const block = [
      'API_KEY=synth_secret_value',
      'DATABASE_URL=postgres://user:pass@db.internal/app',
      'SECRET_TOKEN=yyy',
    ].join('\n');
    await expect(
      buildSeedScrubPipeline().run({ 'tool.output': `env:\n${block}\nend` }),
    ).rejects.toThrow(/scrub class A5/);
  });

  it('does not reject bare 40-hex git SHAs or 0x+64 tx digests', async () => {
    const gitSha = 'd'.repeat(40);
    const tx = `0x${'c'.repeat(64)}`;
    const result = await buildSeedScrubPipeline().run({
      content: `commit ${gitSha} receipt ${tx}`,
    });
    expect(String(result.attributes.content)).toContain(gitSha);
    expect(String(result.attributes.content)).toContain(tx);
    expect(result.rejected).toBeFalsy();
  });

  it('does not treat bare 64-hex without key context as A4', async () => {
    const hex = 'e'.repeat(64);
    const result = await buildSeedScrubPipeline().run({
      content: `digest ${hex} in the log`,
    });
    expect(String(result.attributes.content)).toContain(hex);
  });

  it('assertNoRejectPublish names the class from findings', () => {
    const finding: Finding = {
      class: 'A4',
      span: { key: 'content', start: 0, end: 10 },
      confidence: 'VERY_HIGH',
      evidence: ['private-key-hex64'],
      detector: { name: 'reject-classes', version: '1' },
    };
    const applied = applyDispositions({ content: 'x'.repeat(10) }, [finding]);
    expect(applied.rejected).toBe(true);
    expect(() => assertNoRejectPublish(applied)).toThrow(/scrub class A4/);
  });

  it('detector emits A4/A5 at VERY_HIGH without mutating attributes', () => {
    const det = rejectClassesDetector(DEFAULT_KEY_POLICY);
    const attrs = {
      content: `private key ${PRIV}\n\nFOO=1\nBAR=2\nBAZ=3`,
    };
    const findings = det.detect(attrs) as Finding[];
    expect(attrs.content).toContain(PRIV);
    expect(findings.some((f) => f.class === 'A4' && f.confidence === 'VERY_HIGH')).toBe(true);
    expect(findings.some((f) => f.class === 'A5' && f.confidence === 'VERY_HIGH')).toBe(true);
  });
});

describe('A3 URL credentials (#1972)', () => {
  it('redacts URL userinfo', async () => {
    // Use localhost so the password@host tail is not also an email shape (B1).
    const result = await buildSeedScrubPipeline().run({
      content: 'GET https://alice:s3cret@localhost/path',
    });
    const out = String(result.attributes.content);
    expect(out).not.toContain('alice:s3cret@');
    expect(out).toContain('[SECRET:url-credential]');
  });

  it('redacts ?token= / ?api_key= query values', async () => {
    const result = await buildSeedScrubPipeline().run({
      content: 'https://api.example/v1?api_key=supersecretvalue&x=1',
    });
    expect(String(result.attributes.content)).not.toContain('supersecretvalue');
  });

  it('leaves $TOKEN env-refs in query position alone', () => {
    const det = urlCredentialsDetector(DEFAULT_KEY_POLICY);
    const findings = det.detect({
      content: 'https://api.example/v1?token=$GH_TOKEN',
    }) as Finding[];
    expect(findings).toHaveLength(0);
  });
});

describe('B7 checksummed instruments (#1972)', () => {
  it('validates Luhn and IBAN mod-97 helpers', () => {
    expect(luhnOk('4111111111111111')).toBe(true);
    expect(luhnOk('4111111111111112')).toBe(false);
    expect(ibanMod97Ok('GB82WEST12345698765432')).toBe(true);
    expect(ibanMod97Ok('GB82WEST12345698765433')).toBe(false);
  });

  it('redacts Luhn-valid cards and mod-97 IBANs', async () => {
    const result = await buildSeedScrubPipeline().run({
      content: 'card 4111111111111111 iban GB82WEST12345698765432',
    });
    const out = String(result.attributes.content);
    expect(out).not.toContain('4111111111111111');
    expect(out).not.toContain('GB82WEST12345698765432');
    expect(out).toContain('[CARD]');
    expect(out).toContain('[IBAN]');
  });

  it('does not redact a digit run that fails Luhn', () => {
    const det = checksummedInstrumentsDetector(DEFAULT_KEY_POLICY);
    const findings = det.detect({ content: 'pid 4111111111111112' }) as Finding[];
    expect(findings.filter((f) => f.evidence.includes('card-luhn'))).toHaveLength(0);
  });
});

describe('D2 IP range classification (#1972)', () => {
  it('classifies public / private / loopback / reserved', () => {
    expect(classifyIpv4('8.8.8.8')).toBe('public');
    expect(classifyIpv4('10.0.0.1')).toBe('private');
    expect(classifyIpv4('192.168.1.1')).toBe('private');
    expect(classifyIpv4('127.0.0.1')).toBe('loopback');
    expect(classifyIpv4('169.254.1.1')).toBe('reserved');
    expect(classifyIpv4('203.0.113.10')).toBe('reserved');
  });

  it('redacts public IPs and leaves loopback intact', async () => {
    const result = await buildSeedScrubPipeline().run({
      content: 'peer 8.8.8.8 local 127.0.0.1',
    });
    const out = String(result.attributes.content);
    expect(out).not.toContain('8.8.8.8');
    expect(out).toContain('[IP]');
    expect(out).toContain('127.0.0.1');
  });

  it('flags private-range IPs without redacting in redact-mode', () => {
    const det = ipAddressDetector(DEFAULT_KEY_POLICY);
    const findings = det.detect({ content: 'db at 10.1.2.3' }) as Finding[];
    expect(findings).toHaveLength(1);
    expect(findings[0]!.confidence).toBe('MEDIUM');
    expect(findings[0]!.evidence).toContain('ipv4-private');
  });
});

describe('D3 machine-identity key policy (#1972)', () => {
  it('classifies attempt-manifest host keys as machine-identity', () => {
    expect(classifyKey('host', DEFAULT_KEY_POLICY)).toBe('machine-identity');
    expect(classifyKey('hostname', DEFAULT_KEY_POLICY)).toBe('machine-identity');
    expect(classifyKey('attempt.host', DEFAULT_KEY_POLICY)).toBe('machine-identity');
  });

  it('drops host keys without reject-publish', async () => {
    const result = await buildSeedScrubPipeline().run({
      host: 'ops-laptop.local',
      content: 'ordinary prose',
    });
    expect(result.attributes.host).toBeUndefined();
    expect(result.attributes.content).toBe('ordinary prose');
    expect(result.rejected).toBeFalsy();
    expect(result.redactions.some((r) => r.key === 'host' && r.kind === 'dropped-key')).toBe(true);
  });
});

describe('gitleaks MIT pack (#1972 / Q6)', () => {
  it('pins a dated subset without build-time sync', () => {
    const pack = loadGitleaksPack();
    expect(pack.pin.license).toBe('MIT');
    expect(pack.pin.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pack.pin.note).toMatch(/no build-time sync/i);
    expect(pack.rules.length).toBeGreaterThanOrEqual(8);
  });

  it('emits A1 findings for github-pat / slack-bot shapes', () => {
    const det = gitleaksDetector(DEFAULT_KEY_POLICY);
    // ghp_ + exactly 36 charset chars
    const pat = `ghp_${'A'.repeat(36)}`;
    const findings = det.detect({ content: `token=${pat}` }) as Finding[];
    expect(findings.some((f) => f.class === 'A1' && f.evidence[0] === 'gitleaks:github-pat')).toBe(
      true,
    );
  });

  it('redacts a gitleaks-shaped npm token via the shared inventory', async () => {
    const tok = `npm_${'a'.repeat(36)}`;
    const result = await buildSeedScrubPipeline().run({ content: `auth ${tok}` });
    expect(String(result.attributes.content)).not.toContain(tok);
  });
});

describe('layer2 check-mode still refuses without throwing on ordinary redacts', () => {
  it('returns rejected for a wallet address without throw', async () => {
    const addr = `0x${'1'.repeat(40)}`;
    const result = await buildLayer2ScrubPipeline().run({ content: `fee to ${addr}` });
    expect(result.rejected).toBe(true);
    expect(String(result.attributes.content)).not.toContain(addr);
  });
});
