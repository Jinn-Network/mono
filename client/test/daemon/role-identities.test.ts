import { readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
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

const ALL_NATIVE_SCOPES = ['authorizations', 'observations', 'deliveries', 'verdicts'] as const;

function openAt(root: string, bindingResolver: BindingResolver) {
  return openRoleIdentitySet({
    storePath: join(root, 'identity', 'roles.enc.json'),
    password: 'operator-password',
    agent: AGENT,
    bindingResolver,
    now: () => new Date(BOOT_TIME),
  });
}

describe('native persistent role identities', () => {
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

  it('releases evaluator custody only for the exact sealed Attempt and immutable deployment registration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-identities-host-secret-'));
    const resolver: BindingResolver = {
      resolveBinding: vi.fn(async (query) => resolvedBinding({ key: query.key, scopes: ALL_NATIVE_SCOPES })),
    };
    const identities = await openAt(root, resolver);
    const registration = {
      handle: 'evaluator.pem',
      evaluator: AGENT,
      registrationId: 'prediction-v1',
      evaluationMethodDigest: `sha256:${'6'.repeat(64)}` as const,
      authorize: (input: { readonly submissionDigest: string }) => input.submissionDigest === `sha256:${'2'.repeat(64)}`,
    };
    const host = identities.createEvaluatorHostSecretResolver(registration);
    const authorization = {
      attempt: { attemptUri: 'urn:uuid:00000000-0000-4000-8000-000000000040' },
      launcherId: 'evaluation-harness',
      taskDigest: `sha256:${'1'.repeat(64)}`,
      submission: 'urn:uuid:00000000-0000-4000-8000-000000000041',
      submissionDigest: `sha256:${'2'.repeat(64)}`,
      taskProfile: 'https://jinn.network/task-profiles/evaluation-task/1.0',
      deadline: '2026-08-03T00:00:00.000Z',
      handle: registration.handle,
      target: registration.handle,
      role: 'evaluator',
      evaluator: registration.evaluator,
      registrationId: registration.registrationId,
      evaluationMethodDigest: registration.evaluationMethodDigest,
    } as const;
    const bytes = await host.resolve(authorization as never, {});
    expect(new TextDecoder().decode(bytes)).toContain('PRIVATE KEY');
    bytes.fill(0);
    const fresh = await host.resolve(authorization as never, {});
    expect(new TextDecoder().decode(fresh)).toContain('PRIVATE KEY');
    fresh.fill(0);
    await expect(host.resolve({ ...authorization, submissionDigest: `sha256:${'3'.repeat(64)}` } as never, {}))
      .rejects.toThrow(/durable sealed evaluation/);
    await expect(host.resolve({ ...authorization, taskProfile: 'https://jinn.network/task-profiles/repository-work/1.0' } as never, {}))
      .rejects.toThrow(/outside its sealed Attempt\/registration scope/);
    await expect(host.resolve({ ...authorization, registrationId: 'task-controlled' } as never, {}))
      .rejects.toThrow(/outside its sealed Attempt\/registration scope/);
    await expect(host.resolve({ ...authorization, evaluationMethodDigest: `sha256:${'7'.repeat(64)}` } as never, {}))
      .rejects.toThrow(/outside its sealed Attempt\/registration scope/);
  });
});
