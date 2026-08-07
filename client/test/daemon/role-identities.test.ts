import { readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BindingResolver, ResolvedBinding } from '@jinn-network/trust-core';
import { describe, expect, it, vi } from 'vitest';
import {
  NATIVE_ROLE_IDENTITY_ROLES,
  openRoleIdentitySet,
} from '../../src/daemon/role-identities.js';

const AGENT = 'urn:jinn:operator:test';
const BOOT_TIME = '2026-08-02T12:00:00.000Z';

function resolvedBinding(input: {
  readonly key: string;
  readonly scopes: readonly string[];
  readonly effectiveStart?: string;
  readonly expiresAt?: string;
  readonly revocations?: readonly { readonly effectiveTime: string }[];
}): ResolvedBinding {
  return {
    binding: {
      key: { didKey: input.key, keyid: input.key },
      scope: input.scopes,
      validFrom: input.effectiveStart ?? '2026-08-01T00:00:00.000Z',
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    },
    effectiveStart: input.effectiveStart ?? '2026-08-01T00:00:00.000Z',
    revocations: input.revocations?.map((revocation) => ({
      revocation: {},
      envelopeBytes: new Uint8Array(),
      effectiveTime: revocation.effectiveTime,
    })) ?? [],
  } as ResolvedBinding;
}

/**
 * Every scope a native role can require — the "this binding grants everything" fixture. It carries
 * the Record Discovery announce-plane scope alongside the trust-core families because the three
 * `*-discovery` roles require both (issue #2525); a binding without it is not a fully authorized
 * binding for any native deployment.
 */
const ALL_NATIVE_SCOPES = [
  'authorizations', 'observations', 'deliveries', 'verdicts', 'settlements',
  'jinn:discovery-announcements',
] as const;

function openAt(root: string, bindingResolver: BindingResolver) {
  return openRoleIdentitySet({
    storePath: join(root, 'identity', 'roles.enc.json'),
    password: 'operator-password',
    agent: AGENT,
    bindingResolver,
    now: () => new Date(BOOT_TIME),
  });
}

function decryptStoredRoles(pathBytes: string, password: string): readonly string[] {
  const envelope = JSON.parse(pathBytes) as {
    salt: string; iv: string; authTag: string; ciphertext: string;
  };
  const key = scryptSync(password, Buffer.from(envelope.salt, 'base64'), 32);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  const value = JSON.parse(plaintext.toString('utf8')) as {
    metadata: { ownedRoles: readonly string[] };
    roles: readonly { role: string }[];
  };
  expect(value.metadata.ownedRoles).toEqual(value.roles.map(({ role }) => role));
  return value.metadata.ownedRoles;
}

