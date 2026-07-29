// SPDX-License-Identifier: Apache-2.0

import {
  createPrivateKey,
  sign as signBytes,
} from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DsseSigner } from "@jinn-network/attestation-issuer";

function validateHandle(handle: string): void {
  if (
    handle.length === 0 ||
    basename(handle) !== handle ||
    handle === "." ||
    handle === ".."
  ) {
    throw new TypeError(
      "signer handle must be one filename resolved beneath secrets/",
    );
  }
}

/**
 * Creates an Ed25519 DSSE signer whose only retained authority is a `secrets/` filename.
 *
 * The key file is opened with `O_NOFOLLOW` for every signing request, converted to a transient
 * KeyObject, and the read buffer is zeroed immediately. Construction, launch planning, and
 * journaling therefore never read or retain exact private-key bytes.
 */
export function makeSecretsSigner(
  secretsDir: string,
  handle: string,
): DsseSigner {
  validateHandle(handle);
  const keyPath = join(secretsDir, handle);

  return async (request) => {
    request.signal?.throwIfAborted();
    const file = await open(
      keyPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let keyBytes: Buffer | undefined;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) {
        throw new TypeError("evaluator signer handle must resolve to a file");
      }
      keyBytes = await file.readFile();
    } finally {
      await file.close();
    }

    let key;
    try {
      key = createPrivateKey(keyBytes);
    } finally {
      keyBytes.fill(0);
    }
    request.signal?.throwIfAborted();
    const signature = signBytes(
      null,
      Buffer.from(request.preAuthEncoding),
      key,
    );
    request.signal?.throwIfAborted();
    return [{ signature }];
  };
}
