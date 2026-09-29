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
import { EXTERNAL_ROLES } from '../domain/types.ts';
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
  | 'request.contract'      // договоры по услугам, оплата, реквизиты закрытия (пп. 21, 83–95)
  | 'request.extend'        // продление срока этапа с основанием (пп. 33, 45)
  | 'request.attach'        // приложения к заявке (п. 7.6)
  | 'assignment.view'       // поручения по зарегистрированным заявкам (ТЗ №7, №8)
  | 'assignment.accept'     // принятие поручения в работу — ОР ПСД
  | 'assignment.close'      // контроль и закрытие поручения — ОКО
  | 'memo.create'           // служебная записка в филиал (п. 10)
  | 'memo.answer'           // ответ филиала на служебную записку (п. 10)
  | 'reports.view'          // отчёты по заявкам и сводные отчёты (ТЗ №15, пп. 105, 109)
  | 'reports.branch'        // ежемесячный отчёт своего филиала (п. 105)
  | 'documents.view'        // архив актов: поиск, карточка, просмотр PDF и изображений в браузере
  | 'documents.download'    // скачивание файла на своё устройство (ТЗ, уровни прав архива)
  | 'documents.upload'
  | 'documents.approve'     // визирование
  | 'registry.view'         // мастер-файл «Реестр АМС и загрузки»
  | 'registry.edit'         // только технический учёт активов (п. 12)
  | 'registry.request'      // запрос изменения реестра в технический учёт (п. 12)
  | 'counterparty.verify'   // проверка реквизитов контрагента, заведённого по заявке
  | 'metrics.view'          // показатели и узкие места
  | 'permit.own'            // портал допусков: заявки, работники и бригады своей организации
  | 'permit.view'           // портал допусков: все заявки и отчёт
  | 'permit.review'         // портал допусков: одобрение с файлом допуска, отказ, подтверждение основания
  | 'admin';                // справочники, роли, правила, аудит

const MATRIX: Record<Role, Permission[]> = {
  admin: [
    'request.view', 'request.create', 'request.edit', 'request.register', 'request.transition',
    'request.remark', 'request.tv', 'request.contract', 'request.extend', 'request.attach',
    'assignment.view', 'assignment.accept', 'assignment.close', 'memo.create', 'memo.answer',
    'reports.view', 'reports.branch',
    'documents.view', 'documents.download', 'documents.upload', 'documents.approve',
    'registry.view', 'registry.edit', 'registry.request', 'counterparty.verify', 'metrics.view',
    'permit.view', 'permit.review', 'admin',
  ],
  // Право на переход даётся ролям, которые названы хотя бы в одном переходе
  // (см. TRANSITIONS). Какие именно переходы доступны, решает проверка ролей
  // на самом переходе: документооборот направляет заявку в ОР ПСД и филиал
  // (п. 6), филиал ведёт СМР (пп. 59, 66), бухгалтерия — АВР и ЭСФ (пп. 91–95).
  // Пункт 6: заявки поступают в СП ЦА, ответственное за документооборот, в том
  // числе на бумаге и по почте. Значит это подразделение их и вносит в систему.
  records: ['request.view', 'request.create', 'request.register', 'request.edit',
    'request.transition', 'request.attach', 'registry.view', 'counterparty.verify',
    'assignment.view', 'assignment.accept'],
  orpsd: [
    'request.view', 'request.create', 'request.edit', 'request.transition', 'request.remark',
    'request.tv', 'request.contract', 'request.extend', 'request.attach', 'assignment.view', 'assignment.accept',
    'memo.create', 'reports.view', 'documents.view', 'documents.download', 'documents.upload', 'documents.approve', 'registry.view',
    'registry.request', 'counterparty.verify', 'metrics.view',
  ],
  branch: ['request.view', 'request.transition', 'memo.answer', 'reports.branch', 'documents.view', 'documents.download',
    'documents.upload', 'registry.view', 'registry.request', 'assignment.view', 'assignment.accept'],
  // ОКО: отслеживание зарегистрированных заявок и поручений (ТЗ, раздел 4).
  oko: ['request.view', 'assignment.view', 'assignment.close', 'reports.view', 'metrics.view', 'permit.view'],
  assets: ['documents.view', 'documents.download', 'registry.view', 'registry.edit', 'assignment.view', 'assignment.accept'],
  // Расчёты с контрагентами: счёт, оплата, АВР и ЭСФ (пп. 84–85, 91).
  accounting: ['request.view', 'request.transition', 'request.contract', 'documents.view', 'documents.download',
    'reports.view', 'metrics.view', 'assignment.view', 'assignment.accept'],
  management: ['request.view', 'assignment.view', 'reports.view', 'documents.view', 'registry.view', 'metrics.view',
    'permit.view'],
  customer: ['request.view', 'request.create', 'request.edit', 'request.transition', 'request.attach'],
  // Портал допусков СУА (План модуля допусков, §3). Подрядчик — только своя организация;
  // специалист СУА рассматривает заявки и смотрит архив актов, как в ТЗ портала §1.3.
  contractor: ['permit.own'],
  permits: ['permit.view', 'permit.review', 'documents.view', 'documents.download'],
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

/** Все роли внешние: представитель сторонней организации, а не сотрудник Общества. */
export const isExternal = (actor: Actor): boolean =>
  actor.roles.length > 0 && actor.roles.every((r) => EXTERNAL_ROLES.includes(r));

/**
 * Представитель Заказчика в модуле ОР ПСД. Внешняя роль с другими не
 * совмещается (users.ts, миграция 008), но и при ошибке в данных внешний
 * пользователь не становится сотрудником и не получает доступ ко всем заявкам.
 */
export const isCustomer = (actor: Actor): boolean =>
  actor.roles.includes('customer') && isExternal(actor);

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
