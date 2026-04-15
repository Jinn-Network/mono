// @ts-nocheck
// Test fixture: r1 violation (hardcoded secret)
// This file intentionally violates r1 (Never commit secrets)

import { Database } from './database';

// VIOLATION: Hardcoded API key
const API_KEY = 'sk_live_1234567890abcdef';

// VIOLATION: Hardcoded database credentials
const config = {
  host: 'localhost',
  user: 'admin',
  password: 'SuperSecret123!',
  database: 'production',
};

export async function connectToDatabase() {
  return new Database(config);
}

export async function callExternalAPI(endpoint: string) {
  const response = await fetch(endpoint, {
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
    },
  });

  return response.json();
}
