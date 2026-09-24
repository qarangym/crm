/**
 * Служебные записки в филиал (Регламент п. 10).
 *
 * СП ЦА, ответственное за разработку ТУ, ПСД и договоры, направляет в филиал
 * СЗ с запросом информации; филиал обязан ответить не позднее 3 рабочих дней
 * с даты получения. Просрочка ответа — нарушение срока филиалом и повод для
 * эскалации по п. 100.
 */

import type { Db } from './client.ts';

export const MEMO_ANSWER_DAYS = 3;

export type MemoRow = {
  id: string;
  request_id: string;
  request_number: string;
  branch_id: string;
  branch_name: string;
  subject: string;
  body: string;
  sent_at: string;
  due_at: string;
  answered_at: string | null;
  answer: string | null;
  author_name: string | null;
  answered_by_name: string | null;
  addressee_name: string | null;
  escalation_level: number;
};

const SELECT = `
  SELECT m.id, m.request_id, r.number AS request_number, m.branch_id, b.name AS branch_name,
         m.subject, m.body, m.sent_at, m.due_at::text AS due_at, m.answered_at, m.answer,
         a.full_name AS author_name, ab.full_name AS answered_by_name,
         ad.full_name AS addressee_name, m.escalation_level
    FROM memos m
    JOIN requests r ON r.id = m.request_id
    JOIN branches b ON b.id = m.branch_id
    LEFT JOIN users a ON a.id = m.created_by
    LEFT JOIN users ab ON ab.id = m.answered_by
    LEFT JOIN users ad ON ad.id = m.addressee_id`;

export function forRequest(db: Db, requestId: string): Promise<MemoRow[]> {
  return db.query<MemoRow>(`${SELECT} WHERE m.request_id = $1 ORDER BY m.sent_at`, [requestId]);
}

export function getMemo(db: Db, id: string): Promise<MemoRow | null> {
  return db.one<MemoRow>(`${SELECT} WHERE m.id = $1`, [id]);
}

export function listMemos(db: Db, filter: { branchId?: string; open?: boolean }): Promise<MemoRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.branchId) { params.push(filter.branchId); where.push(`m.branch_id = $${params.length}`); }
  if (filter.open) where.push('m.answered_at IS NULL');
  return db.query<MemoRow>(
    `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.due_at, m.sent_at LIMIT 500`,
    params as never);
}

export async function createMemo(db: Db, m: {
  requestId: string; branchId: string; addresseeId: string | null; subject: string; body: string;
  dueAt: string; createdBy: string;
}): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO memos (request_id, branch_id, addressee_id, subject, body, due_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [m.requestId, m.branchId, m.addresseeId, m.subject, m.body, m.dueAt, m.createdBy]);
  return row!.id;
}

export async function answerMemo(db: Db, id: string, answer: string, userId: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE memos SET answered_at = now(), answer = $2, answered_by = $3
      WHERE id = $1 AND answered_at IS NULL RETURNING id`, [id, answer, userId]);
  return rows.length > 0;
}

/** Доля ответов филиалов в срок 3 рабочих дней (п. 10) — показатель для дашборда. */
export async function answerStats(db: Db): Promise<{
  total: number; answered: number; onTime: number; overdueOpen: number; onTimeShare: number | null;
}> {
  const row = await db.one<{ total: string; answered: string; on_time: string; overdue_open: string }>(
    `SELECT count(*)::text AS total,
            count(answered_at)::text AS answered,
            count(*) FILTER (WHERE answered_at IS NOT NULL AND answered_at::date <= due_at)::text AS on_time,
            count(*) FILTER (WHERE answered_at IS NULL AND due_at < current_date)::text AS overdue_open
       FROM memos`);
  const answered = Number(row?.answered ?? 0);
  const onTime = Number(row?.on_time ?? 0);
  return {
    total: Number(row?.total ?? 0),
    answered,
    onTime,
    overdueOpen: Number(row?.overdue_open ?? 0),
    onTimeShare: answered ? Math.round((onTime / answered) * 1000) / 1000 : null,
  };
}
