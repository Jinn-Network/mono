// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, join, normalize, resolve } from "node:path";
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
  /** C5 — opaque here; `resolveCorpusConfig` owns validation (file-only authority). */
  corpus: z.unknown().optional(),
  /** C6 — opaque here; `resolveRelevanceConfig` owns validation. */
  relevance: z.unknown().optional(),
  /** C6 — opaque here; `resolveProjectionConfig` owns validation. */
  projection: z.unknown().optional(),
  /** C6 — opaque here; `resolveSensitivityConfig` owns validation. */
  sensitivity: z.unknown().optional(),
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
  /** C5 — the public-corpus mirror's own catalog, separate from `catalogPath`. */
  readonly mirrorCatalogPath: string;
  /** C5 — the public-corpus mirror's own object store, separate from `archiveDirectory`. */
  readonly mirrorObjectsDirectory: string;
  /** C5 — the exclusive advisory lock guarding mirror sync (cross-plan contract 5). */
  readonly mirrorLockPath: string;
  readonly corpus: CorpusConfig;
  /** C6 — local relevance ranking limits. */
  readonly relevance: RelevanceConfig;
  /** C6 — budgeted context projection limits. */
  readonly projection: ProjectionConfig;
  /** C6 — index-time sensitivity exclusion settings. */
  readonly sensitivity: SensitivityConfig;
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

// --- C5: public-corpus mirror -------------------------------------------
//
// The set of followed archives and the trust genesis anchor are FILE-ONLY.
// C5 declares no environment key: "which archives may inject content into
// this agent's context" is authority, and custody law C2 forbids acquiring
// authority ambiently. An operator changes what is followed by editing the
// config document, which is reviewable and diffable; an environment
// variable is neither.

/**
 * A local copy of `SOURCE_NAME_GRAMMAR` from
 * `@jinn-network/record-discovery-protocol/src/identifiers.ts`. Copied
 * rather than imported so this module stays dependency-pure per C3's
 * contract; `src/corpus/announcements.test.ts` asserts the two are equal,
 * so a drift upstream fails the build rather than silently diverging.
 */
const SOURCE_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const HttpsUrlSchema = z.string().refine(
  (value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "must be an absolute https URL" },
);

const MirrorSourceConfigSchema = z.strictObject({
  agent: z.string().min(1),
  name: z.string().regex(SOURCE_NAME_PATTERN, "must match the record-discovery source-name grammar"),
  servingRoot: HttpsUrlSchema,
  archiveRootUrl: HttpsUrlSchema,
  repositoryId: z.string().min(1),
});

const CorpusTrustConfigSchema = z.strictObject({
  genesisDigest: z.string().regex(SHA256_DIGEST_PATTERN),
  policyDirectory: z.string().min(1),
  producerPurpose: z.string().min(1).default("jinn:corpus-producer"),
});

/**
 * Which of the three chain-verification postures this install takes:
 *
 *  - `verified` — the default, and the only posture a production mirror over
 *    remote holder feeds may take: announcement chains are verified through
 *    the host-injected `VerifyDriver` before anything is indexed;
 *  - `unverified` — local development only, and unreachable without also
 *    writing `acknowledgeUnverifiedChain: true`;
 *  - `rejecting` — verify nothing, admit nothing.
 */
const CorpusChainVerificationSchema = z.enum(["verified", "unverified", "rejecting"]);

const CorpusConfigSchema = z.strictObject({
  sources: z.array(MirrorSourceConfigSchema).default([]),
  maxEntriesPerSync: z.number().int().positive().max(10_000).default(500),
  syncTimeoutMs: z.number().int().positive().max(600_000).default(30_000),
  /** Absent means `verified`, unless `acknowledgeUnverifiedChain` says otherwise. */
  chainVerification: CorpusChainVerificationSchema.optional(),
  /**
   * Opt-in acknowledgement that this runtime mirrors without verifying
   * announcement-chain signatures (C5 Finding F1). It is the ONLY way to
   * reach the `unverified` posture: naming that posture without this flag is
   * a configuration error, so the unverified path stays impossible to acquire
   * by accident.
   */
  acknowledgeUnverifiedChain: z.boolean().default(false),
  trust: CorpusTrustConfigSchema.optional(),
});

export type MirrorSourceConfig = z.infer<typeof MirrorSourceConfigSchema>;
export type CorpusTrustConfig = z.infer<typeof CorpusTrustConfigSchema>;
export type CorpusChainVerificationMode = z.infer<typeof CorpusChainVerificationSchema>;
export type CorpusConfig = Omit<z.infer<typeof CorpusConfigSchema>, "chainVerification"> & {
  /** Always resolved — the file may omit it, the runtime never sees it absent. */
  readonly chainVerification: CorpusChainVerificationMode;
};

