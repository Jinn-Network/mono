/**
 * Tests for `jinn evidence fetch` (issue #4179) — the requester verb that
 * reaches the artifact retrieval primitive.
 *
 * The primitive is injected through the command factory, so the verb's error
 * mapping and output shape are exercised without any network. Only the IPFS
 * envelope byte fetch is mocked, matching `evidence.test.ts`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEvidenceCommand } from '../../../src/cli/commands/evidence.js';
import type { CommandContext } from '../../../src/cli/command.js';
import type {
  ArtifactAddress,
  ArtifactLocators,
  FetchVerifiedArtifactResult,
  VerifiedArtifact,
} from '@jinn-network/core/corpus-read';

const fetchSignedEnvelopeBytesRawMock = vi.hoisted(() =>
  vi.fn(async (_gateway: string, _cid: string) => new Uint8Array(0)),
);

// MOCK_JUSTIFICATION: the IPFS gateway read is a network boundary reached through
// a module-level import shared with `evidence show`; the same mock is used by the
// sibling `evidence.test.ts`. The artifact fetch under test is injected, not mocked.
vi.mock('../../../src/adapters/mech/ipfs.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchSignedEnvelopeBytesRaw: fetchSignedEnvelopeBytesRawMock,
}));

// ── fixtures ─────────────────────────────────────────────────────────────────

const SAFE = `0x${'11'.repeat(20)}`;
const EOA = `0x${'22'.repeat(20)}`;
const ARTIFACT_SHA = 'c'.repeat(64);
const SECOND_SHA = 'd'.repeat(64);
const ENVELOPE_CID = 'bafy-envelope-001';
const BYTES = Buffer.from('the delivered artifact', 'utf-8');

function artifact(sha256: string, artifactType: string): Record<string, unknown> {
  return {
    artifactType,
    sha256,
    access: { endpoint: 'https://op.example.com', priceUsdc: '0' },
  };
}

function buildEnvelope(artifacts: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    schemaVersion: 'jinn.execution.v1',
    solverType: 'portfolio.v0',
    role: 'solution',
    generatedAt: 1700000000000,
    task: {
      cid: 'bafy-task-001',
      onchainCreationTx: `0x${'ab'.repeat(32)}`,
      onchainCreationBlock: 100,
      requestId: `0x${'cd'.repeat(32)}`,
    },
    participant: { safeAddress: SAFE, agentEoa: EOA },
    window: { startTs: 1, endTs: 86400001 },
    executor: {
      implName: 'claude-mcp',
      implVersion: '1.0.0',
      clientGitSha: 'abc123',
      codeDigest: `sha256:${'ab'.repeat(32)}`,
      runtimeBundleDigest: `sha256:${'bc'.repeat(32)}`,
      plugins: [],
      signingKey: { kind: 'agent-eoa', pubkey: EOA },
    },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts,
    payload: {},
    signature: {
      algo: 'secp256k1',
      signer: EOA,
      hash: `0x${'ee'.repeat(32)}`,
      sig: `0x${'ff'.repeat(65)}`,
    },
  };
}

function encode(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(value));
}

const tempDirs: string[] = [];

function withConfig(argv: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-evidence-fetch-config-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ network: 'testnet' }), 'utf-8');
  return [...argv, '--config', configPath];
}

function makeCtx(argv: string[]): {
  ctx: CommandContext;
  writes: string[];
  exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv,
    stdoutIsTty: false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    env: {},
  };
  return { ctx, writes, exits };
}

function verified(): VerifiedArtifact {
  return {
    sha256: ARTIFACT_SHA,
    bytes: BYTES,
    artifactType: 'output.portfolio.v0',
    provenance: {
      source: 'origin',
      sourceUri: `https://op.example.com/v1/artifacts/${ARTIFACT_SHA}/content`,
      digestAlgorithm: 'sha256',
      fetchedAt: '2026-09-09T00:00:00.000Z',
      sourceOperator: SAFE,
      envelopeCid: ENVELOPE_CID,
      attempts: [
        { leg: 'ipfs', sourceUri: '', outcome: 'skipped' },
        {
          leg: 'origin',
          sourceUri: `https://op.example.com/v1/artifacts/${ARTIFACT_SHA}/content`,
          outcome: 'verified',
        },
      ],
    },
  };
}

/** Builds the command with a stubbed primitive; returns the recorded calls. */
function commandWith(result: FetchVerifiedArtifactResult) {
  const fetchVerifiedArtifact = vi.fn(
    async (_address: ArtifactAddress, _locators: ArtifactLocators) => result,
  );
  return {
    command: createEvidenceCommand({ fetchVerifiedArtifact }),
    fetchVerifiedArtifact,
  };
}

