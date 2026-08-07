import "server-only";

import { isAbsolute } from "node:path";
import type { OperationContext } from "@jinn-network/benchmark-product-core";

export const WORKSPACE_ENV = "BENCHMARK_PRODUCT_WORKSPACE_DIR";
export const PRINCIPAL_ENV = "BENCHMARK_PRODUCT_PRINCIPAL";

export class ProductContextConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductContextConfigurationError";
  }
}

export interface ProductServerConfiguration {
  readonly workspaceDir: string;
  readonly principal: string;
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
  return { workspaceDir, principal };
}

export function createProductOperationContext(
  configuration = readProductServerConfiguration(),
  clock: () => string = () => new Date().toISOString(),
): OperationContext {
  return { ...configuration, clock };
}
