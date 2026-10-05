/**
 * «Мои задачи»: всё, что лежит на сотруднике, — одним списком (п. 102).
 *
 * Заявки (ответственный или исполнитель этапа), поручения, служебные записки на
 * ответ, документы на визу, запросы изменения реестра и заявки на допуск. Просроченное
 * и с истекающим сроком — сверху. Руководитель видит то же по любому сотруднику и
 * нагрузку всех сотрудников: пустой список означает, что делать нечего, а не что
 * задачу потеряли.
 */

import type { Db } from '../db/client.ts';
import { today } from '../domain/calendar.ts';
import { toIsoDate } from '../domain/dates.ts';
import { stage } from '../process/stages.ts';
import type { StageCode } from '../process/stages.ts';
import { ApiError } from './errors.ts';
import type { Router } from './http.ts';
import * as rbac from './rbac.ts';
import type { RouteDeps } from './context.ts';

export type TaskKind = 'request' | 'registration' | 'assignment' | 'memo' | 'document' | 'registry' | 'permit';

export type Task = {
  kind: TaskKind;
  userId: string;
  /** Задача отсутствующего сотрудника, которого пользователь замещает (А3). */
  onBehalfOf?: string | null;
  id: string;
  /** Номер заявки или документа — по нему открывается карточка. */
  ref: string;
  title: string;
  detail: string;
  dueAt: string | null;
  overdue: boolean;
};

const KIND_NAME: Record<TaskKind, string> = {
  request: 'Заявка', registration: 'Регистрация', assignment: 'Поручение', memo: 'Служебная записка',
  document: 'Документ на визу', registry: 'Изменение реестра', permit: 'Допуск',
};

const day = (v: unknown) => toIsoDate(v) ?? null;

/**
 * Все задачи одного сотрудника либо всех (userId = null). У сотрудника — и
 * задачи тех, кого он сегодня замещает, с пометкой «за кого» (А3).
 */
