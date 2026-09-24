/**
 * Сборка приложения: маршруты API поверх процессного движка и репозитория.
 *
 * Все переходы по этапам идут через движок (src/process): условия Регламента
 * нельзя обойти, обратившись к API напрямую. Прямое изменение поля `stage_code`
 * маршрутами не предусмотрено.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.ts';
import * as repo from '../db/repo.ts';
import * as docs from '../db/documents.ts';
import { parseMultipart } from './multipart.ts';
import { FileStore, actFingerprint } from '../storage/files.ts';
import { enqueue } from './notifications.ts';
import { ApiError } from './errors.ts';
import type { AuthConfig, Identity } from './auth.ts';
import { checkOrigin, originOfRequest, requireIdentity } from './auth.ts';
import type { Actor } from './rbac.ts';
import * as rbac from './rbac.ts';
import type { Ctx } from './http.ts';
import { RAW_RESPONSE, Router, clientIp, readJson, sendError, sendJson, sendStatic } from './http.ts';
import { RateLimiter } from './ratelimit.ts';
import type { RouteDeps } from './context.ts';
import { registerContractRoutes } from './contracts.ts';
import { registerAssignmentRoutes } from './assignments.ts';
import { registerMemoRoutes } from './memos.ts';
import { registerAmendmentRoutes } from './amendments.ts';
import * as contractsRepo from '../db/contracts.ts';
import * as assignmentsRepo from '../db/assignments.ts';
import * as memosRepo from '../db/memos.ts';

import { STAGES, stage } from '../process/stages.ts';
import { TRANSITIONS } from '../process/transitions.ts';
import { AUTOMATION_RULES } from '../process/rules.ts';
import { applyTransition, canTransition, customerStatus, openStage, TransitionError } from '../process/engine.ts';
import type { StageCode } from '../process/stages.ts';
import { boardColumns, breakdownByParty, bottlenecks, stageMetrics } from '../process/metrics.ts';
import { validateAmendment, validateRequest } from '../domain/validation.ts';
import { estimate } from '../domain/pricing.ts';
import { today } from '../domain/calendar.ts';
import { toIsoDate } from '../domain/dates.ts';
import { CUSTOMER_STATUS_NAME, OWNER_PARTY_NAME, ROLE_NAME, SERVICE_NAME } from '../domain/types.ts';
import type { RequestService, Role, Service, Tariff } from '../domain/types.ts';

export { RAW_RESPONSE } from './http.ts';

export type AppOptions = {
  db: Db;
  auth: AuthConfig;
  /** Хранилище файлов актов. Без него методы архива отвечают 503. */
  store?: FileStore;
  appOrigin?: string;
  /** Каталог со статикой интерфейса. */
  staticRoot?: string;
  trustProxy?: boolean;
  bootstrapAdminEmail?: string;
  /** Ограничение частоты запросов на один адрес. */
  rateLimit?: { windowMs?: number; max?: number };
};

