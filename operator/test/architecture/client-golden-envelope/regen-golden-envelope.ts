/**
 * Regenerates `golden-envelope.v0.json` (#1832).
 *
 * Run only when a DELIBERATE schema or canonicalization change breaks
 * `test/architecture/golden-envelope.test.ts`, and review the fixture diff as
 * part of that change:
 *
 *   cd operator && yarn tsx test/architecture/client-golden-envelope/regen-golden-envelope.ts
 *
 * Uses the production assembly, validation, signing, and upload path with a
 * loopback-only fake IPFS registry. The well-known Anvil test key #0 and fixed
 * timestamps keep the output fully deterministic.
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assembleAndSignEnvelope,
  type EnvelopeInputs,
} from '../../../src/harnesses/engine/envelope-assembly.js';

const ANVIL_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ANVIL_ADDRESS_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;

const goldenInputs: EnvelopeInputs = {
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
    agentEoa: ANVIL_ADDRESS_0,
  },
  window: { startTs: 1749999000, endTs: 1750000000 },
  executor: {
    implName: 'golden-fixture',
    implVersion: '0.0.1',
    clientGitSha: '0000000000000000000000000000000000000000',
    codeDigest: `sha256:${'a'.repeat(64)}`,
    runtimeBundleDigest: `sha256:${'b'.repeat(64)}`,
    plugins: [],
    signingKey: { kind: 'agent-eoa', pubkey: ANVIL_ADDRESS_0 },
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
};

const registry = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify({ Hash: 'bafy-golden-envelope' })}\n`);
});

await new Promise<void>((resolve, reject) => {
  registry.once('error', reject);
  registry.listen(0, '127.0.0.1', resolve);
});

try {
  const address = registry.address();
  if (address === null || typeof address === 'string') {
    throw new Error('loopback IPFS registry did not expose a TCP port');
  }
  const { envelope, envelopeHash } = await assembleAndSignEnvelope(goldenInputs, {
    ipfsRegistryUrl: `http://127.0.0.1:${address.port}`,
    agentEoaPrivateKey: ANVIL_KEY_0,
  });

  const outPath = fileURLToPath(new URL('./golden-envelope.v0.json', import.meta.url));
  writeFileSync(outPath, `${JSON.stringify(envelope, null, 2)}\n`);
  console.log(`wrote ${outPath}\nhash: ${envelopeHash}\nsigner: ${envelope.signature.signer}`);
} finally {
  await new Promise<void>((resolve, reject) => {
    registry.close((error) => error ? reject(error) : resolve());
  });
}
