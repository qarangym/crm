/**
 * Исполнители заявки: кто ведёт карточку и кому её передать.
 *
 * Смена исполнителя — действие с последствиями: от исполнителя зависят письма,
 * отбор «Мои заявки» и спрос за срок (п. 102). Поэтому передача пишется в
 * журнал с прежним и новым исполнителем, а новый исполнитель получает письмо.
 *
 * Кто передаёт:
 *  - ответственного ОР ПСД — ОР ПСД и ДИТ;
 *  - исполнителя этапа — ОР ПСД (владелец процесса), ДИТ и сотрудники
 *    подразделения, которое исполняет этап: канцелярия — внутри канцелярии,
 *    филиал — внутри своего филиала, расчёты с контрагентами — внутри своих.
 */

import type { Db } from '../db/client.ts';
import * as executors from '../db/executors.ts';
import type { Assignment } from '../db/executors.ts';
import * as repo from '../db/repo.ts';
import type { RequestRow } from '../db/repo.ts';
import { stage } from '../process/stages.ts';
import { ApiError } from './errors.ts';
import type { Router } from './http.ts';
import { notify } from './notify.ts';
import * as rbac from './rbac.ts';
import type { Actor } from './rbac.ts';
import type { Audit, RouteDeps } from './context.ts';

const KIND_TITLE = { responsible: 'ответственный ОР ПСД', stage: 'исполнитель этапа' } as const;

/**
 * Журнал и письма по назначениям. Автоматическое назначение пишется от имени
 * системы; письмо не уходит тому, кто сам взял заявку или сам выполнил переход.
 */
export async function announce(
  db: Db, request: Pick<RequestRow, 'uuid' | 'number' | 'stageCode' | 'facilityName'>, changes: Assignment[],
  audit: Audit, reason = '', auto = false,
): Promise<void> {
  const current = await repo.currentStageRecord(db, request.uuid);
  const stageName = stage(current?.stageCode ?? request.stageCode).name;
  const logAs = auto ? { ...audit, actorId: null, actorName: 'Система' } : audit;
  for (const change of changes) {
    const title = KIND_TITLE[change.kind];
    if (!change.to) {
      await repo.logEvent(db, {
        ...logAs, action: `Не назначен ${title}`, entity: 'request', entityId: request.uuid,
        detail: `${request.number}: в подразделении нет активных сотрудников с нужной ролью — назначьте вручную`,
        result: 'error', regulationRef: 'п. 102',
      });
      continue;
    }
    const from = change.from ? await db.one<{ full_name: string }>('SELECT full_name FROM users WHERE id = $1', [change.from]) : null;
    await repo.logEvent(db, {
      ...logAs, action: `Назначен ${title}`, entity: 'request', entityId: request.uuid,
      detail: `${request.number}, этап «${stageName}»: ${from?.full_name ?? 'не назначен'} → ${change.to.name}` +
        (reason ? `. Причина: ${reason}` : ''),
      regulationRef: 'п. 102',
    });
    if (change.to.id === audit.actorId) continue;
    await notify(db, [change.to.email], {
      eventKey: 'executor_assigned',
      subject: `Вам передана заявка ${request.number}`,
      body: [
        `Вы назначены: ${title}.`,
        `Заявка: ${request.number}${request.facilityName ? `, ${request.facilityName}` : ''}.`,
        `Этап: ${stageName}${current?.dueAt ? `, срок — ${current.dueAt}` : ''}.`,
        auto || !audit.actorId ? 'Назначено системой.' : `Передал: ${audit.actorName}.`,
        ...(reason ? [`Причина: ${reason}.`] : []),
      ].join('\n'),
      payload: { requestId: request.uuid, kind: change.kind },
    });
  }
}

/** Назначение недостающих исполнителей с журналом и письмами — после подачи и перехода. */
export async function assignMissing(db: Db, request: RequestRow, audit: Audit): Promise<void> {
  const changes = await executors.ensureExecutors(db, request.uuid);
  if (changes.length) await announce(db, request, changes, audit, '', true);
}