function resolveCorpusConfig(file: unknown, homeDirectory: string): CorpusConfig {
  const raw = (file as { readonly corpus?: unknown } | undefined)?.corpus;
  const parsed = CorpusConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new PluginRuntimeError(
      RUNTIME_ERROR_CODES.configInvalid,
      `corpus configuration is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const byArchive = new Set<string>();
  const byRepository = new Set<string>();
  for (const source of parsed.data.sources) {
    const archive = `${source.agent}/${source.name}`;
    if (byArchive.has(archive)) {
      throw new PluginRuntimeError(
        RUNTIME_ERROR_CODES.configInvalid,
        `corpus archive ${archive} is followed twice.`,
      );
    }
    byArchive.add(archive);
    if (byRepository.has(source.repositoryId)) {
      throw new PluginRuntimeError(
        RUNTIME_ERROR_CODES.configInvalid,
        `corpus repository id ${source.repositoryId} is claimed by more than one archive.`,
      );
    }
    byRepository.add(source.repositoryId);
  }

  // The acknowledgement flag is the gate on the unverified posture, in both
  // directions: naming `unverified` without it is an error, and setting it
  // alone (the pre-`chainVerification` spelling of the same intent) still
  // selects that posture rather than being silently overridden by the new
  // `verified` default.
  if (parsed.data.chainVerification === "unverified" && !parsed.data.acknowledgeUnverifiedChain) {
    throw new PluginRuntimeError(
      RUNTIME_ERROR_CODES.configInvalid,
      "corpus.chainVerification `unverified` requires corpus.acknowledgeUnverifiedChain: true.",
    );
  }
  const chainVerification: CorpusChainVerificationMode =
    parsed.data.chainVerification ??
    (parsed.data.acknowledgeUnverifiedChain ? "unverified" : "verified");

  return {
    ...parsed.data,
    chainVerification,
    ...(parsed.data.trust === undefined
      ? {}
      : {
          trust: {
            ...parsed.data.trust,
            policyDirectory: resolve(homeDirectory, parsed.data.trust.policyDirectory),
          },
        }),
  };
}

// --- C6: relevance, projection, sensitivity --------------------------------

const RelevanceConfigSchema = z.strictObject({
  maxTerms: z.number().int().min(1).max(32).default(10),
  floor: z.number().int().min(1).max(10).default(2),
  searchLimit: z.number().int().min(1).max(200).default(20),
});

const ProjectionConfigSchema = z.strictObject({
  maxChars: z.number().int().min(200).max(64_000).default(3_500),
  maxRecords: z.number().int().min(1).max(10).default(2),
});

const SensitivityConfigFileSchema = z.strictObject({
  knownIdentities: z.array(z.string().min(1)).default([]),
});

export type RelevanceConfig = z.infer<typeof RelevanceConfigSchema>;
export type ProjectionConfig = z.infer<typeof ProjectionConfigSchema>;

export interface SensitivityConfig {
  readonly knownIdentities: readonly string[];
  /** Derived from `homeDirectory`; not overridable from the config file. */
  readonly noncePath: string;
}

function configSectionError(section: string, error: z.ZodError): PluginRuntimeError {
  return new PluginRuntimeError(
    RUNTIME_ERROR_CODES.configInvalid,
    `${section} configuration is invalid: ${error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ")}`,
  );
}

function resolveRelevanceConfig(file: unknown): RelevanceConfig {
  const raw = (file as { readonly relevance?: unknown } | undefined)?.relevance;
  const parsed = RelevanceConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw configSectionError("relevance", parsed.error);
  }
  return parsed.data;
}

function resolveProjectionConfig(file: unknown): ProjectionConfig {
  const raw = (file as { readonly projection?: unknown } | undefined)?.projection;
  const parsed = ProjectionConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw configSectionError("projection", parsed.error);
  }
  return parsed.data;
}

function resolveSensitivityConfig(file: unknown, homeDirectory: string): SensitivityConfig {
  const raw = (file as { readonly sensitivity?: unknown } | undefined)?.sensitivity;
  const parsed = SensitivityConfigFileSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw configSectionError("sensitivity", parsed.error);
  }
  return {
    knownIdentities: parsed.data.knownIdentities,
    noncePath: join(homeDirectory, "sensitivity-nonce"),
  };
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
    mirrorCatalogPath: join(homeDirectory, "mirror", "catalog.sqlite"),
    mirrorObjectsDirectory: join(homeDirectory, "mirror", "objects"),
    mirrorLockPath: join(homeDirectory, "mirror-sync.lock"),
    corpus: resolveCorpusConfig(source.file, homeDirectory),
    relevance: resolveRelevanceConfig(source.file),
    projection: resolveProjectionConfig(source.file),
    sensitivity: resolveSensitivityConfig(source.file, homeDirectory),
  });
}
