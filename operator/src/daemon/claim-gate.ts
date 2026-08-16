export interface ClaimGate {
  /** Resolves once the projector cursor has reached the finalized head. Never rejects. */
  waitUntilOpen(signal?: AbortSignal): Promise<void>;
  isOpen(): boolean;
}

export function createProjectorCatchUpGate(input: {
  readonly hasCaughtUp: () => Promise<boolean>;
  readonly pollIntervalMs: number;
  readonly logger?: { info(m: string): void };
  readonly sleep?: (ms: number) => Promise<void>;
}): ClaimGate {
  let open = false;
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    isOpen: () => open,
    async waitUntilOpen(signal?: AbortSignal): Promise<void> {
      if (open) return;
      const aborted = (): boolean => signal?.aborted === true;
      while (!aborted()) {
        if (await input.hasCaughtUp()) {
          open = true;
          input.logger?.info(
            '[work] claim gate open — the projector cursor reached the finalized chain head',
          );
          return;
        }
        if (aborted()) return;
        await sleep(input.pollIntervalMs);
      }
    },
  };
}
