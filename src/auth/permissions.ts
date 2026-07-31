export type UserRole = 'superadmin' | 'admin' | 'gerente' | 'operador' | 'visualizacao';

export interface UserPermissions {
  canViewDashboard: boolean;
  canManageProducts: boolean;
  canDeleteProducts: boolean;
  canManageStock: boolean;
  canManageRecipes: boolean;
  canViewReports: boolean;
  canManageUsers: boolean;
  /** Configurações da empresa / integrações / fiscal — só admin e superadmin. */
  canManageSettings: boolean;
  /** PDV: abrir/fechar caixa, vender, sangria e suprimento. */
  canAccessCashier: boolean;
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

/** Aceita role do banco (`super_admin`) e já mapeada no KV/sessão (`superadmin`). */
export function mapAppUserRole(dbRole: string): UserRole {
  switch (String(dbRole || '').trim().toLowerCase()) {
    case 'super_admin':
    case 'superadmin':
      return 'superadmin';
    case 'admin':
      return 'admin';
    case 'manager':
    case 'gerente':
      return 'gerente';
    case 'visualizacao':
    case 'viewer':
      return 'visualizacao';
    case 'operador':
    case 'operador_pdv':
    case 'caixa':
    case 'user':
    case 'operator':
      return 'operador';
    default:
      return 'operador';
  }
}

/**
 * Matriz de perfis:
 * - superadmin / admin: tudo (inclui configurações e usuários)
 * - gerente: operação + relatórios; sem usuários e sem configurações
 * - operador: somente PDV (abrir/fechar caixa, vendas, sangria, troco)
 * - visualizacao: dashboard e relatórios (somente leitura)
 */
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
        canAccessCashier: true,
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
        canAccessCashier: true,
      };
    case 'operador':
      return {
        canViewDashboard: false,
        canManageProducts: false,
        canDeleteProducts: false,
        canManageStock: false,
        canManageRecipes: false,
        canViewReports: false,
        canManageUsers: false,
        canManageSettings: false,
        canAccessCashier: true,
      };
    case 'visualizacao':
      return {
        canViewDashboard: true,
        canManageProducts: false,
        canDeleteProducts: false,
        canManageStock: false,
        canManageRecipes: false,
        canViewReports: true,
        canManageUsers: false,
        canManageSettings: false,
        canAccessCashier: false,
      };
    default:
      return {
        canViewDashboard: false,
        canManageProducts: false,
        canDeleteProducts: false,
        canManageStock: false,
        canManageRecipes: false,
        canViewReports: false,
        canManageUsers: false,
        canManageSettings: false,
        canAccessCashier: true,
      };
  }
}
