import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { LocalTaskExecutionBackendConfig } from '@jinn-network/task-execution-backend-local';

type SecretForwardResolver = NonNullable<LocalTaskExecutionBackendConfig['secretForwardResolver']>;

export function createEvaluatorSignerResolver(input: {
  readonly keyPath: string;
  readonly grantKey: string;
}): SecretForwardResolver {
  return {
    async resolve({ grantKey }, options) {
      options.signal?.throwIfAborted();
      if (grantKey !== input.grantKey) {
        throw new Error(`grant key "${grantKey}" is not a configured secret forward`);
      }
      const file = await open(
        input.keyPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile()) {
          throw new TypeError('evaluator signing key must resolve to a file');
        }
        const buffer = await file.readFile();
        return Uint8Array.from(buffer);
      } finally {
        await file.close();
      }
    },
  };
}
