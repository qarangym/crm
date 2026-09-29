/**
 * Маршруты отчётов (План завершения, B7; ТЗ №15; Регламент пп. 105, 107, 109).
 *
 * Каждый отчёт отдаётся в JSON для экрана и выгружается в XLSX или CSV
 * параметром `format`. Филиал видит и подтверждает только свой ежемесячный отчёт.
 */

import * as repo from '../db/repo.ts';
import * as reports from '../db/reports.ts';
import { today } from '../domain/calendar.ts';
import { CUSTOMER_STATUS_NAME } from '../domain/types.ts';
import type { CustomerStatus } from '../domain/types.ts';
import { stage } from '../process/stages.ts';
import type { StageCode } from '../process/stages.ts';
import { ApiError } from './errors.ts';
import type { Ctx, Router } from './http.ts';
import { RAW_RESPONSE } from './http.ts';
import * as rbac from './rbac.ts';
import type { Actor } from './rbac.ts';
import type { RouteDeps } from './context.ts';
import { toCsv, toXlsx } from './export.ts';
import type { Sheet } from './export.ts';

const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const period = (v: string | null) => (v && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : undefined);
const stageName = (code: string) => { try { return stage(code as StageCode).name; } catch { return code; } };

/** Прошедший месяц — отчётный период по п. 105. */
export function previousPeriod(now: string = today()): string {
  const [y, m] = now.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export function sendSheets(ctx: Ctx, format: string, fileBase: string, sheets: Sheet[]) {
  const csv = format === 'csv';
  const body = csv ? toCsv(sheets[0]) : toXlsx(sheets);
  const name = `${fileBase}-${today()}.${csv ? 'csv' : 'xlsx'}`;
  ctx.res.writeHead(200, {
    'Content-Type': csv ? 'text/csv; charset=utf-8'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Length': body.length,
    'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'private, no-store',
  });
  ctx.res.end(body);
  return RAW_RESPONSE;
}

/** Филиал — только свой отчёт; остальные — по праву просмотра отчётов. */
function branchAccess(actor: Actor, branchId: string) {
  if (rbac.can(actor, 'reports.view')) return;
  if (rbac.can(actor, 'reports.branch') && actor.branchId === branchId) return;
  throw ApiError.forbidden('Отчёт другого филиала');
}

export function registerReportRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  /** ТЗ №15: заявки по видам работ, Заказчикам, стоимости, статусам и срокам обработки. */
  router.get('/api/v1/reports/requests', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'reports.view');
    const q = ctx.query;
    const rows = await reports.requestReport(db, {
      dateFrom: date(q.get('dateFrom')), dateTo: date(q.get('dateTo')),
      branchId: q.get('branch') || undefined, service: q.get('service') || undefined,
      counterparty: q.get('counterparty') || undefined, stageCode: q.get('stage') || undefined,
      customerStatus: q.get('status') || undefined,
    }, await repo.calendar(db));

    const count = (key: (r: reports.RequestReportRow) => string[]) => {
      const out: Record<string, number> = {};
      for (const r of rows) for (const k of key(r)) out[k] = (out[k] ?? 0) + 1;
      return out;
    };
    const days = rows.map((r) => r.processingDays).filter((d): d is number => d !== null).sort((a, b) => a - b);
    const closed = rows.filter((r) => r.closedAt).map((r) => r.processingDays!).sort((a, b) => a - b);
    const median = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)] : null);
    const summary = {
      total: rows.length,
      byService: count((r) => r.services.split(', ').filter(Boolean)),
      byStatus: count((r) => [CUSTOMER_STATUS_NAME[r.customerStatus as CustomerStatus] ?? r.customerStatus]),
      byBranch: count((r) => [r.branch]),
      estimate: rows.reduce((s, r) => s + (r.estimate ?? 0), 0),
      contracts: rows.reduce((s, r) => s + r.contractsAmount, 0),
      paid: rows.reduce((s, r) => s + r.paidAmount, 0),
      medianProcessingDays: median(days),
      medianClosedDays: median(closed),
      withBreaches: rows.filter((r) => r.breachedStages > 0).length,
    };

    const format = q.get('format');
    if (format === 'csv' || format === 'xlsx') {
      await repo.logEvent(db, { ...deps.audit(ctx, actor), action: 'Выгрузка отчёта по заявкам', entity: 'report',
        entityId: 'requests', detail: `${rows.length} заявок · ${format}`, regulationRef: 'ТЗ №15' });
      const header = ['Номер', 'Дата регистрации', 'Заказчик', 'БИН', 'Объект', 'Филиал', 'Услуги', 'Этап',
        'Статус', 'Предварительная стоимость', 'Сумма договоров', 'Оплачено', 'Рабочих дней в обработке',
        'Этапов с нарушением срока', 'Замечаний', 'Дата закрытия'];
      const sheet: Sheet = {
        name: 'Заявки', header,
        rows: rows.map((r) => [r.number, r.registeredAt, r.counterparty, r.bin, r.facility, r.branch, r.services,
          stageName(r.stageCode), CUSTOMER_STATUS_NAME[r.customerStatus as CustomerStatus] ?? r.customerStatus,
          r.estimate, r.contractsAmount, r.paidAmount, r.processingDays, r.breachedStages, r.remarks, r.closedAt]),
      };
      const totals: Sheet = {
        name: 'Итоги', header: ['Показатель', 'Значение'],
        rows: [
          ['Заявок', summary.total], ['Предварительная стоимость', summary.estimate],
          ['Сумма договоров', summary.contracts], ['Оплачено', summary.paid],
          ['Медиана рабочих дней в обработке', summary.medianProcessingDays],
          ['Медиана рабочих дней до закрытия', summary.medianClosedDays],
          ['Заявок с нарушением срока', summary.withBreaches],
          ...Object.entries(summary.byService).map(([k, v]) => [`Услуга: ${k}`, v]),
          ...Object.entries(summary.byStatus).map(([k, v]) => [`Статус: ${k}`, v]),
          ...Object.entries(summary.byBranch).map(([k, v]) => [`Филиал: ${k}`, v]),
        ],
      };
      return sendSheets(ctx, format, 'zayavki', format === 'csv' ? [sheet] : [sheet, totals]);
    }
    return { rows, summary };
  });

  /** п. 105: ежемесячный отчёт филиала об исполненных и неисполненных договорах. */
  router.get('/api/v1/reports/branch-monthly', async (ctx) => {
    const actor = await deps.actor(ctx);
    const branchId = ctx.query.get('branch') || actor.branchId;
    if (!branchId) throw ApiError.badRequest('Укажите филиал');
    branchAccess(actor, branchId);
    const p = period(ctx.query.get('period')) ?? previousPeriod();
    const branch = await db.one<{ name: string }>(`SELECT name FROM branches WHERE id = $1`, [branchId]);
    if (!branch) throw ApiError.notFound('Филиал не найден');
    const submission = await db.one<{ submitted_at: string; note: string; author: string; snapshot: any }>(
      `SELECT br.submitted_at, br.note, u.full_name AS author, br.snapshot
         FROM branch_reports br JOIN users u ON u.id = br.submitted_by
        WHERE br.branch_id = $1 AND br.period = $2`, [branchId, p]);
    // Представленный отчёт показывается в том виде, в каком его подтвердил филиал.
    const rows: reports.BranchMonthlyRow[] = submission?.snapshot ?? await reports.branchMonthly(db, branchId, p);

    const format = ctx.query.get('format');
    if (format === 'csv' || format === 'xlsx') {
      await repo.logEvent(db, { ...deps.audit(ctx, actor), action: 'Выгрузка отчёта филиала', entity: 'report',
        entityId: 'branch-monthly', detail: `${branch.name} · ${p}`, regulationRef: 'п. 105' });
      return sendSheets(ctx, format, `otchet-filiala-${p}`, [{
        name: `Договоры ${p}`,
        header: ['Договор', 'Услуга', 'Заявка', 'Заказчик', 'Объект', 'Сумма', 'Подписан', 'Оплачен',
          'Исполнен в периоде', 'Текущий этап', 'Нарушен срок филиала'],
        rows: rows.map((r) => [r.contract, r.service, r.request, r.counterparty, r.facility, r.amount, r.signedAt,
          r.paidAt, r.executed ? 'да' : 'нет', stageName(r.stage), r.branchDeadlineBreached ? 'да' : 'нет']),
      }]);
    }
    return {
      branch: { id: branchId, name: branch.name }, period: p,
      dueDate: `${reports.monthBounds(p).to.slice(0, 8)}05`,
      submission: submission ? { submittedAt: submission.submitted_at, note: submission.note, author: submission.author } : null,
      summary: {
        executed: rows.filter((r) => r.executed).length,
        notExecuted: rows.filter((r) => !r.executed).length,
        breached: rows.filter((r) => r.branchDeadlineBreached).length,
      },
      rows,
    };
  });

  /** Состояние представления отчётов филиалами за период. */
  router.get('/api/v1/reports/branch-monthly/status', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'reports.view');
    const p = period(ctx.query.get('period')) ?? previousPeriod();
    return {
      period: p,
      branches: await db.query(
        `SELECT b.id, b.name, br.submitted_at, u.full_name AS author
           FROM branches b
           LEFT JOIN branch_reports br ON br.branch_id = b.id AND br.period = $1
           LEFT JOIN users u ON u.id = br.submitted_by
          WHERE b.is_active ORDER BY b.name`, [p]),
    };
  });

  /** Филиал подтверждает отчёт за прошедший месяц (п. 105); снимок строк фиксируется. */
  router.post('/api/v1/reports/branch-monthly/submit', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const body = await ctx.body<{ branchId?: string; period?: string; note?: string }>();
    const branchId = body.branchId || actor.branchId;
    if (!branchId) throw ApiError.badRequest('Укажите филиал');
    if (!rbac.can(actor, 'reports.branch') || (!actor.roles.includes('admin') && actor.branchId !== branchId)) {
      throw ApiError.forbidden('Отчёт подтверждает филиал');
    }
    const p = period(body.period ?? null);
    if (!p) throw ApiError.badRequest('Укажите отчётный месяц', { period: 'ГГГГ-ММ' });
    if (p >= today().slice(0, 7)) throw ApiError.badRequest('Отчёт представляется за прошедший месяц (п. 105)');

    const rows = await reports.branchMonthly(db, branchId, p);
    await db.tx(async (t) => {
      const saved = await t.query(
        `INSERT INTO branch_reports (branch_id, period, submitted_by, note, snapshot)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (branch_id, period) DO NOTHING RETURNING id`,
        [branchId, p, actor.id, String(body.note ?? '').trim().slice(0, 2000), JSON.stringify(rows)]);
      if (!saved.length) throw ApiError.conflict('Отчёт за этот месяц уже представлен');
      const late = today() > `${reports.monthBounds(p).to.slice(0, 8)}05`;
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: late ? 'Отчёт филиала представлен с нарушением срока' : 'Отчёт филиала представлен',
        entity: 'report', entityId: branchId, detail: `${p}: договоров ${rows.length}`, regulationRef: 'п. 105',
      });
    });
    return { ok: true, period: p, rows: rows.length };
  });

  /** пп. 107, 109: сводный отчёт по производственным показателям филиалов за год. */
  router.get('/api/v1/reports/annual', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'reports.view');
    const year = Number(ctx.query.get('year')) || Number(today().slice(0, 4)) - 1;
    if (year < 2000 || year > 2100) throw ApiError.badRequest('Укажите год');
    const rows = await reports.annualReport(db, year);

    const format = ctx.query.get('format');
    if (format === 'csv' || format === 'xlsx') {
      await repo.logEvent(db, { ...deps.audit(ctx, actor), action: 'Выгрузка сводного отчёта', entity: 'report',
        entityId: 'annual', detail: String(year), regulationRef: 'п. 109' });
      const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
      return sendSheets(ctx, format, `svodnyj-otchet-${year}`, [{
        name: `Показатели ${year}`,
        header: ['Филиал', 'Исполнено ТУ', 'Исполнено ПСД', 'Исполнено СМР', 'Этапов филиала',
          'Из них в срок', 'В срок, %', 'Ответов на СЗ', 'Из них в срок', 'Эскалаций 1-го уровня',
          'Эскалаций 2-го уровня', 'Замечаний Заказчиков к АВР', 'Нарушения охраны труда'],
        rows: rows.map((r) => [r.branch, r.executedTu, r.executedPsd, r.executedSmr, r.branchStages,
          r.branchStagesOnTime, pct(r.branchStagesOnTime, r.branchStages), r.memosAnswered, r.memosOnTime,
          r.escalations1, r.escalations2, r.customerObjections, 'в системе не ведётся']),
      }]);
    }
    return {
      year, dueDate: `${year + 1}-03-01`, rows,
      note: 'Учитываются только исполненные, принятые и оплаченные договоры (п. 109). ' +
        'Нарушения охраны труда и плановые значения показателей (п. 107) в системе не ведутся.',
    };
  });
}
