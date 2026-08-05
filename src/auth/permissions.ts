export type UserRole = 'superadmin' | 'admin' | 'gerente' | 'operador' | 'visualizacao';

export type PermissionFlag = keyof UserPermissions;

export interface UserPermissions {
  canViewDashboard: boolean;
  canManageProducts: boolean;
  canDeleteProducts: boolean;
  canManageStock: boolean;
  canManageRecipes: boolean;
  canViewReports: boolean;
  /** Despesas / centros / tipos / contas a receber (escrita). */
  canManageCosts: boolean;
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

/** Aceita role do banco (`super_admin`, `viewer`) e já mapeada no KV/sessão (`superadmin`). */
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

/** Alias semântico: DB → app. */
export function mapDbRoleToApp(role: string): UserRole {
  return mapAppUserRole(role);
}

/** App → valor persistido em app_users.role (CHECK do banco). */
export function mapAppRoleToDb(role: string): string {
  switch (mapAppUserRole(role)) {
    case 'superadmin':
      return 'super_admin';
    case 'admin':
      return 'admin';
    case 'gerente':
      return 'manager';
    case 'visualizacao':
      return 'viewer';
    case 'operador':
    default:
      return 'user';
  }
}

/** Rank para hierarquia de gestão de usuários. */
export function getRoleRank(role: string): number {
  switch (mapAppUserRole(role)) {
    case 'superadmin':
      return 5;
    case 'admin':
      return 4;
    case 'gerente':
      return 3;
    case 'operador':
      return 2;
    case 'visualizacao':
      return 1;
    default:
      return 0;
  }
}

/**
 * Actor pode atribuir `role` se rank(role) < rank(actor).
 * Superadmin pode atribuir qualquer perfil (incluindo outro superadmin).
 */
export function canAssignRole(actorRole: string, targetRole: string): boolean {
  const actor = mapAppUserRole(actorRole);
  const target = mapAppUserRole(targetRole);
  if (actor === 'superadmin') return true;
  return getRoleRank(actor) > getRoleRank(target);
}

/**
 * Actor pode gerir o usuário-alvo (editar/desativar/reset).
 * Superadmin gerencia qualquer um; demais precisam rank estritamente maior.
 */
export function canManageTargetUser(actorRole: string, targetRole: string): boolean {
  const actor = mapAppUserRole(actorRole);
  const target = mapAppUserRole(targetRole);
  if (actor === 'superadmin') return true;
  return getRoleRank(actor) > getRoleRank(target);
}

/** Roles que o actor pode oferecer no formulário de usuários. */
export function assignableRolesFor(actorRole: string): UserRole[] {
  const all: UserRole[] = ['superadmin', 'admin', 'gerente', 'operador', 'visualizacao'];
  return all.filter((r) => canAssignRole(actorRole, r));
}

/**
 * Matriz de perfis:
 * - superadmin / admin: tudo (inclui configurações e usuários)
 * - gerente: operação + relatórios + custos; sem usuários e sem configurações
 * - operador: somente PDV
 * - visualizacao: dashboard e relatórios (somente leitura; sem escrita em custos)
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
        canManageCosts: true,
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
        canManageCosts: true,
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
        canManageCosts: false,
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
        canManageCosts: false,
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
        canManageCosts: false,
        canManageUsers: false,
        canManageSettings: false,
        canAccessCashier: true,
      };
  }
}
