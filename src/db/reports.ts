/**
 * Данные отчётов (План завершения, B7).
 *
 *  - Реестр заявок — ТЗ №15: по зарегистрированным заявкам, видам работ,
 *    Заказчикам, стоимости, статусам и срокам обработки.
 *  - Ежемесячный отчёт филиала об исполненных и неисполненных договорах — п. 105.
 *  - Годовой сводный отчёт по производственным показателям филиалов — пп. 107, 109:
 *    количество исполненных заявок, соблюдение сроков, замечания Заказчиков.
 *
 * Отчёты считаются по данным системы. Показатели, которые система не ведёт
 * (нарушения охраны труда, плановые значения), в отчёт не выдумываются.
 */

import type { Db } from './client.ts';
import { toIsoDate } from '../domain/dates.ts';
import { today, workingDaysBetween } from '../domain/calendar.ts';
import type { WorkCalendar } from '../domain/types.ts';

export type RequestReportFilter = {
  dateFrom?: string; dateTo?: string; branchId?: string; service?: string;
  counterparty?: string; stageCode?: string; customerStatus?: string;
  /** Филиал видит только свои заявки. */
  scopeBranchId?: string;
};

export type RequestReportRow = {
  id: string; number: string; registeredAt: string | null; closedAt: string | null;
  counterparty: string; bin: string; facility: string; branch: string; services: string;
  stageCode: string; customerStatus: string; estimate: number | null;
  contractsAmount: number; paidAmount: number; breachedStages: number; remarks: number;
  /** Рабочих дней от регистрации до закрытия либо до сегодня. */
  processingDays: number | null;
};

export async function requestReport(db: Db, f: RequestReportFilter, calendar: WorkCalendar): Promise<RequestReportRow[]> {
  const where = [`r.stage_code <> 'draft'`];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => { params.push(value); where.push(clause.replaceAll('?', `$${params.length}`)); };
  if (f.dateFrom) add('coalesce(r.registered_at, r.created_at) >= ?::date', f.dateFrom);
  if (f.dateTo) add(`coalesce(r.registered_at, r.created_at) < ?::date + interval '1 day'`, f.dateTo);
  if (f.branchId) add('r.branch_id = ?', f.branchId);
  if (f.scopeBranchId) add('r.branch_id = ?', f.scopeBranchId);
  if (f.service) add('EXISTS (SELECT 1 FROM request_services s WHERE s.request_id = r.id AND s.service = ?)', f.service);
  if (f.counterparty) add(`(cp.name_full ILIKE '%' || ? || '%' OR cp.bin LIKE ? || '%')`, f.counterparty);
  if (f.stageCode) add('r.stage_code = ?', f.stageCode);
  if (f.customerStatus) add('r.customer_status = ?', f.customerStatus);

  const rows = await db.query<Record<string, any>>(
    `SELECT r.id, r.number, r.registered_at, r.created_at, r.closed_at, r.stage_code, r.customer_status,
            r.total_amount, cp.name_full AS counterparty, cp.bin, f.name AS facility, b.name AS branch,
            (SELECT string_agg(s.service, ', ' ORDER BY s.service) FROM request_services s WHERE s.request_id = r.id) AS services,
            (SELECT coalesce(sum(c.amount), 0) FROM contracts c WHERE c.request_id = r.id AND c.status <> 'terminated') AS contracts_amount,
            (SELECT coalesce(sum(c.amount), 0) FROM contracts c
              WHERE c.request_id = r.id AND c.status <> 'terminated' AND c.paid_at IS NOT NULL) AS paid_amount,
            (SELECT count(*) FROM request_stages s WHERE s.request_id = r.id AND s.breached)::int AS breached_stages,
            (SELECT count(*) FROM request_remarks m WHERE m.request_id = r.id)::int AS remarks
       FROM requests r
       JOIN counterparties cp ON cp.id = r.counterparty_id
       LEFT JOIN facilities f ON f.id = r.facility_id
       LEFT JOIN branches b ON b.id = r.branch_id
      WHERE ${where.join(' AND ')}
      ORDER BY coalesce(r.registered_at, r.created_at), r.number
      LIMIT 10000`, params as never);

  const now = today();
  return rows.map((r) => {
    const start = toIsoDate(r.registered_at ?? r.created_at);
    const end = r.closed_at ? toIsoDate(r.closed_at)! : now;
    return {
      id: r.id, number: r.number,
      registeredAt: toIsoDate(r.registered_at), closedAt: toIsoDate(r.closed_at),
      counterparty: r.counterparty, bin: r.bin, facility: r.facility, branch: r.branch,
      services: r.services ?? '', stageCode: r.stage_code, customerStatus: r.customer_status,
      estimate: r.total_amount === null ? null : Number(r.total_amount),
      contractsAmount: Number(r.contracts_amount), paidAmount: Number(r.paid_amount),
      breachedStages: r.breached_stages, remarks: r.remarks,
      processingDays: start ? workingDaysBetween(start, end, calendar) : null,
    };
  });
}

