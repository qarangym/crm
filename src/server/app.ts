/**
 * Сборка приложения: маршруты API поверх процессного движка и репозитория.
 *
 * Все переходы по этапам идут через движок (src/process): условия Регламента
 * нельзя обойти, обратившись к API напрямую. Прямое изменение поля `stage_code`
 * маршрутами не предусмотрено.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../db/client.ts';
import * as repo from '../db/repo.ts';
import { ApiError } from './errors.ts';
import type { AuthConfig, Identity } from './auth.ts';
import { checkOrigin, requireIdentity } from './auth.ts';
import type { Actor } from './rbac.ts';
import * as rbac from './rbac.ts';
import type { Ctx } from './http.ts';
import { Router, clientIp, readJson, sendError, sendJson, sendStatic } from './http.ts';

import { STAGES, stage } from '../process/stages.ts';
import { TRANSITIONS } from '../process/transitions.ts';
import { AUTOMATION_RULES } from '../process/rules.ts';
import { applyTransition, canTransition, customerStatus, openStage, TransitionError } from '../process/engine.ts';
import type { StageCode } from '../process/stages.ts';
import { boardColumns, breakdownByParty, bottlenecks, stageMetrics } from '../process/metrics.ts';
import { validateRequest } from '../domain/validation.ts';
import { estimate } from '../domain/pricing.ts';
import { today } from '../domain/calendar.ts';
import { CUSTOMER_STATUS_NAME, OWNER_PARTY_NAME, SERVICE_NAME } from '../domain/types.ts';
import type { Service, Tariff } from '../domain/types.ts';

export type AppOptions = {
  db: Db;
  auth: AuthConfig;
  appOrigin?: string;
  /** Каталог со статикой интерфейса. */
  staticRoot?: string;
  trustProxy?: boolean;
  bootstrapAdminEmail?: string;
};

