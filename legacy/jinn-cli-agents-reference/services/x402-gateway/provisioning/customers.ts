/**
 * Customer registry for x402 gateway provisioning
 * Reads/writes provisioned customer data to data/customers.json
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

export interface CustomerRecord {
  displayName: string;
  repo: string;
  sshUrl: string;
  railwayServiceId: string;
  domain: string;
  umamiWebsiteId: string;
  createdAt: string;
  status?: 'provisioning' | 'active' | 'partial';
  errorPhase?: string;
  errorMessage?: string;
}

export type CustomerRegistry = Record<string, CustomerRecord>;

// Path to customers.json - relative to repo root
const CUSTOMERS_FILE = join(process.cwd(), '..', '..', 'data', 'customers.json');

/**
 * Load the customer registry from disk
 */
export async function loadCustomers(): Promise<CustomerRegistry> {
  try {
    const data = await readFile(CUSTOMERS_FILE, 'utf-8');
    return JSON.parse(data) as CustomerRegistry;
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      // File doesn't exist, return empty registry
      return {};
    }
    throw e;
  }
}

/**
 * Save the customer registry to disk
 */
export async function saveCustomers(registry: CustomerRegistry): Promise<void> {
  const data = JSON.stringify(registry, null, 2);
  await writeFile(CUSTOMERS_FILE, data, 'utf-8');
}

/**
 * Find a customer by slug
 */
export async function findCustomer(slug: string): Promise<CustomerRecord | null> {
  const registry = await loadCustomers();
  return registry[slug] || null;
}

/**
 * Save or update a customer record
 */
export async function saveCustomer(slug: string, customer: CustomerRecord): Promise<void> {
  const registry = await loadCustomers();
  registry[slug] = customer;
  await saveCustomers(registry);
  console.log(`[provision] Customer record saved: ${slug}`);
}

/**
 * Convert a display name to a slug
 * "Acme Corp Blog" -> "acme-corp-blog"
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
