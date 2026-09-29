/**
 * Маршруты поручений (План завершения, A2; Проверка функционала, В5;
 * ТЗ №7, №8; ТЗ раздел 4, 5).
 *
 * Поручение ОР ПСД создаётся при регистрации заявки; ОР ПСД принимает его в
 * работу, ответ о технической возможности отмечает исполнение по существу
 * (в срок или с нарушением), ОКО проверяет и закрывает. ОКО также поручает
 * работу по заявке другим подразделениям. Выгрузка зарегистрированных заявок
 * для ОКО заменяет обмен с приложением «Контроль и мониторинг» в HCL Notes —
 * ТЗ это прямо допускает.
 */

import * as repo from '../db/repo.ts';
import * as assignments from '../db/assignments.ts';
import { DEPARTMENTS } from '../db/assignments.ts';
import { candidates } from '../db/executors.ts';
import type { AssignmentFilter } from '../db/assignments.ts';
import { today } from '../domain/calendar.ts';
import { stage } from '../process/stages.ts';
import { ApiError } from './errors.ts';
import type { Router } from './http.ts';
import { RAW_RESPONSE } from './http.ts';
import * as rbac from './rbac.ts';
import type { Actor } from './rbac.ts';
import type { RouteDeps } from './context.ts';
import { isoDateOrNull } from './context.ts';
import { notify, roleRecipients } from './notify.ts';

/** Поле CSV: кавычки удваиваются; формулы Excel обезвреживаются. */
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}

/** ОКО, ДИТ и руководство видят все поручения; подразделение — свои и назначенные сотруднику. */
export function assignmentScope(actor: Actor): Pick<AssignmentFilter, 'departments' | 'assigneeId'> {
  if (actor.roles.some((r) => ['admin', 'oko', 'management'].includes(r))) return {};
  const departments = Object.entries(DEPARTMENTS).filter(([, role]) => actor.roles.includes(role)).map(([d]) => d);
  return { departments, assigneeId: actor.id };
}

function visibleTo(actor: Actor, a: assignments.AssignmentRow, branchOfRequest: string | null): boolean {
  const scope = assignmentScope(actor);
  if (!scope.departments) return true;
  if (a.assignee_id === actor.id) return true;
  if (!scope.departments.includes(a.department)) return false;
  // Филиал видит поручения «Филиалу» только по заявкам своего филиала.
  if (a.department === 'Филиал' && !actor.roles.includes('orpsd')) return branchOfRequest === actor.branchId;
  return true;
}

