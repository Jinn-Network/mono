import "server-only";

import type { OperationContext, OperationResult } from "@jinn-network/benchmark-product-core";
import { revalidatePath } from "next/cache";
import type { GuiActionState } from "@/lib/action-state";
import { projectProductErrorForGui } from "./gui-error";
import { createProductOperationContext, ProductContextConfigurationError } from "./product-context";

export function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function optionalField(formData: FormData, name: string): string | undefined {
  const value = field(formData, name);
  return value.length === 0 ? undefined : value;
}

export function jsonField(formData: FormData, name: string, fallback?: unknown): unknown {
  const value = field(formData, name);
  if (value.length === 0 && fallback !== undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new ProductContextConfigurationError(`${name} must be valid JSON`);
  }
}

export function positiveIntegerField(formData: FormData, name: string): number | undefined {
  const value = optionalField(formData, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ProductContextConfigurationError(`${name} must be a positive integer`);
  }
  return parsed;
}

export async function executeOperation<T>(
  operation: (context: OperationContext) => OperationResult<T> | Promise<OperationResult<T>>,
  options: { readonly revalidate?: readonly string[] } = {},
): Promise<GuiActionState> {
  try {
    const outcome = await operation(createProductOperationContext());
    if (!outcome.ok) return { status: "error", error: projectProductErrorForGui(outcome.error) };
    for (const path of options.revalidate ?? []) revalidatePath(path);
    return { status: "success", result: outcome.result };
  } catch (cause) {
    const detail = cause instanceof ProductContextConfigurationError
      ? "The submitted form or server configuration was not accepted. Correct the named setup and retry."
      : "The server action failed before the product operation could return a typed result.";
    return {
      status: "error",
      error: {
        code: "invalid-invocation",
        detail,
      },
    };
  }
}
