/**
 * Роли и права.
 *
 * Ролевая модель воспроизводит разграничение полномочий Регламента и ТЗ:
 * система не даёт роли выполнить действие, которое Регламент закрепляет за
 * другим подразделением. Право на изменение мастер-файла — только у СП ЦА,
 * ответственного за технический учёт активов (п. 12); визирование и
 * утверждение остаются за уполномоченными лицами.
 *
 * Принцип по умолчанию: запрещено всё, что явно не разрешено.
 */

import type { Role } from '../domain/types.ts';
import { ApiError } from './errors.ts';

export type Actor = {
  id: string;
  userId: string;
  email: string;
  fullName: string;
  roles: Role[];
  branchId: string | null;
  counterpartyId: string | null;
  isActive: boolean;
};

export type Permission =
  | 'request.view'          // просмотр заявок
  | 'request.create'        // подача заявки
  | 'request.edit'          // правка до регистрации и при возврате на доработку
  | 'request.register'      // регистрация делопроизводством (п. 6)
  | 'request.transition'    // переходы по этапам
  | 'request.remark'        // возврат на доработку с замечаниями (ТЗ №11)
  | 'request.tv'            // фиксация оценки ТВ (раздел 4)
  | 'documents.view'        // архив актов
  | 'documents.upload'
  | 'documents.approve'     // визирование
  | 'registry.view'         // мастер-файл «Реестр АМС и загрузки»
  | 'registry.edit'         // только технический учёт активов (п. 12)
  | 'metrics.view'          // показатели и узкие места
  | 'admin';                // справочники, роли, правила, аудит

const MATRIX: Record<Role, Permission[]> = {
  admin: [
    'request.view', 'request.create', 'request.edit', 'request.register', 'request.transition',
    'request.remark', 'request.tv', 'documents.view', 'documents.upload', 'documents.approve',
    'registry.view', 'registry.edit', 'metrics.view', 'admin',
  ],
  // Право на переход даётся ролям, которые названы хотя бы в одном переходе
  // (см. TRANSITIONS). Какие именно переходы доступны, решает проверка ролей
  // на самом переходе: документооборот направляет заявку в ОР ПСД и филиал
  // (п. 6), филиал ведёт СМР (пп. 59, 66), бухгалтерия — АВР и ЭСФ (пп. 91–95).
  records: ['request.view', 'request.register', 'request.edit', 'request.transition', 'registry.view'],
  orpsd: [
    'request.view', 'request.create', 'request.edit', 'request.transition', 'request.remark',
    'request.tv', 'documents.view', 'documents.upload', 'documents.approve', 'registry.view',
    'metrics.view',
  ],
  branch: ['request.view', 'request.transition', 'documents.view', 'documents.upload', 'registry.view'],
  oko: ['request.view', 'metrics.view'],
  assets: ['documents.view', 'registry.view', 'registry.edit'],
  accounting: ['request.view', 'request.transition', 'documents.view', 'metrics.view'],
  management: ['request.view', 'documents.view', 'registry.view', 'metrics.view'],
  customer: ['request.view', 'request.create', 'request.edit', 'request.transition'],
};

export function permissionsOf(roles: Role[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const role of roles) for (const p of MATRIX[role] ?? []) out.add(p);
  return out;
}

export function can(actor: Actor, permission: Permission): boolean {
  if (!actor.isActive) return false;
  return permissionsOf(actor.roles).has(permission);
}

export function require(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) throw ApiError.forbidden();
}

export const isCustomer = (actor: Actor): boolean =>
  actor.roles.length > 0 && actor.roles.every((r) => r === 'customer');

/**
 * Область видимости заявок.
 * Заказчик видит только свои; филиал — заявки по объектам своего филиала
 * (п. 6.2 — заявка направляется в филиал для сведения); остальные — все
 * в пределах своих прав.
 */
export function requestScope(actor: Actor): { kind: 'all' } | { kind: 'counterparty'; id: string } | { kind: 'branch'; id: string } | { kind: 'none' } {
  if (actor.roles.includes('admin')) return { kind: 'all' };
  if (isCustomer(actor)) {
    return actor.counterpartyId ? { kind: 'counterparty', id: actor.counterpartyId } : { kind: 'none' };
  }
  if (actor.roles.includes('branch') && !actor.roles.some((r) => ['orpsd', 'oko', 'records', 'accounting', 'management'].includes(r))) {
    return actor.branchId ? { kind: 'branch', id: actor.branchId } : { kind: 'none' };
  }
  if (!can(actor, 'request.view')) return { kind: 'none' };
  return { kind: 'all' };
}
