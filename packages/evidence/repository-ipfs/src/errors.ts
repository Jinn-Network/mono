// SPDX-License-Identifier: Apache-2.0

import {
  EvidenceRepositoryError,
  type EvidenceRepositoryErrorCode,
} from "@jinn-network/evidence-repository";

export type IpfsDependencyOperation =
  | "block-read"
  | "block-write"
  | "local-pin-read"
  | "readback"
  | "remote-pin-read"
  | "remote-pin-write";

export type IpfsDependencyFailureKind =
  | "access-denied"
  | "protocol-failure"
  | "unavailable";

interface IpfsDependencyFailureCause {
  readonly failureKind: IpfsDependencyFailureKind;
  readonly operation: IpfsDependencyOperation;
}

const packageOwnedErrors = new WeakSet<object>();

export function mapIpfsDependencyError(
  error: unknown,
  message: string,
  operation: IpfsDependencyOperation,
  signal?: AbortSignal,
  preserveRepositoryCode = false,
): EvidenceRepositoryError {
  if (signal?.aborted === true) {
    return ipfsRepositoryError(
      "OPERATION_ABORTED",
      "The IPFS repository operation was aborted.",
    );
  }

  if (isIpfsRepositoryError(error)) {
    return sanitizeRepositoryError(error, operation);
  }
  if (
    preserveRepositoryCode &&
    repositoryErrorCode(error) !== undefined
  ) {
    return sanitizeRepositoryError(error, operation);
  }

  const status = dependencyStatus(error);
  const detail = dependencyText(error, "message").toLowerCase();
  if (
    status === 401 ||
    status === 403 ||
    status === 507 ||
    /\b(?:denied|forbidden|not authorized|unauthorized|quota)\b/u.test(detail)
  ) {
    return ipfsDependencyError(
      "ACCESS_DENIED",
      message,
      operation,
      "access-denied",
    );
  }

  const code = dependencyText(error, "code");
  if (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    code === "ECONNABORTED" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    dependencyText(error, "name") === "AbortError" ||
    /\b(?:network|socket|timeout|timed out|unavailable)\b/u.test(detail)
  ) {
    return ipfsDependencyError(
      "DEPENDENCY_UNAVAILABLE",
      message,
      operation,
      "unavailable",
    );
  }

  return ipfsDependencyError(
    "IO_FAILURE",
    message,
    operation,
    "protocol-failure",
  );
}

export function ipfsRepositoryError(
  code: EvidenceRepositoryErrorCode,
  message: string,
): EvidenceRepositoryError {
  const error = new EvidenceRepositoryError(code, message);
  Object.freeze(error);
  packageOwnedErrors.add(error);
  return error;
}

export function ipfsDependencyError(
  code: EvidenceRepositoryErrorCode,
  message: string,
  operation: IpfsDependencyOperation,
  failureKind: IpfsDependencyFailureKind,
): EvidenceRepositoryError {
  const cause: IpfsDependencyFailureCause = Object.freeze({
    failureKind,
    operation,
  });
  const error = new EvidenceRepositoryError(
    code,
    message,
    { cause },
  );
  Object.freeze(error);
  packageOwnedErrors.add(error);
  return error;
}

export function isIpfsRepositoryError(
  error: unknown,
): error is EvidenceRepositoryError {
  return (
    isObjectLike(error) &&
    packageOwnedErrors.has(error)
  );
}

export function repositoryErrorCode(
  error: unknown,
): EvidenceRepositoryErrorCode | undefined {
  if (!isObjectLike(error)) return undefined;
  const code = dependencyDataProperty(error, "code");
  switch (code) {
    case "ACCESS_DENIED":
    case "CONTENT_CORRUPT":
    case "CONTENT_TOO_LARGE":
    case "DEPENDENCY_UNAVAILABLE":
    case "INVALID_REFERENCE":
    case "IO_FAILURE":
    case "OPERATION_ABORTED":
    case "REFERENCE_CONFLICT":
      return code;
    default:
      return undefined;
  }
}

function dependencyStatus(error: unknown): number | undefined {
  if (!isObjectLike(error)) return undefined;
  const directStatus = dependencyDataProperty(error, "status");
  if (typeof directStatus === "number") return directStatus;
  const response = dependencyDataProperty(error, "response");
  if (!isObjectLike(response)) return undefined;
  const responseStatus = dependencyDataProperty(response, "status");
  if (typeof responseStatus === "number") return responseStatus;
  return undefined;
}

function sanitizeRepositoryError(
  error: unknown,
  operation: IpfsDependencyOperation,
): EvidenceRepositoryError {
  switch (repositoryErrorCode(error)) {
    case "ACCESS_DENIED":
      return ipfsDependencyError(
        "ACCESS_DENIED",
        "The configured IPFS read path denied access.",
        operation,
        "access-denied",
      );
    case "DEPENDENCY_UNAVAILABLE":
      return ipfsDependencyError(
        "DEPENDENCY_UNAVAILABLE",
        "The configured IPFS read path was unavailable.",
        operation,
        "unavailable",
      );
    case "IO_FAILURE":
      return ipfsDependencyError(
        "IO_FAILURE",
        "The configured IPFS read path failed.",
        operation,
        "protocol-failure",
      );
    case "CONTENT_CORRUPT":
      return ipfsDependencyError(
        "CONTENT_CORRUPT",
        "The configured IPFS read path returned corrupt content.",
        operation,
        "protocol-failure",
      );
    case "CONTENT_TOO_LARGE":
      return ipfsDependencyError(
        "CONTENT_TOO_LARGE",
        "The configured IPFS read path exceeded its byte limit.",
        operation,
        "protocol-failure",
      );
    case "INVALID_REFERENCE":
      return ipfsDependencyError(
        "INVALID_REFERENCE",
        "The configured IPFS read path rejected the reference.",
        operation,
        "protocol-failure",
      );
    case "REFERENCE_CONFLICT":
      return ipfsDependencyError(
        "REFERENCE_CONFLICT",
        "The configured IPFS read path reported a reference conflict.",
        operation,
        "protocol-failure",
      );
    case "OPERATION_ABORTED":
      return ipfsDependencyError(
        "DEPENDENCY_UNAVAILABLE",
        "The configured IPFS read path stopped unexpectedly.",
        operation,
        "unavailable",
      );
    default:
      return ipfsDependencyError(
        "IO_FAILURE",
        "The configured IPFS read path failed.",
        operation,
        "protocol-failure",
      );
  }
}

function dependencyText(error: unknown, key: string): string {
  if (!isObjectLike(error)) return "";
  const value = dependencyDataProperty(error, key);
  return typeof value === "string" ? value.slice(0, 4_096) : "";
}

function dependencyDataProperty(
  value: object,
  key: string,
): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  );
}
