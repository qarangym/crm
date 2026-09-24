/**
 * Поручения по зарегистрированным заявкам (ТЗ №7, №8; ТЗ раздел 5).
 *
 * Поручение создаётся в одной транзакции с регистрацией заявки и несёт все её
 * сведения: Заказчика, объект, состав услуг, исходные данные, приложения и
 * предварительную стоимость. ОКО отслеживает поручения; ОР ПСД принимает их в
 * работу. Обмен с HCL Notes ТЗ допускает заменить выгрузкой для ОКО.
 */

import type { Db } from './client.ts';
import * as repo from './repo.ts';
import { addWorkingDays, today } from '../domain/calendar.ts';
import type { WorkCalendar } from '../domain/types.ts';

export type AssignmentRow = {
  id: string;
  request_id: string;
  request_number: string;
  kind: string;
  department: string;
  status: 'open' | 'in_progress' | 'done' | 'cancelled';
  due_at: string | null;
  payload: Record<string, unknown>;
  assignee_name: string | null;
  accepted_at: string | null;
  closed_at: string | null;
  close_note: string | null;
  created_at: string;
};

const SELECT = `
  SELECT a.id, a.request_id, r.number AS request_number, a.kind, a.department, a.status,
         a.due_at::text AS due_at, a.payload, u.full_name AS assignee_name,
         a.accepted_at, a.closed_at, a.close_note, a.created_at
    FROM assignments a
    JOIN requests r ON r.id = a.request_id
    LEFT JOIN users u ON u.id = a.assignee_id`;

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
  const attachments = await db.query<Record<string, unknown>>(
    `SELECT d.kind, d.number, v.file_name
       FROM documents d LEFT JOIN file_versions v ON v.document_id = d.id AND v.version = d.current_version
      WHERE d.request_id = $1 ORDER BY d.created_at`, [requestId]);
  return {
    number: request.number,
    registeredAt: request.registeredAt,
    customer: counterparty,
    facility: { id: request.facilityId, name: request.facilityName },
    branch: { id: request.branchId, name: request.branchName },
    services,
    estimate: request.totalAmount,
    freeOfCharge: request.freeOfCharge,
    attachments,
  };
}

/**
 * Поручение ОР ПСД по зарегистрированной заявке. Срок — ответ о технической
 * возможности, не более 5 рабочих дней (п. 9). Повторная регистрация не
 * создаёт дубликат: одно поручение на заявку.
 */
export async function createForRequest(db: Db, requestId: string, calendar: WorkCalendar): Promise<string | null> {
  const payload = await buildPayload(db, requestId);
  const row = await db.one<{ id: string }>(
    `INSERT INTO assignments (request_id, kind, department, due_at, status, reference, payload)
     VALUES ($1, 'control', 'ОР ПСД', $2, 'open', 'п. 9', $3)
     ON CONFLICT (request_id, kind) DO NOTHING
     RETURNING id`,
    [requestId, addWorkingDays(today(), 5, calendar), JSON.stringify(payload)]);
  return row?.id ?? null;
}

export function listAssignments(db: Db, filter: { status?: string; limit?: number } = {}): Promise<AssignmentRow[]> {
  const params: unknown[] = [];
  let where = '';
  if (filter.status === 'active') where = `WHERE a.status IN ('open','in_progress')`;
  else if (filter.status) { params.push(filter.status); where = 'WHERE a.status = $1'; }
  return db.query<AssignmentRow>(
    `${SELECT} ${where} ORDER BY a.created_at DESC LIMIT ${Math.min(filter.limit ?? 200, 1000)}`,
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
    `UPDATE assignments SET status = 'in_progress', accepted_at = now(), accepted_by = $2, assignee_id = $2
      WHERE id = $1 AND status = 'open' RETURNING id`, [id, userId]);
  return rows.length > 0;
}

export async function close(db: Db, id: string, userId: string, note: string, cancelled = false): Promise<boolean> {
  const rows = await db.query(
    `UPDATE assignments SET status = $4, closed_at = now(), closed_by = $2, close_note = $3
      WHERE id = $1 AND status IN ('open','in_progress') RETURNING id`,
    [id, userId, note, cancelled ? 'cancelled' : 'done']);
  return rows.length > 0;
}
