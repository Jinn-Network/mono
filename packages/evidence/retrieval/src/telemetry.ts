import type {
  RetrievalTelemetry,
  RetrievalTelemetryEvent,
} from "./contracts.js";
import type { OperationContext } from "./operation.js";

export interface TelemetrySession {
  emit(
    event: Omit<RetrievalTelemetryEvent, "operationId" | "operation">,
  ): Promise<void>;
}

export function createTelemetrySession(
  sink: RetrievalTelemetry | undefined,
  context: OperationContext,
  operation: RetrievalTelemetryEvent["operation"],
): TelemetrySession {
  return Object.freeze({
    async emit(
      event: Omit<RetrievalTelemetryEvent, "operationId" | "operation">,
    ) {
      if (!sink) return;
      const safe: RetrievalTelemetryEvent = Object.freeze({
        operationId: context.operationId,
        operation,
        stage: event.stage,
        ...(event.source === undefined ? {} : {
          source: Object.freeze({
            id: event.source.id,
            version: event.source.version,
          }),
        }),
        ...(event.bindingProfile === undefined
          ? {}
          : { bindingProfile: event.bindingProfile }),
        ...(event.durationMs === undefined
          ? {}
          : { durationMs: event.durationMs }),
        ...(event.candidateCount === undefined
          ? {}
          : { candidateCount: event.candidateCount }),
        ...(event.resultCount === undefined
          ? {}
          : { resultCount: event.resultCount }),
        ...(event.failureCode === undefined
          ? {}
          : { failureCode: event.failureCode }),
        ...(event.bytes === undefined ? {} : { bytes: event.bytes }),
      });
      try {
        await Promise.resolve(sink.emit(safe)).catch(() => {});
      } catch {
        // Observability is intentionally non-authoritative.
      }
    },
  });
}
