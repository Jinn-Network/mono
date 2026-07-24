import { randomUUID } from 'node:crypto';
import {
  linkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
} from 'node:path';
import {
  CAPABILITY_ATTESTATION_MAX_AGE_MS,
  decodeCapabilityAttestation,
  type CapabilityAttestation,
} from './capability-attestation.js';
import { CANONICAL_GITHUB_HTTPS_REMOTE } from './implementation-executor.js';
import {
  parseReviewClaimRefGitListing,
  REVIEW_CLAIM_REF_GLOB,
} from './github-reader.js';
import { gitOid, type GitOid } from './types.js';

export type CapabilityProbeGitRunner = (
  command: 'git',
  args: readonly string[],
) => Promise<string>;

export interface CapabilityProbeOptions {
  readonly repositoryPath: string;
  readonly remoteName: string;
  readonly implementerLogin: string;
  readonly runGit: CapabilityProbeGitRunner;
  readonly now?: () => Date;
  readonly nextId?: () => string;
}

function exactLease(ref: string, expected: GitOid | null): string {
  return `--force-with-lease=${ref}:${expected ?? ''}`;
}

function parseProbeId(raw: string): string {
  const normalized = raw.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    throw new Error('Capability probe ID must be a UUID');
  }
  return normalized;
}

function parseLsRemote(output: string, ref: string): GitOid | null {
  if (output.trim().length === 0) return null;
  const matches = output.trimEnd().split('\n').filter((line) =>
    line.endsWith(`\t${ref}`));
  if (matches.length !== 1) {
    throw new Error(`Capability probe readback for ${ref} is ambiguous`);
  }
  return gitOid(matches[0]!.split('\t')[0] ?? '');
}

async function requireRejected(operation: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('Capability probe expected a leased push rejection');
}

