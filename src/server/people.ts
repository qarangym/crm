/**
 * Уведомления в системе («колокольчик») и замещение на время отсутствия (А3).
 *
 * Колокольчик — копия каждого письма пользователю системы: сотрудник видит,
 * что нового, не открывая почту, и по ссылке попадает прямо в карточку.
 *
 * Замещение: сотрудник (или ДИТ, или руководитель подразделения) указывает,
 * кто замещает его на период отпуска, командировки или болезни. На это время
 * новые карточки ему не назначаются, его задачи видны замещающему, письма
 * дублируются замещающему. По окончании периода всё возвращается само —
 * карточки не перекладываются, поэтому вернуть «забытые» нельзя забыть.
 */

import * as repo from '../db/repo.ts';
import { ApiError } from './errors.ts';
import type { Router } from './http.ts';
import * as rbac from './rbac.ts';
import type { Actor } from './rbac.ts';
import type { RouteDeps } from './context.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isoDate = (v: unknown) => {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
};

export function registerPeopleRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  /* ------------------------------ колокольчик ------------------------------ */

  router.get('/api/v1/inbox', async (ctx) => {
    const actor = await deps.actor(ctx);
    const limit = Math.min(Math.max(Number(ctx.query.get('limit')) || 30, 1), 200);
    const [items, count] = await Promise.all([
      db.query(
        `SELECT id, event_key, subject, body, link, created_at, read_at FROM inbox
          WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [actor.id, limit]),
      db.one<{ unread: number }>(`SELECT count(*)::int AS unread FROM inbox WHERE user_id = $1 AND read_at IS NULL`, [actor.id]),
    ]);
    return { items, unread: count?.unread ?? 0 };
  });

  router.get('/api/v1/inbox/count', async (ctx) => {
    const actor = await deps.actor(ctx);
    const row = await db.one<{ unread: number }>(
      `SELECT count(*)::int AS unread FROM inbox WHERE user_id = $1 AND read_at IS NULL`, [actor.id]);
    return { unread: row?.unread ?? 0 };
  });

  router.post('/api/v1/inbox/read', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const body = await ctx.body<{ ids?: unknown[]; all?: boolean }>();
    const ids = (body.ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (body.all) {
      await db.query(`UPDATE inbox SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [actor.id]);
    } else if (ids.length) {
      await db.query(`UPDATE inbox SET read_at = now() WHERE user_id = $1 AND id = ANY($2::bigint[]) AND read_at IS NULL`,
        [actor.id, ids]);
    }
    const row = await db.one<{ unread: number }>(
      `SELECT count(*)::int AS unread FROM inbox WHERE user_id = $1 AND read_at IS NULL`, [actor.id]);
    return { unread: row?.unread ?? 0 };
  });

  /* ------------------------------- замещение ------------------------------- */

  const staffOnly = (actor: Actor) => {
    if (rbac.isExternal(actor) || !actor.roles.length) throw ApiError.forbidden();
  };

  /** Может ли пользователь оформить отсутствие сотрудника: сам, ДИТ или руководитель его подразделения. */
  async function mayManage(actor: Actor, userId: string): Promise<boolean> {
    if (userId === actor.id || actor.roles.includes('admin')) return true;
    const row = await db.one<{ ok: boolean }>(
      `SELECT h.is_head AND (h.department <> '' AND h.department = u.department OR h.branch_id IS NOT NULL AND h.branch_id = u.branch_id) AS ok
         FROM users h, users u WHERE h.id = $1 AND u.id = $2`, [actor.id, userId]);
    return !!row?.ok;
  }

  /** Сотрудники Общества — для выбора замещающего. */
  router.get('/api/v1/colleagues', async (ctx) => {
    const actor = await deps.actor(ctx);
    staffOnly(actor);
    return {
      people: await db.query(
        `SELECT u.id, u.full_name, u.position, u.department, b.name AS branch_name, u.is_head,
                array_agg(r.role) AS roles,
                EXISTS (SELECT 1 FROM user_absences a WHERE a.user_id = u.id AND current_date BETWEEN a.date_from AND a.date_to) AS absent
           FROM users u JOIN user_roles r ON r.user_id = u.id LEFT JOIN branches b ON b.id = u.branch_id
          WHERE u.is_active AND r.role NOT IN ('customer', 'contractor')
          GROUP BY u.id, b.name ORDER BY u.full_name`),
    };
  });

  /** Отсутствия: свои, где я замещающий, и — ДИТ и руководителям — все. */
  router.get('/api/v1/absences', async (ctx) => {
    const actor = await deps.actor(ctx);
    staffOnly(actor);
    const all = actor.roles.includes('admin') || !!(await db.one(`SELECT 1 FROM users WHERE id = $1 AND is_head`, [actor.id]));
    return {
      absences: await db.query(
        `SELECT a.id, a.user_id, u.full_name AS user_name, a.substitute_id, s.full_name AS substitute_name,
                a.date_from::text AS date_from, a.date_to::text AS date_to, a.reason,
                current_date BETWEEN a.date_from AND a.date_to AS current
           FROM user_absences a JOIN users u ON u.id = a.user_id JOIN users s ON s.id = a.substitute_id
          WHERE a.date_to >= current_date - 30 AND ($1 OR a.user_id = $2 OR a.substitute_id = $2)
          ORDER BY a.date_from DESC LIMIT 500`, [all, actor.id]),
    };
  });

  router.post('/api/v1/absences', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    staffOnly(actor);
    const body = await ctx.body<{ userId?: string; substituteId?: string; dateFrom?: string; dateTo?: string; reason?: string }>();
    const userId = body.userId && UUID.test(body.userId) ? body.userId : actor.id;
    const fields: Record<string, string> = {};
    const dateFrom = isoDate(body.dateFrom);
    const dateTo = isoDate(body.dateTo);
    if (!dateFrom) fields.dateFrom = 'Укажите начало';
    if (!dateTo) fields.dateTo = 'Укажите окончание';
    if (dateFrom && dateTo && dateTo < dateFrom) fields.dateTo = 'Окончание раньше начала';
    if (!body.substituteId || !UUID.test(body.substituteId)) fields.substituteId = 'Выберите замещающего';
    else if (body.substituteId === userId) fields.substituteId = 'Нельзя замещать самого себя';
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте период отсутствия', fields);
    if (!await mayManage(actor, userId)) throw ApiError.forbidden('Отсутствие оформляет сам сотрудник, его руководитель или ДИТ');
    const substitute = await db.one<{ id: string; full_name: string }>(
      `SELECT u.id, u.full_name FROM users u WHERE u.id = $1 AND u.is_active
          AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role NOT IN ('customer','contractor'))`,
      [body.substituteId]);
    if (!substitute) throw ApiError.badRequest('Замещающий не найден', { substituteId: 'Выберите действующего сотрудника' });
    const overlap = await db.one(
      `SELECT 1 FROM user_absences WHERE user_id = $1 AND daterange(date_from, date_to, '[]') && daterange($2::date, $3::date, '[]')`,
      [userId, dateFrom, dateTo]);
    if (overlap) throw ApiError.conflict('На эти даты отсутствие уже оформлено — измените или удалите прежнее');
    const reason = String(body.reason ?? 'отпуск').trim().slice(0, 64) || 'отпуск';
    const id = await db.tx(async (t) => {
      const row = await t.one<{ id: string }>(
        `INSERT INTO user_absences (user_id, substitute_id, date_from, date_to, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [userId, substitute.id, dateFrom, dateTo, reason, actor.id]);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Оформлено замещение', entity: 'user', entityId: userId,
        detail: `${reason}: ${dateFrom} — ${dateTo}, замещает ${substitute.full_name}`, regulationRef: 'п. 102 Регламента',
      });
      return row!.id;
    });
    return { id };
  });

  router.post('/api/v1/absences/:id/delete', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    staffOnly(actor);
    const row = UUID.test(ctx.params.id)
      ? await db.one<{ user_id: string }>(`SELECT user_id FROM user_absences WHERE id = $1`, [ctx.params.id]) : null;
    if (!row) throw ApiError.notFound('Запись не найдена');
    if (!await mayManage(actor, row.user_id)) throw ApiError.forbidden();
    await db.query(`DELETE FROM user_absences WHERE id = $1`, [ctx.params.id]);
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Отменено замещение', entity: 'user', entityId: row.user_id, detail: ctx.params.id,
    });
    return { ok: true };
  });
}
