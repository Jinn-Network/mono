import { describe, it, expect } from 'vitest';
import { __TEST__ } from 'jinn-node/agent/mcp/tools/shared/ipfs.js';

describe('IPFS resolver helpers', () => {
  it('converts raw delivery CID to directory path with decimal request id', async () => {
    const rawCid = 'f01551220' + 'a'.repeat(64); // hex raw codec CID
    const candidates = __TEST__.buildCidCandidates(rawCid, { requestId: '0x1234' });

    expect(candidates.length).toBeGreaterThan(0);
    const path = candidates[0].cidPath;
    expect(path.endsWith('/4660')).toBe(true); // 0x1234 => 4660
    expect(path.startsWith('b')).toBe(true); // converted to dag-pb base32
  });

  it('recognizes base32 CIDv1 CIDs (bafy format)', async () => {
    const base32Cid = 'bafybeihxvdwy372n7cwfzh42kuw7uajb2sa47nvlmbth73i4mfjfxjl3uq';
    const candidates = __TEST__.buildCidCandidates(base32Cid);

    expect(candidates).toEqual([
      { cidPath: base32Cid, context: base32Cid },
    ]);
  });

  it('recognizes base32 CIDv1 CIDs (bafkre format)', async () => {
    const base32Cid = 'bafkreihxvdwy372n7cwfzh42kuw7uajb2sa47nvlmbth73i4mfjfxjl3uq';
    const candidates = __TEST__.buildCidCandidates(base32Cid);

    expect(candidates).toEqual([
      { cidPath: base32Cid, context: base32Cid },
    ]);
  });
});

