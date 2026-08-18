import "server-only";

import { isAbsolute } from "node:path";
import {
  createDefaultBenchmarkRuntimeHost,
  normalizePublicArchiveBaseUrl,
  type OperationContext,
  type WorkspaceAnchoringEntry,
} from "@colophon-claims/core";

export const WORKSPACE_ENV = "BENCHMARK_PRODUCT_WORKSPACE_DIR";
export const AGENT_DATA_ENV = "BENCHMARK_PRODUCT_AGENT_DATA_DIR";
export const PRINCIPAL_ENV = "BENCHMARK_PRODUCT_PRINCIPAL";
export const ENABLE_TEST_CONTROLS_ENV = "BENCHMARK_PRODUCT_ENABLE_TEST_CONTROLS";
export const TEST_SOLVE_DELAY_MS_ENV = "BENCHMARK_PRODUCT_TEST_SOLVE_DELAY_MS";
export const OPENAI_KEY_FILE_ENV = "BENCHMARK_PRODUCT_OPENAI_API_KEY_FILE";
export const PUBLICATION_PUBLIC_BASE_URL_ENV = "BENCHMARK_PRODUCT_PUBLICATION_PUBLIC_BASE_URL";
export const ANCHOR_PROVIDERS_ENV = "BENCHMARK_PRODUCT_ANCHOR_PROVIDERS";

/** Browser-safe readiness projection. Never returns the credential path or reads its bytes. */
export function openAIConnectionReadiness(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): "configured" | "not-configured" {
  return environment[OPENAI_KEY_FILE_ENV]?.trim() ? "configured" : "not-configured";
}

export class ProductContextConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductContextConfigurationError";
  }
}

export interface ProductServerConfiguration {
  readonly workspaceDir: string;
  /** Non-secret OS user-data directory. This remains server-only. */
  readonly agentDataDir: string;
  readonly principal: string;
  readonly publicationPublicBaseUrl?: string;
  readonly anchorProviders?: readonly WorkspaceAnchoringEntry[];
}

/**
 * The deployment's own anchor providers, as a JSON array of `{ providerProfile, endpoint }`.
 *
 * A browser never supplies an anchor endpoint. The *server* is what contacts it, on every later
 * lock, so a form-supplied URL would turn this action into an outbound-request primitive pointed
 * wherever the form said — the same reason the publication locator above is server-owned. Shape
 * only is checked here; the profile and endpoint rules are the core operation's, which refuses
 * `validation` naming the offending entry.
 */
export function configuredAnchorProviders(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly WorkspaceAnchoringEntry[] | undefined {
  const value = environment[ANCHOR_PROVIDERS_ENV]?.trim();
  if (!value) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch {
    throw new ProductContextConfigurationError(`${ANCHOR_PROVIDERS_ENV} must be a JSON array of { providerProfile, endpoint } entries`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ProductContextConfigurationError(`${ANCHOR_PROVIDERS_ENV} must be a non-empty JSON array of { providerProfile, endpoint } entries`);
  }
  return parsed.map((entry) => {
    const candidate = entry as { readonly providerProfile?: unknown; readonly endpoint?: unknown };
    if (typeof candidate?.providerProfile !== "string" || typeof candidate?.endpoint !== "string") {
      throw new ProductContextConfigurationError(`${ANCHOR_PROVIDERS_ENV} entries must carry string providerProfile and endpoint fields`);
    }
    return { providerProfile: candidate.providerProfile, endpoint: candidate.endpoint };
  });
}

/** A deployment may set this exact public route as its publication locator. We do not derive it
 * from request headers: forwarded host/proto values are not publication authority. */
export function configuredPublicationPublicBaseUrl(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const value = environment[PUBLICATION_PUBLIC_BASE_URL_ENV]?.trim();
  if (!value) return undefined;
  try { return normalizePublicArchiveBaseUrl(value); } catch {
    throw new ProductContextConfigurationError(`${PUBLICATION_PUBLIC_BASE_URL_ENV} must name an http(s) archive mount without credentials, query, or fragment`);
  }
}

export function readRunDriverTestingDeps(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): { readonly solveStartDelayMsForTesting?: number } {
  const rawDelay = environment[TEST_SOLVE_DELAY_MS_ENV]?.trim();
  if (rawDelay === undefined || rawDelay.length === 0) return {};
  if (environment[ENABLE_TEST_CONTROLS_ENV]?.trim() !== "1") {
    throw new ProductContextConfigurationError(
      `${TEST_SOLVE_DELAY_MS_ENV} requires ${ENABLE_TEST_CONTROLS_ENV}=1`,
    );
  }
  const delay = Number(rawDelay);
  if (!Number.isSafeInteger(delay) || delay < 1 || delay > 60_000) {
    throw new ProductContextConfigurationError(`${TEST_SOLVE_DELAY_MS_ENV} must be an integer from 1 to 60000`);
  }
  return { solveStartDelayMsForTesting: delay };
}

export function readProductServerConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ProductServerConfiguration {
  const workspaceDir = environment[WORKSPACE_ENV]?.trim();
  const agentDataDir = environment[AGENT_DATA_ENV]?.trim();
  const principal = environment[PRINCIPAL_ENV]?.trim();
  if (workspaceDir === undefined || workspaceDir.length === 0) {
    throw new ProductContextConfigurationError(`${WORKSPACE_ENV} must name an explicit absolute workspace path`);
  }
  if (!isAbsolute(workspaceDir)) {
    throw new ProductContextConfigurationError(`${WORKSPACE_ENV} must be absolute`);
  }
  if (agentDataDir === undefined || agentDataDir.length === 0) {
    throw new ProductContextConfigurationError(`${AGENT_DATA_ENV} must name an explicit absolute Colophon agent-data path`);
  }
  if (!isAbsolute(agentDataDir)) {
    throw new ProductContextConfigurationError(`${AGENT_DATA_ENV} must be absolute`);
  }
  if (principal === undefined || principal.length === 0) {
    throw new ProductContextConfigurationError(`${PRINCIPAL_ENV} must name the acting workspace principal`);
  }
  const publicationPublicBaseUrl = configuredPublicationPublicBaseUrl(environment);
  const anchorProviders = configuredAnchorProviders(environment);
  return {
    workspaceDir,
    agentDataDir,
    principal,
    ...(publicationPublicBaseUrl === undefined ? {} : { publicationPublicBaseUrl }),
    ...(anchorProviders === undefined ? {} : { anchorProviders }),
  };
}

export function createProductOperationContext(
  configuration = readProductServerConfiguration(),
  clock: () => string = () => new Date().toISOString(),
): OperationContext {
  const runtimeHost = createDefaultBenchmarkRuntimeHost({
    openAI: { keyFilePath: () => process.env.BENCHMARK_PRODUCT_OPENAI_API_KEY_FILE },
    agentDataDir: configuration.agentDataDir,
  });
  return { workspaceDir: configuration.workspaceDir, principal: configuration.principal, clock, runtimeHost };
}