export async function runCapabilityProbe(
  options: CapabilityProbeOptions,
): Promise<CapabilityAttestation> {
  const now = options.now ?? (() => new Date());
  const probeId = parseProbeId((options.nextId ?? randomUUID)());
  const branch = `refs/heads/autopilot/capability-${probeId}`;
  const review =
    `refs/jinn-autopilot/review-claims/v1/capability-${probeId}`;
  const git = (args: readonly string[]) => options.runGit(
    'git',
    ['-C', options.repositoryPath, ...args],
  );
  const readRef = async (ref: string): Promise<GitOid | null> =>
    parseLsRemote(await git(['ls-remote', options.remoteName, ref]), ref);
  const push = (args: readonly string[]) => {
    const refspecIndex = args.findIndex((arg) => !arg.startsWith('--'));
    if (refspecIndex < 0) throw new Error('Capability probe push has no refspec');
    return git([
      'push',
      ...args.slice(0, refspecIndex),
      options.remoteName,
      ...args.slice(refspecIndex),
    ]);
  };
  const remoteUrl = (await git([
    'remote',
    'get-url',
    options.remoteName,
  ])).trim();
  if (remoteUrl !== CANONICAL_GITHUB_HTTPS_REMOTE) {
    throw new Error('Capability probe requires the canonical HTTPS remote');
  }
  if (await readRef(branch) !== null || await readRef(review) !== null) {
    throw new Error('Capability probe disposable refs already exist');
  }

  const tree = gitOid((await git([
    'rev-parse',
    '--verify',
    'HEAD^{tree}',
  ])).trim());
  let parent = gitOid((await git([
    'rev-parse',
    '--verify',
    'HEAD',
  ])).trim());
  const commits: GitOid[] = [];
  for (let index = 1; index <= 3; index += 1) {
    const commit = gitOid((await git([
      '-c',
      'user.name=Jinn Autopilot',
      '-c',
      'user.email=autopilot@jinn.network',
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      `Autopilot capability probe ${probeId} step ${index}`,
    ])).trim());
    commits.push(commit);
    parent = commit;
  }
  const [one, two, three] = commits as [
    GitOid,
    GitOid,
    GitOid,
  ];

  try {
    await push([exactLease(review, null), `${one}:${review}`]);
    if (await readRef(review) !== one) {
      throw new Error('Capability probe absent-ref creation readback failed');
    }
    // jinn-mono#1883-follow-up: GitHub's GraphQL `ref(qualifiedName:)`
    // permanently returns null for refs/jinn-autopilot/* — proven live, and
    // it silently broke every review-claim read. Prove the git-transport
    // listing production now uses instead (`GhLifecycleReader`'s
    // `git ls-remote <remote> '<glob>'`) actually surfaces this disposable
    // ref with the exact OID just pushed, so this gate covers the read path
    // as well as the write path.
    const listedAfterCreation = parseReviewClaimRefGitListing(
      await git(['ls-remote', options.remoteName, REVIEW_CLAIM_REF_GLOB]),
    );
    if (listedAfterCreation.get(`capability-${probeId}`) !== one) {
      throw new Error(
        'Capability probe git-transport listing did not surface the disposable review ref',
      );
    }
    await requireRejected(() =>
      push([exactLease(review, null), `${two}:${review}`]));
    if (await readRef(review) !== one) {
      throw new Error('Capability probe competing absent-ref write changed the ref');
    }

    await push([exactLease(review, one), `${two}:${review}`]);
    if (await readRef(review) !== two) {
      throw new Error('Capability probe expected-parent advance failed');
    }
    await requireRejected(() =>
      push([exactLease(review, one), `${three}:${review}`]));
    if (await readRef(review) !== two) {
      throw new Error('Capability probe stale-parent rejection changed the ref');
    }

    await push([exactLease(branch, null), `${one}:${branch}`]);
    if (await readRef(branch) !== one) {
      throw new Error('Capability probe branch absent-ref creation readback failed');
    }
    await push([exactLease(branch, one), `${two}:${branch}`]);
    if (await readRef(branch) !== two) {
      throw new Error('Capability probe branch expected-parent advance failed');
    }

    try {
      await push([exactLease(branch, two), `${three}:${branch}`]);
      throw new Error('simulated capability-probe response loss');
    } catch {
      // A rejected push and an accepted push whose response was lost are
      // indistinguishable here. Classify either outcome only by exact
      // readback of the ref.
    }
    const ambiguousBranch = await readRef(branch);
    if (ambiguousBranch !== three) {
      throw new Error('Capability probe ambiguous readback did not converge');
    }

    await push([exactLease(branch, three), `:${branch}`]);
    await push([exactLease(review, two), `:${review}`]);
    if (await readRef(branch) !== null || await readRef(review) !== null) {
      throw new Error('Capability probe exact cleanup was incomplete');
    }
  } catch (error) {
    throw new Error(
      `Live GitHub capability probe failed; disposable refs were retained for inspection: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const verifiedAt = now();
  return decodeCapabilityAttestation({
    version: 2,
    repositoryUrl: CANONICAL_GITHUB_HTTPS_REMOTE,
    remoteName: options.remoteName,
    probeId,
    implementerLogin: options.implementerLogin,
    verifiedAt: verifiedAt.toISOString(),
    expiresAt: new Date(
      verifiedAt.getTime() + CAPABILITY_ATTESTATION_MAX_AGE_MS,
    ).toISOString(),
    refs: { branch, review },
    proofs: {
      absentRefCreation: true,
      expectedParentRejection: true,
      ambiguousReadback: true,
      exactCleanup: true,
      readViaGitTransport: true,
    },
  }, {
    remoteName: options.remoteName,
    configuredLogins: [options.implementerLogin],
    now: verifiedAt,
  });
}

export function writeCapabilityAttestation(
  outputPath: string,
  attestation: CapabilityAttestation,
  nextId: () => string = randomUUID,
): void {
  if (!isAbsolute(outputPath)) {
    throw new Error('Capability attestation output path must be absolute');
  }
  const temporary = join(
    dirname(outputPath),
    `.capability-attestation-${nextId()}.tmp`,
  );
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify(attestation, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    // Atomic no-clobber publication: never overwrite an older artifact if a
    // caller accidentally reuses its path.
    linkSync(temporary, outputPath);
  } finally {
    rmSync(temporary, { force: true });
  }
}
