import { createDecipheriv, scryptSync } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BindingResolver, ResolvedBinding } from '@jinn-network/trust-core';
import { runCli } from '../../src/cli/index.js';
import { createNativeRequesterCommand } from '../../src/cli/commands/native-requester.js';
import { NATIVE_ROLE_IDENTITY_ROLES, openRoleIdentitySet } from '../../src/daemon/role-identities.js';
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

  it('lists NATIVE_ROLE_IDENTITY_ROLES membership across the four sets with no gaps or overlaps', () => {
    // Sanity guard on the fixture itself: the CLI's four role-set groupings partition every
    // native role exactly once, matching the requester/admission/solver/evaluator stores
    // native-production-deployment.ts opens at boot.
    const grouped = ['requester-submission', 'requester-discovery', 'admission',
      'solver-delivery', 'solver-settlement', 'solver-discovery',
      'evaluator-verdict', 'evaluator-settlement', 'evaluator-discovery'];
    expect([...grouped].sort()).toEqual([...NATIVE_ROLE_IDENTITY_ROLES].sort());
  });
});
