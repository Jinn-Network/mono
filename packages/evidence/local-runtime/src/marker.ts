// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { constants, lstat, open, rename } from "node:fs/promises";
import { dirname } from "node:path";

import {
  LocalEvidenceRuntimeError,
  localRuntimeIoError,
} from "./errors.js";
import { enforcePrivateFile, type LocalRuntimePaths } from "./paths.js";

export interface LocalEvidenceRuntimeMarkerV1 {
  readonly format: "jinn-local-evidence-runtime";
  readonly version: 1;
  readonly runtimeId: `urn:uuid:${string}`;
  readonly sourceId: `urn:uuid:${string}`;
  readonly repositoryId: string;
}

function serialize(marker: LocalEvidenceRuntimeMarkerV1): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(marker)}\n`);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validate(value: unknown): LocalEvidenceRuntimeMarkerV1 {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { format?: unknown }).format !== "jinn-local-evidence-runtime"
  ) {
    throw new LocalEvidenceRuntimeError(
      "RUNTIME_CORRUPT",
      "The runtime marker has an invalid format.",
    );
  }
  if ((value as { version?: unknown }).version !== 1) {
    throw new LocalEvidenceRuntimeError(
      "ROOT_VERSION_UNSUPPORTED",
      "The runtime marker version is unsupported.",
    );
  }
  const marker = value as Partial<LocalEvidenceRuntimeMarkerV1>;
  const uuid = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (
    typeof marker.runtimeId !== "string" ||
    typeof marker.sourceId !== "string" ||
    !uuid.test(marker.runtimeId) ||
    !uuid.test(marker.sourceId) ||
    marker.repositoryId !== `local:${marker.runtimeId.slice(9)}` ||
    JSON.stringify(value) !== JSON.stringify({
      format: marker.format,
      version: marker.version,
      runtimeId: marker.runtimeId,
      sourceId: marker.sourceId,
      repositoryId: marker.repositoryId,
    })
  ) {
    throw new LocalEvidenceRuntimeError(
      "RUNTIME_CORRUPT",
      "The runtime marker identities are invalid.",
    );
  }
  return marker as LocalEvidenceRuntimeMarkerV1;
}

export async function openRuntimeMarker(
  paths: LocalRuntimePaths,
): Promise<LocalEvidenceRuntimeMarkerV1> {
  try {
    try {
      const stat = await lstat(paths.markerPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new LocalEvidenceRuntimeError(
          "UNSAFE_PATH",
          "The runtime marker must be a regular file.",
        );
      }
      await enforcePrivateFile(paths.markerPath);
      const handle = await open(
        paths.markerPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        return validate(JSON.parse(await handle.readFile("utf8")));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const runtimeUuid = randomUUID();
    const marker: LocalEvidenceRuntimeMarkerV1 = {
      format: "jinn-local-evidence-runtime",
      version: 1,
      runtimeId: `urn:uuid:${runtimeUuid}`,
      sourceId: `urn:uuid:${randomUUID()}`,
      repositoryId: `local:${runtimeUuid}`,
    };
    const temporary = `${paths.markerPath}.${randomUUID()}.tmp`;
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(serialize(marker));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, paths.markerPath);
    await enforcePrivateFile(paths.markerPath);
    await syncDirectory(dirname(paths.markerPath));
    return marker;
  } catch (error) {
    if (error instanceof LocalEvidenceRuntimeError) throw error;
    if (error instanceof SyntaxError) {
      throw new LocalEvidenceRuntimeError(
        "RUNTIME_CORRUPT",
        "The runtime marker is not valid JSON.",
        { cause: error },
      );
    }
    throw localRuntimeIoError(error, "Unable to open the runtime marker.");
  }
}
