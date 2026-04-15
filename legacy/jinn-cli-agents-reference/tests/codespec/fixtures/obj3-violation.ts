// Test fixture: obj3 violation (security issues)
// This file intentionally violates obj3 (Minimize Harm)

import { ethers } from 'ethers';

export class WalletManager {
  // VIOLATION: Unsafe private key handling
  async createWallet(privateKey: string) {
    // Should validate and sanitize, but doesn't
    const wallet = new ethers.Wallet(privateKey);

    // VIOLATION: Logging sensitive data
    console.log('Created wallet with key:', privateKey);

    return wallet;
  }

  // VIOLATION: Missing validation before financial operation
  async transferFunds(to: string, amount: string, wallet: ethers.Wallet) {
    // No validation of 'to' address format
    // No validation of amount
    // No balance check

    const tx = await wallet.sendTransaction({
      to,
      value: ethers.parseEther(amount),
    });

    return tx;
  }

  // VIOLATION: Fail-open pattern (returns success on error)
  async verifyTransaction(txHash: string): Promise<boolean> {
    try {
      const tx = await this.fetchTransaction(txHash);
      return tx.status === 'success';
    } catch (error) {
      // VIOLATION: Fail-open - returns true on error
      return true;
    }
  }

  // VIOLATION: Silent error in financial context
  async executeSwap(tokenA: string, tokenB: string, amount: bigint) {
    try {
      const result = await this.performSwap(tokenA, tokenB, amount);
      return result;
    } catch (error) {
      // VIOLATION: Silently discards error in financial operation
      return null;
    }
  }

  // Dummy implementations
  private async fetchTransaction(hash: string) {
    return { status: 'success' };
  }

  private async performSwap(tokenA: string, tokenB: string, amount: bigint) {
    return { success: true };
  }
}
