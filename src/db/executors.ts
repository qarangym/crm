/**
 * Исполнители заявки: у каждой карточки на доске — конкретный человек.
 *
 * Пункт 102 Регламента: ответственные лица несут персональную ответственность
 * за прохождение контрольных точек. Поэтому у заявки нет состояния «ничья»:
 *
 *  - ответственный ОР ПСД (`requests.assignee_id`) — ведёт заявку от подачи до
 *    закрытия: ОР ПСД рассматривает заявку, готовит КП и договоры, контролирует
 *    оплату, оборудование и приёмку (пп. 9, 21, 56, 88, 93);
 *  - исполнитель этапа (`request_stages.assignee_id`) — кто действует сейчас:
 *    канцелярия регистрирует (п. 6), филиал выполняет СМР (п. 59), расчёты с
 *    контрагентами оформляют АВР (п. 91). На этапах ОР ПСД и на этапах Заказчика
 *    это ответственный ОР ПСД: срок Заказчика контролирует он.
 *
 * Если конкретного человека не выбрали, назначается наименее загруженный
 * сотрудник нужного подразделения (для филиала — своего филиала; если в
 * филиале нет пользователей системы — главный инженер области, затем
 * курирующий заместитель директора по Приложению 7). Руководитель или сам
 * сотрудник переназначает карточку — с записью в журнал.
 */

import type { Db } from './client.ts';
import type { OwnerParty, Role } from '../domain/types.ts';

/** Чья роль исполняет этап. На этапах Заказчика срок контролирует ОР ПСД. */
export const EXECUTOR_ROLE: Record<OwnerParty, Role> = {
  records: 'records',
  orpsd: 'orpsd',
  branch: 'branch',
  accounting: 'accounting',
  customer: 'orpsd',
};

export type Person = { id: string; name: string; email: string };

/** Нагрузка — открытые заявки, где сотрудник ответственный или исполнитель текущего этапа. */
const LOAD = `(
  SELECT count(*) FROM requests q
   WHERE q.closed_at IS NULL AND q.stage_code <> 'draft'
     AND (q.assignee_id = u.id OR EXISTS (SELECT 1 FROM request_stages s
           WHERE s.request_id = q.id AND s.left_at IS NULL AND s.assignee_id = u.id)))`;

/** Сотрудники, которые могут исполнять этап роли (филиал — только свой). */
export function candidates(db: Db, role: Role, branchId: string | null) {
  return db.query<{ id: string; name: string; email: string; load: number }>(
    `SELECT u.id, u.full_name AS name, u.email, ${LOAD}::int AS load
       FROM users u JOIN user_roles r ON r.user_id = u.id
      WHERE u.is_active AND r.role = $1
        AND ($1 <> 'branch' OR u.branch_id = $2::uuid)
      ORDER BY load, u.full_name`, [role, branchId]);
}

/** Может ли сотрудник исполнять этап этой роли. */
export async function eligible(db: Db, userId: string, role: Role, branchId: string | null): Promise<Person | null> {
  return db.one<Person>(
    `SELECT u.id, u.full_name AS name, u.email
       FROM users u JOIN user_roles r ON r.user_id = u.id
      WHERE u.id = $1 AND u.is_active AND r.role = $2
        AND ($2 <> 'branch' OR u.branch_id = $3::uuid)`, [userId, role, branchId]);
}

async function person(db: Db, id: string | null): Promise<Person | null> {
  if (!id) return null;
  return db.one<Person>(
    `SELECT id, full_name AS name, email FROM users WHERE id = $1 AND is_active`, [id]);
}

/** Филиал без пользователей системы: главный инженер области, затем куратор (п. 99.1, Прил. 7). */
async function branchFallback(db: Db, branchId: string | null): Promise<Person | null> {
  if (!branchId) return null;
  return db.one<Person>(
    `SELECT u.id, u.full_name AS name, u.email
       FROM branches b JOIN users u ON u.id = coalesce(
         (SELECT x.id FROM users x WHERE x.id = b.chief_engineer_id AND x.is_active),
         (SELECT x.id FROM users x WHERE x.id = b.curator_id AND x.is_active))
      WHERE b.id = $1`, [branchId]);
}

export type OpenCard = {
  requestId: string;
  number: string;
  branchId: string | null;
  closed: boolean;
  stageCode: string;
  responsibleId: string | null;
  stageRecordId: string | null;
  ownerParty: OwnerParty | null;
  stageExecutorId: string | null;
};

async function card(db: Db, requestId: string): Promise<OpenCard | null> {
  const row = await db.one<Record<string, any>>(
    `SELECT r.id, r.number, r.branch_id, r.closed_at, r.stage_code, r.assignee_id,
            s.id AS stage_id, s.owner_party, s.assignee_id AS stage_assignee
       FROM requests r
       LEFT JOIN LATERAL (
         SELECT id, owner_party, assignee_id FROM request_stages
          WHERE request_id = r.id AND left_at IS NULL ORDER BY entered_at DESC LIMIT 1
       ) s ON true
      WHERE r.id = $1`, [requestId]);
  if (!row) return null;
  return {
    requestId: row.id, number: row.number, branchId: row.branch_id, closed: !!row.closed_at,
    stageCode: row.stage_code, responsibleId: row.assignee_id, stageRecordId: row.stage_id,
    ownerParty: row.owner_party, stageExecutorId: row.stage_assignee,
  };
}