export function createApp(options: AppOptions) {
  const { db, auth } = options;
  const router = new Router();

  /* --------------------------- вспомогательное --------------------------- */

  async function actorOf(identity: Identity): Promise<Actor> {
    let actor = await repo.findActorByIdentity(db, identity);
    if (!actor && options.bootstrapAdminEmail &&
        identity.email === options.bootstrapAdminEmail.toLowerCase()) {
      // Первичная настройка: первый вход указанного адреса создаёт администратора,
      // если администраторов ещё нет. Дальше роли назначает ДИТ вручную.
      if (await repo.bootstrapAdmin(db, identity.email, identity.displayName)) {
        actor = await repo.findActorByIdentity(db, identity);
      }
    }
    if (!actor) {
      throw ApiError.forbidden(
        'Учётная запись не заведена в системе. Обратитесь в ДИТ для назначения прав.');
    }
    if (!actor.isActive) throw ApiError.forbidden('Учётная запись отключена');
    return actor;
  }

  const auditOf = (ctx: Ctx, actor: Actor | null) => ({
    actorId: actor?.id ?? null,
    actorName: actor?.fullName ?? '',
    ip: ctx.ip,
    userAgent: String(ctx.req.headers['user-agent'] ?? '').slice(0, 500),
  });

  /* ------------------------------- маршруты ------------------------------ */

  router.get('/api/v1/health', async () => {
    const row = await db.one<{ ok: number }>('SELECT 1 AS ok');
    return { status: row ? 'ok' : 'degraded', time: new Date().toISOString() };
  });

  /** Конфигурация процесса для интерфейса: этапы, переходы, правила, словари. */
  router.get('/api/v1/config', () => ({
    stages: STAGES.map((s) => ({
      code: s.code, order: s.order, name: s.name, short: s.short,
      slaValue: s.slaValue, slaUnit: s.slaUnit, slaText: s.slaText,
      ownerParty: s.ownerParty, ownerName: OWNER_PARTY_NAME[s.ownerParty],
      serviceScope: s.serviceScope ?? null, customerStatus: s.customerStatus,
      customerStatusName: CUSTOMER_STATUS_NAME[s.customerStatus],
      terminal: s.terminal, regulationRef: s.regulationRef, hint: s.hint,
    })),
    transitions: TRANSITIONS.map((t) => ({
      from: t.from, to: t.to, title: t.title, roles: t.roles, regulationRef: t.regulationRef,
    })),
    rules: AUTOMATION_RULES,
    ownerParties: OWNER_PARTY_NAME,
    services: SERVICE_NAME,
  }));

  router.get('/api/v1/me', async (ctx) => {
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    return {
      id: actor.id, email: actor.email, fullName: actor.fullName, roles: actor.roles,
      branchId: actor.branchId, counterpartyId: actor.counterpartyId,
      permissions: [...rbac.permissionsOf(actor.roles)],
    };
  });

  router.get('/api/v1/facilities', async (ctx) => {
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'registry.view');
    return { facilities: await repo.listFacilities(db) };
  });

  router.get('/api/v1/tariffs', async (ctx) => {
    await actorOf(requireIdentity(ctx.req.headers, auth));
    return { tariffs: await repo.listTariffs(db, today()) };
  });

  router.get('/api/v1/requests', async (ctx) => {
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'request.view');
    const rows = await repo.listRequests(db, {
      scope: rbac.requestScope(actor),
      stageCode: (ctx.query.get('stage') as StageCode) || undefined,
      branchId: ctx.query.get('branch') || undefined,
      service: (ctx.query.get('service') as Service) || undefined,
      limit: Number(ctx.query.get('limit') ?? 100),
      offset: Number(ctx.query.get('offset') ?? 0),
    });
    return {
      requests: rows.map((r) => ({
        ...r,
        customerStatus: customerStatus(r),
        customerStatusName: CUSTOMER_STATUS_NAME[customerStatus(r)],
        stageName: stage(r.stageCode).name,
      })),
    };
  });

  router.get('/api/v1/requests/:id', async (ctx) => {
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    const request = await loadVisible(actor, ctx.params.id);
    const [services, remarks, history, events] = await Promise.all([
      repo.listRequestServices(db, request.uuid),
      repo.listRemarks(db, request.uuid),
      repo.stageHistory(db, request.uuid),
      repo.listEvents(db, 'request', request.uuid, 100),
    ]);
    const current = await repo.currentStageRecord(db, request.uuid);
    const available = TRANSITIONS
      .filter((t) => t.from === request.stageCode)
      .filter((t) => {
        const scope = stage(t.to).serviceScope;
        return !scope || request.services.includes(scope);
      })
      .map((t) => {
        const check = canTransition(request, t.to);
        return {
          to: t.to, title: t.title, regulationRef: t.regulationRef, roles: t.roles,
          allowed: check.ok, failures: check.ok ? [] : check.failures,
        };
      });
    return {
      request: { ...request, customerStatus: customerStatus(request) },
      services, remarks, history, events, currentStage: current, transitions: available,
    };
  });

  async function loadVisible(actor: Actor, id: string) {
    rbac.require(actor, 'request.view');
    const request = await repo.getRequest(db, id);
    if (!request) throw ApiError.notFound('Заявка не найдена');
    const scope = rbac.requestScope(actor);
    if (scope.kind === 'none') throw ApiError.forbidden();
    if (scope.kind === 'counterparty' && request.counterpartyId !== scope.id) {
      throw ApiError.forbidden('Нет доступа к чужой заявке');
    }
    if (scope.kind === 'branch' && request.branchId !== scope.id) {
      throw ApiError.forbidden('Заявка другого филиала');
    }
    return request;
  }

  /** Подача заявки. Номер присваивается сразу (п. 6, ТЗ №7). */
  router.post('/api/v1/requests', async (ctx) => {
    checkOrigin(ctx.req.headers.origin as string | undefined, options.appOrigin);
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'request.create');

    const body = await ctx.body<{
      counterpartyId?: string; facilityId?: string; draft?: boolean;
      applicant?: Record<string, unknown>;
      services?: { service: Service; placement: string; params: Record<string, unknown>;
                   tariffId?: string; tariffQuantity?: number; basisReference?: string }[];
    }>();

    const draft = body.draft === true;
    const counterpartyId = rbac.isCustomer(actor)
      ? (actor.counterpartyId ?? '')            // Заказчик подаёт только от своей организации
      : String(body.counterpartyId ?? '');
    if (!counterpartyId) throw ApiError.badRequest('Не определена организация Заказчика');

    const errors = validateRequest(
      { ...(body.applicant ?? {}), facilityId: body.facilityId, services: body.services ?? [] } as never,
      draft,
    );
    if (Object.keys(errors).length) throw ApiError.badRequest('Проверьте заполнение формы', errors);

    const facility = (await repo.listFacilities(db)).find((f) => f.id === body.facilityId);
    if (!facility) throw ApiError.badRequest('Выберите объект из справочника', { facilityId: 'Объект не найден' });

    const tariffs = (await repo.listTariffs(db, today())) as unknown as Tariff[];
    const services = (body.services ?? []).map((s) => ({
      service: s.service, placement: s.placement, params: s.params ?? {},
      tariffId: s.tariffId ?? null, tariffQuantity: s.tariffQuantity ?? null,
      basisReference: s.basisReference ?? null,
    }));
    const priced = estimate(services as never, tariffs, today());
    const freeOfCharge = priced.lines.every((l) => l.amount === 0);

    const cal = await repo.calendar(db);
    const stageCode: StageCode = draft ? 'draft' : 'registered';
    const snapshot = { id: 0, services: services.map((s) => s.service) } as never;
    const record = openStage(snapshot, stageCode, today(), cal);

    const created = await repo.createRequest(db, {
      counterpartyId,
      facilityId: facility.id,
      branchId: facility.branch_id,
      createdBy: actor.id,
      stageCode,
      freeOfCharge,
      totalAmount: priced.hasUndetermined ? null : priced.total,
      services: services.map((s, i) => ({ ...s, amount: priced.lines[i]?.amount ?? null })),
    }, record);

    await repo.logEvent(db, {
      ...auditOf(ctx, actor),
      action: draft ? 'Сохранён черновик заявки' : 'Заявка подана через портал',
      entity: 'request', entityId: created.uuid,
      detail: `${created.number} · ${services.map((s) => s.service).join(', ')}`,
      regulationRef: 'п. 6',
    });
    return { request: created, estimate: priced };
  });

  /** Переход по этапам. Единственный способ сменить этап заявки. */
  router.post('/api/v1/requests/:id/transition', async (ctx) => {
    checkOrigin(ctx.req.headers.origin as string | undefined, options.appOrigin);
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'request.transition');

    const body = await ctx.body<{
      to?: StageCode; reason?: string; version?: number;
      offerExpired?: boolean; silenceAccepted?: boolean;
    }>();
    const request = await loadVisible(actor, ctx.params.id);
    if (!body.to) throw ApiError.badRequest('Не указан целевой этап');

    const definition = TRANSITIONS.find((t) => t.from === request.stageCode && t.to === body.to);
    if (definition && !definition.roles.some((r) => actor.roles.includes(r as never))) {
      await repo.logEvent(db, {
        ...auditOf(ctx, actor), action: 'Отказ в переходе по правам', entity: 'request',
        entityId: request.uuid, detail: `${request.stageCode} → ${body.to}`, result: 'denied',
        regulationRef: definition.regulationRef,
      });
      throw ApiError.forbidden('Этот переход выполняет другое подразделение');
    }

    const cal = await repo.calendar(db);
    const current = await repo.currentStageRecord(db, request.uuid);
    const input = { reason: body.reason, offerExpired: body.offerExpired, silenceAccepted: body.silenceAccepted };

    let outcome;
    try {
      outcome = applyTransition(request, current, body.to, input, { calendar: cal, now: today() });
    } catch (error) {
      if (error instanceof TransitionError) {
        await repo.logEvent(db, {
          ...auditOf(ctx, actor), action: 'Переход отклонён по Регламенту', entity: 'request',
          entityId: request.uuid, detail: error.message, result: 'denied',
        });
        throw ApiError.regulation(error.failures as never);
      }
      throw error;
    }

    await db.tx(async (t) => {
      const ok = await repo.updateStage(
        t, request.uuid, outcome.opened.stageCode,
        customerStatus(outcome.request), body.version ?? request.version,
        body.to === 'closed_done' || String(body.to).startsWith('closed_')
          ? { closed_at: new Date().toISOString(), closed_reason: body.reason ?? null }
          : {},
      );
      if (!ok) throw ApiError.conflict('Карточка изменилась. Обновите заявку и повторите');
      if (outcome.closed) {
        await repo.closeStageRecord(t, request.uuid, today(), outcome.closed.breached);
      }
      await repo.openStageRecord(t, request.uuid, outcome.opened);
      if (body.to !== 'draft') await repo.resolveRemarks(t, request.uuid);
      for (const event of outcome.events) {
        await repo.logEvent(t, {
          ...auditOf(ctx, actor), action: event.message, entity: 'request',
          entityId: request.uuid, detail: body.reason ?? '', regulationRef: event.regulationRef ?? null,
        });
      }
    });

    return { request: await repo.getRequest(db, request.uuid) };
  });

  /** Фиксация оценки технической возможности (раздел 4, п. 16.5). */
  router.post('/api/v1/requests/:id/tv', async (ctx) => {
    checkOrigin(ctx.req.headers.origin as string | undefined, options.appOrigin);
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'request.tv');

    const body = await ctx.body<{
      status?: 'pending' | 'confirmed' | 'unavailable';
      masterFileVersion?: string;
      verificationCalc?: 'not_required' | 'required' | 'done' | null;
      version?: number;
    }>();
    const request = await loadVisible(actor, ctx.params.id);

    if (body.status === 'confirmed' && !String(body.masterFileVersion ?? '').trim()) {
      throw ApiError.regulation([{
        code: 'no_master_version',
        message: 'Укажите версию мастер-файла «Реестр АМС и загрузки», использованную при расчёте',
        regulationRef: 'п. 16.5',
      }]);
    }

    const ok = await repo.updateStage(
      db, request.uuid, request.stageCode, customerStatus(request),
      body.version ?? request.version,
      {
        tv_status: body.status ?? request.tvStatus,
        master_file_version: body.masterFileVersion ?? request.masterFileVersion,
        verification_calc: body.verificationCalc ?? request.verificationCalcDecision,
      },
    );
    if (!ok) throw ApiError.conflict('Карточка изменилась. Обновите заявку и повторите');

    await repo.logEvent(db, {
      ...auditOf(ctx, actor), action: 'Зафиксирована оценка технической возможности',
      entity: 'request', entityId: request.uuid,
      detail: `${body.status ?? request.tvStatus} · реестр ${body.masterFileVersion ?? ''}`,
      regulationRef: 'пп. 16.3, 16.5',
    });
    return { request: await repo.getRequest(db, request.uuid) };
  });

  /** Замечания к полям формы — основание возврата на доработку (ТЗ №11). */
  router.post('/api/v1/requests/:id/remarks', async (ctx) => {
    checkOrigin(ctx.req.headers.origin as string | undefined, options.appOrigin);
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'request.remark');

    const body = await ctx.body<{ remarks?: { field: string; text: string }[] }>();
    const remarks = (body.remarks ?? []).filter((r) => r.field && r.text?.trim());
    if (!remarks.length) {
      throw ApiError.badRequest('Укажите хотя бы одно замечание с перечнем необходимых исправлений');
    }
    const request = await loadVisible(actor, ctx.params.id);

    await db.tx(async (t) => {
      for (const r of remarks) await repo.addRemark(t, request.uuid, r.field, r.text.trim(), actor.id);
      await repo.updateStage(t, request.uuid, request.stageCode, 'clarification', request.version);
      await repo.logEvent(t, {
        ...auditOf(ctx, actor), action: 'Заявка возвращена на доработку',
        entity: 'request', entityId: request.uuid,
        detail: remarks.map((r) => `${r.field}: ${r.text}`).join('; '), regulationRef: 'ТЗ №11',
      });
    });
    return { request: await repo.getRequest(db, request.uuid), remarks: await repo.listRemarks(db, request.uuid) };
  });

  /** Доска: колонки-этапы со счётчиками и карточками. */
  router.get('/api/v1/board', async (ctx) => {
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'request.view');
    const rows = await repo.listRequests(db, { scope: rbac.requestScope(actor), limit: 500 });
    const open = await repo.allStageRecords(db, 400);
    const records = (open as Record<string, any>[])
      .filter((r) => !r.left_at)
      .map(toStageRecord);
    return {
      columns: boardColumns(records, today()),
      cards: rows.map((r) => ({
        id: r.uuid, number: r.number, stageCode: r.stageCode,
        counterparty: r.counterpartyName, facility: r.facilityName, branch: r.branchName,
        services: r.services, totalAmount: r.totalAmount, openRemarks: r.openRemarks,
        customerStatus: customerStatus(r),
      })),
    };
  });

  /** Показатели узких мест: медиана против норматива и разбивка по сторонам. */
  router.get('/api/v1/metrics', async (ctx) => {
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'metrics.view');
    const cal = await repo.calendar(db);
    const records = ((await repo.allStageRecords(db, 400)) as Record<string, any>[]).map(toStageRecord);
    const metrics = stageMetrics(records, today(), cal);
    return {
      stages: metrics,
      bottlenecks: bottlenecks(metrics),
      byParty: breakdownByParty(records, today(), cal).map((p) => ({
        ...p, ownerName: OWNER_PARTY_NAME[p.ownerParty],
      })),
    };
  });

  function toStageRecord(row: Record<string, any>) {
    const iso = (v: unknown) => (v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10));
    return {
      requestId: 0,
      stageCode: row.stage_code as StageCode,
      enteredAt: iso(row.entered_at)!,
      leftAt: iso(row.left_at),
      dueAt: iso(row.due_at),
      slaValue: row.sla_value,
      slaUnit: row.sla_unit,
      ownerParty: row.owner_party,
      extendedBy: row.extended_by ?? 0,
      extensionReason: null,
      escalationLevel: row.escalation_level ?? 0,
      breached: row.breached ?? false,
    };
  }

  /* ------------------------------ обработчик ----------------------------- */

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      const route = router.match(req.method ?? 'GET', url.pathname);
      if (route) {
        const ctx: Ctx = {
          req, res, url, params: route.params, query: url.searchParams,
          ip: clientIp(req, options.trustProxy ?? false),
          body: <T>() => readJson<T>(req),
        };
        sendJson(res, 200, await route.handler(ctx));
        return;
      }
      if (url.pathname.startsWith('/api/')) throw ApiError.notFound('Метод API не найден');

      if (options.staticRoot && req.method === 'GET') {
        if (await sendStatic(res, options.staticRoot, url.pathname)) return;
      }
      throw ApiError.notFound('Страница не найдена');
    } catch (error) {
      sendError(res, error);
    }
  };
}
