import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  marketplaceTaskSelectionSidecarPath,
  readMarketplaceTaskSelection,
  writeMarketplaceTaskSelection,
} from '../../src/tasks/submit-selection.js';

describe('marketplace Task selection sidecar', () => {
  it('atomically freezes and reloads a request-bound manifest selection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-selection-'));
    const requestPath = join(dir, 'request.json');
    const request = { schemaVersion: 'jinn-task-submit-request.v1', id: 'autopilot:one' };
    writeFileSync(requestPath, JSON.stringify(request));

    expect(readMarketplaceTaskSelection({ requestPath, request })).toBeNull();
    writeMarketplaceTaskSelection({
      requestPath,
      request,
      solverNetManifestCid: 'bafy-frozen',
      solverNetName: 'Autopilot production',
    });
    expect(readMarketplaceTaskSelection({ requestPath, request })).toMatchObject({
      schemaVersion: 'jinn-task-submit-selection.v1',
      solverNetManifestCid: 'bafy-frozen',
      solverNetName: 'Autopilot production',
    });
    expect(existsSync(marketplaceTaskSelectionSidecarPath(requestPath))).toBe(true);
  });

  it('fails closed when canonical request content changes or a writer races with a different selection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-selection-'));
    const requestPath = join(dir, 'request.json');
    const request = { schemaVersion: 'jinn-task-submit-request.v1', id: 'autopilot:one' };
    writeFileSync(requestPath, JSON.stringify(request));
    writeMarketplaceTaskSelection({
      requestPath,
      request,
      solverNetManifestCid: 'bafy-frozen',
    });

    expect(() => readMarketplaceTaskSelection({
      requestPath,
      request: { ...request, id: 'autopilot:changed' },
    })).toThrow(/request digest/i);
    expect(() => writeMarketplaceTaskSelection({
      requestPath,
      request,
      solverNetManifestCid: 'bafy-different',
    })).toThrow(/different SolverNet selection/i);
  });

  it('rejects a sidecar selection that contradicts the request-bound explicit CID', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-selection-'));
    const requestPath = join(dir, 'request.json');
    const request = {
      schemaVersion: 'jinn-task-submit-request.v1',
      id: 'autopilot:one',
      solverNetManifestCid: 'bafy-explicit',
    };
    writeFileSync(requestPath, JSON.stringify(request));
    expect(() => writeMarketplaceTaskSelection({
      requestPath,
      request,
      solverNetManifestCid: 'bafy-contradiction',
    })).toThrow(/contradicts/i);
  });
});
