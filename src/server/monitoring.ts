/**
 * Наблюдение за работой системы (План завершения, B4).
 *
 * Эскалации пишет планировщик, уведомления копятся в очереди — без этих
 * маршрутов ни то ни другое не было видно людям: ни руководителю, которому
 * важно, какие заявки эскалированы, ни ДИТ, которому важно, уходит ли почта.
 */

import * as repo from '../db/repo.ts';
import { ApiError } from './errors.ts';
import type { Router } from './http.ts';
import * as rbac from './rbac.ts';
import type { RouteDeps } from './context.ts';

export function registerMonitoringRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  /** Эскалации по п. 100: последние записи и счётчики уровней по филиалам. */
  router.get('/api/v1/escalations', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'metrics.view');
    const rows = await db.query(
      `SELECT e.id, e.level, e.reason, e.created_at, r.id AS request_id, r.number AS request_number,
              b.name AS branch_name, n.full_name AS notified_name, c.full_name AS copy_name,
              (e.memo_id IS NOT NULL) AS about_memo
         FROM escalations e
         JOIN requests r ON r.id = e.request_id
         JOIN branches b ON b.id = r.branch_id
         LEFT JOIN users n ON n.id = e.notified_user_id
         LEFT JOIN users c ON c.id = e.copy_user_id
        WHERE e.created_at > now() - interval '365 days'
        ORDER BY e.created_at DESC LIMIT 300`);
    const byBranch = await db.query(
      `SELECT b.name AS branch_name,
              count(*) FILTER (WHERE e.level = 1)::int AS level1,
              count(*) FILTER (WHERE e.level = 2)::int AS level2
         FROM escalations e
         JOIN requests r ON r.id = e.request_id
         JOIN branches b ON b.id = r.branch_id
        WHERE e.created_at > now() - interval '365 days'
        GROUP BY b.name ORDER BY level2 DESC, level1 DESC`);
    return { escalations: rows, byBranch };
  });

  /** Очередь уведомлений: сколько отправлено, ждёт, не доставлено — для ДИТ. */
  router.get('/api/v1/notifications', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    const status = ctx.query.get('status');
    const counts = await db.one<{ queued: number; sent: number; failed: number }>(
      `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
              count(*) FILTER (WHERE status = 'sent')::int AS sent,
              count(*) FILTER (WHERE status = 'failed')::int AS failed
         FROM notifications`);
    const rows = await db.query(
      `SELECT id, event_key, channel, recipient, subject, status, attempts, error, created_at, sent_at
         FROM notifications
        WHERE $1::text IS NULL OR status = $1
        ORDER BY created_at DESC LIMIT 200`,
      [status && ['queued', 'sent', 'failed'].includes(status) ? status : null]);
    return {
      counts,
      mailEnabled: process.env.SMTP_ENABLED === 'true',
      notifications: rows,
    };
  });

  /** Повторная отправка недоставленного уведомления: попытки обнуляются. */
  router.post('/api/v1/notifications/:id/retry', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    const rows = await db.query(
      `UPDATE notifications SET status = 'queued', attempts = 0, error = NULL
        WHERE id = $1 AND status = 'failed' RETURNING id, recipient, subject`, [ctx.params.id]);
    if (!rows.length) throw ApiError.conflict('Повторить можно только недоставленное уведомление');
    const row = rows[0] as { recipient: string; subject: string };
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Уведомление поставлено на повторную отправку',
      entity: 'notification', entityId: ctx.params.id, detail: `${row.recipient}: ${row.subject}`,
    });
    return { ok: true };
  });
}
