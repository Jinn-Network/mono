import { describe, it, expectTypeOf } from 'vitest';
import type {
  ScopedSigner,
  ScopedRpc,
  ScopedSecrets,
  SignTypedDataArgs,
  SendAllowedCallArgs,
} from './index.js';

describe('capability handle types', () => {
  it('ScopedSigner exposes address + signTypedData + sendAllowedCall', () => {
    expectTypeOf<ScopedSigner['address']>().toBeString();
    expectTypeOf<ScopedSigner['signTypedData']>().toBeFunction();
    expectTypeOf<ScopedSigner['sendAllowedCall']>().toBeFunction();
  });

  it('ScopedRpc exposes the read-only viem subset', () => {
    expectTypeOf<ScopedRpc['readContract']>().toBeFunction();
    expectTypeOf<ScopedRpc['getBlockNumber']>().toBeFunction();
    expectTypeOf<ScopedRpc['getChainId']>().toBeFunction();
  });

  it('ScopedSecrets is a read-only string record', () => {
    expectTypeOf<ScopedSecrets>().toEqualTypeOf<Readonly<Record<string, string>>>();
  });

  it('SignTypedDataArgs / SendAllowedCallArgs are exposed', () => {
    expectTypeOf<SignTypedDataArgs['primaryType']>().toEqualTypeOf<string>();
    expectTypeOf<SendAllowedCallArgs['data']>().toBeString();
  });
});