export function createApp(options: AppOptions) {
  const { db, auth, store } = options;
  const router = new Router();

  /* --------------------------- вспомогательное --------------------------- */

  async function actorOf(identity: Identity): Promise<Actor> {
    let actor = await repo.findActorByIdentity(db, identity);
    if (actor === null && options.bootstrapAdminEmail &&
        identity.email === options.bootstrapAdminEmail.toLowerCase()) {
      // Первичная настройка: первый вход указанного адреса создаёт администратора,
      // если администраторов ещё нет. Дальше роли назначает ДИТ вручную.
      if (await repo.bootstrapAdmin(db, identity.email, identity.displayName)) {
        actor = await repo.findActorByIdentity(db, identity);
      }
    }
    if (actor === 'subject_mismatch') {
      throw ApiError.forbidden(
        'Этот адрес закреплён за другой учётной записью входа. Обратитесь в ДИТ для сверки.');
    }
    if (!actor) {
      throw ApiError.forbidden(
        'Учётная запись не заведена в системе. Обратитесь в ДИТ для назначения прав.');
    }
    if (!actor.isActive) throw ApiError.forbidden('Учётная запись отключена');
    return actor;
  }

  /** Изменяющая операция принимается только со своего сайта. */
  const guardOrigin = (ctx: Ctx) => checkOrigin(
    ctx.req.headers.origin as string | undefined,
    options.appOrigin,
    originOfRequest(ctx.req.headers, options.trustProxy ?? false),
  );

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

  /** Карточка объекта: ярусы и размещённое оборудование — для оценки ТВ (п. 16.2). */
  router.get('/api/v1/facilities/:id', async (ctx) => {
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'registry.view');
    const facility = (await repo.listFacilities(db)).find((f) => f.id === ctx.params.id);
    if (!facility) throw ApiError.notFound('Объект не найден');
    const [tiers, tenants] = await Promise.all([
      repo.listTiers(db, facility.id),
      repo.listTenants(db, facility.id),
    ]);
    return { facility, tiers, tenants };
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
    const [services, remarks, history, events, contracts, memos, assignments] = await Promise.all([
      repo.listRequestServices(db, request.uuid),
      repo.listRemarks(db, request.uuid),
      repo.stageHistory(db, request.uuid),
      repo.listEvents(db, 'request', request.uuid, 100),
      contractsRepo.listContracts(db, request.uuid),
      memosRepo.forRequest(db, request.uuid),
      rbac.can(actor, 'assignment.view') ? assignmentsRepo.forRequest(db, request.uuid) : Promise.resolve([]),
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
      services, remarks, history, events, contracts, memos, assignments,
      currentStage: current, transitions: available,
    };
  });

  /** Поручение ОР ПСД по зарегистрированной заявке (ТЗ №7, №8). */
  async function registerAssignment(
    t: Db, requestId: string, number: string, cal: Awaited<ReturnType<typeof repo.calendar>>,
    ctx: Ctx, actor: Actor,
  ): Promise<void> {
    const id = await assignmentsRepo.createForRequest(t, requestId, cal);
    if (!id) return;
    await repo.logEvent(t, {
      ...auditOf(ctx, actor), action: 'Создано поручение ОР ПСД', entity: 'request', entityId: requestId,
      detail: `${number}: ответ о технической возможности — не более 5 рабочих дней`, regulationRef: 'ТЗ №7, п. 9',
    });
  }

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
    guardOrigin(ctx);
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'request.create');

    const body = await ctx.body<{
      counterpartyId?: string; facilityId?: string; draft?: boolean;
      applicant?: Record<string, unknown>;
      services?: { service: Service; placement: string; params: Record<string, unknown>;
                   tariffId?: string; tariffQuantity?: number; basisReference?: string }[];
    }>();

    const draft = body.draft === true;
    const applicant = (body.applicant ?? {}) as Record<string, string>;

    const errors = validateRequest(
      { ...applicant, facilityId: body.facilityId, services: body.services ?? [] } as never,
      draft,
    );
    if (Object.keys(errors).length) throw ApiError.badRequest('Проверьте заполнение формы', errors);

    /*
     * Организация Заказчика. Представитель подаёт заявку только от своей
     * организации. Сотрудник Общества вносит заявку, поступившую бумагой или
     * почтой (п. 6): организация определяется по БИН, при отсутствии карточки
     * она заводится со статусом «на проверке».
     */
    let counterpartyId: string;
    if (rbac.isCustomer(actor)) {
      if (!actor.counterpartyId) {
        throw ApiError.forbidden('Учётная запись не привязана к организации. Обратитесь в ДИТ.');
      }
      counterpartyId = actor.counterpartyId;
    } else if (body.counterpartyId) {
      counterpartyId = String(body.counterpartyId);
    } else {
      const resolved = await repo.resolveCounterparty(db, {
        bin: String(applicant.bin ?? ''),
        company: String(applicant.company ?? ''),
        email: applicant.email, phone: applicant.phone, contact: applicant.contact,
      });
      counterpartyId = resolved.id;
      if (resolved.created) {
        await repo.logEvent(db, {
          ...auditOf(ctx, actor), action: 'Заведена карточка контрагента по заявке',
          entity: 'counterparty', entityId: counterpartyId,
          detail: `${applicant.company} · БИН ${applicant.bin} · требует проверки реквизитов`,
        });
      }
    }

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

    // ТЗ №7: заявка регистрируется вместе с поручением — в одной транзакции.
    const created = await db.tx(async (t) => {
      const row = await repo.createRequest(t, {
        counterpartyId,
        facilityId: facility.id,
        branchId: facility.branch_id,
        createdBy: actor.id,
        stageCode,
        freeOfCharge,
        totalAmount: priced.hasUndetermined ? null : priced.total,
        services: services.map((s, i) => ({ ...s, amount: priced.lines[i]?.amount ?? null })),
      }, record);
      await repo.logEvent(t, {
        ...auditOf(ctx, actor),
        action: draft ? 'Сохранён черновик заявки' : 'Заявка подана через портал',
        entity: 'request', entityId: row.uuid,
        detail: `${row.number} · ${services.map((s) => s.service).join(', ')}`,
        regulationRef: 'п. 6',
      });
      if (!draft) await registerAssignment(t, row.uuid, row.number ?? '', cal, ctx, actor);
      return row;
    });

    if (!draft) {
      // ТЗ №9: Заказчик получает подтверждение с регистрационным номером.
      const contact = String((body.applicant as Record<string, unknown> | undefined)?.email ?? '');
      await enqueue(db, {
        eventKey: 'request_submitted',
        recipient: contact,
        subject: `Заявка ${created.number} принята`,
        body: [
          'Ваша заявка принята и передана на регистрацию.',
          '',
          `Номер: ${created.number}`,
          `Объект: ${created.facilityName}`,
          `Услуги: ${services.map((s) => s.service).join(', ')}`,
          '',
          'Ответ о технической возможности направляется в срок не более 5 рабочих дней',
          'с даты регистрации (пункт 9 Регламента ОРПСД-Р-01).',
        ].join('\n'),
      });
    }
    return { request: created, estimate: priced };
  });

  /**
   * Регистрация заявки делопроизводством: входящий номер и дата (п. 6).
   * Без этих реквизитов заявка не уходит на оценку технической возможности —
   * порядок регистрации Регламентом закреплён за СП ЦА, ответственным за
   * документооборот, и система его не подменяет.
   */
  router.post('/api/v1/requests/:id/registration', async (ctx) => {
    guardOrigin(ctx);
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'request.register');

    const body = await ctx.body<{ incomingNumber?: string; incomingDate?: string; version?: number }>();
    const number = String(body.incomingNumber ?? '').trim();
    const date = String(body.incomingDate ?? '').trim();
    const fields: Record<string, string> = {};
    if (!number) fields.incomingNumber = 'Укажите входящий регистрационный номер';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fields.incomingDate = 'Укажите дату регистрации в формате ГГГГ-ММ-ДД';
    else if (date > today()) fields.incomingDate = 'Дата регистрации не может быть в будущем';
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте реквизиты регистрации', fields);

    const request = await loadVisible(actor, ctx.params.id);
    const ok = await repo.updateStage(
      db, request.uuid, request.stageCode, customerStatus(request),
      body.version ?? request.version,
      { incoming_number: number.slice(0, 64), incoming_date: date },
    );
    if (!ok) throw ApiError.conflict('Карточка изменилась. Обновите заявку и повторите');

    await repo.logEvent(db, {
      ...auditOf(ctx, actor), action: 'Заявка зарегистрирована делопроизводством',
      entity: 'request', entityId: request.uuid,
      detail: `вх. ${number} от ${date}`, regulationRef: 'п. 6',
    });
    return { request: await repo.getRequest(db, request.uuid) };
  });

  /** Переход по этапам. Единственный способ сменить этап заявки. */
  router.post('/api/v1/requests/:id/transition', async (ctx) => {
    guardOrigin(ctx);
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

    // Подача черновика: те же проверки, что при подаче сразу (ТЗ №4, №5).
    const submittingDraft = request.stageCode === 'draft' && body.to === 'registered';
    if (submittingDraft) {
      const stored = (await repo.listRequestServices(db, request.uuid)) as Record<string, any>[];
      const errors = validateAmendment({
        facilityId: request.facilityId,
        services: stored.map((s) => ({
          service: s.service, placement: s.placement, params: s.params ?? {},
          tariffId: s.tariff_id, tariffQuantity: s.tariff_quantity, basisReference: s.basis_reference,
        })) as RequestService[],
      });
      if (Object.keys(errors).length) throw ApiError.badRequest('Черновик заполнен не полностью', errors);
    }

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
          : submittingDraft ? { registered_at: new Date().toISOString() } : {},
      );
      if (!ok) throw ApiError.conflict('Карточка изменилась. Обновите заявку и повторите');
      if (outcome.closed) {
        await repo.closeStageRecord(t, request.uuid, today(), outcome.closed.breached);
      }
      await repo.openStageRecord(t, request.uuid, outcome.opened);
      if (submittingDraft) await registerAssignment(t, request.uuid, request.number ?? '', cal, ctx, actor);
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
    guardOrigin(ctx);
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
    guardOrigin(ctx);
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
      const customer = await t.one<{ email: string }>(
        'SELECT email FROM counterparties WHERE id = $1', [request.counterpartyId]);
      await enqueue(t, {
        eventKey: 'request_returned',
        recipient: customer?.email ?? '',
        subject: `Заявка ${request.number}: требуются уточнения`,
        body: [
          `По заявке ${request.number} необходимо внести исправления:`,
          '',
          ...remarks.map((r, i) => `${i + 1}. ${r.field} — ${r.text}`),
          '',
          'Исправьте указанные поля и отправьте заявку повторно.',
          'Новая заявка не создаётся, номер и история сохраняются.',
        ].join('\n'),
      });
    });
    return { request: await repo.getRequest(db, request.uuid), remarks: await repo.listRemarks(db, request.uuid) };
  });

  /* --------------------------- пользователи и роли ------------------------ */

  /**
   * Управление учётными записями. Роли назначает только ДИТ: Регламент
   * закрепляет действия за подразделениями, поэтому самопроизвольной выдачи
   * прав быть не должно. Каждое изменение пишется в журнал.
   */
  router.get('/api/v1/users', async (ctx) => {
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'admin');
    return { users: await repo.listUsers(db, ctx.query.get('q') ?? undefined) };
  });

  router.post('/api/v1/users', async (ctx) => {
    guardOrigin(ctx);
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'admin');

    const body = await ctx.body<{
      email?: string; fullName?: string; position?: string; department?: string;
      branchId?: string | null; counterpartyId?: string | null; roles?: Role[]; isActive?: boolean;
    }>();

    const email = String(body.email ?? '').trim().toLowerCase();
    const fullName = String(body.fullName ?? '').trim();
    const roles = (body.roles ?? []).filter((r) => r in ROLE_NAME) as Role[];
    const fields: Record<string, string> = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields.email = 'Укажите корректный адрес почты';
    if (fullName.length < 3) fields.fullName = 'Укажите фамилию и инициалы';
    if (!roles.length) fields.roles = 'Назначьте хотя бы одну роль';
    if (roles.includes('branch') && !body.branchId) fields.branchId = 'Для роли «Филиал» укажите филиал';
    if (roles.includes('customer') && !body.counterpartyId) {
      fields.counterpartyId = 'Для роли «Заказчик» укажите организацию';
    }
    if (email === actor.email && !roles.includes('admin')) {
      // Иначе администратор может случайно лишить себя прав и закрыть вход всем.
      fields.roles = 'Нельзя снять с себя роль администратора';
    }
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте данные сотрудника', fields);

    const saved = await repo.upsertUser(db, {
      email, fullName,
      position: String(body.position ?? '').slice(0, 255),
      department: String(body.department ?? '').slice(0, 128),
      branchId: body.branchId ?? null,
      counterpartyId: body.counterpartyId ?? null,
      isActive: body.isActive !== false,
      roles,
    });

    await repo.logEvent(db, {
      ...auditOf(ctx, actor), action: 'Назначены права пользователю', entity: 'user',
      entityId: saved.id, detail: `${email}: ${roles.map((r) => ROLE_NAME[r]).join(', ')}`,
    });
    return { user: saved };
  });

  router.post('/api/v1/users/:id/disable', async (ctx) => {
    guardOrigin(ctx);
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'admin');
    if (ctx.params.id === actor.id) throw ApiError.badRequest('Нельзя отключить собственную учётную запись');

    const ok = await repo.setUserActive(db, ctx.params.id, false);
    if (!ok) throw ApiError.notFound('Пользователь не найден');
    await repo.logEvent(db, {
      ...auditOf(ctx, actor), action: 'Учётная запись отключена', entity: 'user',
      entityId: ctx.params.id, detail: '',
    });
    return { ok: true };
  });

  /** Журнал действий: доступен ОКО и ДИТ (ТЗ №12). */
  router.get('/api/v1/audit', async (ctx) => {
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    if (!actor.roles.includes('admin') && !actor.roles.includes('oko')) throw ApiError.forbidden();
    return {
      events: await repo.searchEvents(db, {
        entity: ctx.query.get('entity') ?? undefined,
        actorId: ctx.query.get('actor') ?? undefined,
        result: ctx.query.get('result') ?? undefined,
        limit: Number(ctx.query.get('limit') ?? 200),
      }),
    };
  });

  /* ------------------ договоры, поручения, служебные записки ---------------- */

  const deps: RouteDeps = {
    db,
    actor: (ctx) => actorOf(requireIdentity(ctx.req.headers, auth)),
    guardOrigin,
    audit: auditOf,
    loadVisible,
  };
  registerContractRoutes(router, deps);
  registerAssignmentRoutes(router, deps);
  registerMemoRoutes(router, deps);
  registerAmendmentRoutes(router, deps);

  /* ------------------------------ архив актов ----------------------------- */

  /** Поиск по архиву: все критерии комбинируются (требование архива №4). */
  router.get('/api/v1/documents', async (ctx) => {
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'documents.view');
    const q = ctx.query;
    const rows = await docs.searchDocuments(db, {
      kind: q.get('kind') || undefined,
      facility: q.get('facility') || undefined,
      owner: q.get('owner') || undefined,
      contractor: q.get('contractor') || undefined,
      dateFrom: q.get('dateFrom') || undefined,
      dateTo: q.get('dateTo') || undefined,
      requestId: q.get('requestId') || undefined,
      // Филиал видит только свои документы; остальным ролям архив открыт целиком.
      branchId: onlyBranch(actor) ? (actor.branchId ?? '00000000-0000-0000-0000-000000000000') : undefined,
      limit: Number(q.get('limit') ?? 50),
      offset: Number(q.get('offset') ?? 0),
    });
    return { documents: rows };
  });

  router.get('/api/v1/documents/:id', async (ctx) => {
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    const document = await loadDocument(actor, ctx.params.id);
    await repo.logEvent(db, {
      ...auditOf(ctx, actor), action: 'Просмотр карточки документа', entity: 'document',
      entityId: document.id, detail: document.number,
    });
    return { document, versions: await docs.listVersions(db, document.id) };
  });

  /**
   * Форма акта по виду документа и составу услуг заявки.
   * Пункт 70 относит типовую форму № 2В к подрядным работам (СМР); для услуг
   * (ТУ, ПСД) применяется форма Р-1. Технический АВР филиала — по Приложению 6.
   */
  function resolveActForm(kind: string, requested: string, services: Service[]): string {
    const allowed = ['Р-1', '2В', 'Прил. 6', 'произвольная'];
    if (requested) return allowed.includes(requested) ? requested : 'invalid';
    if (kind === 'Технический АВР') return 'Прил. 6';
    if (kind === 'Акт приема-передачи') return 'произвольная'; // п. 58
    if (kind !== 'АВР') return '';
    const smr = services.includes('СМР');
    const other = services.some((s) => s !== 'СМР');
    if (smr && other) return 'ambiguous';
    if (smr) return '2В';
    return other ? 'Р-1' : '2В';
  }

  function onlyBranch(actor: Actor): boolean {
    return actor.roles.includes('branch') &&
      !actor.roles.some((r) => ['admin', 'orpsd', 'assets', 'accounting', 'management'].includes(r));
  }

  async function loadDocument(actor: Actor, id: string) {
    rbac.require(actor, 'documents.view');
    const document = await docs.getDocument(db, id);
    if (!document) throw ApiError.notFound('Документ не найден');
    if (onlyBranch(actor) && document.branch_id !== actor.branchId) {
      throw ApiError.forbidden('Документ другого филиала');
    }
    return document;
  }

  /**
   * Загрузка акта: карточка с реквизитами и файл.
   * Проверяется тип и сигнатура файла, дубликат по ключевым реквизитам
   * (требование архива №11) и принадлежность филиалу.
   */
  router.post('/api/v1/documents', async (ctx) => {
    guardOrigin(ctx);
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'documents.upload');
    if (!store) throw new ApiError('Хранилище файлов не настроено', 503, 'storage_unavailable');

    const form = await parseMultipart(ctx.req);
    const file = form.files[0];
    if (!file) throw ApiError.badRequest('Выберите файл');

    const meta = form.fields;
    const kind = String(meta.kind ?? '').trim();
    const allowedKinds = ['Акт приема-передачи', 'Технический АВР', 'АВР', 'ТУ', 'ПСД (РП)', 'Договор', 'Распоряжение', 'КП', 'Приложение'];
    if (!allowedKinds.includes(kind)) throw ApiError.badRequest('Укажите вид документа', { kind: 'Недопустимый вид' });

    // ОР ПСД загружает в архив окончательную версию АВР после подписания Заказчиком.
    if (actor.roles.includes('orpsd') && !actor.roles.includes('admin') &&
        !['АВР', 'Приложение'].includes(kind)) {
      throw ApiError.forbidden('ОР ПСД загружает окончательную версию АВР; акты приёма-передачи загружает филиал');
    }

    const fields: Record<string, string> = {};
    const required = kind === 'Приложение' ? ['number', 'docDate'] : ['number', 'docDate', 'facilityId', 'ownerId', 'contractor'];
    for (const key of required) if (!String(meta[key] ?? '').trim()) fields[key] = 'Заполните реквизит';
    const docDate = String(meta.docDate ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(docDate)) fields.docDate = 'Дата в формате ГГГГ-ММ-ДД';
    else if (docDate > today()) fields.docDate = 'Дата акта не может быть в будущем';
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте реквизиты документа', fields);

    const facilityId = String(meta.facilityId ?? '') || null;
    const facility = facilityId ? (await repo.listFacilities(db)).find((f) => f.id === facilityId) : null;
    if (facilityId && !facility) throw ApiError.badRequest('Объект не найден', { facilityId: 'Выберите объект' });
    if (onlyBranch(actor) && facility && facility.branch_id !== actor.branchId) {
      throw ApiError.forbidden('Можно загружать документы только своего филиала');
    }

    const fingerprint = kind === 'Приложение' ? null : actFingerprint({
      kind, number: String(meta.number), facilityId: facilityId ?? '',
      ownerId: String(meta.ownerId ?? ''), contractor: String(meta.contractor ?? ''), docDate,
    });
    if (fingerprint) {
      const duplicate = await docs.findByFingerprint(db, fingerprint);
      if (duplicate) {
        throw ApiError.conflict(
          `Акт с такими реквизитами уже зарегистрирован: ${duplicate.number} от ${String(duplicate.doc_date).slice(0, 10)}`);
      }
    }

    // Форма акта (п. 70): Р-1 для ТУ и ПСД, № 2В для СМР; технический АВР филиала — Приложение 6.
    const requestId = String(meta.requestId ?? '') || null;
    const linked = requestId ? await repo.getRequest(db, requestId) : null;
    if (requestId && !linked) throw ApiError.badRequest('Заявка не найдена', { requestId: 'Проверьте номер заявки' });
    const formCode = resolveActForm(kind, String(meta.formCode ?? '').trim(), linked?.services ?? []);
    if (formCode === 'ambiguous') {
      throw ApiError.badRequest('Укажите форму акта', {
        formCode: 'В заявке есть и услуги (ТУ, ПСД — форма Р-1), и СМР (форма № 2В): выберите форму этого акта',
      });
    }
    if (formCode === 'invalid') throw ApiError.badRequest('Недопустимая форма акта', { formCode: 'Допустимы: Р-1, 2В, Прил. 6' });

    const stored = await store.put(randomUUID(), file.filename, file.data);
    let documentId: string;
    try {
      documentId = await docs.createDocument(db, {
        requestId,
        kind, formCode,
        number: String(meta.number).trim(),
        facilityId, ownerId: String(meta.ownerId ?? '') || null,
        contractorName: String(meta.contractor ?? '').trim(),
        branchId: facility?.branch_id ?? actor.branchId,
        docDate, validUntil: String(meta.validUntil ?? '') || null,
        fingerprint, createdBy: actor.id,
      }, stored);
    } catch (error) {
      // Запись в базу не удалась — файл в хранилище не оставляем.
      await store.remove(stored.key).catch(() => {});
      throw error;
    }

    await repo.logEvent(db, {
      ...auditOf(ctx, actor), action: 'Загружен документ', entity: 'document', entityId: documentId,
      detail: `${kind} ${meta.number} · файл ${stored.fileName} · ${stored.sha256.slice(0, 12)}`,
      regulationRef: kind === 'Акт приема-передачи' ? 'п. 58' : kind === 'Технический АВР' ? 'п. 66'
        : kind === 'АВР' ? 'пп. 70, 91' : null,
    });
    return { document: await docs.getDocument(db, documentId) };
  });

  /** Замена файла: новая версия, визирование снимается. */
  router.post('/api/v1/documents/:id/versions', async (ctx) => {
    guardOrigin(ctx);
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'documents.upload');
    if (!store) throw new ApiError('Хранилище файлов не настроено', 503, 'storage_unavailable');

    const document = await loadDocument(actor, ctx.params.id);
    if (document.approved && !actor.roles.includes('admin')) {
      throw ApiError.forbidden('Завизированный документ защищён от изменения; замена доступна ДИТ');
    }
    const form = await parseMultipart(ctx.req);
    const file = form.files[0];
    if (!file) throw ApiError.badRequest('Выберите файл');

    const stored = await store.put(document.id, file.filename, file.data);
    const version = await docs.replaceFile(db, document.id, document.current_version, stored, actor.id);

    await repo.logEvent(db, {
      ...auditOf(ctx, actor), action: 'Загружена новая версия документа', entity: 'document',
      entityId: document.id, detail: `${stored.fileName} · версия ${version}`,
    });
    return { document: await docs.getDocument(db, document.id), version };
  });

  /** Визирование карточки. После него правка и удаление закрыты. */
  router.post('/api/v1/documents/:id/approve', async (ctx) => {
    guardOrigin(ctx);
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'documents.approve');
    const document = await loadDocument(actor, ctx.params.id);
    if (document.kind === 'Приложение') throw ApiError.badRequest('Приложение к заявке не визируется');

    const ok = await docs.approveDocument(db, document.id, actor.id);
    if (!ok) throw ApiError.conflict('Документ уже завизирован');

    await repo.logEvent(db, {
      ...auditOf(ctx, actor), action: 'Документ завизирован', entity: 'document',
      entityId: document.id, detail: `${document.kind} ${document.number}`,
      regulationRef: document.kind === 'Акт приема-передачи' ? 'п. 58'
        : document.kind === 'Технический АВР' ? 'п. 66' : document.kind === 'АВР' ? 'пп. 70, 91' : null,
    });
    return { document: await docs.getDocument(db, document.id) };
  });

  /** Удаление карточки — только до визирования (требование ТЗ по архиву). */
  router.post('/api/v1/documents/:id/delete', async (ctx) => {
    guardOrigin(ctx);
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'documents.upload');
    const document = await loadDocument(actor, ctx.params.id);
    if (document.approved) throw ApiError.forbidden('Завизированный документ удалить нельзя');

    const keys = await docs.deleteDocument(db, document.id);
    if (!keys.length) throw ApiError.conflict('Документ уже завизирован или удалён');
    if (store) for (const key of keys) await store.remove(key).catch(() => {});

    await repo.logEvent(db, {
      ...auditOf(ctx, actor), action: 'Удалена невизированная карточка документа', entity: 'document',
      entityId: document.id, detail: `${document.kind} ${document.number}`,
    });
    return { ok: true };
  });

  /** Скачивание файла. Каждое обращение фиксируется в журнале с именем файла. */
  router.get('/api/v1/documents/:id/file', async (ctx) => {
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    if (!store) throw new ApiError('Хранилище файлов не настроено', 503, 'storage_unavailable');
    const document = await loadDocument(actor, ctx.params.id);
    const version = Number(ctx.query.get('version')) || document.current_version;
    const row = await docs.getVersion(db, document.id, version);
    if (!row) throw ApiError.notFound('Версия файла не найдена');

    const preview = ctx.query.get('preview') === '1';
    await repo.logEvent(db, {
      ...auditOf(ctx, actor), action: preview ? 'Просмотр файла' : 'Скачивание файла',
      entity: 'document', entityId: document.id,
      detail: `${row.file_name} · версия ${version}`,
    });

    const { stream, size } = await store.read(row.storage_key);
    const inline = preview && ['application/pdf', 'image/png', 'image/jpeg'].includes(row.mime);
    ctx.res.writeHead(200, {
      'Content-Type': row.mime,
      'Content-Length': size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    });
    stream.pipe(ctx.res);
    return RAW_RESPONSE;
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
        dueAt: r.dueAt, escalationLevel: r.escalationLevel, ownerParty: r.ownerParty,
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
      memos: await memosRepo.answerStats(db),
    };
  });

  function toStageRecord(row: Record<string, any>) {
    const iso = toIsoDate;
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

  // Ограничение частоты: защищает пул соединений от зациклившегося клиента.
  const limiter = new RateLimiter({
    windowMs: Number(options.rateLimit?.windowMs ?? 60_000),
    max: Number(options.rateLimit?.max ?? 300),
  });

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      const route = router.match(req.method ?? 'GET', url.pathname);
      if (route) {
        const ip = clientIp(req, options.trustProxy ?? false);
        // Проверка доступности не ограничивается: её опрашивает мониторинг.
        if (url.pathname !== '/api/v1/health') {
          const verdict = limiter.check(ip ?? 'unknown');
          if (!verdict.allowed) {
            res.setHeader('Retry-After', String(verdict.retryAfterSec));
            throw new ApiError(
              'Слишком много запросов. Повторите через несколько секунд.', 429, 'rate_limited');
          }
        }
        const ctx: Ctx = {
          req, res, url, params: route.params, query: url.searchParams,
          ip,
          body: <T>() => readJson<T>(req),
        };
        const result = await route.handler(ctx);
        // Обработчик мог записать ответ сам — например, отдать файл потоком.
        if (result !== RAW_RESPONSE) sendJson(res, 200, result);
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
