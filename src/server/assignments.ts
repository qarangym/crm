/**
 * Маршруты поручений (План завершения, A2; ТЗ №7, №8; ТЗ раздел 5).
 *
 * Поручение создаётся при регистрации заявки; ОР ПСД принимает его в работу,
 * ОКО отслеживает и закрывает. Выгрузка зарегистрированных заявок для ОКО
 * заменяет обмен с приложением «Контроль и мониторинг» в HCL Notes — ТЗ это
 * прямо допускает.
 */

import * as repo from '../db/repo.ts';
import * as assignments from '../db/assignments.ts';
import { ApiError } from './errors.ts';
import type { Router } from './http.ts';
import { RAW_RESPONSE } from './http.ts';
import * as rbac from './rbac.ts';
import type { RouteDeps } from './context.ts';

/** Поле CSV: кавычки удваиваются; формулы Excel обезвреживаются. */
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function registerAssignmentRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  /** Очередь поручений: по умолчанию — действующие. */
  router.get('/api/v1/assignments', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'assignment.view');
    const status = ctx.query.get('status') ?? 'active';
    return { assignments: await assignments.listAssignments(db, { status: status === 'all' ? undefined : status }) };
  });

  /**
   * Выгрузка зарегистрированных заявок и поручений для ОКО (ТЗ раздел 5).
   * CSV с разделителем «;» и BOM — открывается в Excel без настройки кодировки.
   */
  router.get('/api/v1/assignments/export', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'assignment.view');
    const rows = await assignments.listAssignments(db, { limit: 1000 });
    const header = ['Номер заявки', 'Дата регистрации', 'Заказчик', 'БИН', 'Объект', 'Филиал',
      'Услуги', 'Предварительная стоимость', 'Поручено', 'Срок', 'Статус', 'Исполнитель', 'Закрыто'];
    const status: Record<string, string> = { open: 'Новое', in_progress: 'В работе', done: 'Исполнено', cancelled: 'Снято' };
    const lines = [header.map(csvCell).join(';')];
    for (const a of rows) {
      const p = a.payload as Record<string, any>;
      lines.push([
        a.request_number, String(p.registeredAt ?? '').slice(0, 10), p.customer?.name_full, p.customer?.bin,
        p.facility?.name, p.branch?.name,
        (p.services ?? []).map((s: { service: string }) => s.service).join(', '),
        p.estimate ?? '', a.department, a.due_at ?? '', status[a.status] ?? a.status,
        a.assignee_name ?? '', a.closed_at ? String(new Date(a.closed_at).toISOString()).slice(0, 10) : '',
      ].map(csvCell).join(';'));
    }
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Выгрузка поручений для ОКО', entity: 'assignment',
      entityId: 'export', detail: `${rows.length} записей`, regulationRef: 'ТЗ, раздел 5',
    });
    const body = '﻿' + lines.join('\r\n') + '\r\n';
    ctx.res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="assignments-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'private, no-store',
    });
    ctx.res.end(body);
    return RAW_RESPONSE;
  });

  router.get('/api/v1/assignments/:id', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'assignment.view');
    const row = await assignments.getAssignment(db, ctx.params.id);
    if (!row) throw ApiError.notFound('Поручение не найдено');
    return { assignment: row };
  });

  /** Принятие поручения в работу — ОР ПСД. */
  router.post('/api/v1/assignments/:id/accept', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'assignment.accept');
    const row = await assignments.getAssignment(db, ctx.params.id);
    if (!row) throw ApiError.notFound('Поручение не найдено');
    await db.tx(async (t) => {
      if (!await assignments.accept(t, row.id, actor.id)) {
        throw ApiError.conflict('Поручение уже принято в работу или закрыто');
      }
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Поручение принято в работу', entity: 'request',
        entityId: row.request_id, detail: `${row.request_number} · ${row.department}`, regulationRef: 'ТЗ №7',
      });
    });
    return { assignment: await assignments.getAssignment(db, row.id) };
  });

  /** Закрытие поручения — ОКО, с отметкой в журнале. */
  router.post('/api/v1/assignments/:id/close', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'assignment.close');
    const row = await assignments.getAssignment(db, ctx.params.id);
    if (!row) throw ApiError.notFound('Поручение не найдено');
    const body = await ctx.body<{ note?: string; cancelled?: boolean }>();
    const note = String(body.note ?? '').trim();
    if (note.length < 3) throw ApiError.badRequest('Укажите результат исполнения', { note: 'Результат или основание снятия' });

    await db.tx(async (t) => {
      if (!await assignments.close(t, row.id, actor.id, note, body.cancelled === true)) {
        throw ApiError.conflict('Поручение уже закрыто');
      }
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: body.cancelled ? 'Поручение снято с контроля' : 'Поручение исполнено',
        entity: 'request', entityId: row.request_id, detail: `${row.request_number}: ${note}`, regulationRef: 'ТЗ №7',
      });
    });
    return { assignment: await assignments.getAssignment(db, row.id) };
  });
}
