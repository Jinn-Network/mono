/** task.v1 signing. */

import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { signCanonical } from '../harnesses/engine/signing.js';
import type { SignedTaskV1, TaskV1 } from '../types/task-document.js';

export async function signTaskV1(task: TaskV1, privateKey: Hex): Promise<SignedTaskV1> {
  const account = privateKeyToAccount(privateKey);
  const signerAddress = account.address as `0x${string}`;
  const signed = await signCanonical(task, privateKey, signerAddress);
  return {
    ...task,
    signature: {
      algo: 'secp256k1',
      signer: account.address,
      hash: signed.hash,
      sig: signed.sig,
    },
  };
}
