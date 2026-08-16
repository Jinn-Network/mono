import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startApiServer, type ApiServer } from '../../src/api/server.js';
import { Store } from '../../src/store/store.js';

let store: Store;
let server: ApiServer | undefined;
let baseUrl: string;

beforeEach(async () => {
  store = new Store(':memory:');
  server = await startApiServer({ port: 0, store, apiToken: 'test-token' });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server?.close();
  store?.close();
});

describe('no human surface on the daemon origin', () => {
  it('GET / returns 404 JSON { error: no_human_surface }', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_human_surface' });
  });

  it('GET /assets/main.js is not a dashboard bundle', async () => {
    const res = await fetch(`${baseUrl}/assets/main.js`);
    expect(res.status).toBe(404);
  });
});