describe('native persistent role identities', () => {
  it('opens only explicitly owned roles and subjects every family to the full authority gate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-identities-scoped-'));
    const resolver: BindingResolver = {
      resolveBinding: vi.fn(async (query) => resolvedBinding({ key: query.key, scopes: ALL_NATIVE_SCOPES })),
    };
    const verifyRoleBinding = vi.fn(async () => ({ bindingDigest: `sha256:${'1'.repeat(64)}` as const }));
    const identities = await openRoleIdentitySet({
      storePath: join(root, 'identity', 'roles.enc.json'),
      password: 'operator-password',
      agent: 'urn:jinn:solver:scoped',
      requiredRoles: ['solver-delivery', 'solver-discovery'],
      bindingResolver: resolver,
      verifyRoleBinding,
      now: () => new Date(BOOT_TIME),
    });

    expect(identities.get('solver-delivery').role).toBe('solver-delivery');
    expect(identities.get('solver-discovery').role).toBe('solver-discovery');
    expect(() => identities.get('requester-submission')).toThrow(/unavailable/u);
    expect(resolver.resolveBinding).toHaveBeenCalledTimes(2);
    // One authority gate PER required scope, not per role: `solver-discovery` requires both the
    // trust-core family it signs under and the announce-plane scope the discovery client filters
    // on, and each is verified independently.
    expect(verifyRoleBinding.mock.calls.map(([value]) => [value.role, value.agent, value.family])).toEqual([
      ['solver-delivery', 'urn:jinn:solver:scoped', 'deliveries'],
      ['solver-discovery', 'urn:jinn:solver:scoped', 'observations'],
      ['solver-discovery', 'urn:jinn:solver:scoped', 'jinn:discovery-announcements'],
    ]);
    const encrypted = await readFile(join(root, 'identity', 'roles.enc.json'), 'utf8');
    expect(decryptStoredRoles(encrypted, 'operator-password')).toEqual([
      'solver-delivery',
      'solver-discovery',
    ]);
    expect(encrypted).not.toContain('requester-submission');
    expect(encrypted).not.toContain('evaluator-verdict');
  });

  it('requester custody has no solver/evaluator/admission private authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-identities-requester-custody-'));
    const path = join(root, 'identity', 'requester.enc.json');
    const resolver: BindingResolver = {
      resolveBinding: vi.fn(async (query) => resolvedBinding({ key: query.key, scopes: ALL_NATIVE_SCOPES })),
    };
    await openRoleIdentitySet({
      storePath: path,
      password: 'operator-password',
      agent: 'urn:jinn:requester:scoped',
      requiredRoles: ['requester-submission', 'requester-discovery'],
      bindingResolver: resolver,
      now: () => new Date(BOOT_TIME),
    });
    const encrypted = await readFile(path, 'utf8');
    expect(decryptStoredRoles(encrypted, 'operator-password')).toEqual([
      'requester-submission',
      'requester-discovery',
    ]);
    expect(encrypted).not.toContain('solver-delivery');
    expect(encrypted).not.toContain('evaluator-verdict');
    expect(encrypted).not.toContain('admission');
  });

  it('refuses a co-hosted admission key when it is opened under the requester Agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-identities-wrong-agent-'));
    const admissionAgent = 'urn:jinn:admission:stable';
    const resolver: BindingResolver = {
      resolveBinding: vi.fn(async (query) => query.agent === admissionAgent
        ? resolvedBinding({ key: query.key, scopes: ALL_NATIVE_SCOPES })
        : null),
    };
    const common = {
      storePath: join(root, 'identity', 'roles.enc.json'),
      password: 'operator-password',
      requiredRoles: ['admission'] as const,
      bindingResolver: resolver,
      now: () => new Date(BOOT_TIME),
    };
    await expect(openRoleIdentitySet({ ...common, agent: 'urn:jinn:requester:wrong' }))
      .rejects.toThrow(/admission.*no effective binding/u);
    await expect(openRoleIdentitySet({ ...common, agent: admissionAgent })).resolves.toBeDefined();
  });

  it('rejects a relative identity-store path before changing filesystem permissions', async () => {
    const resolver: BindingResolver = { resolveBinding: vi.fn(async () => null) };
    const implicitCwdPath = resolve('roles.enc.json');
    expect(existsSync(implicitCwdPath)).toBe(false);

    await expect(openRoleIdentitySet({
      storePath: 'roles.enc.json',
      password: 'operator-password',
      agent: AGENT,
      bindingResolver: resolver,
      now: () => new Date(BOOT_TIME),
    })).rejects.toThrow(/path must be absolute/i);
    expect(existsSync(implicitCwdPath)).toBe(false);
  });

  it('persists distinct role key IDs across two cold restarts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-identities-'));
    const resolver: BindingResolver = {
      resolveBinding: vi.fn(async (query) =>
        resolvedBinding({ key: query.key, scopes: ALL_NATIVE_SCOPES }),
      ),
    };

    const first = await openAt(root, resolver);
    const second = await openAt(root, resolver);

    const firstIds = NATIVE_ROLE_IDENTITY_ROLES.map((role) => first.get(role).keyId);
    const secondIds = NATIVE_ROLE_IDENTITY_ROLES.map((role) => second.get(role).keyId);
    expect(firstIds).toEqual(secondIds);
    expect(new Set(firstIds).size).toBe(NATIVE_ROLE_IDENTITY_ROLES.length);
  });

  it('verifies signed discovery material with the persisted public key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-identities-verify-'));
    const resolver: BindingResolver = {
      resolveBinding: vi.fn(async (query) => resolvedBinding({ key: query.key, scopes: ALL_NATIVE_SCOPES })),
    };
    const identities = await openAt(root, resolver);
    const identity = identities.get('solver-discovery');
    const payload = new TextEncoder().encode('durable source append');
    const signature = identity.sign(payload);

    expect(identity.verify(payload, signature)).toBe(true);
    expect(identity.verify(new TextEncoder().encode('different append'), signature)).toBe(false);
  });

  it('stores encrypted key material with owner-only directory and file permissions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-identities-permissions-'));
    const resolver: BindingResolver = {
      resolveBinding: vi.fn(async (query) => resolvedBinding({ key: query.key, scopes: ALL_NATIVE_SCOPES })),
    };
    const identities = await openAt(root, resolver);
    const path = join(root, 'identity', 'roles.enc.json');

    const stored = await readFile(path, 'utf8');
    expect(stored).not.toContain(identities.get('solver-delivery').keyId);
    expect(stored).not.toContain('PRIVATE KEY');
    expect((await stat(join(root, 'identity'))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('fails closed when an existing identity store is corrupted instead of generating a replacement key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-identities-corrupt-'));
    const resolver: BindingResolver = {
      resolveBinding: vi.fn(async (query) => resolvedBinding({ key: query.key, scopes: ALL_NATIVE_SCOPES })),
    };
    await openAt(root, resolver);
    const path = join(root, 'identity', 'roles.enc.json');
    const corrupt = '{"version":2,"ciphertext":"missing-role"}';
    await writeFile(path, corrupt);

    await expect(openAt(root, resolver)).rejects.toThrow(/identity store/i);
    await expect(readFile(path, 'utf8')).resolves.toBe(corrupt);
  });

  it('rejects a role when the resolver has no effective binding for its persisted key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-identities-unbound-'));
    const resolver: BindingResolver = {
      resolveBinding: vi.fn(async () => null),
    };

    await expect(openAt(root, resolver)).rejects.toThrow(/no effective binding/i);
  });

  it('rejects a role whose binding is not yet effective at native boot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-identities-future-'));
    const resolver: BindingResolver = {
      resolveBinding: vi.fn(async (query) =>
        resolvedBinding({
          key: query.key,
          scopes: ALL_NATIVE_SCOPES,
          effectiveStart: '2026-08-02T12:00:01.000Z',
        }),
      ),
    };

    await expect(openAt(root, resolver)).rejects.toThrow(/not effective/i);
  });

  it('rejects a role whose binding expired before native boot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-identities-expired-'));
    const resolver: BindingResolver = {
      resolveBinding: vi.fn(async (query) =>
        resolvedBinding({
          key: query.key,
          scopes: ALL_NATIVE_SCOPES,
          expiresAt: '2026-08-02T11:59:59.000Z',
        }),
      ),
    };

    await expect(openAt(root, resolver)).rejects.toThrow(/expired/i);
  });

  it('rejects a role whose binding is revoked at or before native boot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-identities-revoked-'));
    const resolver: BindingResolver = {
      resolveBinding: vi.fn(async (query) =>
        resolvedBinding({
          key: query.key,
          scopes: ALL_NATIVE_SCOPES,
          revocations: [{ effectiveTime: BOOT_TIME }],
        }),
      ),
    };

    await expect(openAt(root, resolver)).rejects.toThrow(/revoked/i);
  });

  it('requires evaluator verdict custody to be authorized for Delivery as well as verdict records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-identities-evaluator-delivery-scope-'));
    let bindingIndex = 0;
    const resolver: BindingResolver = {
      resolveBinding: vi.fn(async (query) => {
        const role = NATIVE_ROLE_IDENTITY_ROLES[bindingIndex++];
        return resolvedBinding({
          key: query.key,
          scopes: role === 'evaluator-verdict'
            ? ['authorizations', 'observations', 'verdicts']
            : ALL_NATIVE_SCOPES,
        });
      }),
    };

    await expect(openAt(root, resolver)).rejects.toThrow(/evaluator-verdict.*lacks required deliveries scope/i);
  });

  it('re-resolves delivery authority at Delivery.createdAt instead of trusting the boot decision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-identities-delivery-time-'));
    const deliveryTime = '2026-08-02T12:05:00.000Z';
    const resolver: BindingResolver = {
      resolveBinding: vi.fn(async (query, atTime) => resolvedBinding({
        key: query.key,
        scopes: ALL_NATIVE_SCOPES,
        ...(atTime === deliveryTime
          ? { revocations: [{ effectiveTime: '2026-08-02T12:04:00.000Z' }] }
          : {}),
      })),
    };
    const identities = await openAt(root, resolver);

    await expect(identities.resolveEffective('solver-delivery', deliveryTime)).resolves.toEqual({
      ok: false,
      reason: 'revoked',
    });
    expect(resolver.resolveBinding).toHaveBeenCalledWith({
      key: identities.get('solver-delivery').keyId,
      agent: AGENT,
    }, deliveryTime);
  });

  it('never exposes evaluator private custody through a child-process secret resolver', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-identities-host-signing-'));
    const resolver: BindingResolver = {
      resolveBinding: vi.fn(async (query) => resolvedBinding({ key: query.key, scopes: ALL_NATIVE_SCOPES })),
    };
    const identities = await openAt(root, resolver);
    expect('createEvaluatorHostSecretResolver' in identities).toBe(false);
    const payload = new TextEncoder().encode('host-validated-verdict-payload');
    const identity = identities.get('evaluator-verdict');
    expect(identity.verify(payload, identity.sign(payload))).toBe(true);
    expect(JSON.stringify(identities)).not.toContain('PRIVATE KEY');
  });
});
