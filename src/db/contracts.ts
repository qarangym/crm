/**
 * Договоры и оплата по услугам заявки.
 *
 * Регламент пп. 21, 32, 48: на каждую услугу (ТУ, ПСД, СМР) заключается свой
 * договор; п. 53 — договор на СМР не ранее утверждения сметы; пп. 59, 86 —
 * работы начинаются после 100 % оплаты по договору этой услуги.
 * Проверки норм выполняет процессный движок; здесь только чтение и запись.
 */

import type { Db } from './client.ts';
import type { Service } from '../domain/types.ts';

export type ContractRow = {
  id: string;
  number: string;
  request_id: string | null;
  counterparty_id: string;
  service: Service | null;
  subject: string;
  amount: string | null;
  signed_at: string | null;
  invoice_at: string | null;
  paid_at: string | null;
  status: 'draft' | 'signed' | 'paid' | 'executed' | 'terminated';
  refund_amount: string | null;
  terminated_at: string | null;
  avr_formed_at: string | null;
  avr_sent_at: string | null;
  avr_objection: string | null;
  accepted_at: string | null;
  accepted_by_silence: boolean;
  /** Завизированный АВР по этому договору (либо общий АВР заявки без привязки к договору). */
  avr_approved: boolean;
  created_at: string;
};

const COLUMNS = `c.id, c.number, c.request_id, c.counterparty_id, c.service, c.subject, c.amount,
  c.signed_at::text AS signed_at, c.invoice_at::text AS invoice_at, c.paid_at::text AS paid_at,
  c.status, c.refund_amount, c.terminated_at::text AS terminated_at,
  c.avr_formed_at::text AS avr_formed_at, c.avr_sent_at::text AS avr_sent_at, c.avr_objection,
  c.accepted_at::text AS accepted_at, c.accepted_by_silence,
  EXISTS (SELECT 1 FROM documents d WHERE d.kind = 'АВР' AND d.approved
           AND (d.contract_id = c.id OR (d.contract_id IS NULL AND d.request_id = c.request_id))) AS avr_approved,
  c.created_at`;

export function listContracts(db: Db, requestId: string): Promise<ContractRow[]> {
  return db.query<ContractRow>(
    `SELECT ${COLUMNS} FROM contracts c WHERE c.request_id = $1 ORDER BY c.created_at`, [requestId]);
}

export function getContract(db: Db, id: string): Promise<ContractRow | null> {
  return db.one<ContractRow>(`SELECT ${COLUMNS} FROM contracts c WHERE c.id = $1`, [id]);
}

export function activeContract(db: Db, requestId: string, service: Service): Promise<ContractRow | null> {
  return db.one<ContractRow>(
    `SELECT ${COLUMNS} FROM contracts c
      WHERE c.request_id = $1 AND c.service = $2 AND c.status <> 'terminated'`, [requestId, service]);
}

export function findByNumber(db: Db, number: string): Promise<ContractRow | null> {
  return db.one<ContractRow>(`SELECT ${COLUMNS} FROM contracts c WHERE c.number = $1`, [number]);
}

export type NewContract = {
  requestId: string;
  counterpartyId: string;
  service: Service;
  number: string;
  subject: string;
  amount: number | null;
  signedAt: string | null;
  invoiceAt: string | null;
  createdBy: string;
};

export async function createContract(db: Db, c: NewContract): Promise<ContractRow> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO contracts (number, request_id, counterparty_id, service, subject, amount,
                            signed_at, invoice_at, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [c.number, c.requestId, c.counterpartyId, c.service, c.subject, c.amount,
     c.signedAt, c.invoiceAt, c.signedAt ? 'signed' : 'draft', c.createdBy]);
  return (await getContract(db, row!.id))!;
}

/** Фиксация поступления 100 % оплаты (пп. 86, 88). Повторная отметка не перезаписывает дату. */
export async function recordPayment(db: Db, id: string, paidAt: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE contracts SET paid_at = $2, status = 'paid'
      WHERE id = $1 AND paid_at IS NULL AND status <> 'terminated' RETURNING id`, [id, paidAt]);
  return rows.length > 0;
}

/** Расторжение (пп. 96–97): договор перестаёт действовать, сумма возврата фиксируется. */
export async function terminateContract(
  db: Db, id: string, at: string, refundAmount: number | null,
): Promise<boolean> {
  const rows = await db.query(
    `UPDATE contracts SET status = 'terminated', terminated_at = $2, refund_amount = $3
      WHERE id = $1 AND status <> 'terminated' RETURNING id`, [id, at, refundAmount]);
  return rows.length > 0;
}

/* ------------------------- АВР по договору (В6) ------------------------- */

/**
 * Начало срока на замечания к АВР (п. 94): самая поздняя дата направления АВР
 * по договорам, которые ещё не приняты. Нет таких договоров — null.
 */
export async function silenceStart(db: Db, requestId: string): Promise<string | null> {
  const row = await db.one<{ at: string | null }>(
    `SELECT max(avr_sent_at)::text AS at FROM contracts
      WHERE request_id = $1 AND status <> 'terminated' AND accepted_at IS NULL AND avr_sent_at IS NOT NULL`, [requestId]);
  return row?.at ?? null;
}

/** Есть ли по заявке непринятый договор с мотивированными замечаниями к АВР. */
export async function hasObjection(db: Db, requestId: string): Promise<boolean> {
  const row = await db.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM contracts
      WHERE request_id = $1 AND status <> 'terminated' AND accepted_at IS NULL AND avr_objection IS NOT NULL`, [requestId]);
  return (row?.n ?? 0) > 0;
}

export type AvrPatch = {
  avr_formed_at?: string | null;
  avr_sent_at?: string | null;
  avr_objection?: string | null;
  accepted_at?: string | null;
  accepted_by_silence?: boolean;
};

/** Реквизиты АВР договора. Принятый договор получает статус «исполнен» (п. 127). */
export async function updateAvr(db: Db, id: string, patch: AvrPatch): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [key, value] of Object.entries(patch)) {
    params.push(value);
    sets.push(`${key} = $${params.length}`);
  }
  if ('accepted_at' in patch) {
    sets.push(patch.accepted_at
      ? `status = 'executed'`
      : `status = CASE WHEN paid_at IS NOT NULL THEN 'paid' WHEN signed_at IS NOT NULL THEN 'signed' ELSE 'draft' END`);
  }
  const rows = await db.query(
    `UPDATE contracts SET ${sets.join(', ')} WHERE id = $1 AND status <> 'terminated' RETURNING id`, params as never);
  return rows.length > 0;
}

/** Действующие договоры заявки (не расторгнутые). */
export function activeContracts(db: Db, requestId: string): Promise<ContractRow[]> {
  return db.query<ContractRow>(
    `SELECT ${COLUMNS} FROM contracts c WHERE c.request_id = $1 AND c.status <> 'terminated' ORDER BY c.created_at`, [requestId]);
}
