/**
 * Addresses derived from the industry-standard development mnemonic
 * ("test test test test test test test test test test test junk", accounts #0–#9), which
 * every local EVM simulator prints on startup and whose private keys are public.
 *
 * A chain record MUST NOT name one as a fixture account. Design §8: because a sandbox may
 * report chain id 1 for contract and signature compatibility, every EIP-155 transaction in a
 * published solution script is a structurally valid mainnet transaction from that fixture
 * address, permanently. Fixture addresses are inert by *economics* — they hold nothing — not
 * by cryptography. An address whose key is already public and which someone may one day fund
 * turns the whole published corpus of scripts into replayable transactions from it. Keys are
 * therefore freshly generated per record and never a well-known one.
 *
 * The list is a floor, not a proof of exhaustiveness: it names the set anyone would reach for
 * by accident. Adding a newly popularised dev address here is a one-line edit.
 */
export const WELL_KNOWN_DEV_ADDRESSES: readonly string[] = Object.freeze([
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
  "0x976ea74026e726554db657fa54763abd0c3a0aa9",
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
]);

const devAddresses = new Set(WELL_KNOWN_DEV_ADDRESSES);

/**
 * Case-insensitive so a caller holding an EIP-55 checksummed spelling still gets the right
 * answer. `Address` in a sealed record is lowercase-only, so inside this package the fold is
 * a no-op — it exists for the callers outside it.
 *
 * Folded with `toLowerCase`, never `toLocaleLowerCase`: the tree's source-boundary canary
 * bans locale-sensitive APIs, because an ordering or folding decision made against host ICU
 * data can change a record's digest between two hosts running identical code.
 */
export function isWellKnownDevAddress(address: string): boolean {
  return devAddresses.has(address.toLowerCase());
}