export async function collectTasks(db: Db, userId: string | null): Promise<Task[]> {
  const own = await collectFor(db, userId);
  if (!userId) return own;
  const replaced = await db.query<{ user_id: string; full_name: string }>(
    `SELECT a.user_id, u.full_name FROM user_absences a JOIN users u ON u.id = a.user_id
      WHERE a.substitute_id = $1 AND current_date BETWEEN a.date_from AND a.date_to`, [userId]);
  for (const r of replaced) {
    for (const t of await collectFor(db, r.user_id)) {
      own.push({ ...t, userId, onBehalfOf: r.full_name, title: `${t.title} — за ${r.full_name}` });
    }
  }
  const now = today();
  const rank = (t: Task) => (t.overdue ? 0 : t.dueAt && t.dueAt <= now ? 1 : 2);
  return own.sort((a, b) => rank(a) - rank(b) || (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') || a.ref.localeCompare(b.ref));
}

async function collectFor(db: Db, userId: string | null): Promise<Task[]> {
  const now = today();
  const tasks: Task[] = [];
  const add = (t: Omit<Task, 'overdue' | 'dueAt'> & { dueAt: unknown }) => {
    const dueAt = day(t.dueAt);
    tasks.push({ ...t, dueAt, overdue: !!dueAt && dueAt < now });
  };
  const who = (column: string, n = 1) => `($${n}::uuid IS NULL OR ${column} = $${n}::uuid)`;

  const requests = await db.query<Record<string, any>>(
    `SELECT r.id, r.number, r.stage_code, r.registration_confirmed_at, r.assignee_id AS responsible_id,
            s.assignee_id AS executor_id, s.due_at, s.paused_at, cp.name_full AS customer, f.name AS facility
       FROM requests r
       JOIN counterparties cp ON cp.id = r.counterparty_id
       LEFT JOIN facilities f ON f.id = r.facility_id
       LEFT JOIN LATERAL (SELECT assignee_id, due_at, paused_at FROM request_stages
                           WHERE request_id = r.id AND left_at IS NULL ORDER BY entered_at DESC LIMIT 1) s ON true
      WHERE r.closed_at IS NULL AND r.stage_code <> 'draft'
        AND ($1::uuid IS NULL OR r.assignee_id = $1::uuid OR s.assignee_id = $1::uuid)`, [userId]);
  for (const r of requests) {
    const st = stage(r.stage_code as StageCode);
    const base = { id: r.id, ref: r.number, detail: `${r.customer}${r.facility ? ' · ' + r.facility : ''}`, dueAt: r.due_at };
    const executorTask = userId === null ? r.executor_id : userId === r.executor_id ? userId : null;
    const responsibleTask = userId === null ? r.responsible_id : userId === r.responsible_id ? userId : null;
    if (executorTask) {
      const confirm = r.stage_code === 'registered' && !r.registration_confirmed_at;
      add({ ...base, kind: confirm ? 'registration' : 'request', userId: executorTask,
        title: confirm ? 'Подтвердить регистрацию' : `Этап «${st.name}»${r.paused_at ? ' (срок приостановлен)' : ''}` });
    }
    // Ответственный ОР ПСД, если он не исполнитель этапа, видит заявку как наблюдаемую: срок — общий.
    if (responsibleTask && responsibleTask !== r.executor_id) {
      add({ ...base, kind: 'request', userId: responsibleTask, title: `Ведёте заявку: этап «${st.name}»` });
    }
  }

  for (const a of await db.query<Record<string, any>>(
    `SELECT a.id, a.body, a.due_at, a.assignee_id, r.number, a.department
       FROM assignments a JOIN requests r ON r.id = a.request_id
      WHERE a.status IN ('open','in_progress') AND a.fulfilled_at IS NULL AND a.assignee_id IS NOT NULL
        AND ${who('a.assignee_id')}`, [userId])) {
    add({ kind: 'assignment', userId: a.assignee_id, id: a.id, ref: a.number, dueAt: a.due_at,
      title: a.body.length > 90 ? a.body.slice(0, 90) + '…' : a.body, detail: `Поручение · ${a.department}` });
  }
  // Исполненное поручение (ответ о ТВ дан) у исполнителя больше не висит: его закрывает ОКО с отметкой.
  const oko = await db.query<{ id: string }>(
    `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id
      WHERE ur.role = 'oko' AND u.is_active AND ${who('u.id')}`, [userId]);
  if (oko.length) {
    for (const a of await db.query<Record<string, any>>(
      `SELECT a.id, a.department, a.fulfilled_at, r.number FROM assignments a JOIN requests r ON r.id = a.request_id
        WHERE a.status IN ('open','in_progress') AND a.fulfilled_at IS NOT NULL`)) {
      for (const u of oko) {
        add({ kind: 'assignment', userId: u.id, id: a.id, ref: a.number, dueAt: null,
          title: 'Закрыть исполненное поручение', detail: `Поручение · ${a.department} · исполнено ${day(a.fulfilled_at)?.split('-').reverse().join('.')}` });
      }
    }
  }

  for (const m of await db.query<Record<string, any>>(
    `SELECT m.id, m.subject, m.due_at, m.addressee_id, r.number FROM memos m JOIN requests r ON r.id = m.request_id
      WHERE m.answered_at IS NULL AND m.addressee_id IS NOT NULL AND ${who('m.addressee_id')}`, [userId])) {
    add({ kind: 'memo', userId: m.addressee_id, id: m.id, ref: m.number, dueAt: m.due_at,
      title: `Ответить на запрос: ${m.subject}`, detail: 'Служебная записка, ответ за 3 рабочих дня (п. 10)' });
  }

  for (const d of await db.query<Record<string, any>>(
    `SELECT d.id, d.kind, d.number, d.approver_id, r.number AS request_number
       FROM documents d LEFT JOIN requests r ON r.id = d.request_id
      WHERE NOT d.approved AND d.kind <> 'Приложение' AND d.approver_id IS NOT NULL AND ${who('d.approver_id')}`, [userId])) {
    add({ kind: 'document', userId: d.approver_id, id: d.id, ref: d.number, dueAt: null,
      title: `Завизировать: ${d.kind} ${d.number}`, detail: d.request_number ? `Заявка ${d.request_number}` : 'Архив актов' });
  }

  for (const c of await db.query<Record<string, any>>(
    `SELECT c.id, c.body, c.due_at, c.assignee_id, f.name AS facility
       FROM registry_change_requests c JOIN facilities f ON f.id = c.facility_id
      WHERE c.resolved_at IS NULL AND c.assignee_id IS NOT NULL AND ${who('c.assignee_id')}`, [userId])) {
    add({ kind: 'registry', userId: c.assignee_id, id: c.id, ref: c.facility, dueAt: c.due_at,
      title: c.body.length > 90 ? c.body.slice(0, 90) + '…' : c.body, detail: `Реестр АМС · ${c.facility} (пп. 13–14)` });
  }

  // Допуски (Инструкция о допуске): рассмотрение СУА — 14 рабочих дней (п. 14), согласование руководства
  // филиала (пп. 8, 14, 18), оформление аварийного допуска (п. 18), инструктаж и СИЗ на объекте (пп. 21–23).
  const permitDetail = (a: Record<string, any>) => `${a.company}${a.facility ? ' · ' + a.facility : ''}`;
  for (const a of await db.query<Record<string, any>>(
    `SELECT a.id, a.number, a.is_urgent, a.assignee_id, a.review_due_at, a.branch_approval, c.name_full AS company, f.name AS facility
       FROM access_requests a JOIN counterparties c ON c.id = a.counterparty_id LEFT JOIN facilities f ON f.id = a.facility_id
      WHERE a.status = 'pending_review' AND a.assignee_id IS NOT NULL AND ${who('a.assignee_id')}`, [userId])) {
    add({ kind: 'permit', userId: a.assignee_id, id: a.id, ref: a.number, dueAt: a.review_due_at,
      title: `${a.is_urgent ? 'СРОЧНО: ' : ''}Рассмотреть заявку на допуск${a.branch_approval === 'pending' ? ' (ждёт согласования филиала)' : ''}`,
      detail: permitDetail(a) });
  }
  for (const a of await db.query<Record<string, any>>(
    `SELECT a.id, a.number, a.work_type, a.branch_approver_id, a.branch_due_at, c.name_full AS company, f.name AS facility
       FROM access_requests a JOIN counterparties c ON c.id = a.counterparty_id LEFT JOIN facilities f ON f.id = a.facility_id
      WHERE a.status = 'pending_review' AND a.branch_approval = 'pending' AND a.branch_approver_id IS NOT NULL
        AND ${who('a.branch_approver_id')}`, [userId])) {
    add({ kind: 'permit', userId: a.branch_approver_id, id: a.id, ref: a.number, dueAt: a.branch_due_at,
      title: a.work_type === 'emergency' ? 'АВАРИЯ: согласовать допуск сегодня (п. 18)' : 'Согласовать допуск на объект филиала',
      detail: permitDetail(a) });
  }
  for (const a of await db.query<Record<string, any>>(
    `SELECT a.id, a.number, a.assignee_id, a.followup_due_at, a.letter_file_id IS NOT NULL AS letter, c.name_full AS company, f.name AS facility
       FROM access_requests a JOIN counterparties c ON c.id = a.counterparty_id LEFT JOIN facilities f ON f.id = a.facility_id
      WHERE a.status = 'approved' AND a.provisional AND a.assignee_id IS NOT NULL AND ${who('a.assignee_id')}`, [userId])) {
    add({ kind: 'permit', userId: a.assignee_id, id: a.id, ref: a.number, dueAt: a.followup_due_at,
      title: a.letter ? 'Оформить письменное разрешение по аварийному допуску' : 'Аварийный допуск: ждём оформленный запрос',
      detail: permitDetail(a) });
  }
  for (const a of await db.query<Record<string, any>>(
    `SELECT a.id, a.number, a.site_officer_id, a.period_start, c.name_full AS company, f.name AS facility
       FROM access_requests a JOIN counterparties c ON c.id = a.counterparty_id LEFT JOIN facilities f ON f.id = a.facility_id
      WHERE a.status = 'approved' AND a.site_officer_id IS NOT NULL AND ${who('a.site_officer_id')}
        AND a.period_start::date <= current_date + 1 AND a.period_end::date >= current_date
        AND NOT EXISTS (SELECT 1 FROM site_admissions s WHERE s.request_id = a.id)`, [userId])) {
    add({ kind: 'permit', userId: a.site_officer_id, id: a.id, ref: a.number, dueAt: a.period_start,
      title: 'Допуск на объект: инструктаж, проверка СИЗ и документов (пп. 21–23)', detail: permitDetail(a) });
  }

  const rank = (t: Task) => (t.overdue ? 0 : t.dueAt && t.dueAt <= now ? 1 : 2);
  return tasks.sort((a, b) => rank(a) - rank(b) || (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') || a.ref.localeCompare(b.ref));
}

const SEE_OTHERS = ['admin', 'orpsd', 'management', 'oko'];

/** Видит задачи и нагрузку других: руководство, ОР ПСД, ОКО, ДИТ и руководители подразделений. */
async function seesOthers(db: Db, actor: { id: string; roles: string[] }): Promise<boolean> {
  if (actor.roles.some((r) => SEE_OTHERS.includes(r))) return true;
  return !!await db.one(`SELECT 1 FROM users WHERE id = $1 AND is_head`, [actor.id]);
}

export function registerTaskRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  async function staff(ctx: Parameters<RouteDeps['actor']>[0]) {
    const actor = await deps.actor(ctx);
    if (rbac.isExternal(actor)) throw ApiError.forbidden();
    return actor;
  }

  /** Задачи сотрудника; `user=<id>` — руководителям. */
  router.get('/api/v1/tasks', async (ctx) => {
    const actor = await staff(ctx);
    const wanted = ctx.query.get('user');
    const target = wanted && wanted !== 'me' ? wanted : actor.id;
    if (target !== actor.id && !await seesOthers(db, actor)) throw ApiError.forbidden();
    if (!/^[0-9a-f-]{36}$/i.test(target)) throw ApiError.badRequest('Некорректный сотрудник');
    const user = await db.one<{ id: string; full_name: string }>('SELECT id, full_name FROM users WHERE id = $1', [target]);
    if (!user) throw ApiError.notFound('Сотрудник не найден');
    const tasks = await collectTasks(db, target);
    return {
      user: { id: user.id, name: user.full_name },
      tasks: tasks.map((t) => ({ ...t, kindName: KIND_NAME[t.kind] })),
      counts: { total: tasks.length, overdue: tasks.filter((t) => t.overdue).length },
    };
  });

  /** Число задач для значка в меню: одним лёгким запросом, без списка. */
  router.get('/api/v1/tasks/count', async (ctx) => {
    const actor = await staff(ctx);
    const tasks = await collectTasks(db, actor.id);
    return { total: tasks.length, overdue: tasks.filter((t) => t.overdue).length };
  });

  /** Нагрузка всех сотрудников: кто чем занят и у кого просрочено. */
  router.get('/api/v1/tasks/load', async (ctx) => {
    const actor = await staff(ctx);
    if (!await seesOthers(db, actor)) throw ApiError.forbidden();
    const [people, all] = await Promise.all([
      db.query<{ id: string; full_name: string; department: string; roles: string[] }>(
        `SELECT u.id, u.full_name, u.department, array_agg(r.role) AS roles
           FROM users u JOIN user_roles r ON r.user_id = u.id
          WHERE u.is_active AND r.role NOT IN ('customer', 'contractor')
          GROUP BY u.id ORDER BY u.full_name`),
      collectTasks(db, null),
    ]);
    return {
      people: people.map((p) => {
        const mine = all.filter((t) => t.userId === p.id);
        return {
          id: p.id, name: p.full_name, department: p.department, roles: p.roles,
          total: mine.length, overdue: mine.filter((t) => t.overdue).length,
          byKind: Object.fromEntries((Object.keys(KIND_NAME) as TaskKind[])
            .map((k) => [k, mine.filter((t) => t.kind === k).length]).filter(([, n]) => n)),
        };
      }),
    };
  });
}
