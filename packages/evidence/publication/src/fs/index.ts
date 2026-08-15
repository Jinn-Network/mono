// SPDX-License-Identifier: Apache-2.0
import {
  prepareFilesystemPublicationJournalPaths,
} from "./paths.js";
import {
  FilesystemPublicationJournalStore,
} from "./store.js";

export interface FilesystemPublicationJournalStoreOptions {
  readonly rootDir: string;
}

export async function createFilesystemPublicationJournalStore(
  options: FilesystemPublicationJournalStoreOptions,
): Promise<FilesystemPublicationJournalStore> {
  return new FilesystemPublicationJournalStore(
    await prepareFilesystemPublicationJournalPaths(options.rootDir),
  );
}

export {
  FILESYSTEM_PUBLICATION_JOURNAL_FORMAT,
} from "./paths.js";
export {
  FILESYSTEM_PUBLICATION_JOURNAL_MAX_REVISION_BYTES,
  FilesystemPublicationJournalStore,
} from "./store.js";
