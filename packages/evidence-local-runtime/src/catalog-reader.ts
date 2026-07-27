// SPDX-License-Identifier: MIT
import {
  EvidenceCatalogError,
  type EvidenceCatalogReader,
} from "@jinn-network/evidence-catalog";

interface ReaderSlot {
  readonly reader: EvidenceCatalogReader;
  readonly close: () => Promise<void>;
  leases: number;
  retired: boolean;
  closed: boolean;
  drained?: () => void;
}

export interface SwitchableCatalogReader {
  readonly reader: EvidenceCatalogReader;
  switchTo(
    reader: EvidenceCatalogReader,
    close: () => Promise<void>,
  ): Promise<void>;
  close(): Promise<void>;
}

export function createSwitchableCatalogReader(
  initialReader: EvidenceCatalogReader,
  initialClose: () => Promise<void>,
  assertReadable: () => void = () => {},
): SwitchableCatalogReader {
  let current: ReaderSlot = {
    reader: initialReader,
    close: initialClose,
    leases: 0,
    retired: false,
    closed: false,
  };
  let proxyClosed = false;
  let retirementError: unknown;
  const retirements = new Set<Promise<void>>();

  async function retire(slot: ReaderSlot): Promise<void> {
    if (slot.closed) return;
    slot.retired = true;
    if (slot.leases > 0) {
      await new Promise<void>((resolve) => { slot.drained = resolve; });
    }
    if (slot.closed) return;
    slot.closed = true;
    await slot.close();
  }

  function retireInBackground(slot: ReaderSlot): void {
    const pending = retire(slot)
      .catch((error: unknown) => { retirementError ??= error; })
      .finally(() => { retirements.delete(pending); });
    retirements.add(pending);
  }

  async function leased<T>(
    operation: (reader: EvidenceCatalogReader) => Promise<T>,
  ): Promise<T> {
    if (proxyClosed) {
      throw new EvidenceCatalogError(
        "IO_FAILURE",
        "The local evidence Catalog reader is closed.",
      );
    }
    assertReadable();
    const slot = current;
    slot.leases += 1;
    try {
      return await operation(slot.reader);
    } finally {
      slot.leases -= 1;
      if (slot.retired && slot.leases === 0) slot.drained?.();
    }
  }

  const reader: EvidenceCatalogReader = {
    getRecord: (reference, options) =>
      leased((value) => value.getRecord(reference, options)),
    findRecordsForEntity: (entityId, query, options) =>
      leased((value) => value.findRecordsForEntity(entityId, query, options)),
    findExecutions: (query, options) =>
      leased((value) => value.findExecutions(query, options)),
    findEvaluations: (query, options) =>
      leased((value) => value.findEvaluations(query, options)),
    findVerifications: (query, options) =>
      leased((value) => value.findVerifications(query, options)),
    getRecordLocations: (reference, options) =>
      leased((value) => value.getRecordLocations(reference, options)),
  };

  return {
    reader,
    async switchTo(nextReader, close) {
      if (proxyClosed) {
        await close();
        throw new EvidenceCatalogError(
          "IO_FAILURE",
          "The local evidence Catalog reader is closed.",
        );
      }
      const previous = current;
      current = {
        reader: nextReader,
        close,
        leases: 0,
        retired: false,
        closed: false,
      };
      retireInBackground(previous);
    },
    async close() {
      if (proxyClosed) return;
      proxyClosed = true;
      retireInBackground(current);
      await Promise.all(retirements);
      if (retirementError !== undefined) throw retirementError;
    },
  };
}
