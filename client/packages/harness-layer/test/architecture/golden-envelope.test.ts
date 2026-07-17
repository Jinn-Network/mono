import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keccak256, recoverAddress } from 'viem';
import { SignedEnvelopeSchema } from '../../../../src/types/envelope.js';
import { canonicalJson } from '../../../../src/harnesses/engine/canonical-json.js';

/**
 * Golden-envelope fixture test (#1832).
 *
 * The fixture is one canonical signed envelope with a pinned hash + signature,
 * produced once by `test/fixtures/regen-golden-envelope.ts` with the
 * well-known Anvil test key #0. It freezes the envelope seam three ways:
 *
 *   (a) the fixture still parses under SignedEnvelopeSchema — schema widening
 *       that breaks old envelopes fails here;
 *   (b) re-canonicalizing the envelope body (minus `signature`) reproduces the
 *       pinned keccak256 hash — any canonical-JSON drift fails here;
 *   (c) recovering the signer from (hash, sig) yields the fixture's signer —
 *       any signing-scheme drift fails here.
 *
 * If a deliberate schema/canonicalization change breaks this test, re-run the
 * regen script and review the fixture diff as part of the change.
 */
const fixturePath = fileURLToPath(
  new URL('../fixtures/golden-envelope.v0.json', import.meta.url),
);

describe('golden envelope fixture (#1832)', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));

  it('parses under SignedEnvelopeSchema', () => {
    const parsed = SignedEnvelopeSchema.safeParse(fixture);
    expect(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues, null, 2)).toBe(true);
  });

  it('canonical hash of the envelope body matches the pinned signature.hash', () => {
    const { signature, ...unsigned } = fixture;
    const canonical = canonicalJson(unsigned);
    const hash = keccak256(new TextEncoder().encode(canonical));
    expect(hash).toBe(signature.hash);
  });

  it('signer recovered from (hash, sig) matches the pinned signature.signer', async () => {
    const { signature } = fixture;
    const recovered = await recoverAddress({
      hash: signature.hash,
      signature: signature.sig,
    });
    expect(recovered.toLowerCase()).toBe(signature.signer.toLowerCase());
  });
});