export type Assignment = {
  kind: 'responsible' | 'stage';
  from: string | null;
  to: Person | null;
};

/**
 * Назначает недостающих исполнителей: ответственного ОР ПСД и исполнителя
 * открытого этапа. Уже назначенный действующий сотрудник не меняется.
 * Сотрудник, чья учётная запись отключена, заменяется — карточка не должна
 * «висеть» на уволенном или отсутствующем.
 * Черновик Заказчика и закрытая заявка исполнителей не получают.
 * Возвращает, кто назначен; `to: null` — назначить некого (нет сотрудников роли).
 */
export async function ensureExecutors(db: Db, requestId: string): Promise<Assignment[]> {
  const c = await card(db, requestId);
  if (!c || c.closed || c.stageCode === 'draft') return [];
  const changes: Assignment[] = [];

  let responsible = await person(db, c.responsibleId);
  if (!responsible) {
    responsible = (await candidates(db, 'orpsd', null))[0] ?? null;
    if (responsible) await db.query('UPDATE requests SET assignee_id = $2 WHERE id = $1', [c.requestId, responsible.id]);
    await syncControlAssignment(db, c.requestId, responsible?.id ?? null);
    changes.push({ kind: 'responsible', from: c.responsibleId, to: responsible });
  }

  if (c.stageRecordId && c.ownerParty) {
    const current = await person(db, c.stageExecutorId);
    const role = EXECUTOR_ROLE[c.ownerParty];
    // Этапы ОР ПСД и Заказчика ведёт ответственный ОР ПСД: он и исполнитель этапа.
    const stillValid = current && (role === 'orpsd'
      ? current.id === responsible?.id || !!await eligible(db, current.id, 'orpsd', null)
      : !!await eligible(db, current.id, role, c.branchId) ||
        (role === 'branch' && current.id === (await branchFallback(db, c.branchId))?.id));
    if (!stillValid) {
      const next = role === 'orpsd' ? responsible
        : (await candidates(db, role, c.branchId))[0] ?? (role === 'branch' ? await branchFallback(db, c.branchId) : null);
      if (next) await db.query('UPDATE request_stages SET assignee_id = $2 WHERE id = $1', [c.stageRecordId, next.id]);
      changes.push({ kind: 'stage', from: c.stageExecutorId, to: next ?? null });
    }
  }
  return changes;
}

/** Ответственный ОР ПСД — исполнитель поручения ОР ПСД по заявке (ТЗ №7). */
async function syncControlAssignment(db: Db, requestId: string, userId: string | null): Promise<void> {
  await db.query(
    `UPDATE assignments SET assignee_id = $2
      WHERE request_id = $1 AND kind = 'control' AND status IN ('open', 'in_progress')`, [requestId, userId]);
}

/** Смена ответственного ОР ПСД. Этапы, которые он ведёт, переходят вместе с ним. */
export async function setResponsible(db: Db, requestId: string, userId: string): Promise<void> {
  const c = await card(db, requestId);
  if (!c) return;
  await db.query('UPDATE requests SET assignee_id = $2 WHERE id = $1', [requestId, userId]);
  if (c.stageRecordId && c.ownerParty && EXECUTOR_ROLE[c.ownerParty] === 'orpsd' &&
      (!c.stageExecutorId || c.stageExecutorId === c.responsibleId)) {
    await db.query('UPDATE request_stages SET assignee_id = $2 WHERE id = $1', [c.stageRecordId, userId]);
  }
  await syncControlAssignment(db, requestId, userId);
}

export async function setStageExecutor(db: Db, requestId: string, userId: string): Promise<void> {
  await db.query(
    `UPDATE request_stages SET assignee_id = $2 WHERE request_id = $1 AND left_at IS NULL`, [requestId, userId]);
}

/** Сведения для карточки: кто сейчас, кому можно передать. */
export async function executorsOf(db: Db, requestId: string) {
  const c = await card(db, requestId);
  if (!c) return null;
  const role = c.ownerParty ? EXECUTOR_ROLE[c.ownerParty] : null;
  return {
    responsible: await person(db, c.responsibleId),
    stage: await person(db, c.stageExecutorId),
    stageRole: role,
    ownerParty: c.ownerParty,
    responsibleCandidates: c.closed ? [] : await candidates(db, 'orpsd', null),
    stageCandidates: c.closed || !role || c.stageCode === 'draft' ? [] : await candidates(db, role, c.branchId),
    card: c,
  };
}

/** Открытые заявки без исполнителя или с отключённым исполнителем — для ежедневной проверки. */
export function needingExecutors(db: Db) {
  return db.query<{ id: string; number: string }>(
    `SELECT r.id, r.number
       FROM requests r
       LEFT JOIN users ru ON ru.id = r.assignee_id AND ru.is_active
       LEFT JOIN LATERAL (
         SELECT s.assignee_id FROM request_stages s
          WHERE s.request_id = r.id AND s.left_at IS NULL ORDER BY s.entered_at DESC LIMIT 1
       ) s ON true
       LEFT JOIN users su ON su.id = s.assignee_id AND su.is_active
      WHERE r.closed_at IS NULL AND r.stage_code <> 'draft'
        AND (ru.id IS NULL OR su.id IS NULL)
      ORDER BY r.created_at`);
}