describe('evidence fetch', () => {
  beforeEach(() => {
    fetchSignedEnvelopeBytesRawMock.mockReset();
    fetchSignedEnvelopeBytesRawMock.mockResolvedValue(
      encode(buildEnvelope([artifact(ARTIFACT_SHA, 'output.portfolio.v0')])),
    );
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('returns the verified bytes with their provenance', async () => {
    const { command, fetchVerifiedArtifact } = commandWith({ ok: true, artifact: verified() });
    const { ctx, writes, exits } = makeCtx(
      withConfig(['fetch', '--envelope-cid', ENVELOPE_CID, '--json']),
    );
    await command.run(ctx);

    expect(exits).toEqual([]);
    const out = JSON.parse(writes[0]!);
    expect(out).toMatchObject({
      verb: 'evidence fetch',
      envelopeCid: ENVELOPE_CID,
      sha256: ARTIFACT_SHA,
      artifactType: 'output.portfolio.v0',
      sizeBytes: BYTES.length,
      verified: true,
    });
    expect(Buffer.from(out.contentBase64, 'base64').equals(BYTES)).toBe(true);
    expect(out.provenance).toMatchObject({
      source: 'origin',
      digestAlgorithm: 'sha256',
      sourceOperator: SAFE,
    });
    expect(out.provenance.attempts).toHaveLength(2);

    // The verb hands the primitive every locator the envelope carries.
    expect(fetchVerifiedArtifact).toHaveBeenCalledOnce();
    const [address, locators] = fetchVerifiedArtifact.mock.calls[0]!;
    expect(address).toEqual({ sha256: ARTIFACT_SHA, artifactType: 'output.portfolio.v0' });
    expect(locators).toMatchObject({
      endpoint: 'https://op.example.com',
      envelopeCid: ENVELOPE_CID,
      ownerSafe: SAFE,
    });
  });

  it('--human summarizes the retrieval and never prints the bytes', async () => {
    const { command } = commandWith({ ok: true, artifact: verified() });
    const { ctx, writes } = makeCtx(
      withConfig(['fetch', '--envelope-cid', ENVELOPE_CID, '--human']),
    );
    await command.run(ctx);

    const rendered = writes.join('');
    expect(rendered).toContain(ARTIFACT_SHA);
    expect(rendered).toContain('output.portfolio.v0');
    expect(rendered).toContain('verified');
    expect(rendered).not.toContain(BYTES.toString('base64'));
    expect(rendered).not.toContain('contentBase64');
  });

  it('refuses to guess when the envelope carries more than one artifact', async () => {
    fetchSignedEnvelopeBytesRawMock.mockResolvedValue(
      encode(
        buildEnvelope([
          artifact(ARTIFACT_SHA, 'output.portfolio.v0'),
          artifact(SECOND_SHA, 'design_document'),
        ]),
      ),
    );
    const { command, fetchVerifiedArtifact } = commandWith({ ok: true, artifact: verified() });
    const { ctx, writes, exits } = makeCtx(
      withConfig(['fetch', '--envelope-cid', ENVELOPE_CID, '--json']),
    );
    await command.run(ctx);

    expect(exits).toEqual([11]);
    const out = JSON.parse(writes[0]!);
    expect(out.code).toBe('invalid_invocation');
    expect(out.details.artifacts).toEqual([
      { artifactType: 'output.portfolio.v0', sha256: ARTIFACT_SHA },
      { artifactType: 'design_document', sha256: SECOND_SHA },
    ]);
    expect(fetchVerifiedArtifact).not.toHaveBeenCalled();
  });

  it('rejects a --sha256 the envelope does not name', async () => {
    const { command, fetchVerifiedArtifact } = commandWith({ ok: true, artifact: verified() });
    const { ctx, writes, exits } = makeCtx(
      withConfig(['fetch', '--envelope-cid', ENVELOPE_CID, '--sha256', 'e'.repeat(64), '--json']),
    );
    await command.run(ctx);

    expect(exits).toEqual([11]);
    expect(JSON.parse(writes[0]!)).toMatchObject({
      code: 'invalid_invocation',
      details: { field: '--sha256' },
    });
    expect(fetchVerifiedArtifact).not.toHaveBeenCalled();
  });

  it('exits fatal on a digest mismatch and emits no bytes', async () => {
    const { command } = commandWith({
      ok: false,
      sha256: ARTIFACT_SHA,
      reason: 'digest_mismatch',
      retryable: false,
      message: 'the bytes were discarded',
      attempts: [],
      mismatch: {
        expectedSha256: ARTIFACT_SHA,
        actualSha256: 'f'.repeat(64),
        sourceUri: 'https://op.example.com/v1/artifacts/x/content',
        sourceOperator: SAFE,
      },
    });
    const { ctx, writes, exits } = makeCtx(
      withConfig(['fetch', '--envelope-cid', ENVELOPE_CID, '--json']),
    );
    await command.run(ctx);

    expect(exits).toEqual([50]);
    const out = JSON.parse(writes[0]!);
    expect(out.code).toBe('fatal');
    expect(out.details).toMatchObject({
      expectedSha256: ARTIFACT_SHA,
      actualSha256: 'f'.repeat(64),
      sourceUri: 'https://op.example.com/v1/artifacts/x/content',
      sourceOperator: SAFE,
    });
    expect(writes.join('')).not.toContain(BYTES.toString('base64'));
    expect(JSON.stringify(out)).not.toContain('contentBase64');
  });

  it('exits transient on an origin timeout', async () => {
    const { command } = commandWith({
      ok: false,
      sha256: ARTIFACT_SHA,
      reason: 'timeout',
      retryable: true,
      message: 'origin stalled',
      attempts: [],
    });
    const { ctx, writes, exits } = makeCtx(
      withConfig(['fetch', '--envelope-cid', ENVELOPE_CID, '--json']),
    );
    await command.run(ctx);

    expect(exits).toEqual([40]);
    expect(JSON.parse(writes[0]!)).toMatchObject({
      code: 'transient_error',
      details: { reason: 'timeout', retryable: true },
    });
  });

  it('requires --envelope-cid', async () => {
    const { command } = commandWith({ ok: true, artifact: verified() });
    const { ctx, writes, exits } = makeCtx(withConfig(['fetch', '--json']));
    await command.run(ctx);

    expect(exits).toEqual([11]);
    expect(JSON.parse(writes[0]!)).toMatchObject({
      code: 'invalid_invocation',
      details: { field: '--envelope-cid' },
    });
  });

  it('stays in the config-only read family — no keystore, signer, daemon or store', async () => {
    // The verb is legal in this family only because the primitive is keyless
    // and store-free. Guard the property at the source level: the command
    // module must not reach for a keystore, a signer, the daemon client, or
    // the SQLite store.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../../../src/cli/commands/evidence.ts', import.meta.url),
      'utf-8',
    );
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    expect(
      specifiers.filter((s) => /keystore|signer|wallet|store\/|bootstrap|daemon/i.test(s)),
      `evidence must stay config-only; found: ${specifiers.join(', ')}`,
    ).toEqual([]);
  });
});
