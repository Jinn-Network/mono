import { describe, it, expect } from 'vitest';
import { withTestEnv, getEnvSnapshot } from '../helpers/env-controller.js';

describe('env-controller integration', () => {
  it('loads env and exposes snapshot', async () => {
    await withTestEnv(async (snapshot) => {
      expect(snapshot.runtimeEnvironment).toBe('test');
      expect(process.env.OPERATE_PROFILE_DIR).toBe(snapshot.operateProfileDir);
      const cached = getEnvSnapshot();
      expect(cached.operateProfileDir).toBe(snapshot.operateProfileDir);
    });
  });
});
