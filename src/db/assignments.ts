/**
 * Поручения по зарегистрированным заявкам (ТЗ №7, №8; ТЗ раздел 5).
 *
 * Поручение создаётся в одной транзакции с регистрацией заявки и несёт все её
 * сведения: Заказчика, объект, состав услуг, исходные данные, приложения и
 * предварительную стоимость. ОКО отслеживает поручения и может поручить работу
 * по заявке другому подразделению; ОР ПСД принимает поручение в работу.
 * Обмен с HCL Notes ТЗ допускает заменить выгрузкой для ОКО.
 */

import type { Db } from './client.ts';
import * as repo from './repo.ts';
import { addWorkingDays, today } from '../domain/calendar.ts';
import type { Role, WorkCalendar } from '../domain/types.ts';

export type AssignmentRow = {
  id: string;
  request_id: string;
  request_number: string;
  kind: string;
  department: string;
  body: string;
  status: 'open' | 'in_progress' | 'done' | 'cancelled';
  due_at: string | null;
  payload: Record<string, unknown>;
  assignee_id: string | null;
  assignee_name: string | null;
  author_name: string | null;
  accepted_at: string | null;
  fulfilled_at: string | null;
  fulfilled_on_time: boolean | null;
  closed_at: string | null;
  close_note: string | null;
  created_at: string;
};

/** Подразделения, которым ОКО поручает работу по заявке, и их роли в системе. */
export const DEPARTMENTS: Record<string, Role> = {
  'ОР ПСД': 'orpsd',
  'Филиал': 'branch',
  'Документооборот': 'records',
  'Расчёты с контрагентами': 'accounting',
  'Технический учёт активов': 'assets',
};

const SELECT = `
  SELECT a.id, a.request_id, r.number AS request_number, a.kind, a.department, a.body, a.status,
         a.due_at::text AS due_at, a.payload, a.assignee_id, u.full_name AS assignee_name,
         au.full_name AS author_name, a.accepted_at, a.fulfilled_at, a.fulfilled_on_time,
         a.closed_at, a.close_note, a.created_at
    FROM assignments a
    JOIN requests r ON r.id = a.request_id
    LEFT JOIN users u ON u.id = a.assignee_id
    LEFT JOIN users au ON au.id = a.created_by`;

/**
 * Карточка поручения: все сведения заявки на момент регистрации (ТЗ №8).
 * Снимок хранится в поручении, чтобы ОКО видело то, что было поручено, даже
 * если заявку позже исправят по замечаниям.
 */
async function buildPayload(db: Db, requestId: string): Promise<Record<string, unknown>> {
  const request = await repo.getRequest(db, requestId);
  if (!request) throw new Error('Заявка не найдена');
  const services = await repo.listRequestServices(db, requestId);
  const counterparty = await db.one<Record<string, unknown>>(
    `SELECT name_full, bin, contact_person, phone, email FROM counterparties WHERE id = $1`,
    [request.counterpartyId]);
  return {
    number: request.number,
    registeredAt: request.registeredAt,
    customer: counterparty,
    facility: { id: request.facilityId, name: request.facilityName },
    branch: { id: request.branchId, name: request.branchName },
    services,
    estimate: request.totalAmount,
    freeOfCharge: request.freeOfCharge,
    attachments: await attachmentsOf(db, requestId),
  };
}

function attachmentsOf(db: Db, requestId: string) {
  return db.query<Record<string, unknown>>(
    `SELECT d.id, d.kind, d.number, v.file_name
       FROM documents d LEFT JOIN file_versions v ON v.document_id = d.id AND v.version = d.current_version
      WHERE d.request_id = $1 AND d.kind = 'Приложение' ORDER BY d.created_at`, [requestId]);
}

/**
 * Поручение ОР ПСД по зарегистрированной заявке. Срок — ответ о технической
 * возможности, не более 5 рабочих дней (п. 9). Повторная регистрация не
 * создаёт дубликат: одно поручение на заявку.
 */
export async function createForRequest(db: Db, requestId: string, calendar: WorkCalendar): Promise<string | null> {
  const payload = await buildPayload(db, requestId);
  const row = await db.one<{ id: string }>(
    `INSERT INTO assignments (request_id, kind, department, due_at, status, reference, payload, body, assignee_id)
     VALUES ($1, 'control', 'ОР ПСД', $2, 'open', 'п. 9', $3,
             'Рассмотреть заявку и дать ответ о технической возможности',
             -- Исполнитель поручения — ответственный ОР ПСД по заявке (src/db/executors.ts).
             (SELECT assignee_id FROM requests WHERE id = $1))
     ON CONFLICT (request_id) WHERE kind = 'control' DO NOTHING
     RETURNING id`,
    [requestId, addWorkingDays(today(), 5, calendar), JSON.stringify(payload)]);
  return row?.id ?? null;
}

