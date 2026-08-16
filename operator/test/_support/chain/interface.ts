import type { Address, Hex, WalletClient } from 'viem';

/**
 * Common API for anything that pretends to be an EVM chain in tests.
 * Implemented by `anvil.ts` (real anvil fork) and, potentially later, by an
 * in-memory `FakeChain` (deferred — see design spec §5.4 and risk #1).
 */
export interface ChainTestHarness {
  /** JSON-RPC URL the harness listens on. */
  rpcUrl: string;

  /** Impersonate an address, run `fn`, then stop impersonating — even on throw. */
  impersonate<T>(addr: Address, fn: (client: WalletClient) => Promise<T>): Promise<T>;

  /** Set native (ETH) balance for an address. */
  setBalance(addr: Address, wei: bigint): Promise<void>;

  /** Write directly to a contract storage slot — used for token funding via balance map. */
  setStorageSlot(contract: Address, slot: Hex, value: Hex): Promise<void>;

  /** Mine N empty blocks. */
  mineBlocks(n: number): Promise<void>;

  /** Current block timestamp in seconds. */
  now(): Promise<number>;

  /** Advance block timestamp by `seconds`. */
  advanceTime(seconds: number): Promise<void>;

  /** Tear down the harness (kill anvil, drop state). */
  teardown(): Promise<void>;
}
