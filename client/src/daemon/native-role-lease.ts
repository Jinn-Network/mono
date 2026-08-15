import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

interface LeaseDocument {
  readonly version: 1;
  readonly role: 'requester' | 'solver' | 'evaluator';
  readonly agent: string;
  readonly owner: string;
  readonly pid: number;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
}

export class NativeRoleLeaseError extends Error {
  override readonly name = 'NativeRoleLeaseError';
}

async function readLease(path: string): Promise<LeaseDocument | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LeaseDocument;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new NativeRoleLeaseError(`native role lease cannot be read: ${String(cause)}`);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function valid(document: LeaseDocument, role: LeaseDocument['role'], agent: string): boolean {
  return document.version === 1
    && document.role === role
    && document.agent === agent
    && document.owner.length >= 16
    && Number.isSafeInteger(document.pid)
    && document.pid > 0
    && Number.isFinite(Date.parse(document.expiresAt));
}

async function atomicWrite(path: string, value: LeaseDocument): Promise<void> {
  const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (cause) {
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
}

/** Process-level ownership acquired before role custody is opened. */
export function createNativeRoleLease(input: {
  readonly path: string;
  readonly role: LeaseDocument['role'];
  readonly agent: string;
  readonly ttlMs?: number;
  readonly now?: () => Date;
  readonly isPidAlive?: (pid: number) => boolean;
}): {
  acquire(): Promise<void>;
  owned(): Promise<boolean>;
  renew(): Promise<void>;
  release(): Promise<void>;
} {
  const owner = randomBytes(16).toString('hex');
  const ttlMs = input.ttlMs ?? 30_000;
  const now = input.now ?? (() => new Date());
  const alive = input.isPidAlive ?? pidAlive;
  let acquired = false;

  function document(acquiredAt: string): LeaseDocument {
    const current = now();
    if (!Number.isFinite(current.getTime())) throw new NativeRoleLeaseError('native role lease clock is invalid');
    return {
      version: 1,
      role: input.role,
      agent: input.agent,
      owner,
      pid: process.pid,
      acquiredAt,
      renewedAt: current.toISOString(),
      expiresAt: new Date(current.getTime() + ttlMs).toISOString(),
    };
  }

  return {
    async acquire() {
      if (acquired) return;
      await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const next = document(now().toISOString());
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          handle = await open(input.path, 'wx', 0o600);
          await handle.writeFile(`${JSON.stringify(next)}\n`, 'utf8');
          await handle.sync();
          await handle.close();
          acquired = true;
          return;
        } catch (cause) {
          await handle?.close().catch(() => undefined);
          if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
        }
        const prior = await readLease(input.path);
        if (prior === undefined) continue;
        if (!valid(prior, input.role, input.agent)) {
          throw new NativeRoleLeaseError('native role lease belongs to a different or malformed scope');
        }
        if (Date.parse(prior.expiresAt) > now().getTime() || alive(prior.pid)) {
          throw new NativeRoleLeaseError(`native ${input.role} role already has a live worker`);
        }
        await rename(input.path, `${input.path}.stale-${prior.owner}`).catch((cause) => {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        });
      }
      throw new NativeRoleLeaseError(`native ${input.role} role lease could not be acquired`);
    },
    async owned() {
      const current = await readLease(input.path);
      return acquired && current?.owner === owner && Date.parse(current.expiresAt) > now().getTime();
    },
    async renew() {
      const current = await readLease(input.path);
      if (!acquired || current?.owner !== owner) throw new NativeRoleLeaseError('native role lease ownership was lost');
      await atomicWrite(input.path, document(current.acquiredAt));
    },
    async release() {
      const current = await readLease(input.path);
      if (current?.owner === owner) await unlink(input.path).catch(() => undefined);
      acquired = false;
    },
  };
}
