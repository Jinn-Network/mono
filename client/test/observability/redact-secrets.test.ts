/**
 * Exhaustive coverage of the security-critical redaction module for the
 * one-click operator debug report (issue #420).
 *
 * One assertion (or assertion group) per enumerated secret surface from the
 * scoping plan §4. Negative assertions confirm intentionally-kept data
 * (wallet addresses, RPC hostnames, contract addresses, file paths) survives.
 */
import { describe, expect, it } from 'vitest';
import {
  redactValue,
  redactRpcUrl,
  redactConfig,
  buildRedactionReport,
  REDACTION_VERSION,
} from '../../src/observability/redact-secrets.js';

/** Walk a value and collect every primitive string it contains. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) allStrings(item, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) allStrings(v, out);
  }
  return out;
}

describe('redactValue — secret-name key surfaces', () => {
  it('redacts JINN_PASSWORD by key name', () => {
    const out = redactValue({ JINN_PASSWORD: 'hunter2-very-secret' }) as Record<string, unknown>;
    expect(out['JINN_PASSWORD']).not.toContain('hunter2');
    expect(String(out['JINN_PASSWORD'])).toMatch(/redacted/i);
  });

  it('redacts a keystore-password-shaped key', () => {
    const out = redactValue({ keystorePassword: 'on-disk-pw' }) as Record<string, unknown>;
    expect(out['keystorePassword']).not.toBe('on-disk-pw');
    expect(String(out['keystorePassword'])).toMatch(/redacted/i);
  });

  it('redacts privateKey', () => {
    const out = redactValue({ privateKey: '0x' + 'ab'.repeat(32) }) as Record<string, unknown>;
    expect(String(out['privateKey'])).toMatch(/redacted/i);
    expect(out['privateKey']).not.toContain('abab');
  });

  it('redacts agentPrivateKey (private_key variant)', () => {
    const out = redactValue({ agent_private_key: '0x' + 'cd'.repeat(32) }) as Record<string, unknown>;
    expect(String(out['agent_private_key'])).toMatch(/redacted/i);
  });

  it('redacts mnemonic / seed phrase', () => {
    const out = redactValue({
      mnemonic: 'test test test test test test test test test test test junk',
      seedPhrase: 'another twelve word secret phrase here for safety reasons now ok',
    }) as Record<string, unknown>;
    expect(String(out['mnemonic'])).toMatch(/redacted/i);
    expect(out['mnemonic']).not.toContain('junk');
    expect(String(out['seedPhrase'])).toMatch(/redacted/i);
  });

  it('redacts DAEMON_API_TOKEN', () => {
    const out = redactValue({ DAEMON_API_TOKEN: 'tok_live_abcdef123456' }) as Record<string, unknown>;
    expect(String(out['DAEMON_API_TOKEN'])).toMatch(/redacted/i);
    expect(out['DAEMON_API_TOKEN']).not.toContain('abcdef');
  });

  it('redacts a nested ui.token', () => {
    const out = redactValue({ ui: { token: 'ui-secret-token-xyz', port: 7331 } }) as {
      ui: { token: unknown; port: unknown };
    };
    expect(String(out.ui.token)).toMatch(/redacted/i);
    expect(out.ui.port).toBe(7331);
  });

  it('redacts handshakeKey', () => {
    const out = redactValue({ handshakeKey: 'handshake-secret-0987' }) as Record<string, unknown>;
    expect(String(out['handshakeKey'])).toMatch(/redacted/i);
  });

  it('redacts ANTHROPIC_API_KEY / OPENAI_API_KEY-shaped keys', () => {
    const out = redactValue({
      ANTHROPIC_API_KEY: 'sk-ant-api03-real-key',
      OPENAI_API_KEY: 'sk-openai-real-key',
      OPENROUTER_API_KEY: 'sk-or-real-key',
    }) as Record<string, unknown>;
    expect(String(out['ANTHROPIC_API_KEY'])).toMatch(/redacted/i);
    expect(String(out['OPENAI_API_KEY'])).toMatch(/redacted/i);
    expect(String(out['OPENROUTER_API_KEY'])).toMatch(/redacted/i);
  });

  it('redacts generic *.secret, *.password, *.apiKey, *.authorization keys', () => {
    const out = redactValue({
      somethingSecret: 'leak1',
      dbPassword: 'leak2',
      providerApiKey: 'leak3',
      authorization: 'Bearer leak4',
      passphrase: 'leak5',
    }) as Record<string, unknown>;
    for (const k of ['somethingSecret', 'dbPassword', 'providerApiKey', 'authorization', 'passphrase']) {
      expect(String(out[k])).toMatch(/redacted/i);
    }
    expect(allStrings(out).join(' ')).not.toMatch(/leak[1-5]/);
  });
});

describe('redactValue — secret-shaped string values regardless of key name', () => {
  it('redacts a bare 0x-64 hex private-key-shaped string in any value', () => {
    const planted = '0x' + 'ef'.repeat(32);
    const out = redactValue({ note: `the key was ${planted} oops` }) as Record<string, unknown>;
    expect(out['note']).not.toContain(planted);
    expect(String(out['note'])).toMatch(/redacted/i);
  });

  it('redacts a JWT-shaped token string in any value', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHDpoEAdf3FfTxqVdrt6BDQ';
    const out = redactValue({ detail: `auth header ${jwt}` }) as Record<string, unknown>;
    expect(out['detail']).not.toContain(jwt);
    expect(String(out['detail'])).toMatch(/redacted/i);
  });

  it('does NOT redact a 0x-40 wallet address embedded in a string', () => {
    const addr = '0x' + 'ab'.repeat(20);
    const out = redactValue({ note: `master ${addr}` }) as Record<string, unknown>;
    expect(out['note']).toContain(addr);
  });
});

describe('redactValue — recursion into nested structures and arrays', () => {
  it('redacts secrets inside nested objects', () => {
    const out = redactValue({
      a: { b: { c: { privateKey: '0x' + '11'.repeat(32) } } },
    }) as { a: { b: { c: { privateKey: unknown } } } };
    expect(String(out.a.b.c.privateKey)).toMatch(/redacted/i);
  });

  it('redacts secrets inside arrays of objects', () => {
    const out = redactValue({
      services: [{ name: 'svc-1', token: 'secret-a' }, { name: 'svc-2', token: 'secret-b' }],
    }) as { services: Array<{ name: string; token: unknown }> };
    expect(out.services[0]?.name).toBe('svc-1');
    expect(String(out.services[0]?.token)).toMatch(/redacted/i);
    expect(String(out.services[1]?.token)).toMatch(/redacted/i);
  });

  it('does not mutate the input object', () => {
    const input = { privateKey: '0x' + '22'.repeat(32) };
    redactValue(input);
    expect(input.privateKey).toBe('0x' + '22'.repeat(32));
  });

  it('passes primitives through unchanged', () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
    expect(redactValue(null)).toBe(null);
    expect(redactValue('a plain string')).toBe('a plain string');
  });
});

describe('redactRpcUrl — keep host, strip embedded credentials', () => {
  it('strips an Infura-style /v3/<key> path segment', () => {
    const out = redactRpcUrl('https://mainnet.base.org/v3/abcdef0123456789abcdef0123456789');
    expect(out).toContain('mainnet.base.org');
    expect(out).not.toContain('abcdef0123456789');
  });

  it('strips an ?key= / ?apikey= query credential', () => {
    const out = redactRpcUrl('https://base-sepolia.example.com/rpc?apikey=SUPERSECRETKEYVALUE');
    expect(out).toContain('base-sepolia.example.com');
    expect(out).not.toContain('SUPERSECRETKEYVALUE');
  });

  it('strips a long opaque trailing key segment (Tenderly-style)', () => {
    const out = redactRpcUrl('https://base-sepolia.gateway.tenderly.co/75tyLMQuD8EHpXxMwINIKu');
    expect(out).toContain('tenderly.co');
    expect(out).not.toContain('75tyLMQuD8EHpXxMwINIKu');
  });

  it('keeps a plain RPC URL with no credential untouched in host/path shape', () => {
    const out = redactRpcUrl('https://mainnet.base.org');
    expect(out).toContain('mainnet.base.org');
  });

  it('keeps the userinfo stripped but host visible for user:pass@host URLs', () => {
    const out = redactRpcUrl('https://user:password@rpc.example.com/');
    expect(out).toContain('rpc.example.com');
    expect(out).not.toContain('password');
  });
});

describe('redactConfig — full JinnConfig redaction', () => {
  it('redacts secrets but keeps RPC hostnames, addresses and paths', () => {
    const config = {
      network: 'testnet',
      rpcUrl: 'https://base-sepolia.gateway.tenderly.co/75tyLMQuD8EHpXxMwINIKu',
      archiveRpcUrl: 'https://archive.example.com/v3/keykeykeykeykeykeykeykey',
      dbPath: '/home/user/.jinn-client/jinn.db',
      earningDir: '/home/user/.jinn-client/earning',
      distributorAddress: '0x' + 'cc'.repeat(20),
      ui: { token: 'ui-token-leaks', handshakeKey: 'handshake-leaks' },
      apiPort: 7331,
    };
    const out = redactConfig(config as never) as Record<string, unknown>;
    // RPC hostnames kept, key segments stripped.
    expect(String(out['rpcUrl'])).toContain('tenderly.co');
    expect(String(out['rpcUrl'])).not.toContain('75tyLMQuD8EHpXxMwINIKu');
    expect(String(out['archiveRpcUrl'])).toContain('archive.example.com');
    expect(String(out['archiveRpcUrl'])).not.toContain('keykeykeykey');
    // Paths and addresses kept.
    expect(out['dbPath']).toBe('/home/user/.jinn-client/jinn.db');
    expect(out['earningDir']).toBe('/home/user/.jinn-client/earning');
    expect(out['distributorAddress']).toBe('0x' + 'cc'.repeat(20));
    expect(out['apiPort']).toBe(7331);
    // UI token + handshake key redacted.
    const ui = out['ui'] as Record<string, unknown>;
    expect(String(ui['token'])).toMatch(/redacted/i);
    expect(String(ui['handshakeKey'])).toMatch(/redacted/i);
  });
});

describe('round-trip — no planted secret string survives redaction', () => {
  it('removes every planted secret from a fixture config', () => {
    const SECRETS = {
      keystorePw: 'PLANTED-keystore-pw-7c9',
      daemonToken: 'PLANTED-daemon-token-a1b',
      uiToken: 'PLANTED-ui-token-d4e',
      handshake: 'PLANTED-handshake-f6g',
      anthropic: 'sk-ant-PLANTED-anthropic-h8i',
      privHex: '0x' + 'a1'.repeat(32),
      mnemonic: 'PLANTED zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
      rpcKey: 'PLANTEDrpcKeySegment987654',
    };
    const fixture = {
      network: 'testnet',
      rpcUrl: `https://rpc.example.com/v3/${SECRETS.rpcKey}`,
      keystorePassword: SECRETS.keystorePw,
      DAEMON_API_TOKEN: SECRETS.daemonToken,
      ui: { token: SECRETS.uiToken, handshakeKey: SECRETS.handshake },
      env: { ANTHROPIC_API_KEY: SECRETS.anthropic },
      wallet: { privateKey: SECRETS.privHex, mnemonic: SECRETS.mnemonic },
      nested: [{ deep: { secret: SECRETS.daemonToken } }],
      note: `error: connecting with ${SECRETS.privHex} failed`,
    };
    const out = redactValue(fixture);
    const haystack = JSON.stringify(out);
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(haystack, `secret "${name}" leaked`).not.toContain(secret);
    }
  });
});

describe('redaction report', () => {
  it('exposes a stable REDACTION_VERSION constant', () => {
    expect(typeof REDACTION_VERSION).toBe('string');
    expect(REDACTION_VERSION.length).toBeGreaterThan(0);
  });

  it('buildRedactionReport documents redacted and intentionally-kept surfaces', () => {
    const report = buildRedactionReport();
    expect(report).toMatch(/redact/i);
    // Redacted surfaces enumerated.
    expect(report).toMatch(/keystore/i);
    expect(report).toMatch(/JINN_PASSWORD/);
    expect(report).toMatch(/private key/i);
    expect(report).toMatch(/mnemonic/i);
    // Intentionally-kept surfaces enumerated.
    expect(report).toMatch(/wallet address/i);
    expect(report).toMatch(/RPC/);
    expect(report).toMatch(/kept|retained/i);
  });
});
