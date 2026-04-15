// @ts-nocheck
// Test fixture: Clean file (no violations)
// This file follows all CodeSpec rules and objectives

import { logger } from '../../../shared/logger';

export class CleanService {
  /**
   * Fetches user data by ID
   * Follows canonical error handling pattern: log + throw
   */
  async getUser(id: string) {
    try {
      const user = await this.fetchUser(id);
      return user;
    } catch (error) {
      logger.error('Failed to fetch user', { id, error });
      throw error;
    }
  }

  /**
   * Updates user data
   * Follows canonical error handling pattern: log + throw
   */
  async updateUser(id: string, data: Record<string, unknown>) {
    try {
      const result = await this.saveUser(id, data);
      return result;
    } catch (error) {
      logger.error('Failed to update user', { id, error });
      throw error;
    }
  }

  /**
   * Validates email using consistent null checking pattern
   * Uses explicit null/undefined checks (canonical pattern)
   */
  validateEmail(email: string | null | undefined): boolean {
    if (email === null || email === undefined) {
      return false;
    }
    return email.includes('@');
  }

  /**
   * Validates phone number using consistent null checking pattern
   * Uses explicit null/undefined checks (canonical pattern)
   */
  validatePhone(phone: string | null | undefined): boolean {
    if (phone === null || phone === undefined) {
      return false;
    }
    return phone.length === 10;
  }

  // Private helpers
  private async fetchUser(id: string) {
    return { id, name: 'Test User' };
  }

  private async saveUser(id: string, data: Record<string, unknown>) {
    return { id, ...data };
  }
}
