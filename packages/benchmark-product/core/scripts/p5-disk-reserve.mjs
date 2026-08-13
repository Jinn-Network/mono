import { spawnSync } from "node:child_process";
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
  const temporary = `${destination}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temporary, destination);
  const directoryFd = openSync(runRoot, "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

function allocateReserve(path, bytes) {
  const result = process.platform === "darwin"
    ? spawnSync("/usr/bin/mkfile", [`${String(Number(bytes / GIB))}g`, path], { stdio: "pipe" })
    : spawnSync("fallocate", ["-l", bytes.toString(), path], { stdio: "pipe" });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.toString("utf8").trim() ?? `exit ${String(result.status)}`;
    throw new Error(`P5 could not create its run-owned disk reserve: ${detail}`);
  }
}

function validatedState(runRoot) {
  const statePath = join(runRoot, P5_RESERVE_STATE);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (state?.schema !== "demo1.p5-disk-reserve/1" || state.reserveFile !== RESERVE_NAME
    || !Number.isSafeInteger(state.dev) || !Number.isSafeInteger(state.ino)
    || !Number.isSafeInteger(state.currentBytes) || state.currentBytes < 0) {
    throw new Error("P5 disk reserve state is invalid");
  }
  const reservePath = join(runRoot, RESERVE_NAME);
  assertInsideRunRoot(runRoot, reservePath);
  const stat = lstatSync(reservePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== state.dev || stat.ino !== state.ino
    || stat.size !== state.currentBytes) {
    throw new Error("P5 disk reserve identity or size changed outside the run");
  }
  return { state, reservePath };
}

export function createP5DiskReserve(runRoot, {
  diskPath = "/",
  allocate = allocateReserve,
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

export function recoverP5DiskCapacity(runRoot, label, {
  diskPath = "/",
  availableBytes = freeBytes,
  resize = truncateSync,
} = {}) {
  const root = resolve(runRoot);
  const before = availableBytes(diskPath);
  const { state, reservePath } = validatedState(root);
  let available = before;
  let released = 0n;
  while (available < P5_SAFE_TARGET_BYTES && state.currentBytes > 0) {
    const needed = P5_SAFE_TARGET_BYTES - available;
    const rounded = ((needed + GIB - 1n) / GIB) * GIB;
    const release = rounded > BigInt(state.currentBytes) ? BigInt(state.currentBytes) : rounded;
    const nextSize = BigInt(state.currentBytes) - release;
    resize(reservePath, Number(nextSize));
    const fd = openSync(reservePath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    state.currentBytes = Number(nextSize);
    released += release;
    writeState(root, state);
    available = availableBytes(diskPath);
  }
  const event = {
    schema: "demo1.p5-disk-recovery/1",
    at: new Date().toISOString(),
    label,
    before: snapshot(before),
    after: snapshot(available),
    releasedBytes: released.toString(),
    reserveRemainingBytes: String(state.currentBytes),
    safeTargetRestored: available >= P5_SAFE_TARGET_BYTES,
    hardFloorSatisfied: available >= P5_HARD_FLOOR_BYTES,
    cleanupScope: "run-owned-reserve-only",
  };
  durableAppend(join(root, P5_RECOVERY_LOG), event);
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

export function releaseP5DiskReserve(runRoot, label = "run complete", { diskPath = "/" } = {}) {
  const root = resolve(runRoot);
  const before = freeBytes(diskPath);
  const { state, reservePath } = validatedState(root);
  const released = state.currentBytes;
  truncateSync(reservePath, 0);
  const fd = openSync(reservePath, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  state.currentBytes = 0;
  writeState(root, state);
  const after = freeBytes(diskPath);
  const event = {
    schema: "demo1.p5-disk-recovery/1",
    at: new Date().toISOString(),
    label,
    before: snapshot(before),
    after: snapshot(after),
    releasedBytes: String(released),
    reserveRemainingBytes: "0",
    safeTargetRestored: after >= P5_SAFE_TARGET_BYTES,
    hardFloorSatisfied: after >= P5_HARD_FLOOR_BYTES,
    cleanupScope: "run-owned-reserve-only",
  };
  durableAppend(join(root, P5_RECOVERY_LOG), event);
  return event;
}
