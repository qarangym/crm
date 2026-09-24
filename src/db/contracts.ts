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
  created_at: string;
};

const COLUMNS = `id, number, request_id, counterparty_id, service, subject, amount,
  signed_at::text AS signed_at, invoice_at::text AS invoice_at, paid_at::text AS paid_at,
  status, refund_amount, terminated_at::text AS terminated_at, created_at`;

export function listContracts(db: Db, requestId: string): Promise<ContractRow[]> {
  return db.query<ContractRow>(
    `SELECT ${COLUMNS} FROM contracts WHERE request_id = $1 ORDER BY created_at`, [requestId]);
}

export function getContract(db: Db, id: string): Promise<ContractRow | null> {
  return db.one<ContractRow>(`SELECT ${COLUMNS} FROM contracts WHERE id = $1`, [id]);
}

export function activeContract(db: Db, requestId: string, service: Service): Promise<ContractRow | null> {
  return db.one<ContractRow>(
    `SELECT ${COLUMNS} FROM contracts
      WHERE request_id = $1 AND service = $2 AND status <> 'terminated'`, [requestId, service]);
}

export function findByNumber(db: Db, number: string): Promise<ContractRow | null> {
  return db.one<ContractRow>(`SELECT ${COLUMNS} FROM contracts WHERE number = $1`, [number]);
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
