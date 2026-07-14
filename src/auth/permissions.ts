export type UserRole = 'superadmin' | 'admin' | 'gerente' | 'operador' | 'visualizacao';

export interface UserPermissions {
  canViewDashboard: boolean;
  canManageProducts: boolean;
  canDeleteProducts: boolean;
  canManageStock: boolean;
  canManageRecipes: boolean;
  canViewReports: boolean;
  canManageUsers: boolean;
  canManageSettings: boolean;
}

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  companyId?: string;
  role: UserRole;
  permissions: UserPermissions;
  status: 'active' | 'inactive';
  createdAt: Date;
  updatedAt: Date;
}

export function mapAppUserRole(dbRole: string): UserRole {
  switch (dbRole) {
    case 'super_admin':
      return 'superadmin';
    case 'admin':
      return 'admin';
    case 'manager':
      return 'gerente';
    default:
      return 'operador';
  }
}

export function getPermissionsByRole(role: UserRole): UserPermissions {
  switch (role) {
    case 'superadmin':
    case 'admin':
      return {
        canViewDashboard: true,
        canManageProducts: true,
        canDeleteProducts: true,
        canManageStock: true,
        canManageRecipes: true,
        canViewReports: true,
        canManageUsers: true,
        canManageSettings: true,
      };
    case 'gerente':
      return {
        canViewDashboard: true,
        canManageProducts: true,
        canDeleteProducts: true,
        canManageStock: true,
        canManageRecipes: true,
        canViewReports: true,
        canManageUsers: false,
        canManageSettings: false,
      };
    default:
      return {
        canViewDashboard: true,
        canManageProducts: true,
        canDeleteProducts: false,
        canManageStock: false,
        canManageRecipes: false,
        canViewReports: false,
        canManageUsers: false,
        canManageSettings: false,
      };
  }
}