function mayChange(actor: Actor, kind: 'responsible' | 'stage', role: string | null, sameBranch: boolean): boolean {
  if (actor.roles.includes('admin') || actor.roles.includes('orpsd')) return true;
  if (kind === 'responsible' || !role) return false;
  if (!actor.roles.includes(role as never)) return false;
  return role !== 'branch' || sameBranch;
}

export function registerExecutorRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  /** Кто ведёт заявку и кому её можно передать (с текущей нагрузкой). */
  router.get('/api/v1/requests/:id/executors', async (ctx) => {
    const actor = await deps.actor(ctx);
    if (rbac.isCustomer(actor)) throw ApiError.forbidden();
    const request = await deps.loadVisible(actor, ctx.params.id);
    const info = await executors.executorsOf(db, request.uuid);
    if (!info) throw ApiError.notFound('Заявка не найдена');
    const sameBranch = !!actor.branchId && actor.branchId === request.branchId;
    return {
      responsible: info.responsible,
      stage: info.stage,
      stageRole: info.stageRole,
      ownerParty: info.ownerParty,
      canChangeResponsible: !info.card.closed && mayChange(actor, 'responsible', null, sameBranch),
      canChangeStage: !info.card.closed && info.card.stageCode !== 'draft' && mayChange(actor, 'stage', info.stageRole, sameBranch),
      responsibleCandidates: info.responsibleCandidates,
      stageCandidates: info.stageCandidates,
    };
  });

  /** Передача заявки другому сотруднику. */
  router.post('/api/v1/requests/:id/executor', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    if (rbac.isCustomer(actor)) throw ApiError.forbidden();
    const request = await deps.loadVisible(actor, ctx.params.id);
    const body = await ctx.body<{ kind?: string; userId?: string; reason?: string }>();
    const kind = body.kind === 'responsible' ? 'responsible' : body.kind === 'stage' ? 'stage' : null;
    if (!kind) throw ApiError.badRequest('Укажите, кого назначить', { kind: 'responsible или stage' });
    const info = await executors.executorsOf(db, request.uuid);
    if (!info) throw ApiError.notFound('Заявка не найдена');
    if (info.card.closed || info.card.stageCode === 'draft') {
      throw ApiError.conflict('Исполнитель назначается по поданной и не закрытой заявке');
    }

    const role = kind === 'responsible' ? 'orpsd' : info.stageRole;
    const sameBranch = !!actor.branchId && actor.branchId === request.branchId;
    if (!mayChange(actor, kind, info.stageRole, sameBranch)) {
      await repo.logEvent(db, {
        ...deps.audit(ctx, actor), action: 'Отказ в передаче заявки', entity: 'request', entityId: request.uuid,
        detail: `${request.number}: ${KIND_TITLE[kind]}`, result: 'denied', regulationRef: 'п. 102',
      });
      throw ApiError.forbidden(kind === 'responsible'
        ? 'Ответственного назначает ОР ПСД'
        : 'Исполнителя этапа назначает подразделение, которое его выполняет, или ОР ПСД');
    }
    const target = role ? await executors.eligible(db, String(body.userId ?? ''), role, request.branchId) : null;
    if (!target) {
      throw ApiError.badRequest('Проверьте исполнителя', {
        userId: role === 'branch' ? 'Нужен действующий сотрудник филиала этой заявки' : 'Нужен действующий сотрудник подразделения, которое исполняет этап',
      });
    }
    const previous = kind === 'responsible' ? info.responsible : info.stage;
    if (previous?.id === target.id) return { executors: await executors.executorsOf(db, request.uuid).then(strip) };

    const reason = String(body.reason ?? '').trim().slice(0, 500);
    await db.tx(async (t) => {
      if (kind === 'responsible') await executors.setResponsible(t, request.uuid, target.id);
      else await executors.setStageExecutor(t, request.uuid, target.id);
      await announce(t, request, [{ kind, from: previous?.id ?? null, to: target }], deps.audit(ctx, actor), reason);
    });
    return { executors: await executors.executorsOf(db, request.uuid).then(strip) };
  });
}

function strip(info: Awaited<ReturnType<typeof executors.executorsOf>>) {
  if (!info) return null;
  const { card: _card, ...rest } = info;
  return rest;
}
