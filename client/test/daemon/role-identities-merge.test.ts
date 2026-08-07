/**
 * `RoleIdentitySet.merge` (one-swap M2, umbrella #2461).
 *
 * `identityStores` is keyed by role FAMILY — one encrypted file per family — but
 * `composition-root.ts`'s native mode reads across families off a single `RoleIdentitySet`
 * (`solver-*` for delivery/publication/settlement, `requester-submission` for the projector's
 * association resolver). A multi-role fleet process therefore presents one set over several
 * stores. These tests pin that it is a UNION and refuses every ambiguity rather than picking.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BindingResolver, ResolvedBinding } from '@jinn-network/trust-core';
import { describe, expect, it, vi } from 'vitest';
import {
  IdentityStoreError,
  RoleIdentitySet,
  openRoleIdentitySet,
  type NativeRoleIdentityRole,
} from '../../src/daemon/role-identities.js';

const AGENT = 'urn:jinn:operator:fleet';
const BOOT_TIME = '2026-08-06T12:00:00.000Z';
/**
 * Every scope a native role can require. Includes the Record Discovery announce-plane scope the
 * three `*-discovery` roles gained in issue #2525 — without it this is not a "grants everything"
 * binding and `RoleIdentitySet.open` refuses those roles.
 */
const ALL_SCOPES = [
  'authorizations', 'observations', 'deliveries', 'verdicts', 'settlements',
  'jinn:discovery-announcements',
];

function resolver(): BindingResolver {
  return {
    resolveBinding: vi.fn(async (query: { key: string }) => ({
      binding: {
        key: { didKey: query.key, keyid: query.key },
        scope: ALL_SCOPES,
        validFrom: '2026-08-01T00:00:00.000Z',
      },
      effectiveStart: '2026-08-01T00:00:00.000Z',
      revocations: [],
    } as unknown as ResolvedBinding)),
  };
}

function open(input: {
  readonly root: string;
  readonly file: string;
  readonly roles: readonly NativeRoleIdentityRole[];
  readonly bindingResolver: BindingResolver;
  readonly agent?: string;
}): Promise<RoleIdentitySet> {
  return openRoleIdentitySet({
    agent: input.agent ?? AGENT,
    requiredRoles: input.roles,
    storePath: join(input.root, input.file),
    password: 'operator-password',
    bindingResolver: input.bindingResolver,
    now: () => new Date(BOOT_TIME),
  });
}

const SOLVER_ROLES = ['solver-delivery', 'solver-settlement', 'solver-discovery'] as const;

describe('RoleIdentitySet.merge', () => {
  it('unions two family stores into the one set the native composition reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-merge-'));
    const bindingResolver = resolver();
    const solver = await open({ root, file: 'solver.enc.json', roles: SOLVER_ROLES, bindingResolver });
    const requester = await open({
      root, file: 'requester.enc.json', roles: ['requester-submission'], bindingResolver,
    });

    const merged = RoleIdentitySet.merge([solver, requester]);
    expect(merged.agent).toBe(AGENT);
    // Every role each store owned is reachable, and it is the SAME identity object -- merging
    // re-mints nothing.
    for (const role of SOLVER_ROLES) {
      expect(merged.get(role).keyId).toBe(solver.get(role).keyId);
    }
    expect(merged.get('requester-submission').keyId)
      .toBe(requester.get('requester-submission').keyId);
    // ... and no role neither store owned appears.
    expect(() => merged.get('evaluator-verdict')).toThrow(IdentityStoreError);
  });

  it('still re-resolves authority at the record\'s own effective time, caching no boot decision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-merge-effective-'));
    const bindingResolver = resolver();
    const merged = RoleIdentitySet.merge([
      await open({ root, file: 'solver.enc.json', roles: SOLVER_ROLES, bindingResolver }),
    ]);
    const callsAfterOpen = vi.mocked(bindingResolver.resolveBinding).mock.calls.length;

    await expect(merged.resolveEffective('solver-delivery', BOOT_TIME))
      .resolves.toMatchObject({ ok: true });
    expect(vi.mocked(bindingResolver.resolveBinding).mock.calls.length)
      .toBeGreaterThan(callsAfterOpen);
  });

  it('refuses an empty merge', () => {
    expect(() => RoleIdentitySet.merge([])).toThrow(/at least one set/u);
  });

  it('refuses sets that do not share one Agent IRI', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-merge-agent-'));
    const bindingResolver = resolver();
    const solver = await open({ root, file: 'solver.enc.json', roles: SOLVER_ROLES, bindingResolver });
    const other = await open({
      root,
      file: 'requester.enc.json',
      roles: ['requester-submission'],
      bindingResolver,
      agent: 'urn:jinn:operator:someone-else',
    });
    expect(() => RoleIdentitySet.merge([solver, other])).toThrow(/do not share one Agent IRI/u);
  });

  it('refuses two stores claiming the same signing role', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-merge-dupe-'));
    const bindingResolver = resolver();
    const first = await open({
      root, file: 'a.enc.json', roles: ['solver-delivery'], bindingResolver,
    });
    const second = await open({
      root, file: 'b.enc.json', roles: ['solver-delivery'], bindingResolver,
    });
    expect(() => RoleIdentitySet.merge([first, second]))
      .toThrow(/owned by more than one identity store/u);
  });

  it('refuses sets opened against different binding resolvers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-role-merge-resolver-'));
    const solver = await open({
      root, file: 'solver.enc.json', roles: SOLVER_ROLES, bindingResolver: resolver(),
    });
    const requester = await open({
      root, file: 'requester.enc.json', roles: ['requester-submission'], bindingResolver: resolver(),
    });
    expect(() => RoleIdentitySet.merge([solver, requester]))
      .toThrow(/do not share one binding resolver/u);
  });
});
