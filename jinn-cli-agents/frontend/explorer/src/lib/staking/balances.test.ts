import { describe, expect, it } from 'vitest'
import { getEthFundingLevel } from './balances'

describe('staking balance thresholds', () => {
  it('marks healthy when ETH is at or above target', () => {
    expect(getEthFundingLevel(BigInt('2000000000000000'))).toBe('healthy')
    expect(getEthFundingLevel(BigInt('3500000000000000'))).toBe('healthy')
  })

  it('marks warning when ETH is between threshold and target', () => {
    expect(getEthFundingLevel(BigInt('1000000000000000'))).toBe('warning')
    expect(getEthFundingLevel(BigInt('1500000000000000'))).toBe('warning')
  })

  it('marks critical when ETH is below threshold', () => {
    expect(getEthFundingLevel(BigInt('999999999999999'))).toBe('critical')
    expect(getEthFundingLevel(BigInt(0))).toBe('critical')
  })
})
