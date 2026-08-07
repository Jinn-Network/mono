import "server-only";

import type { OperationContext, OperationResult } from "@jinn-network/benchmark-product-core";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import type { GuiActionState } from "@/lib/action-state";
import { createProductOperationContext, ProductContextConfigurationError } from "./product-context";
import { projectProductErrorForGui } from "./gui-error";

const STILL_RUNNING = Symbol("still-running");

function actionState<T>(outcome: OperationResult<T>): GuiActionState {
  return outcome.ok
    ? { status: "success", result: outcome.result }
    : { status: "error", error: projectProductErrorForGui(outcome.error) };
}

/** Starts the exact public core promise in-process. Immediate validation/authority/state failures
 * are returned honestly; a still-live driver is registered with Next's request-lifetime `after`
 * primitive and reports its eventual outcome through the core-owned durable run journal. */
export async function executeBackgroundOperation<T>(
  operationName: "launch" | "resume",
  operation: (context: OperationContext) => Promise<OperationResult<T>>,
  options: { readonly revalidate?: readonly string[] } = {},
): Promise<GuiActionState> {
  try {
    const task = operation(createProductOperationContext());
    const initial = await Promise.race([
      task,
      new Promise<typeof STILL_RUNNING>((resolve) => setImmediate(() => resolve(STILL_RUNNING))),
    ]);
    if (initial !== STILL_RUNNING) {
      if (initial.ok) for (const path of options.revalidate ?? []) revalidatePath(path);
      return actionState(initial);
    }

    const completion = task.then((outcome) => {
      for (const path of options.revalidate ?? []) revalidatePath(path);
      return outcome;
    });
    after(completion);
    return { status: "scheduled", result: { phase: "scheduled", operation: operationName } };
  } catch (cause) {
    const detail = cause instanceof ProductContextConfigurationError
      ? cause.message
      : "The server action failed before the product operation could return a typed result.";
    return { status: "error", error: { code: "invalid-invocation", detail } };
  }
}
