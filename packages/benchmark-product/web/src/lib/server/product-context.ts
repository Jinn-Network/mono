import "server-only";

import { isAbsolute } from "node:path";
import {
  createDefaultBenchmarkRuntimeHost,
  normalizePublicArchiveBaseUrl,
  type OperationContext,
} from "@jinn-network/benchmark-product-core";

const runtimeHost = createDefaultBenchmarkRuntimeHost({
  openAI: { keyFilePath: () => process.env.BENCHMARK_PRODUCT_OPENAI_API_KEY_FILE },
});

export const WORKSPACE_ENV = "BENCHMARK_PRODUCT_WORKSPACE_DIR";
export const PRINCIPAL_ENV = "BENCHMARK_PRODUCT_PRINCIPAL";
export const ENABLE_TEST_CONTROLS_ENV = "BENCHMARK_PRODUCT_ENABLE_TEST_CONTROLS";
export const TEST_SOLVE_DELAY_MS_ENV = "BENCHMARK_PRODUCT_TEST_SOLVE_DELAY_MS";
export const OPENAI_KEY_FILE_ENV = "BENCHMARK_PRODUCT_OPENAI_API_KEY_FILE";
export const PUBLICATION_PUBLIC_BASE_URL_ENV = "BENCHMARK_PRODUCT_PUBLICATION_PUBLIC_BASE_URL";

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
  readonly principal: string;
  readonly publicationPublicBaseUrl?: string;
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
  const principal = environment[PRINCIPAL_ENV]?.trim();
  if (workspaceDir === undefined || workspaceDir.length === 0) {
    throw new ProductContextConfigurationError(`${WORKSPACE_ENV} must name an explicit absolute workspace path`);
  }
  if (!isAbsolute(workspaceDir)) {
    throw new ProductContextConfigurationError(`${WORKSPACE_ENV} must be absolute`);
  }
  if (principal === undefined || principal.length === 0) {
    throw new ProductContextConfigurationError(`${PRINCIPAL_ENV} must name the acting workspace principal`);
  }
  const publicationPublicBaseUrl = configuredPublicationPublicBaseUrl(environment);
  return { workspaceDir, principal, ...(publicationPublicBaseUrl === undefined ? {} : { publicationPublicBaseUrl }) };
}

export function createProductOperationContext(
  configuration = readProductServerConfiguration(),
  clock: () => string = () => new Date().toISOString(),
): OperationContext {
  return { ...configuration, clock, runtimeHost };
}
