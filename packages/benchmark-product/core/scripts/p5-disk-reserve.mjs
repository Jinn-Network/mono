import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statfsSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const GIB = 1024n * 1024n * 1024n;
export const P5_START_FREE_BYTES = 60n * GIB;
export const P5_SAFE_TARGET_BYTES = 44n * GIB;
export const P5_RESERVE_BYTES = 16n * GIB;
export const P5_HARD_FLOOR_BYTES = 40n * GIB;
export const P5_RESERVE_STATE = "p5-disk-reserve.json";
export const P5_RECOVERY_LOG = "p5-disk-recovery.jsonl";
const RESERVE_NAME = "p5-disk-reserve.bin";
const RESIZE_INTENT_NAME = "p5-disk-reserve-resize.json";

function freeBytes(path = "/") {
  const stats = statfsSync(path, { bigint: true });
  return stats.bavail * stats.bsize;
}

function snapshot(bytes) {
  return {
    availableBytes: bytes.toString(),
    availableGiB: (Number(bytes) / 1024 ** 3).toFixed(2),
  };
}

function assertInsideRunRoot(runRoot, target) {
  const root = realpathSync(runRoot);
  const parent = realpathSync(dirname(target));
  const rel = relative(root, parent);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("P5 disk reserve refused a path outside the run-owned output root");
  }
  return root;
}

function writeState(runRoot, state) {
  const destination = join(runRoot, P5_RESERVE_STATE);
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const fileFd = openSync(temporary, "r");
  try {
    fsyncSync(fileFd);
  } finally {
    closeSync(fileFd);
  }
  renameSync(temporary, destination);
  syncDirectory(runRoot);
}