export function registerAssignmentRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  async function withBranches(rows: assignments.AssignmentRow[]) {
    if (!rows.length) return new Map<string, string | null>();
    const ids = [...new Set(rows.map((r) => r.request_id))];
    const branches = await db.query<{ id: string; branch_id: string | null }>(
      'SELECT id, branch_id FROM requests WHERE id = ANY($1::uuid[])', [ids]);
    return new Map(branches.map((b) => [b.id, b.branch_id]));
  }

  async function visibleList(actor: Actor, filter: AssignmentFilter) {
    const rows = await assignments.listAssignments(db, { ...filter, ...assignmentScope(actor) });
    const branches = await withBranches(rows);
    return rows.filter((a) => visibleTo(actor, a, branches.get(a.request_id) ?? null));
  }

  /** Очередь поручений: по умолчанию — действующие. */
  router.get('/api/v1/assignments', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'assignment.view');
    const status = ctx.query.get('status') ?? 'active';
    return { assignments: await visibleList(actor, { status: status === 'all' ? undefined : status }) };
  });

  /** Справочник подразделений и сотрудников для формы поручения. */
  router.get('/api/v1/assignments/departments', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'assignment.close');
    const users = await db.query<{ id: string; full_name: string; roles: string[]; branch_id: string | null }>(
      `SELECT u.id, u.full_name, u.branch_id, array_agg(r.role) AS roles
         FROM users u JOIN user_roles r ON r.user_id = u.id
        WHERE u.is_active AND r.role = ANY($1::text[])
        GROUP BY u.id ORDER BY u.full_name`, [Object.values(DEPARTMENTS)]);
    return {
      departments: Object.entries(DEPARTMENTS).map(([name, role]) => ({
        name, role, users: users.filter((u) => u.roles.includes(role)).map((u) => ({ id: u.id, name: u.full_name, branchId: u.branch_id })),
      })),
    };
  });

  /**
   * Выгрузка зарегистрированных заявок и поручений для ОКО (ТЗ раздел 5).
   * CSV с разделителем «;» и BOM — открывается в Excel без настройки кодировки.
   */
  router.get('/api/v1/assignments/export', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'assignment.view');
    const rows = await visibleList(actor, { limit: 1000 });
    const header = ['Номер заявки', 'Дата регистрации', 'Заказчик', 'БИН', 'Объект', 'Филиал',
      'Услуги', 'Предварительная стоимость', 'Поручено', 'Содержание', 'Срок', 'Статус', 'Исполнитель',
      'Исполнено по существу', 'В срок', 'Закрыто'];
    const status: Record<string, string> = { open: 'Новое', in_progress: 'В работе', done: 'Исполнено', cancelled: 'Снято' };
    const lines = [header.map(csvCell).join(';')];
    const day = (v: unknown) => (v ? new Date(String(v)).toISOString().slice(0, 10) : '');
    for (const a of rows) {
      const p = a.payload as Record<string, any>;
      lines.push([
        a.request_number, String(p.registeredAt ?? '').slice(0, 10), p.customer?.name_full, p.customer?.bin,
        p.facility?.name, p.branch?.name,
        (p.services ?? []).map((s: { service: string }) => s.service).join(', '),
        p.estimate ?? '', a.department, a.body, a.due_at ?? '', status[a.status] ?? a.status,
        a.assignee_name ?? '', day(a.fulfilled_at),
        a.fulfilled_on_time === null ? '' : a.fulfilled_on_time ? 'да' : 'нет',
        day(a.closed_at),
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

  async function loadAssignment(actor: Actor, id: string) {
    const row = await assignments.getAssignment(db, id);
    if (!row) throw ApiError.notFound('Поручение не найдено');
    const branches = await withBranches([row]);
    if (!visibleTo(actor, row, branches.get(row.request_id) ?? null)) throw ApiError.forbidden('Поручение другого подразделения');
    return row;
  }

  router.get('/api/v1/assignments/:id', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'assignment.view');
    return { assignment: await loadAssignment(actor, ctx.params.id) };
  });

  /** Поручение ОКО подразделению по заявке: подразделение, исполнитель, срок, содержание. */
  router.post('/api/v1/requests/:id/assignments', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'assignment.close');
    const request = await deps.loadVisible(actor, ctx.params.id);
    if (stage(request.stageCode).terminal) throw ApiError.conflict('Заявка закрыта');

    const body = await ctx.body<{ department?: string; assigneeId?: string | null; dueAt?: string; body?: string }>();
    const department = String(body.department ?? '');
    const text = String(body.body ?? '').trim();
    const dueAt = isoDateOrNull(body.dueAt);
    const fields: Record<string, string> = {};
    if (!(department in DEPARTMENTS)) fields.department = 'Выберите подразделение';
    if (text.length < 10) fields.body = 'Опишите, что поручается';
    if (!dueAt || dueAt === 'invalid') fields.dueAt = 'Укажите срок исполнения';
    else if (dueAt < today()) fields.dueAt = 'Срок не может быть в прошлом';
    let assigneeEmail: string | null = null;
    let assigneeId: string | null = body.assigneeId || null;
    if (assigneeId) {
      const user = await db.one<{ email: string }>(
        `SELECT u.email FROM users u JOIN user_roles r ON r.user_id = u.id
          WHERE u.id = $1 AND u.is_active AND r.role = $2`, [assigneeId, DEPARTMENTS[department] ?? '']);
      if (!user) fields.assigneeId = 'Исполнитель должен работать в выбранном подразделении';
      assigneeEmail = user?.email ?? null;
    } else if (department in DEPARTMENTS) {
      // Поручения «подразделению вообще» нет: сотрудник не выбран — наименее загруженный (п. 102).
      const role = DEPARTMENTS[department];
      const pick = (await candidates(db, role, role === 'branch' ? request.branchId : null))[0];
      if (!pick) fields.assigneeId = 'В подразделении нет действующих сотрудников — выберите исполнителя вручную';
      assigneeId = pick?.id ?? null;
      assigneeEmail = pick?.email ?? null;
    }
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте поручение', fields);

    const id = await db.tx(async (t) => {
      const created = await assignments.createManual(t, {
        requestId: request.uuid, department, assigneeId,
        dueAt: dueAt as string, body: text, createdBy: actor.id,
      });
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'ОКО направило поручение', entity: 'request', entityId: request.uuid,
        detail: `${department}: ${text}. Срок ${dueAt}`, regulationRef: 'ТЗ, раздел 4',
      });
      const recipients = assigneeEmail
        ? [assigneeEmail]
        : await roleRecipients(t, [DEPARTMENTS[department]], department === 'Филиал' ? request.branchId : null);
      await notify(t, recipients, {
        eventKey: 'assignment_created',
        subject: `Поручение по заявке ${request.number}`,
        body: `${text}\n\nСрок исполнения: ${dueAt}.\nЗаявка: ${request.number}, ${request.facilityName ?? ''}.`,
        payload: { requestId: request.uuid, assignmentId: created },
      });
      return created;
    });
    return { assignment: await assignments.getAssignment(db, id) };
  });

  /** Принятие поручения в работу — подразделение-исполнитель. */
  router.post('/api/v1/assignments/:id/accept', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'assignment.accept');
    const row = await loadAssignment(actor, ctx.params.id);
    const role = DEPARTMENTS[row.department];
    if (!actor.roles.includes('admin') && row.assignee_id !== actor.id && !(role && actor.roles.includes(role))) {
      throw ApiError.forbidden('Поручение адресовано другому подразделению');
    }
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
    const row = await loadAssignment(actor, ctx.params.id);
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
