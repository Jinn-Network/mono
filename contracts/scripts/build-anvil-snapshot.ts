/**
 * Compatibility entrypoint for the committed Anvil snapshot builder.
 *
 * The implementation lives in the client package because it imports client
 * dependencies (`viem`, Safe deployment metadata, and earning bootstrap code).
 * Keep this path stable for docs, CI messages, and operator muscle memory.
 */

import { fileURLToPath } from 'node:url';

export async function main(): Promise<void> {
  const builder = await import(new URL('../../operator/scripts/build-anvil-snapshot.ts', import.meta.url).href);
  const buildAnvilSnapshot = builder['buildAnvilSnapshot'];
  if (typeof buildAnvilSnapshot !== 'function') {
    throw new Error('client snapshot builder did not export buildAnvilSnapshot()');
  }
  await buildAnvilSnapshot();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
