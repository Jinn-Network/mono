import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('MockV3Aggregator', () => {
  it('initial constructor sets answer + round 1', async () => {
    const F = await ethers.getContractFactory('MockV3Aggregator');
    const m = await F.deploy(8, 340_000_000_000n);
    expect(await m.latestRound()).to.equal(1n);
    expect(await m.latestAnswer()).to.equal(340_000_000_000n);
    const [roundId, answer] = await m.latestRoundData();
    expect(roundId).to.equal(1n);
    expect(answer).to.equal(340_000_000_000n);
  });

  it('pushRound with strictly increasing roundId + explicit updatedAt', async () => {
    const F = await ethers.getContractFactory('MockV3Aggregator');
    const m = await F.deploy(8, 340_000_000_000n);
    await m.pushRound(5, 355_000_000_000n, 1_700_000_000);
    expect(await m.latestRound()).to.equal(5n);
    const [roundId, answer, , updatedAt] = await m.latestRoundData();
    expect(roundId).to.equal(5n);
    expect(answer).to.equal(355_000_000_000n);
    expect(updatedAt).to.equal(1_700_000_000n);
  });

  it('pushRound rejects non-increasing roundId', async () => {
    const F = await ethers.getContractFactory('MockV3Aggregator');
    const m = await F.deploy(8, 340_000_000_000n);
    await expect(m.pushRound(1, 355_000_000_000n, 1_700_000_000)).to.be.revertedWith('round must be strictly increasing');
  });
});
