/**
 * Active Service Context — Identity singleton for multi-service rotation
 *
 * Holds the currently active service identity (mech, safe, key, service ID).
 * When populated, operate-profile.ts getters use this instead of reading
 * from the .operate directory, enabling hot-swap between services.
 *
 * Also holds a registry of ALL services for cross-mech credential resolution.
 * When WORKER_MECH_FILTER_MODE=any, the worker may claim requests from a
 * mech that belongs to a different service than the active one. The registry
 * allows delivery code to look up the correct Safe/key by target mech address.
 *
 * In single-service mode this is never populated, so existing behavior
 * is preserved with zero overhead.
 */

import type { ServiceInfo } from '../ServiceConfigReader.js';

export interface ActiveServiceIdentity {
  mechAddress: string;
  safeAddress: string;
  privateKey: string;
  chainConfig: string;
  serviceId: number;
  serviceConfigId: string;
  stakingContract: string | null;
}

let _active: ActiveServiceIdentity | null = null;
let _allServices: ServiceInfo[] = [];

/** Set the active service identity (called by ServiceRotator) */
export function setActiveService(identity: ActiveServiceIdentity): void {
  _active = identity;
}

/** Get the active service identity, or null if single-service mode */
export function getActiveService(): ActiveServiceIdentity | null {
  return _active;
}

/** Clear the active service (revert to .operate directory reads) */
export function clearActiveService(): void {
  _active = null;
}

// Typed getters matching operate-profile.ts interface

export function getActiveMechAddress(): string | null {
  return _active?.mechAddress ?? null;
}

export function getActiveSafeAddress(): string | null {
  return _active?.safeAddress ?? null;
}

export function getActivePrivateKey(): string | null {
  return _active?.privateKey ?? null;
}

export function getActiveChainConfig(): string | null {
  return _active?.chainConfig ?? null;
}

// Service registry — all services for cross-mech credential resolution

/** Store all services (called by ServiceRotator.initialize) */
export function setAllServices(services: ServiceInfo[]): void {
  _allServices = services;
}

/** Get all registered services */
export function getAllRegisteredServices(): ServiceInfo[] {
  return _allServices;
}

/** Look up the service that owns a given mech address */
export function getServiceByMech(mechAddress: string): ServiceInfo | undefined {
  return _allServices.find(
    s => s.mechContractAddress?.toLowerCase() === mechAddress.toLowerCase()
  );
}
