import { createDecipheriv, scryptSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BindingResolver, ResolvedBinding } from '@jinn-network/trust-core';
import { runCli } from '../../src/cli/index.js';
import {
  createNativeRequesterCommand,
  orderedRolesForSet,
  ROLE_SETS,
} from '../../src/cli/commands/native-requester.js';
import {
  IdentityStore,
  listRoleIdentityKeyIds,
  NATIVE_ROLE_IDENTITY_ROLES,
  openRoleIdentitySet,
  type NativeRoleIdentityRole,
} from '../../src/daemon/role-identities.js';
import type { CommandContext } from '../../src/cli/command.js';

function captureIo() {
  const writes: string[] = [];
  const exits: number[] = [];
  return {
    writer: { write: (text: string) => { writes.push(text); return true; } },
    exit: (code: number) => { exits.push(code); },
    writes,
    exits,
  };
}

function context(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const io = captureIo();
  return {
    io,
    ctx: {
      argv,
      stdoutIsTty: false,
      writer: io.writer,
      exit: io.exit,
      env,
    } satisfies CommandContext,
  };
}

interface DecryptedStore {
  readonly metadata: { readonly ownedRoles: readonly string[] };
  readonly roles: readonly { role: string; keyId: string; publicKeyDer: string; privateKeyDer: string }[];
}

/** Decrypts the raw envelope on disk without going through IdentityStore, to check leakage. */
function decryptStoredRoles(storePath: string, password: string): DecryptedStore {
  const envelope = JSON.parse(readFileSync(storePath, 'utf8')) as {
    salt: string; iv: string; authTag: string; ciphertext: string;
  };
  const key = scryptSync(password, Buffer.from(envelope.salt, 'base64'), 32);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as DecryptedStore;
}

function tempStorePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'jinn-native-identity-cli-'));
  return join(root, 'identity', 'roles.enc.json');
}

function alwaysBindingResolver(): BindingResolver {
  return {
    resolveBinding: vi.fn(async (query): Promise<ResolvedBinding> => ({
      binding: {
        key: { didKey: query.key, keyid: query.key },
        scope: ['authorizations', 'observations', 'deliveries', 'verdicts', 'settlements'],
        validFrom: '2026-01-01T00:00:00.000Z',
      },
      effectiveStart: '2026-01-01T00:00:00.000Z',
      revocations: [],
    } as ResolvedBinding)),
  };
}