/** Поручение ОКО подразделению по заявке (ТЗ, раздел 4). */
export async function createManual(db: Db, a: {
  requestId: string; department: string; assigneeId: string | null; dueAt: string; body: string; createdBy: string;
}): Promise<string> {
  const payload = await buildPayload(db, a.requestId);
  const row = await db.one<{ id: string }>(
    `INSERT INTO assignments (request_id, kind, department, assignee_id, due_at, status, reference, payload, body, created_by)
     VALUES ($1, 'manual', $2, $3, $4, 'open', 'ТЗ, раздел 4', $5, $6, $7) RETURNING id`,
    [a.requestId, a.department, a.assigneeId, a.dueAt, JSON.stringify(payload), a.body, a.createdBy]);
  return row!.id;
}

/** Перечень приложений в карточке поручения — после загрузки или удаления файла. */
export async function refreshPayload(db: Db, requestId: string): Promise<void> {
  const attachments = await attachmentsOf(db, requestId);
  await db.query(
    `UPDATE assignments SET payload = jsonb_set(payload, '{attachments}', $2::jsonb)
      WHERE request_id = $1 AND status IN ('open','in_progress')`,
    [requestId, JSON.stringify(attachments)]);
}

export type AssignmentFilter = {
  status?: string;
  limit?: number;
  /** Видимость для подразделения: поручения его подразделений либо назначенные сотруднику. */
  departments?: string[];
  assigneeId?: string;
};

export function listAssignments(db: Db, filter: AssignmentFilter = {}): Promise<AssignmentRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (filter.status === 'active') where.push(`a.status IN ('open','in_progress')`);
  else if (filter.status) { params.push(filter.status); where.push(`a.status = $${params.length}`); }
  if (filter.departments) {
    params.push(filter.departments);
    const byDept = `a.department = ANY($${params.length}::text[])`;
    if (filter.assigneeId) {
      params.push(filter.assigneeId);
      where.push(`(${byDept} OR a.assignee_id = $${params.length})`);
    } else {
      where.push(byDept);
    }
  }
  return db.query<AssignmentRow>(
    `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY a.created_at DESC LIMIT ${Math.min(filter.limit ?? 200, 1000)}`,
    params as never);
}

export function getAssignment(db: Db, id: string): Promise<AssignmentRow | null> {
  return db.one<AssignmentRow>(`${SELECT} WHERE a.id = $1`, [id]);
}

export function forRequest(db: Db, requestId: string): Promise<AssignmentRow[]> {
  return db.query<AssignmentRow>(`${SELECT} WHERE a.request_id = $1 ORDER BY a.created_at`, [requestId]);
}

export async function accept(db: Db, id: string, userId: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE assignments SET status = 'in_progress', accepted_at = now(), accepted_by = $2,
            assignee_id = coalesce(assignee_id, $2)
      WHERE id = $1 AND status = 'open' RETURNING id`, [id, userId]);
  return rows.length > 0;
}

export async function close(db: Db, id: string, userId: string | null, note: string, cancelled = false): Promise<boolean> {
  const rows = await db.query(
    `UPDATE assignments SET status = $4, closed_at = now(), closed_by = $2, close_note = $3
      WHERE id = $1 AND status IN ('open','in_progress') RETURNING id`,
    [id, userId, note, cancelled ? 'cancelled' : 'done']);
  return rows.length > 0;
}

/**
 * Отметка исполнения поручения ОР ПСД по существу: дан ответ о технической
 * возможности (п. 9). Поручение остаётся на контроле ОКО до закрытия, но видно,
 * исполнено ли оно в срок.
 */
export async function markFulfilled(db: Db, requestId: string, on: string): Promise<{ onTime: boolean } | null> {
  const row = await db.one<{ on_time: boolean }>(
    `UPDATE assignments SET fulfilled_at = now(), fulfilled_on_time = (due_at IS NULL OR $2::date <= due_at)
      WHERE request_id = $1 AND kind = 'control' AND fulfilled_at IS NULL
      RETURNING fulfilled_on_time AS on_time`, [requestId, on]);
  return row ? { onTime: row.on_time } : null;
}

/** Заявка закрыта — незакрытые поручения по ней закрываются автоматически. */
export async function closeForRequest(db: Db, requestId: string, note: string): Promise<number> {
  const rows = await db.query(
    `UPDATE assignments SET status = 'done', closed_at = now(), close_note = $2
      WHERE request_id = $1 AND status IN ('open','in_progress') RETURNING id`, [requestId, note]);
  return rows.length;
}
