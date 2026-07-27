// SPDX-License-Identifier: Apache-2.0
import type {
  RepositoryOperationOptions,
} from "@jinn-network/evidence-repository";

import { createPublicationOperation } from "./operation.js";
import {
  prepareAnnouncementPartitionsWithOperation,
} from "./partition-internal.js";
import type {
  AnnouncementMember,
  AnnouncementSink,
  PreparedPublicationPartition,
} from "./types.js";

export async function prepareAnnouncementPartitions(
  members: readonly AnnouncementMember[],
  destination: string,
  sink: AnnouncementSink,
  options?: RepositoryOperationOptions,
): Promise<readonly PreparedPublicationPartition[]> {
  const operation = createPublicationOperation(options);
  try {
    return await prepareAnnouncementPartitionsWithOperation(
      members,
      destination,
      sink,
      operation,
    );
  } finally {
    operation.close();
  }
}
