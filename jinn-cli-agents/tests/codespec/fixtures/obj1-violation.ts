// Test fixture: obj1 violation (multiple error handling patterns)
// This file intentionally violates obj1 (Follow the Principle of Orthodoxy)

export class UserService {
  // VIOLATION: Mix of error handling patterns
  async getUser(id: string) {
    try {
      const user = await this.fetchUser(id);
      return user;
    } catch (error) {
      // Pattern 1: Just throw
      throw error;
    }
  }

  async updateUser(id: string, data: any) {
    try {
      const result = await this.saveUser(id, data);
      return result;
    } catch (error) {
      // Pattern 2: Log and throw
      console.error('Update failed:', error);
      throw error;
    }
  }

  async deleteUser(id: string) {
    try {
      await this.removeUser(id);
    } catch (error) {
      // Pattern 3: Log and return null
      console.error('Delete failed:', error);
      return null;
    }
  }

  async createUser(data: any) {
    try {
      return await this.insertUser(data);
    } catch (error) {
      // Pattern 4: Silent catch
      return undefined;
    }
  }

  // VIOLATION: Mix of null checking patterns
  validateEmail(email: string | null) {
    // Pattern 1: Explicit null check
    if (email === null) {
      return false;
    }
    return email.includes('@');
  }

  validatePhone(phone: string | null) {
    // Pattern 2: Truthy check
    if (!phone) {
      return false;
    }
    return phone.length === 10;
  }

  validateName(name: string | null | undefined) {
    // Pattern 3: Nullish coalescing
    const safeName = name ?? '';
    return safeName.length > 0;
  }

  // Dummy implementations
  private async fetchUser(id: string) { return { id }; }
  private async saveUser(id: string, data: any) { return { id, ...data }; }
  private async removeUser(id: string) { }
  private async insertUser(data: any) { return { id: '123', ...data }; }
}
