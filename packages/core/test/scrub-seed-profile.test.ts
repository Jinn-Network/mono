import { describe, expect, it } from 'vitest';
import { buildSeedScrubPipeline, buildLayer2ScrubPipeline } from '../src/scrub/index.js';

/**
 * Seed profile: wallet-address redaction (#1959) — coupled to #1784.
 *
 * The episode seed lane runs the seed profile (buildSeedScrubPipeline; the
 * #1784 switch landed in c59a0030a). The seed profile drops openredaction, so
 * before this rule it passed `0x`+40-hex wallet addresses through verbatim to
 * the public, on-chain-anchored corpus — the leak documented in #1959. This
 * pins the deterministic address rule that closes it. The rule is the scrub
 * redesign's C1 detector (PR #1967, `docs/superpowers/specs/2026-07-22-scrub-
 * redesign-design.md` §6.2) minus the instance-allowlist refinement — a
 * zero-false-positive-risk, forward-compatible tactical fix.
 */
describe('seed profile — wallet-address rule (#1959)', () => {
  // Never a real address: `0x` + forty zeros.
  const FAKE_ADDRESS = `0x${'0'.repeat(40)}`;

  it('stubs a 0x+40-hex wallet address to [ETH_ADDR_n]', async () => {
    const result = await buildSeedScrubPipeline().run({
      'episode.steps[0].text': `Relayer top-up sent to ${FAKE_ADDRESS} on Base.`,
    });
    const out = String(result.attributes['episode.steps[0].text']);
    expect(out).not.toContain(FAKE_ADDRESS);
    expect(out).toMatch(/\[ETH_ADDR_\d+\]/);
    expect(
      result.redactions.some(
        (r) => r.stage === 'plain-patterns' && r.kind === 'pii' && r.detail === 'eth-address',
      ),
    ).toBe(true);
  });

  it('leaves a bare 40-hex git SHA and a 0x+64-hex tx hash intact (provenance receipts)', async () => {
    // The `0x` prefix and the exactly-40 length are the load-bearing
    // carve-outs from the redesign's C1 note: bare 40-hex (no `0x`) is a git
    // object id, and `0x`+64-hex is a transaction hash — both are Legibility
    // receipts the detector must not swallow.
    const gitSha = 'd'.repeat(40);
    const txHash = `0x${'b'.repeat(64)}`;
    const result = await buildSeedScrubPipeline().run({
      'episode.steps[0].text': `Fixed at commit ${gitSha}; anchored in tx ${txHash}.`,
    });
    const out = String(result.attributes['episode.steps[0].text']);
    expect(out).toContain(gitSha);
    expect(out).toContain(txHash);
    expect(result.redactions).toHaveLength(0);
  });

  it('redacts mixed-case / EIP-55-checksummed hex addresses', async () => {
    // Locks the `[a-fA-F0-9]` charset: EIP-55 checksummed addresses are the
    // common real-world form (design §6.2). A future regression narrowing the
    // charset to `[a-f0-9]` would silently leak every checksummed address and
    // still pass a lowercase-only suite — this vector prevents that.
    const mixedCase = `0x${'dEaDbEeF'.repeat(5)}`; // 40 hex, upper+lower A–F, synthetic
    const result = await buildSeedScrubPipeline().run({
      'episode.steps[0].text': `Staking contract at ${mixedCase}.`,
    });
    const out = String(result.attributes['episode.steps[0].text']);
    expect(out).not.toContain(mixedCase);
    expect(out).toMatch(/\[ETH_ADDR_\d+\]/);
    expect(
      result.redactions.some((r) => r.stage === 'plain-patterns' && r.detail === 'eth-address'),
    ).toBe(true);
  });

  it('stubs every address on a line with per-occurrence [ETH_ADDR_n] indexing', async () => {
    // Exercises the index>0 path: a broken increment (always 0) would pass a
    // single-address assertion but fail here.
    const first = `0x${'1'.repeat(40)}`;
    const second = `0x${'2'.repeat(40)}`;
    const result = await buildSeedScrubPipeline().run({
      'episode.steps[0].text': `relayer ${first} funded operator ${second}`,
    });
    const out = String(result.attributes['episode.steps[0].text']);
    expect(out).not.toContain(first);
    expect(out).not.toContain(second);
    expect(out).toContain('[ETH_ADDR_0]');
    expect(out).toContain('[ETH_ADDR_1]');
    expect(
      result.redactions.filter((r) => r.detail === 'eth-address'),
    ).toHaveLength(2);
  });
});

/**
 * Seed profile: no over-redaction of ordinary prose (#1784 regression corpus).
 *
 * The #1784 defacement came from openredaction firing on ordinary words and
 * hex-looking ids in reviewed public seed content. The seed profile omits
 * openredaction, so each of these known trigger strings must pass through
 * untouched with zero redactions. This is the corpus the redesign's §7
 * zero-corruption gate permanently locks; pinned here as the tactical
 * regression net.
 */
describe('seed profile — no over-redaction of prose (#1784 regression corpus)', () => {
  it.each([
    'claim registration',
    'misconfiguration',
    'mismatch',
    'participate',
    'invisible',
    'invocation',
    'ambiguous',
    'restructure',
    'resolving',
    '987654',
  ])('passes %p through the seed profile with zero redactions', async (text) => {
    const result = await buildSeedScrubPipeline().run({ 'episode.steps[0].text': text });
    expect(result.attributes['episode.steps[0].text']).toBe(text);
    expect(result.redactions).toHaveLength(0);
  });
});

/**
 * Layer-2 profile: same wallet-address class (#1959, review finding 3).
 *
 * buildLayer2ScrubPipeline is the distillation publish gate (CHECK-mode:
 * distill.ts rejects a skill on any scrub change) and the bridge/distiller
 * input scrub. Without the rule a distilled body carrying a raw `0x`+40-hex
 * address produced no redaction and published verbatim to the public layer-2
 * corpus — the same leak class this PR closes for seeds. The rule flows in via
 * the same opt-in `walletAddresses` flag, so a scrub change (redaction) trips
 * the fail-closed gate.
 */
describe('layer-2 profile — wallet-address rule (#1959)', () => {
  const FAKE_ADDRESS = `0x${'0'.repeat(40)}`;

  it('stubs a 0x+40-hex wallet address (so the fail-closed distill gate trips)', async () => {
    const result = await buildLayer2ScrubPipeline().run({
      'skill.md': `## Steps\n\nSend the fee to ${FAKE_ADDRESS}.`,
    });
    const out = String(result.attributes['skill.md']);
    expect(out).not.toContain(FAKE_ADDRESS);
    expect(out).toMatch(/\[ETH_ADDR_\d+\]/);
    expect(
      result.redactions.some((r) => r.stage === 'plain-patterns' && r.detail === 'eth-address'),
    ).toBe(true);
  });

  it('leaves a bare 40-hex git SHA and a 0x+64-hex tx hash intact', async () => {
    const gitSha = 'd'.repeat(40);
    const txHash = `0x${'b'.repeat(64)}`;
    const result = await buildLayer2ScrubPipeline().run({
      'skill.md': `Verified at ${gitSha}; anchored ${txHash}.`,
    });
    const out = String(result.attributes['skill.md']);
    expect(out).toContain(gitSha);
    expect(out).toContain(txHash);
    expect(result.redactions).toHaveLength(0);
  });
});
