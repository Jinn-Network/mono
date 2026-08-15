export type NativeCleanup = () => void | Promise<void>;

/** Reverse-order acquisition scope for production graphs that transfer ownership on success. */
export class NativeConstructionScope {
  private cleanups: NativeCleanup[] = [];
  private released = false;

  defer(cleanup: NativeCleanup): void {
    if (this.released) throw new Error('native construction ownership was already transferred');
    this.cleanups.push(cleanup);
  }

  release(): void {
    this.released = true;
    this.cleanups = [];
  }

  async unwind(cause: unknown): Promise<never> {
    if (this.released) throw cause;
    this.released = true;
    const failures: unknown[] = [];
    for (const cleanup of this.cleanups.reverse()) {
      try { await cleanup(); } catch (cleanupCause) { failures.push(cleanupCause); }
    }
    this.cleanups = [];
    if (failures.length > 0) {
      throw new AggregateError([cause, ...failures], 'native construction and cleanup failed');
    }
    throw cause;
  }
}
