import type { UserPermissions } from '../auth/permissions.js';

export interface AuthContext {
  userId: string;
  email: string;
  fullName: string;
  role: string;
  companyId?: string;
  permissions?: UserPermissions;
}
