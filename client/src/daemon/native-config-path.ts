/**
 * Resolves and loads the native-v1 structured config file.
 *
 * Native-v1 has its own config file, deliberately separate from the legacy
 * `~/.jinn-client/config.json` — see issue #2378. The legacy loader
 * (`config.ts`'s `loadConfig`) always runs an additive, atomic shape-v2
 * migration that adds keys (`configShapeVersion`, `claimPolicy`,
 * `executionWiring`, `posting`) the strict `NativeProductFileSchema`
 * refuses to admit — there is no single file both parsers can agree on
 * (proved in `client/test/config/migrate-shape-v2-native-collision.test.ts`).
 *
 * Keeping the files — and the code paths that read them — fully separate
 * means the legacy migration can never touch a native file, by
 * construction: no discriminator, no coupling, nothing for the legacy
 * loader to ever learn about native's existence.
 *
 * Both `jinn run` (`client/src/cli/commands/run.ts`) and the native-only
 * entry (`client/src/native-main.ts`) import this module so the path they
 * resolve — and the loader they call — can never disagree.
 *
 * `NativeProductFileSchema` is imported lazily, inside `loadNativeProductConfigFile`,
 * rather than at module top level. `getNativeConfigPathFromArgs`/`resolveNativeConfigPath`
 * are cheap and run on every `jinn run` invocation (including plain legacy boots) to decide
 * which product to load; a top-level import here would otherwise pull
 * `@jinn-network/trust-core` + `@jinn-network/marketplace-binding` + `zod` into every legacy
 * run too, which is exactly the static-import discipline `native-vertical-config.ts`
 * (this module's sibling, consumed the same way) already keeps.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NativeProductConfig } from './native-product-config.js';

const NATIVE_CONFIG_FLAG = '--native-config';
const NATIVE_CONFIG_FLAG_EQUALS = `${NATIVE_CONFIG_FLAG}=`;

/**
 * Reads `--native-config <path>` or `--native-config=<path>` out of a raw argv array.
 * Both forms are accepted because Node's `parseArgs` (used for `--help`/strict-flag
 * validation elsewhere in `run.ts`) accepts both for a `type: 'string'` option — a
 * raw scan that only recognised the space-separated form would silently drop
 * `--native-config=<path>` invocations onto the legacy path instead of erroring.
 */
export function getNativeConfigPathFromArgs(argv: string[] = process.argv): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === NATIVE_CONFIG_FLAG) {
      const next = argv[i + 1];
      return next ? next : undefined;
    }
    if (arg.startsWith(NATIVE_CONFIG_FLAG_EQUALS)) {
      const value = arg.slice(NATIVE_CONFIG_FLAG_EQUALS.length);
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

export interface NativeConfigPathEnv {
  readonly HOME?: string;
  readonly JINN_NATIVE_CONFIG_PATH?: string;
}

/**
 * Resolution order: `--native-config` flag > `JINN_NATIVE_CONFIG_PATH` env >
 * `<HOME>/.jinn-client/native-config.json` — a sibling of, and never the
 * same file as, the legacy default `<HOME>/.jinn-client/config.json`.
 *
 * Takes `env` explicitly (rather than reading `homedir()` alone) so callers
 * that thread a `CommandContext.env` — including tests — get a path that
 * agrees with the rest of that context, matching the existing
 * `ctx.env['HOME'] ?? homedir()` pattern used elsewhere in `run.ts`.
 */
export function resolveNativeConfigPath(
  argv: string[] = process.argv,
  env: NativeConfigPathEnv = process.env,
): string {
  return (
    getNativeConfigPathFromArgs(argv)
    ?? env.JINN_NATIVE_CONFIG_PATH
    ?? join(env.HOME ?? homedir(), '.jinn-client', 'native-config.json')
  );
}

export class NativeConfigLoadError extends Error {}

/**
 * Reads and strictly validates the native-v1 config file at `path`. Never
 * migrates, never writes — a pure read + `NativeProductFileSchema.safeParse`.
 * Throws `NativeConfigLoadError` (never returns a partial/legacy-fallback
 * result) on a missing file, invalid JSON, or a schema violation — including
 * a legacy-shaped file pointed at by mistake.
 *
 * Async so the schema import above can stay lazy (a dynamic `import()` is
 * always asynchronous) — this only executes once a caller has already
 * decided to load a native file, at which point the schema's dependency
 * weight is expected, not incurred on every legacy run.
 */
export async function loadNativeProductConfigFile(path: string): Promise<NativeProductConfig> {
  if (!existsSync(path)) {
    throw new NativeConfigLoadError(`native-v1 structured config is missing: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new NativeConfigLoadError(`native-v1 structured config is not JSON: ${String(cause)}`);
  }
  const { NativeProductFileSchema } = await import('./native-product-config.js');
  const parsed = NativeProductFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new NativeConfigLoadError(`native-v1 structured config is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}