describe('native-vertical identity CLI surface', () => {
  it('refuses without JINN_PASSWORD', async () => {
    const command = createNativeRequesterCommand();
    const store = tempStorePath();
    const { ctx, io } = context(['identity', '--store', store, '--roles', 'requester', '--create'], {});

    await command.run(ctx);

    const envelope = JSON.parse(io.writes.join(''));
    expect(envelope.code).toBe('invalid_invocation');
    expect(envelope.message).toMatch(/JINN_PASSWORD/);
    expect(io.exits).toEqual([11]);
  });

  it('refuses --roles values outside the four canonical role sets', async () => {
    const command = createNativeRequesterCommand();
    const store = tempStorePath();
    const { ctx, io } = context(
      ['identity', '--store', store, '--roles', 'bogus', '--create'],
      { JINN_PASSWORD: 'operator-password' },
    );

    await command.run(ctx);

    const envelope = JSON.parse(io.writes.join(''));
    expect(envelope.code).toBe('invalid_invocation');
    expect(envelope.message).toMatch(/requester\|admission\|solver\|evaluator/);
  });

  it('refuses --store when missing', async () => {
    const command = createNativeRequesterCommand();
    const { ctx, io } = context(
      ['identity', '--roles', 'requester', '--create'],
      { JINN_PASSWORD: 'operator-password' },
    );

    await command.run(ctx);

    const envelope = JSON.parse(io.writes.join(''));
    expect(envelope.code).toBe('invalid_invocation');
    expect(envelope.message).toMatch(/--store/);
  });

  it('refuses to list a store that does not exist without --create', async () => {
    const command = createNativeRequesterCommand();
    const store = tempStorePath();
    const { ctx, io } = context(
      ['identity', '--store', store, '--roles', 'requester'],
      { JINN_PASSWORD: 'operator-password' },
    );

    await command.run(ctx);

    const envelope = JSON.parse(io.writes.join(''));
    expect(envelope.code).toBe('invalid_invocation');
    expect(envelope.message).toMatch(/does not exist/);
    // The library speaks `create: true` (its own boolean parameter); the CLI surface must
    // reword to the operator's actual flag, not leak the parameter name verbatim.
    expect(envelope.message).toMatch(/--create/);
    expect(envelope.message).not.toMatch(/create: true/);
    expect(envelope.exampleCli).toMatch(/--create/);
    expect(io.exits).toEqual([11]);
  });

  it('creates a store then lists it back with the identical keyIds (round trip)', async () => {
    const command = createNativeRequesterCommand();
    const store = tempStorePath();
    const env = { JINN_PASSWORD: 'operator-password' };

    const created = context(['identity', '--store', store, '--roles', 'requester', '--create'], env);
    await command.run(created.ctx);
    const createdEnvelope = JSON.parse(created.io.writes.join(''));
    expect(createdEnvelope.kind).toBe('native_role_identity_listing');
    expect(createdEnvelope.created).toBe(true);
    expect(createdEnvelope.roleSet).toBe('requester');
    expect(createdEnvelope.identities).toEqual([
      { role: 'requester-submission', keyId: expect.stringMatching(/^did:key:z/) },
      { role: 'requester-discovery', keyId: expect.stringMatching(/^did:key:z/) },
    ]);

    const listed = context(['identity', '--store', store, '--roles', 'requester'], env);
    await command.run(listed.ctx);
    const listedEnvelope = JSON.parse(listed.io.writes.join(''));
    expect(listedEnvelope.created).toBe(false);
    expect(listedEnvelope.identities).toEqual(createdEnvelope.identities);
    expect(listed.io.exits).toEqual([]);
  });

  it('is idempotent across repeated --create calls', async () => {
    const command = createNativeRequesterCommand();
    const store = tempStorePath();
    const env = { JINN_PASSWORD: 'operator-password' };

    const first = context(['identity', '--store', store, '--roles', 'solver', '--create'], env);
    await command.run(first.ctx);
    const second = context(['identity', '--store', store, '--roles', 'solver', '--create'], env);
    await command.run(second.ctx);

    expect(JSON.parse(second.io.writes.join('')).identities).toEqual(
      JSON.parse(first.io.writes.join('')).identities,
    );
    expect(JSON.parse(second.io.writes.join('')).created).toBe(false);
  });

  it('lists role sets in the same canonical order production boot uses', async () => {
    const command = createNativeRequesterCommand();
    const store = tempStorePath();
    const env = { JINN_PASSWORD: 'operator-password' };
    const { ctx, io } = context(['identity', '--store', store, '--roles', 'solver', '--create'], env);

    await command.run(ctx);

    const envelope = JSON.parse(io.writes.join(''));
    expect(envelope.identities.map((i: { role: string }) => i.role)).toEqual([
      'solver-delivery',
      'solver-settlement',
      'solver-discovery',
    ]);
  });

  it('lists the single-role admission set', async () => {
    const command = createNativeRequesterCommand();
    const store = tempStorePath();
    const env = { JINN_PASSWORD: 'operator-password' };
    const { ctx, io } = context(['identity', '--store', store, '--roles', 'admission', '--create'], env);

    await command.run(ctx);

    const envelope = JSON.parse(io.writes.join(''));
    expect(envelope.identities).toEqual([{ role: 'admission', keyId: expect.stringMatching(/^did:key:z/) }]);
  });

  it('fails with a clear error on a wrong password', async () => {
    const command = createNativeRequesterCommand();
    const store = tempStorePath();
    const created = context(
      ['identity', '--store', store, '--roles', 'evaluator', '--create'],
      { JINN_PASSWORD: 'right-password' },
    );
    await command.run(created.ctx);

    const wrong = context(
      ['identity', '--store', store, '--roles', 'evaluator'],
      { JINN_PASSWORD: 'wrong-password' },
    );
    await command.run(wrong.ctx);

    const envelope = JSON.parse(wrong.io.writes.join(''));
    expect(envelope.code).toBe('invalid_invocation');
    expect(envelope.message).toMatch(/cannot be decrypted/);
    expect(wrong.io.exits).toEqual([11]);
  });

  it('never prints private key material in JSON or human output', async () => {
    const command = createNativeRequesterCommand();
    const store = tempStorePath();
    const env = { JINN_PASSWORD: 'operator-password' };

    const jsonRun = context(['identity', '--store', store, '--roles', 'evaluator', '--create'], env);
    await command.run(jsonRun.ctx);
    const humanRun = context(['identity', '--store', store, '--roles', 'evaluator', '--human'], env);
    await command.run(humanRun.ctx);

    const onDisk = decryptStoredRoles(store, 'operator-password');
    const secretSubstrings = onDisk.roles.flatMap((role) => [role.privateKeyDer, role.publicKeyDer]);
    expect(secretSubstrings.length).toBeGreaterThan(0);

    const jsonOutput = jsonRun.io.writes.join('');
    const humanOutput = humanRun.io.writes.join('');
    for (const secret of secretSubstrings) {
      expect(jsonOutput).not.toContain(secret);
      expect(humanOutput).not.toContain(secret);
    }
    // Structural check too: the printed identities carry only role + keyId.
    const parsed = JSON.parse(jsonOutput);
    for (const identity of parsed.identities) {
      expect(Object.keys(identity).sort()).toEqual(['keyId', 'role']);
    }
  });

  it('prints copy-pasteable role -> keyId lines in human mode', async () => {
    const command = createNativeRequesterCommand();
    const store = tempStorePath();
    const env = { JINN_PASSWORD: 'operator-password' };
    const { ctx, io } = context(['identity', '--store', store, '--roles', 'admission', '--create', '--human'], env);

    await command.run(ctx);

    const output = io.writes.join('');
    expect(output).toMatch(/^admission\tdid:key:z/);
  });

  it('creates a store that the production RoleIdentitySet.open boot path accepts', async () => {
    const command = createNativeRequesterCommand();
    const store = tempStorePath();
    const env = { JINN_PASSWORD: 'operator-password' };
    const { ctx, io } = context(['identity', '--store', store, '--roles', 'solver', '--create'], env);

    await command.run(ctx);
    const envelope = JSON.parse(io.writes.join(''));

    const identities = await openRoleIdentitySet({
      storePath: store,
      password: 'operator-password',
      agent: 'urn:jinn:operator:test',
      requiredRoles: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
      bindingResolver: alwaysBindingResolver(),
      now: () => new Date('2026-08-05T00:00:00.000Z'),
    });

    for (const identity of envelope.identities) {
      expect(identities.get(identity.role).keyId).toBe(identity.keyId);
    }
  });

  it('advertises identity usage in --help', async () => {
    const io = captureIo();

    await runCli(['native-vertical', '--help'], { writer: io.writer, exit: io.exit, stdoutIsTty: false });

    expect(io.writes.join('')).toContain('jinn native-vertical identity --store <absolute path>');
  });

  it('partitions every native role into exactly one of the four ROLE_SETS (no gaps, no overlaps)', () => {
    // Asserts against the real implementation's ROLE_SETS export, not a hardcoded literal that
    // could silently drift from it: dropping or duplicating a role in ROLE_SETS must fail this.
    const allMembers = Object.values(ROLE_SETS).flatMap((set) => [...set]);
    expect(new Set(allMembers).size).toBe(allMembers.length); // no role listed in more than one set
    expect([...allMembers].sort()).toEqual([...NATIVE_ROLE_IDENTITY_ROLES].sort()); // no gaps
  });

  it('requester/admission/solver/evaluator ROLE_SETS match the exact boot-order role lists', () => {
    expect(orderedRolesForSet('requester')).toEqual(['requester-submission', 'requester-discovery']);
    expect(orderedRolesForSet('admission')).toEqual(['admission']);
    expect(orderedRolesForSet('solver')).toEqual(['solver-delivery', 'solver-settlement', 'solver-discovery']);
    // Explicit evaluator assertion: catches a dropped member (e.g. evaluator-discovery) that a
    // sum/sort-only partition check across all four sets could otherwise mask.
    expect(orderedRolesForSet('evaluator')).toEqual([
      'evaluator-verdict',
      'evaluator-settlement',
      'evaluator-discovery',
    ]);
  });

  it('refuses a relative --store path', async () => {
    const command = createNativeRequesterCommand();
    const { ctx, io } = context(
      ['identity', '--store', 'relative/roles.enc.json', '--roles', 'requester', '--create'],
      { JINN_PASSWORD: 'operator-password' },
    );

    await command.run(ctx);

    const envelope = JSON.parse(io.writes.join(''));
    expect(envelope.code).toBe('invalid_invocation');
    expect(envelope.message).toMatch(/absolute/);
  });

  it('refuses --roles that does not match an existing store\'s owned role set', async () => {
    const command = createNativeRequesterCommand();
    const store = tempStorePath();
    const env = { JINN_PASSWORD: 'operator-password' };

    const created = context(['identity', '--store', store, '--roles', 'requester', '--create'], env);
    await command.run(created.ctx);
    expect(created.io.exits).toEqual([]);

    const mismatched = context(['identity', '--store', store, '--roles', 'solver'], env);
    await command.run(mismatched.ctx);

    const envelope = JSON.parse(mismatched.io.writes.join(''));
    expect(envelope.code).toBe('invalid_invocation');
    expect(envelope.message).toMatch(/owned role set/);
    expect(mismatched.io.exits).toEqual([11]);
  });

  it('creates the store file at 0600 and a freshly-created parent directory at 0700', async () => {
    const command = createNativeRequesterCommand();
    const store = tempStorePath();
    const { ctx } = context(
      ['identity', '--store', store, '--roles', 'admission', '--create'],
      { JINN_PASSWORD: 'operator-password' },
    );

    await command.run(ctx);

    expect(statSync(store).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(store)).mode & 0o777).toBe(0o700);
  });

  it('never narrows the mode of a pre-existing parent directory (MINOR 3 — no $HOME chmod)', async () => {
    const command = createNativeRequesterCommand();
    const root = mkdtempSync(join(tmpdir(), 'jinn-native-identity-preexisting-'));
    const parent = join(root, 'operator-home');
    mkdirSync(parent, { mode: 0o755 });
    chmodSync(parent, 0o755); // mkdir's mode is umask-adjusted; force the exact starting mode.
    const store = join(parent, 'roles.enc.json');
    const { ctx } = context(
      ['identity', '--store', store, '--roles', 'admission', '--create'],
      { JINN_PASSWORD: 'operator-password' },
    );

    await command.run(ctx);

    expect(statSync(parent).mode & 0o777).toBe(0o755);
    expect(statSync(store).mode & 0o777).toBe(0o600); // the store file itself is still locked down
  });

  it('detects a lost create race and refuses to print keyIds nobody can bind to (MAJOR 1)', async () => {
    const store = tempStorePath();
    const password = 'operator-password';
    const ownedRoles: readonly NativeRoleIdentityRole[] = ['admission'];
    const originalLoadOrCreate = IdentityStore.prototype.loadOrCreate;
    let calls = 0;

    const spy = vi.spyOn(IdentityStore.prototype, 'loadOrCreate').mockImplementation(
      async function (this: IdentityStore, now: Date, roles: readonly NativeRoleIdentityRole[]) {
        calls += 1;
        if (calls !== 1) return originalLoadOrCreate.call(this, now, roles);
        // This call mints and persists its own keys first...
        const mine = await originalLoadOrCreate.call(this, now, roles);
        // ...but a concurrent competitor's write lands right after (e.g. the native daemon's own
        // first boot on the same store path, which holds no lease against this CLI), clobbering
        // the file with a different mint before the caller gets to verify.
        await unlink(store);
        const competitor = await IdentityStore.open({ path: store, password });
        await originalLoadOrCreate.call(competitor, now, roles);
        return mine;
      },
    );

    try {
      await expect(
        listRoleIdentityKeyIds({ storePath: store, password, ownedRoles, create: true }),
      ).rejects.toThrow(/creation race detected/);
    } finally {
      spy.mockRestore();
    }
  });
});
