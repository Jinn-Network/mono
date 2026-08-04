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
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NativeProductFileSchema, type NativeProductConfig } from './native-product-config.js';

/** Reads `--native-config <path>` out of a raw argv array. Mirrors `config.ts`'s `getConfigPathFromArgs`. */
export function getNativeConfigPathFromArgs(argv: string[] = process.argv): string | undefined {
  const idx = argv.indexOf('--native-config');
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : undefined;
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
 */
export function loadNativeProductConfigFile(path: string): NativeProductConfig {
  if (!existsSync(path)) {
    throw new NativeConfigLoadError(`native-v1 structured config is missing: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new NativeConfigLoadError(`native-v1 structured config is not JSON: ${String(cause)}`);
  }
  const parsed = NativeProductFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new NativeConfigLoadError(`native-v1 structured config is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}
