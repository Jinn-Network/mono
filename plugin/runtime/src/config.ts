// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, join, normalize } from "node:path";
import { z } from "zod";

import { PluginRuntimeError, RUNTIME_ERROR_CODES } from "./errors.js";
import type { LogLevel } from "./logger.js";

const LogLevelSchema = z.enum(["silent", "error", "warn", "info", "debug"]);

/**
 * The optional on-disk configuration document. The caller reads and parses the file; this
 * module only validates. Keeping the read outside means nothing in the library touches
 * the filesystem to acquire configuration.
 */
export const RuntimeConfigFileSchema = z.strictObject({
  home: z.string().min(1).optional(),
  logLevel: LogLevelSchema.optional(),
  captureRetentionDays: z.number().int().positive().optional(),
  captureArchiveBusyTimeoutMs: z.number().int().positive().optional(),
});

export type RuntimeConfigFile = z.infer<typeof RuntimeConfigFileSchema>;

/**
 * Everything the resolver is allowed to read. The environment is injected wholesale
 * rather than reached for, so no code path in this package acquires ambient authority
 * (custody law C2); `.github/scripts/plugin-tree-source-boundaries.test.mjs` enforces it.
 */
export interface RuntimeConfigSource {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Absolute. The host adapter supplies the per-host-home path. */
  readonly homeDirectory: string;
  /** Already-parsed JSON of an optional configuration file. */
  readonly file?: unknown;
}

export interface RuntimeConfig {
  readonly homeDirectory: string;
  readonly archiveDirectory: string;
  /** Product-owned staging for session feeds and recorder workspaces. Never inside `archiveDirectory`. */
  readonly captureDirectory: string;
  /** Days of raw staging material kept before the sweep removes it. */
  readonly captureRetentionDays: number;
  /** How long `sealSession` waits for an archive another process holds. */
  readonly captureArchiveBusyTimeoutMs: number;
  readonly catalogPath: string;
  readonly indexPath: string;
  readonly mirrorStatePath: string;
  readonly logLevel: LogLevel;
}

export const ENVIRONMENT_KEYS = Object.freeze({
  home: "JINN_PLUGIN_HOME",
  logLevel: "JINN_PLUGIN_LOG_LEVEL",
} as const);

function invalid(path: string, message: string, cause?: unknown): PluginRuntimeError {
  return new PluginRuntimeError(
    RUNTIME_ERROR_CODES.configInvalid,
    `runtime configuration is invalid at ${path}: ${message}`,
    cause === undefined ? undefined : { cause },
  );
}

/** Empty and whitespace-only environment values are treated as unset, never as overrides. */
function present(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Coerces an env override through zod rather than `Number()`, so a non-numeric value fails
 * loudly as `config-invalid` naming its field — the same shape as the `logLevel` path.
 */
function positiveIntegerSetting(
  envKey: string,
  envValue: string | undefined,
  fileValue: number | undefined,
  fallback: number,
): number {
  if (envValue === undefined) return fileValue ?? fallback;
  const parsed = z
    .string()
    .regex(/^[1-9]\d*$/u)
    .safeParse(envValue);
  if (!parsed.success) {
    throw new PluginRuntimeError(
      "config-invalid",
      `${envKey} must be a positive integer, received ${JSON.stringify(envValue)}.`,
    );
  }
  return Number(parsed.data);
}

function parseFile(file: unknown): RuntimeConfigFile {
  if (file === undefined || file === null) return {};
  const parsed = RuntimeConfigFileSchema.safeParse(file);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid(issue?.path.join(".") || "<root>", issue?.message ?? "unrecognized document");
  }
  return parsed.data;
}

function parseLogLevel(value: string): LogLevel {
  const parsed = LogLevelSchema.safeParse(value);
  if (!parsed.success) {
    throw invalid("logLevel", `expected one of ${LogLevelSchema.options.join(", ")}`);
  }
  return parsed.data;
}

/**
 * Resolve the runtime's configuration. Precedence: defaults, then the configuration file,
 * then the environment. Pure — no filesystem, no clock, no ambient reads.
 */
export function resolveRuntimeConfig(source: RuntimeConfigSource): RuntimeConfig {
  const file = parseFile(source.file);

  const envHome = present(source.env[ENVIRONMENT_KEYS.home]);
  const envLogLevel = present(source.env[ENVIRONMENT_KEYS.logLevel]);

  const rawHome = envHome ?? file.home ?? source.homeDirectory;
  if (typeof rawHome !== "string" || rawHome.trim() === "") {
    throw invalid("home", "a home directory is required");
  }
  if (!isAbsolute(rawHome)) {
    throw invalid("home", `expected an absolute path, received ${rawHome}`);
  }
  const homeDirectory = normalize(rawHome).replace(/\/+$/u, "") || "/";

  const logLevel = envLogLevel !== undefined
    ? parseLogLevel(envLogLevel)
    : file.logLevel ?? "info";

  return Object.freeze({
    homeDirectory,
    archiveDirectory: join(homeDirectory, "archive"),
    // Product-owned staging. Deliberately NOT under archiveDirectory: `local-runtime` and the
    // filesystem repository assert exclusive ownership and 0700 on that tree, and it is under
    // an exclusive lock whenever a capture is sealing.
    captureDirectory: join(homeDirectory, "capture"),
    captureRetentionDays: positiveIntegerSetting(
      "JINN_PLUGIN_CAPTURE_RETENTION_DAYS",
      present(source.env.JINN_PLUGIN_CAPTURE_RETENTION_DAYS),
      file?.captureRetentionDays,
      30,
    ),
    captureArchiveBusyTimeoutMs: positiveIntegerSetting(
      "JINN_PLUGIN_ARCHIVE_BUSY_TIMEOUT_MS",
      present(source.env.JINN_PLUGIN_ARCHIVE_BUSY_TIMEOUT_MS),
      file?.captureArchiveBusyTimeoutMs,
      10_000,
    ),
    catalogPath: join(homeDirectory, "catalog.sqlite"),
    indexPath: join(homeDirectory, "index.sqlite"),
    mirrorStatePath: join(homeDirectory, "mirror-state.json"),
    logLevel,
  });
}