/* ------------------------------ отчёт филиала (п. 105) ------------------------------ */

export type BranchMonthlyRow = {
  contract: string; service: string; request: string; counterparty: string; facility: string;
  amount: number | null; signedAt: string | null; paidAt: string | null;
  executed: boolean; stage: string; branchDeadlineBreached: boolean;
};

/** Границы месяца ГГГГ-ММ: первый день и первый день следующего. */
export function monthBounds(period: string): { from: string; to: string } {
  const [y, m] = period.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { from: `${period}-01`, to: `${next}-01` };
}

/**
 * Договоры филиала, действовавшие в отчётном месяце: исполненные — заявка
 * закрыта исполнением в этом месяце; неисполненные — на конец месяца не исполнены.
 * Отдельно отмечается нарушение сроков, за которые отвечает филиал.
 */
export async function branchMonthly(db: Db, branchId: string, period: string): Promise<BranchMonthlyRow[]> {
  const { from, to } = monthBounds(period);
  const rows = await db.query<Record<string, any>>(
    `SELECT c.number AS contract, c.service, c.amount, c.signed_at::text AS signed_at, c.paid_at::text AS paid_at,
            r.number AS request, r.stage_code, r.closed_at, cp.name_full AS counterparty, f.name AS facility,
            (r.stage_code = 'closed_done' AND r.closed_at >= $2::date AND r.closed_at < $3::date) AS executed,
            EXISTS (SELECT 1 FROM request_stages s WHERE s.request_id = r.id AND s.owner_party = 'branch'
                     AND (s.breached OR (s.left_at IS NULL AND s.due_at < $3::date))) AS branch_breached
       FROM contracts c
       JOIN requests r ON r.id = c.request_id
       JOIN counterparties cp ON cp.id = r.counterparty_id
       LEFT JOIN facilities f ON f.id = r.facility_id
      WHERE r.branch_id = $1
        AND coalesce(c.signed_at, c.created_at::date) < $3::date
        AND (c.terminated_at IS NULL OR c.terminated_at >= $2::date)
        -- Исполненные раньше отчётного месяца в отчёт не входят.
        AND NOT (r.stage_code = 'closed_done' AND r.closed_at < $2::date)
        AND r.stage_code NOT IN ('closed_rejected', 'closed_expired')
      ORDER BY executed DESC, r.number, c.service`, [branchId, from, to]);
  return rows.map((r) => ({
    contract: r.contract, service: r.service ?? '', request: r.request, counterparty: r.counterparty,
    facility: r.facility, amount: r.amount === null ? null : Number(r.amount),
    signedAt: r.signed_at, paidAt: r.paid_at, executed: r.executed, stage: r.stage_code,
    branchDeadlineBreached: r.branch_breached,
  }));
}

/* ----------------------------- сводный отчёт (пп. 107, 109) ----------------------------- */

