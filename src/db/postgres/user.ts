import { queryPostgres } from './connection';

export interface User {
  id: string;
  username: string;
  email: string;
  is_active: boolean;
  budget_limit?: number;
  budget_used: number;
  rate_limit_rpm?: number;
  rate_limit_tpm?: number;
  created_at: Date;
  updated_at: Date;
}

// Mock data for users
const mockUsers: User[] = [
  {
    id: 'user_1',
    username: 'test_user_1',
    email: 'test1@example.com',
    is_active: true,
    budget_limit: 2000,
    budget_used: 150,
    rate_limit_rpm: 100,
    rate_limit_tpm: 20000,
    created_at: new Date(),
    updated_at: new Date(),
  },
  {
    id: 'user_2',
    username: 'test_user_2',
    email: 'test2@example.com',
    is_active: true,
    budget_limit: 1000,
    budget_used: 800,
    rate_limit_rpm: 50,
    rate_limit_tpm: 10000,
    created_at: new Date(),
    updated_at: new Date(),
  },
];

export async function getUserById(userId: string): Promise<User | null> {
  try {
    // TODO: Replace with actual database query
    // const users = await queryPostgres<User>(
    //   'SELECT * FROM users WHERE id = $1 AND is_active = true',
    //   [userId]
    // );

    // Mock implementation
    const user = mockUsers.find((u) => u.id === userId && u.is_active);
    return user || null;
  } catch (error) {
    console.error('Get user error:', error);
    return null;
  }
}