function syncDirectory(path) {
  const directoryFd = openSync(path, "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

export function allocateP5ReserveFile(path, bytes, {
  platform = process.platform,
  spawn = spawnSync,
} = {}) {
  // `mkfile` is installed under /usr/sbin on current macOS releases. Resolve it through PATH
  // rather than pinning the obsolete /usr/bin location; the exact resulting file size is still
  // verified by createP5DiskReserve before any state is sealed.
  const result = platform === "darwin"
    ? spawn("mkfile", [`${String(Number(bytes / GIB))}g`, path], { stdio: "pipe" })
    : spawn("fallocate", ["-l", bytes.toString(), path], { stdio: "pipe" });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.toString("utf8").trim() ?? `exit ${String(result.status)}`;
    throw new Error(`P5 could not create its run-owned disk reserve: ${detail}`);
  }
}

function resizeIntentPath(runRoot) {
  return join(runRoot, RESIZE_INTENT_NAME);
}

function parseResizeIntent(runRoot) {
  const path = resizeIntentPath(runRoot);
  if (!existsSync(path)) return undefined;
  const intent = JSON.parse(readFileSync(path, "utf8"));
  if (intent?.schema !== "demo1.p5-disk-resize/1" || intent.reserveFile !== RESERVE_NAME
    || typeof intent.operationId !== "string" || intent.operationId.length === 0
    || typeof intent.label !== "string" || intent.label.length === 0
    || !Number.isSafeInteger(intent.dev) || !Number.isSafeInteger(intent.ino)
    || !Number.isSafeInteger(intent.fromBytes) || intent.fromBytes < 0
    || !Number.isSafeInteger(intent.toBytes) || intent.toBytes < 0
    || intent.toBytes > intent.fromBytes
    || typeof intent.before?.availableBytes !== "string"
    || typeof intent.before?.availableGiB !== "string") {
    throw new Error("P5 disk reserve resize intent is invalid");
  }
  return intent;
}

function syncReserveFile(path) {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeResizeIntent(runRoot, intent) {
  const path = resizeIntentPath(runRoot);
  if (existsSync(path)) throw new Error("P5 disk reserve already has an unfinished resize intent");
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(intent, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const fd = openSync(temporary, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDirectory(runRoot);
}

function removeResizeIntent(runRoot) {
  const path = resizeIntentPath(runRoot);
  if (!existsSync(path)) return;
  unlinkSync(path);
  syncDirectory(runRoot);
}

/**
 * Authenticate the reserve and complete any durably announced resize. The intent is retained
 * until its recovery event is durable, so a stop at every truncate/state/log boundary is
 * resumable and auditable.
 */
function validatedState(runRoot, { resize = truncateSync } = {}) {
  const statePath = join(runRoot, P5_RESERVE_STATE);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (state?.schema !== "demo1.p5-disk-reserve/1" || state.reserveFile !== RESERVE_NAME
    || !Number.isSafeInteger(state.dev) || !Number.isSafeInteger(state.ino)
    || !Number.isSafeInteger(state.currentBytes) || state.currentBytes < 0) {
    throw new Error("P5 disk reserve state is invalid");
  }
  const reservePath = join(runRoot, RESERVE_NAME);
  assertInsideRunRoot(runRoot, reservePath);
  let stat = lstatSync(reservePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== state.dev || stat.ino !== state.ino) {
    throw new Error("P5 disk reserve identity or size changed outside the run");
  }
  const intent = parseResizeIntent(runRoot);
  if (intent === undefined) {
    if (stat.size !== state.currentBytes) {
      throw new Error("P5 disk reserve identity or size changed outside the run");
    }
    return { state, reservePath, intent: undefined };
  }
  if (intent.dev !== state.dev || intent.ino !== state.ino
    || !((state.currentBytes === intent.fromBytes && (stat.size === intent.fromBytes || stat.size === intent.toBytes))
      || (state.currentBytes === intent.toBytes && stat.size === intent.toBytes))) {
    throw new Error("P5 disk reserve resize intent does not match the authenticated reserve state");
  }
  if (stat.size === intent.fromBytes) {
    resize(reservePath, intent.toBytes);
    syncReserveFile(reservePath);
    stat = lstatSync(reservePath);
  }
  if (stat.size !== intent.toBytes) {
    throw new Error("P5 disk reserve resize did not reach its durable target");
  }
  if (state.currentBytes !== intent.toBytes) {
    state.currentBytes = intent.toBytes;
    writeState(runRoot, state);
  }
  return { state, reservePath, intent };
}

export function createP5DiskReserve(runRoot, {
  diskPath = "/",
  allocate = allocateP5ReserveFile,
  available = freeBytes,
} = {}) {
  const root = realpathSync(runRoot);
  const before = available(diskPath);
  if (before < P5_START_FREE_BYTES) {
    throw new Error(
      `P5 start gate refused: ${snapshot(before).availableGiB} GiB free; 60.00 GiB is required `
      + "to establish the run-owned recovery reserve. No caches or user data were deleted.",
    );
  }
  const reservePath = join(root, RESERVE_NAME);
  if (existsSync(join(root, P5_RESERVE_STATE)) || existsSync(reservePath)) {
    throw new Error("P5 disk reserve already exists; use the explicit resume path");
  }
  assertInsideRunRoot(root, reservePath);
  allocate(reservePath, P5_RESERVE_BYTES);
  const stat = lstatSync(reservePath);
  if (!stat.isFile() || stat.isSymbolicLink() || BigInt(stat.size) !== P5_RESERVE_BYTES) {
    throw new Error("P5 disk reserve allocation did not create the exact run-owned regular file");
  }
  const state = {
    schema: "demo1.p5-disk-reserve/1",
    createdAt: new Date().toISOString(),
    reserveFile: RESERVE_NAME,
    dev: stat.dev,
    ino: stat.ino,
    initialBytes: Number(P5_RESERVE_BYTES),
    currentBytes: stat.size,
  };
  writeState(root, state);
  return { before: snapshot(before), after: snapshot(available(diskPath)), reserveBytes: state.currentBytes };
}

function durableAppend(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8" });
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directoryFd = openSync(dirname(path), "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

function recoveryEvents(runRoot) {
  const path = join(runRoot, P5_RECOVERY_LOG);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function finalizeResizeIntent(runRoot, intent, available) {
  const prior = recoveryEvents(runRoot).find((event) => event?.operationId === intent.operationId);
  if (prior !== undefined) {
    removeResizeIntent(runRoot);
    return prior;
  }
  const event = {
    schema: "demo1.p5-disk-recovery/1",
    operationId: intent.operationId,
    at: new Date().toISOString(),
    label: intent.label,
    before: intent.before,
    after: snapshot(available),
    releasedBytes: String(BigInt(intent.fromBytes) - BigInt(intent.toBytes)),
    reserveRemainingBytes: String(intent.toBytes),
    safeTargetRestored: available >= P5_SAFE_TARGET_BYTES,
    hardFloorSatisfied: available >= P5_HARD_FLOOR_BYTES,
    cleanupScope: "run-owned-reserve-only",
  };
  durableAppend(join(runRoot, P5_RECOVERY_LOG), event);
  removeResizeIntent(runRoot);
  return event;
}

function beginResizeIntent(runRoot, label, state, before, toBytes) {
  const intent = {
    schema: "demo1.p5-disk-resize/1",
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
    label,
    before: snapshot(before),
    reserveFile: RESERVE_NAME,
    dev: state.dev,
    ino: state.ino,
    fromBytes: state.currentBytes,
    toBytes,
  };
  writeResizeIntent(runRoot, intent);
  return intent;
}

export function recoverP5DiskCapacity(runRoot, label, {
  diskPath = "/",
  availableBytes = freeBytes,
  resize = truncateSync,
} = {}) {
  const root = resolve(runRoot);
  let validated = validatedState(root, { resize });
  if (validated.intent !== undefined) {
    finalizeResizeIntent(root, validated.intent, availableBytes(diskPath));
    validated = validatedState(root, { resize });
  }
  const before = availableBytes(diskPath);
  let available = before;
  let event;
  if (available < P5_SAFE_TARGET_BYTES && validated.state.currentBytes > 0) {
    const needed = P5_SAFE_TARGET_BYTES - available;
    const rounded = ((needed + GIB - 1n) / GIB) * GIB;
    const release = rounded > BigInt(validated.state.currentBytes)
      ? BigInt(validated.state.currentBytes)
      : rounded;
    const nextSize = Number(BigInt(validated.state.currentBytes) - release);
    const intent = beginResizeIntent(root, label, validated.state, before, nextSize);
    // validatedState owns completion of the announced resize. If resize throws (including after
    // changing the file), the durable intent remains and the next invocation resumes it.
    validated = validatedState(root, { resize });
    available = availableBytes(diskPath);
    event = finalizeResizeIntent(root, intent, available);
  } else {
    event = {
      schema: "demo1.p5-disk-recovery/1",
      at: new Date().toISOString(),
      label,
      before: snapshot(before),
      after: snapshot(available),
      releasedBytes: "0",
      reserveRemainingBytes: String(validated.state.currentBytes),
      safeTargetRestored: available >= P5_SAFE_TARGET_BYTES,
      hardFloorSatisfied: available >= P5_HARD_FLOOR_BYTES,
      cleanupScope: "run-owned-reserve-only",
    };
    durableAppend(join(root, P5_RECOVERY_LOG), event);
  }
  if (available < P5_HARD_FLOOR_BYTES) {
    throw new Error(
      `P5 disk recovery refused ${label}: ${snapshot(available).availableGiB} GiB free after releasing `
      + "the run-owned reserve; 40.00 GiB is required. No caches or user data were deleted.",
    );
  }
  return event;
}

export function inspectP5DiskReserve(runRoot) {
  const { state } = validatedState(resolve(runRoot));
  return { ...state };
}

export function releaseP5DiskReserve(runRoot, label = "run complete", {
  diskPath = "/",
  availableBytes = freeBytes,
  resize = truncateSync,
} = {}) {
  const root = resolve(runRoot);
  let validated = validatedState(root, { resize });
  if (validated.intent !== undefined) {
    const recovered = finalizeResizeIntent(root, validated.intent, availableBytes(diskPath));
    validated = validatedState(root, { resize });
    if (recovered.label === label && recovered.reserveRemainingBytes === "0") return recovered;
  }
  const before = availableBytes(diskPath);
  const { state } = validated;
  if (state.currentBytes === 0 && existsSync(join(root, P5_RECOVERY_LOG))) {
    const prior = recoveryEvents(root).findLast((event) => event?.label === label
      && event?.reserveRemainingBytes === "0");
    if (prior !== undefined) return prior;
  }
  const intent = beginResizeIntent(root, label, state, before, 0);
  validatedState(root, { resize });
  return finalizeResizeIntent(root, intent, availableBytes(diskPath));
}
