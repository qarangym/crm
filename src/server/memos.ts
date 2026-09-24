/**
 * Маршруты служебных записок в филиал (План завершения, A3; Регламент п. 10).
 *
 * ОР ПСД направляет в филиал запрос из карточки заявки; срок ответа — 3 рабочих
 * дня с даты получения. Филиал отвечает в системе. Просроченная записка —
 * нарушение срока филиалом: её эскалирует фоновое задание по п. 100.
 */

import * as repo from '../db/repo.ts';
import * as memos from '../db/memos.ts';
import { addWorkingDays, today } from '../domain/calendar.ts';
import { stage } from '../process/stages.ts';
import { ApiError } from './errors.ts';
import type { Router } from './http.ts';
import { enqueue } from './notifications.ts';
import * as rbac from './rbac.ts';
import type { RouteDeps } from './context.ts';

export function registerMemoRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  /** Служебные записки по заявке. */
  router.get('/api/v1/requests/:id/memos', async (ctx) => {
    const actor = await deps.actor(ctx);
    const request = await deps.loadVisible(actor, ctx.params.id);
    return { memos: await memos.forRequest(db, request.uuid) };
  });

  /** Очередь служебных записок. Филиал видит только адресованные ему. */
  router.get('/api/v1/memos', async (ctx) => {
    const actor = await deps.actor(ctx);
    const branchOnly = actor.roles.includes('branch') &&
      !actor.roles.some((r) => ['admin', 'orpsd', 'oko', 'management'].includes(r));
    if (!branchOnly) rbac.require(actor, 'request.view');
    if (branchOnly && !actor.branchId) throw ApiError.forbidden('Учётная запись не привязана к филиалу');
    return {
      memos: await memos.listMemos(db, {
        branchId: branchOnly ? actor.branchId! : (ctx.query.get('branch') || undefined),
        open: ctx.query.get('open') === '1',
      }),
    };
  });

  /** Показатель п. 10: доля ответов филиалов в срок. */
  router.get('/api/v1/memos/stats', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'metrics.view');
    return { stats: await memos.answerStats(db) };
  });

  /** Запрос в филиал (п. 10): адресат — курирующий заместитель директора (Приложение 7). */
  router.post('/api/v1/requests/:id/memos', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'memo.create');
    const request = await deps.loadVisible(actor, ctx.params.id);
    if (stage(request.stageCode).terminal) throw ApiError.conflict('Заявка закрыта');

    const body = await ctx.body<{ subject?: string; body?: string }>();
    const subject = String(body.subject ?? '').trim();
    const text = String(body.body ?? '').trim();
    const fields: Record<string, string> = {};
    if (subject.length < 5) fields.subject = 'Укажите тему запроса';
    if (text.length < 20) fields.body = 'Опишите, какая информация требуется от филиала';
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте служебную записку', fields);

    const branch = await db.one<{ curator_id: string | null; curator_email: string | null; engineer_email: string | null }>(
      `SELECT b.curator_id, cu.email AS curator_email, en.email AS engineer_email
         FROM branches b
         LEFT JOIN users cu ON cu.id = b.curator_id
         LEFT JOIN users en ON en.id = b.chief_engineer_id
        WHERE b.id = $1`, [request.branchId]);
    const dueAt = addWorkingDays(today(), memos.MEMO_ANSWER_DAYS, await repo.calendar(db));

    const id = await db.tx(async (t) => {
      const memoId = await memos.createMemo(t, {
        requestId: request.uuid, branchId: request.branchId, addresseeId: branch?.curator_id ?? null,
        subject: subject.slice(0, 255), body: text, dueAt, createdBy: actor.id,
      });
      const message = {
        subject: `Служебная записка по заявке ${request.number}: ${subject}`.slice(0, 255),
        body: `${text}\n\nОтвет необходимо предоставить не позднее ${dueAt} ` +
          '(3 рабочих дня, пункт 10 Регламента ОРПСД-Р-01).',
        payload: { memoId, requestId: request.uuid },
      };
      // Куратор — ответственный по Приложению 7; главный инженер области — исполнитель (п. 99.1).
      await enqueue(t, { eventKey: 'memo_sent', recipient: branch?.curator_email ?? '', ...message });
      await enqueue(t, { eventKey: 'memo_sent', recipient: branch?.engineer_email ?? '', ...message });
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Направлена служебная записка в филиал', entity: 'request',
        entityId: request.uuid, detail: `${request.branchName}: ${subject}. Срок ответа ${dueAt}`,
        regulationRef: 'п. 10',
      });
      return memoId;
    });
    return { memo: await memos.getMemo(db, id) };
  });

  /** Ответ филиала на служебную записку. */
  router.post('/api/v1/memos/:id/answer', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'memo.answer');
    const memo = await memos.getMemo(db, ctx.params.id);
    if (!memo) throw ApiError.notFound('Служебная записка не найдена');
    if (!actor.roles.includes('admin') && memo.branch_id !== actor.branchId) {
      throw ApiError.forbidden('Служебная записка адресована другому филиалу');
    }
    const body = await ctx.body<{ answer?: string }>();
    const answer = String(body.answer ?? '').trim();
    if (answer.length < 10) throw ApiError.badRequest('Опишите ответ по существу запроса', { answer: 'Не менее 10 символов' });

    await db.tx(async (t) => {
      if (!await memos.answerMemo(t, memo.id, answer, actor.id)) throw ApiError.conflict('Ответ уже зафиксирован');
      const late = today() > memo.due_at;
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: late ? 'Филиал ответил на служебную записку с нарушением срока' : 'Филиал ответил на служебную записку',
        entity: 'request', entityId: memo.request_id,
        detail: `${memo.subject}. Срок ${memo.due_at}`, regulationRef: 'п. 10',
      });
      const author = await t.one<{ email: string }>(
        `SELECT u.email FROM memos m JOIN users u ON u.id = m.created_by WHERE m.id = $1`, [memo.id]);
      await enqueue(t, {
        eventKey: 'memo_answered', recipient: author?.email ?? '',
        subject: `Ответ филиала по заявке ${memo.request_number}: ${memo.subject}`.slice(0, 255),
        body: answer, payload: { memoId: memo.id, requestId: memo.request_id },
      });
    });
    return { memo: await memos.getMemo(db, memo.id) };
  });
}