export type AnnualBranchRow = {
  branchId: string; branch: string;
  executedTu: number; executedPsd: number; executedSmr: number;
  /** Этапы, за которые отвечает филиал: всего завершено и из них в срок. */
  branchStages: number; branchStagesOnTime: number;
  memosAnswered: number; memosOnTime: number;
  escalations1: number; escalations2: number;
  /** Заявки с мотивированными замечаниями Заказчика к АВР. */
  customerObjections: number;
};

export async function annualReport(db: Db, year: number): Promise<AnnualBranchRow[]> {
  const from = `${year}-01-01`, to = `${year + 1}-01-01`;
  const rows = await db.query<Record<string, any>>(
    `WITH executed AS (
       -- п. 109: только исполненные, принятые и оплаченные договоры.
       SELECT r.id, r.branch_id FROM requests r
        WHERE r.stage_code = 'closed_done' AND r.closed_at >= $1::date AND r.closed_at < $2::date
          AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.request_id = r.id
                           AND c.status <> 'terminated' AND c.paid_at IS NULL)
     )
     SELECT b.id, b.name,
       (SELECT count(*) FROM executed e JOIN request_services s ON s.request_id = e.id
         WHERE e.branch_id = b.id AND s.service = 'ТУ')::int AS tu,
       (SELECT count(*) FROM executed e JOIN request_services s ON s.request_id = e.id
         WHERE e.branch_id = b.id AND s.service = 'ПСД')::int AS psd,
       (SELECT count(*) FROM executed e JOIN request_services s ON s.request_id = e.id
         WHERE e.branch_id = b.id AND s.service = 'СМР')::int AS smr,
       (SELECT count(*) FROM request_stages st JOIN requests r ON r.id = st.request_id
         WHERE r.branch_id = b.id AND st.owner_party = 'branch'
           AND st.left_at >= $1::date AND st.left_at < $2::date)::int AS stages,
       (SELECT count(*) FROM request_stages st JOIN requests r ON r.id = st.request_id
         WHERE r.branch_id = b.id AND st.owner_party = 'branch' AND NOT st.breached
           AND st.left_at >= $1::date AND st.left_at < $2::date)::int AS stages_on_time,
       (SELECT count(*) FROM memos m WHERE m.branch_id = b.id
         AND m.answered_at >= $1::date AND m.answered_at < $2::date)::int AS memos,
       (SELECT count(*) FROM memos m WHERE m.branch_id = b.id AND m.answered_at::date <= m.due_at
         AND m.answered_at >= $1::date AND m.answered_at < $2::date)::int AS memos_on_time,
       (SELECT count(*) FROM escalations e JOIN requests r ON r.id = e.request_id
         WHERE r.branch_id = b.id AND e.level = 1 AND e.created_at >= $1::date AND e.created_at < $2::date)::int AS esc1,
       (SELECT count(*) FROM escalations e JOIN requests r ON r.id = e.request_id
         WHERE r.branch_id = b.id AND e.level = 2 AND e.created_at >= $1::date AND e.created_at < $2::date)::int AS esc2,
       (SELECT count(DISTINCT ev.entity_id) FROM events ev JOIN requests r ON r.id::text = ev.entity_id
         WHERE r.branch_id = b.id AND ev.action = 'Получены мотивированные замечания Заказчика к АВР'
           AND ev.occurred_at >= $1::date AND ev.occurred_at < $2::date)::int AS objections
       FROM branches b
      WHERE b.is_active
      ORDER BY b.name`, [from, to]);
  return rows.map((r) => ({
    branchId: r.id, branch: r.name, executedTu: r.tu, executedPsd: r.psd, executedSmr: r.smr,
    branchStages: r.stages, branchStagesOnTime: r.stages_on_time,
    memosAnswered: r.memos, memosOnTime: r.memos_on_time,
    escalations1: r.esc1, escalations2: r.esc2, customerObjections: r.objections,
  }));
}
