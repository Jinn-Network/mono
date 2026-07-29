// SPDX-License-Identifier: Apache-2.0

/**
 * Platform-neutral custody transitions shared by the conformance seam.  The native Linux shim
 * performs the corresponding syscalls; its integration suite is the OS proof.  This small
 * controller makes the ordering and control boundaries executable on every supported host.
 */
export interface ShimCleanupPort {
  signalHarnessSubtree(signal: "SIGKILL"): void | Promise<void>;
  reapHarnessLeader(): void | Promise<void>;
}

export interface ShimSubreaperPort {
  enableSubreaper(): boolean;
}

export interface ShimSignalGuardPort {
  ignoreSignal(signal: "SIGTERM" | "SIGINT" | "SIGHUP"): void;
}

/** The group signal is issued before its leader can be reaped and its PGID reused. */
export async function cleanupHarnessSubtree(port: ShimCleanupPort): Promise<{ readonly signalDelivered: true; readonly leaderReaped: true }> {
  await port.signalHarnessSubtree("SIGKILL");
  await port.reapHarnessLeader();
  return { signalDelivered: true, leaderReaped: true };
}

/** Linux supplies the real primitive; other hosts can surface their declared custody residual. */
export function establishSubreaperCustody(port: ShimSubreaperPort): { readonly subreaper: boolean; readonly visibleToCustodyScan: boolean } {
  const subreaper = port.enableSubreaper();
  return { subreaper, visibleToCustodyScan: subreaper };
}

/** The shim must survive broad cancellation signals so it remains the sole outcome recorder. */
export function installCustodianSignalGuards(port: ShimSignalGuardPort): void {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) port.ignoreSignal(signal);
}
