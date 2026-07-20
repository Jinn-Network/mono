import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runCapabilityProbe,
  writeCapabilityAttestation,
  type CapabilityProbeGitRunner,
} from '../../src/lifecycle/capability-probe.js';
import {
  readCapabilityAttestation,
} from '../../src/lifecycle/capability-attestation.js';

const REMOTE = 'jinn-autopilot-v2';
const PROBE_ID = '12345678-1234-4234-8234-123456789abc';

function fakeGit(options: {
  brokenAtomicRejection?: boolean;
  loseSecondSuccessfulAtomicResponse?: boolean;
} = {}) {
  const refs = new Map<string, string>();
  const pushes: string[][] = [];
  let commit = 0;
  let successfulAtomicPushes = 0;
  const runGit: CapabilityProbeGitRunner = async (_command, rawArgs) => {
    const args = [...rawArgs];
    expect(args.splice(0, 2)).toEqual(['-C', '/repo']);
    const command = args[0];
    if (command === 'remote') {
      return 'https://github.com/Jinn-Network/mono.git\n';
    }
    if (command === 'ls-remote') {
      const ref = args[2]!;
      const value = refs.get(ref);
      return value === undefined ? '' : `${value}\t${ref}\n`;
    }
    if (command === 'rev-parse') {
      return args[2] === 'HEAD^{tree}' ? `${'b'.repeat(40)}\n` : `${'a'.repeat(40)}\n`;
    }
    if (args.includes('commit-tree')) {
      commit += 1;
      return `${String(commit).repeat(40)}\n`;
    }
    if (command !== 'push') {
      throw new Error(`unexpected git ${args.join(' ')}`);
    }
    pushes.push(args);
    const atomic = args.includes('--atomic');
    const remoteIndex = args.indexOf(REMOTE);
    expect(remoteIndex).toBeGreaterThan(0);
    const optionsBeforeRemote = args.slice(1, remoteIndex);
    const refspecs = args.slice(remoteIndex + 1);
    const leases = new Map<string, string | null>();
    for (const option of optionsBeforeRemote) {
      if (!option.startsWith('--force-with-lease=')) continue;
      const lease = option.slice('--force-with-lease='.length);
      const separator = lease.lastIndexOf(':');
      const ref = lease.slice(0, separator);
      const expected = lease.slice(separator + 1);
      leases.set(ref, expected.length === 0 ? null : expected);
    }
    const updates = refspecs.map((refspec) => {
      const separator = refspec.lastIndexOf(':');
      return {
        next: refspec.slice(0, separator) || null,
        ref: refspec.slice(separator + 1),
      };
    });
    const stale = updates.some(({ ref }) =>
      (refs.get(ref) ?? null) !== (leases.get(ref) ?? null));
    if (stale) {
      if (atomic && options.brokenAtomicRejection && updates[0] !== undefined) {
        const first = updates[0];
        if (first.next === null) refs.delete(first.ref);
        else refs.set(first.ref, first.next);
      }
      throw new Error('lease rejected');
    }
    for (const update of updates) {
      if (update.next === null) refs.delete(update.ref);
      else refs.set(update.ref, update.next);
    }
    if (atomic) {
      successfulAtomicPushes += 1;
      if (
        options.loseSecondSuccessfulAtomicResponse
        && successfulAtomicPushes === 2
      ) {
        throw new Error('transport failed after remote accepted the push');
      }
    }
    return '';
  };
  return { refs, pushes, runGit };
}

describe('live GitHub capability probe', () => {
  it('proves CAS, atomic rejection, ambiguous readback, and exact cleanup', async () => {
    const fake = fakeGit();
    const attestation = await runCapabilityProbe({
      repositoryPath: '/repo',
      remoteName: REMOTE,
      implementerLogin: 'implementation-bot',
      runGit: fake.runGit,
      nextId: () => PROBE_ID,
      now: () => new Date('2026-07-20T12:00:00.000Z'),
    });

    expect(attestation.proofs).toEqual({
      absentRefCreation: true,
      expectedParentRejection: true,
      atomicPairSuccess: true,
      atomicPairRejection: true,
      ambiguousReadback: true,
      exactCleanup: true,
    });
    expect(fake.refs.size).toBe(0);
    expect(fake.pushes.filter((args) => args.includes('--atomic'))).toHaveLength(3);

    const directory = mkdtempSync(join(tmpdir(), 'jinn-capability-attestation-'));
    const path = join(directory, 'attestation.json');
    writeCapabilityAttestation(path, attestation, () => PROBE_ID);
    expect(lstatSync(path).mode & 0o077).toBe(0);
    expect(readCapabilityAttestation(path, {
      remoteName: REMOTE,
      configuredLogins: ['implementation-bot'],
      now: new Date('2026-07-21T12:00:00.000Z'),
    })).toEqual(attestation);
    expect(() => readCapabilityAttestation(path, {
      remoteName: REMOTE,
      configuredLogins: ['implementation-bot'],
      now: new Date('2026-08-20T12:00:00.001Z'),
    })).toThrow(/expired|validity window/i);
  });

  it('refuses attestation when a rejected atomic push changes either ref', async () => {
    const fake = fakeGit({ brokenAtomicRejection: true });

    await expect(runCapabilityProbe({
      repositoryPath: '/repo',
      remoteName: REMOTE,
      implementerLogin: 'implementation-bot',
      runGit: fake.runGit,
      nextId: () => PROBE_ID,
      now: () => new Date('2026-07-20T12:00:00.000Z'),
    })).rejects.toThrow(/both refs unchanged/i);
  });

  it('classifies a genuinely lost atomic push response by exact paired readback', async () => {
    const fake = fakeGit({ loseSecondSuccessfulAtomicResponse: true });

    await expect(runCapabilityProbe({
      repositoryPath: '/repo',
      remoteName: REMOTE,
      implementerLogin: 'implementation-bot',
      runGit: fake.runGit,
      nextId: () => PROBE_ID,
      now: () => new Date('2026-07-20T12:00:00.000Z'),
    })).resolves.toMatchObject({
      proofs: { ambiguousReadback: true },
    });
    expect(fake.refs.size).toBe(0);
  });

  it('refuses to overwrite an existing output path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jinn-capability-old-'));
    const path = join(directory, 'attestation.json');
    const old = '{"stale":true}\n';
    writeFileSync(path, old, { mode: 0o600 });
    const fake = fakeGit();
    const attestation = await runCapabilityProbe({
      repositoryPath: '/repo',
      remoteName: REMOTE,
      implementerLogin: 'implementation-bot',
      runGit: fake.runGit,
      nextId: () => PROBE_ID,
      now: () => new Date('2026-07-20T12:00:00.000Z'),
    });

    expect(() => writeCapabilityAttestation(path, attestation))
      .toThrow(/exist/i);
    expect(readFileSync(path, 'utf8')).toBe(old);
  });
});
