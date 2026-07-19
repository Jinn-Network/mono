/**
 * Regenerates `golden-envelope.v0.json` (#1832).
 *
 * Run only when a DELIBERATE schema or canonicalization change breaks
 * `test/architecture/golden-envelope.test.ts`, and review the fixture diff as
 * part of that change:
 *
 *   cd client && yarn tsx packages/harness-layer/test/fixtures/regen-golden-envelope.ts
 *
 * Uses the well-known Anvil test key #0 (public, funds-free, never a secret)
 * and fixed timestamps so the output is fully deterministic.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { UnsignedEnvelopeSchema, SignedEnvelopeSchema } from '../../../../src/types/envelope.js';
import { signCanonical } from '../../../../src/harnesses/engine/signing.js';

const ANVIL_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const account = privateKeyToAccount(ANVIL_KEY_0);

const unsigned = UnsignedEnvelopeSchema.parse({
  schemaVersion: 'jinn.execution.v1',
  solverType: 'prediction.v0',
  role: 'solution',
  generatedAt: 1750000000,
  task: {
    cid: 'bafybeigoldenenvelopefixture0000000000000000000000000000000',
    onchainCreationTx: `0x${'11'.repeat(32)}`,
    onchainCreationBlock: 1,
    requestId: `0x${'22'.repeat(32)}`,
  },
  participant: {
    safeAddress: `0x${'33'.repeat(20)}`,
    agentEoa: account.address,
  },
  window: { startTs: 1749999000, endTs: 1750000000 },
  executor: {
    implName: 'golden-fixture',
    implVersion: '0.0.1',
    clientGitSha: '0000000000000000000000000000000000000000',
    codeDigest: `sha256:${'a'.repeat(64)}`,
    runtimeBundleDigest: `sha256:${'b'.repeat(64)}`,
    plugins: [],
    signingKey: { kind: 'agent-eoa', pubkey: account.address },
    mode: 'frozen',
  },
  evidenceTier: 'self-signed',
  attestation: null,
  trajectory: null,
  artifacts: [],
  payload: {
    prediction: {
      probability: '0.5',
      submittedAt: 1750000000,
      modelId: 'golden-fixture',
    },
  },
});

const signed = await signCanonical(unsigned, ANVIL_KEY_0, account.address);
const envelope = SignedEnvelopeSchema.parse({
  ...unsigned,
  signature: {
    algo: 'secp256k1',
    signer: signed.signer,
    hash: signed.hash,
    sig: signed.sig,
  },
});

const outPath = fileURLToPath(new URL('./golden-envelope.v0.json', import.meta.url));
writeFileSync(outPath, `${JSON.stringify(envelope, null, 2)}\n`);
console.log(`wrote ${outPath}\nhash: ${signed.hash}\nsigner: ${signed.signer}`);
