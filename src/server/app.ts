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
import type { Scanner } from '../storage/antivirus.ts';
import { ScannerUnavailableError } from '../storage/antivirus.ts';
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
import { registerUserRoutes } from './users.ts';
import { registerMonitoringRoutes } from './monitoring.ts';
import { registerCapacityRoutes } from './capacity.ts';
import { registerReportRoutes } from './reports.ts';
import { registerAttachmentRoutes } from './attachments.ts';
import { registerControlRoutes } from './controls.ts';
import { assignMissing, registerExecutorRoutes } from './executors.ts';
import { loadStageOverrides, registerDirectoryRoutes } from './directories.ts';
import { registerPermitRoutes } from '../permits/server/routes.ts';
import { customerContract, customerRequest, customerTimeline } from './customer.ts';
import * as notices from './events.ts';
import { notify, roleRecipients } from './notify.ts';
import * as contractsRepo from '../db/contracts.ts';
import * as assignmentsRepo from '../db/assignments.ts';
import * as memosRepo from '../db/memos.ts';

import { currentStages, stage } from '../process/stages.ts';
import { TRANSITIONS } from '../process/transitions.ts';
import { AUTOMATION_RULES } from '../process/rules.ts';
import { applyTransition, canTransition, customerStatus, openStage, TransitionError } from '../process/engine.ts';
import type { StageCode } from '../process/stages.ts';
import { boardColumns, breakdownByParty, bottlenecks, stageMetrics } from '../process/metrics.ts';
import { validateAmendment, validateRequest } from '../domain/validation.ts';
import { estimate } from '../domain/pricing.ts';
import { addWorkingDays, isOverdue, today, workingDaysBetween } from '../domain/calendar.ts';
import { toIsoDate } from '../domain/dates.ts';
import { CUSTOMER_STATUS_NAME, OWNER_PARTY_NAME, SERVICE_NAME } from '../domain/types.ts';
import type { RequestService, Role, Service, Tariff } from '../domain/types.ts';

export { RAW_RESPONSE } from './http.ts';

export type AppOptions = {
  db: Db;
  auth: AuthConfig;
  /** Хранилище файлов актов. Без него методы архива отвечают 503. */
  store?: FileStore;
  /** Антивирусная проверка вложений до записи в хранилище (C2). Без неё проверяются тип и сигнатура. */
  scanner?: Scanner | null;
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
    stages: currentStages().map((s) => ({
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
    // Реквизиты организации Заказчика подставляются в форму заявки и не
    // вводятся заново: заявка подаётся только от своей организации (С1).
    const counterparty = actor.counterpartyId
      ? await db.one(
        `SELECT id, bin, name_full, contact_person, email, phone, status FROM counterparties WHERE id = $1`,
        [actor.counterpartyId])
      : null;
    const permissions = [...rbac.permissionsOf(actor.roles)];
    // Модули одной системы: заявки ОР ПСД (/) и портал допусков СУА (/dopusk/).
    const modules = [
      ...(permissions.some((p) => !p.startsWith('permit.')) ? ['orpsd'] : []),
      ...(permissions.some((p) => p.startsWith('permit.')) ? ['permits'] : []),
    ];
    return {
      id: actor.id, email: actor.email, fullName: actor.fullName, roles: actor.roles,
      branchId: actor.branchId, counterpartyId: actor.counterpartyId, counterparty,
      isCustomer: rbac.isCustomer(actor), isExternal: rbac.isExternal(actor),
      permissions, modules,
    };
  });

  /**
   * Справочник объектов. Полные сведения мастер-файла (загрузка, мощность) —
   * только с правом просмотра реестра: это коммерческая тайна (п. 12). Для
   * подачи заявки достаточно наименования, адреса и филиала (п. 16.1, К1).
   */
  router.get('/api/v1/facilities', async (ctx) => {
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    if (rbac.can(actor, 'registry.view')) return { facilities: await repo.listFacilities(db) };
    rbac.require(actor, 'request.create');
    return {
      facilities: (await repo.listFacilities(db)).map((f) => ({
        id: f.id, inv_no: f.inv_no, name: f.name, kind: f.kind, branch_id: f.branch_id,
        branch_name: f.branch_name, address: f.address, height_m: f.height_m,
      })),
    };
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
      state: (ctx.query.get('state') as 'open' | 'closed') || undefined,
      q: ctx.query.get('q') || undefined,
      // «Мои заявки»: где я ответственный ОР ПСД или исполнитель текущего этапа.
      executorId: ctx.query.get('executor') === 'me' ? actor.id : ctx.query.get('executor') || undefined,
      unassigned: ctx.query.get('unassigned') === '1',
    });
    if (rbac.isCustomer(actor)) {
      return { requests: rows.map((r) => ({ ...customerRequest(r), stageName: stage(r.stageCode).name })) };
    }
    return {
      requests: rows.map((r) => ({
        ...r,
        customerStatus: customerStatus(r),
        customerStatusName: CUSTOMER_STATUS_NAME[customerStatus(r)],
        stageName: stage(r.stageCode).name,
      })),
    };
  });

  /**
   * Условия, которые проверяет сервер, а не оператор: истёк ли срок оферты
   * (табл. 1) и истекли ли 10 рабочих дней на замечания к АВР (п. 94).
   * Признак, присланный из браузера, не принимается — иначе закрыть заявку
   * «по молчанию» можно было бы в любой день.
   */
  async function serverFacts(request: repo.RequestRow, current: Awaited<ReturnType<typeof repo.currentStageRecord>>) {
    const cal = await repo.calendar(db);
    const offerExpired = request.stageCode === 'awaiting_payment' && !!current?.dueAt && isOverdue(current.dueAt, today());
    const silenceFrom = await contractsRepo.silenceStart(db, request.uuid) ?? request.avrSentAt;
    const silenceUntil = silenceFrom ? addWorkingDays(silenceFrom, 10, cal) : null;
    const silenceAccepted = request.stageCode === 'closing' && !!silenceUntil && silenceUntil < today() &&
      !request.avrObjection && !await contractsRepo.hasObjection(db, request.uuid);
    return { offerExpired, silenceAccepted, offerUntil: request.stageCode === 'awaiting_payment' ? current?.dueAt ?? null : null, silenceUntil };
  }

  /** Переходы, требующие причины: отказ и расторжение (п. 19, табл. 1, пп. 96–97). */
  const NEEDS_REASON: StageCode[] = ['closed_rejected', 'closed_cancelled'];

  router.get('/api/v1/requests/:id', async (ctx) => {
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    const request = await loadVisible(actor, ctx.params.id);
    const customer = rbac.isCustomer(actor);
    const [services, remarks, history, events, contracts, memos, assignments, escalations] = await Promise.all([
      repo.listRequestServices(db, request.uuid),
      repo.listRemarks(db, request.uuid),
      repo.stageHistory(db, request.uuid),
      // Внутренний журнал с именами сотрудников Заказчику не отдаётся (В1).
      customer ? Promise.resolve([]) : repo.listEvents(db, 'request', request.uuid, 100),
      contractsRepo.listContracts(db, request.uuid),
      customer ? Promise.resolve([]) : memosRepo.forRequest(db, request.uuid),
      rbac.can(actor, 'assignment.view') ? assignmentsRepo.forRequest(db, request.uuid) : Promise.resolve([]),
      // Эскалации по п. 100 — внутреннее дело Общества, Заказчику не показываются.
      customer ? Promise.resolve([]) : db.query(
        `SELECT e.level, e.reason, e.created_at, n.full_name AS notified_name, c.full_name AS copy_name
           FROM escalations e
           LEFT JOIN users n ON n.id = e.notified_user_id LEFT JOIN users c ON c.id = e.copy_user_id
          WHERE e.request_id = $1 ORDER BY e.created_at`, [request.uuid]),
    ]);
    const current = await repo.currentStageRecord(db, request.uuid);
    const facts = await serverFacts(request, current);
    const available = TRANSITIONS
      .filter((t) => t.from === request.stageCode)
      .filter((t) => {
        const scope = stage(t.to).serviceScope;
        return !scope || request.services.includes(scope);
      })
      .filter((t) => !customer || t.roles.includes('customer'))
      .map((t) => {
        const needsReason = NEEDS_REASON.includes(t.to);
        // Причину спросит диалог: её отсутствие кнопку не блокирует (К2).
        const check = canTransition(request, t.to, {
          reason: needsReason ? 'указывается при подтверждении' : undefined,
          offerExpired: facts.offerExpired, silenceAccepted: facts.silenceAccepted,
        });
        return {
          to: t.to, title: t.title, regulationRef: t.regulationRef, roles: t.roles, needsReason,
          allowed: check.ok, failures: check.ok ? [] : check.failures,
          availableAfter: t.to === 'closed_expired' ? facts.offerUntil : t.to === 'closed_done' && !request.closingConfirmed ? facts.silenceUntil : null,
        };
      });

    if (customer) {
      return {
        request: customerRequest(request),
        services, remarks,
        history: customerTimeline(history, remarks),
        contracts: contracts.map(customerContract),
        transitions: available,
      };
    }
    return {
      request: { ...request, customerStatus: customerStatus(request) },
      services, remarks, history, events, contracts, memos, assignments, escalations,
      currentStage: current, transitions: available, facts,
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
      counterpartyId?: string; facilityId?: string; facilityAddress?: string; draft?: boolean;
      applicant?: Record<string, unknown>;
      services?: { service: Service; placement: string; params: Record<string, unknown>;
                   tariffId?: string; tariffQuantity?: number; basisReference?: string }[];
    }>();

    const draft = body.draft === true;
    const applicant = { ...(body.applicant ?? {}) } as Record<string, string>;
    // Представитель Заказчика подаёт заявку от своей организации: реквизиты
    // берутся из карточки контрагента, а не из формы (С1).
    let own: Record<string, string> | null = null;
    if (rbac.isCustomer(actor) && actor.counterpartyId) {
      own = await db.one<Record<string, string>>(
        `SELECT name_full AS company, bin, contact_person AS contact, email, phone FROM counterparties WHERE id = $1`,
        [actor.counterpartyId]);
      if (own) {
        applicant.company = own.company;
        applicant.bin = own.bin;
        for (const key of ['contact', 'email', 'phone'] as const) if (!String(applicant[key] ?? '').trim()) applicant[key] = own[key];
      }
    }

    const facilityAddress = String(body.facilityAddress ?? '').trim();
    const errors = validateRequest(
      { ...applicant, facilityId: body.facilityId, facilityAddress, services: body.services ?? [] } as never,
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

    const facility = body.facilityId ? (await repo.listFacilities(db)).find((f) => f.id === body.facilityId) : null;
    if (body.facilityId && !facility) throw ApiError.badRequest('Выберите объект из справочника', { facilityId: 'Объект не найден' });
    if (!facility && !facilityAddress) {
      throw ApiError.badRequest('Выберите объект из справочника либо укажите адрес', { facilityId: 'Объект не выбран' });
    }

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
        facilityId: facility?.id ?? null,
        branchId: facility?.branch_id ?? null,
        facilityAddress: facility ? null : facilityAddress,
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
      if (draft) return row;
      // У поданной заявки сразу есть исполнители: канцелярия и ответственный ОР ПСД (п. 102).
      await assignMissing(t, row, auditOf(ctx, actor));
      await registerAssignment(t, row.uuid, row.number ?? '', cal, ctx, actor);
      return (await repo.getRequest(t, row.uuid))!;
    });

    if (!draft) await afterSubmit(created, applicant.email, cal);
    return { request: rbac.isCustomer(actor) ? customerRequest(created) : created, estimate: priced };
  });

  /**
   * После подачи: подтверждение Заказчику с номером (ТЗ №9) и поручение на
   * контроль ОКО (ТЗ №7). Письмо — в очередь: сбой почты подачу не отменяет.
   */
  async function afterSubmit(created: repo.RequestRow, contactEmail: string | undefined, cal: Awaited<ReturnType<typeof repo.calendar>>) {
    await enqueue(db, {
      eventKey: 'request_submitted',
      recipient: String(contactEmail ?? ''),
      subject: `Заявка ${created.number} принята`,
      body: [
        'Ваша заявка принята и передана на регистрацию.',
        '',
        `Номер: ${created.number}`,
        `Объект: ${created.facilityName ?? created.facilityAddress ?? '—'}`,
        `Услуги: ${created.services.join(', ')}`,
        '',
        'Ответ о технической возможности направляется в срок не более 5 рабочих дней',
        'с даты регистрации (пункт 9 Регламента ОРПСД-Р-01).',
      ].join('\n'),
    });
    await notices.assignmentCreated(db, created, addWorkingDays(today(), 5, cal));
  }

  /**
   * Объект по адресу из заявки определяет Общество (п. 16.1, С5): от объекта
   * зависят филиал, куратор и данные реестра для оценки ТВ.
   */
  router.post('/api/v1/requests/:id/facility', async (ctx) => {
    guardOrigin(ctx);
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    if (!rbac.can(actor, 'request.register') && !rbac.can(actor, 'request.tv')) throw ApiError.forbidden();
    const request = await loadVisible(actor, ctx.params.id);
    if (!['draft', 'registered', 'tv_review'].includes(request.stageCode)) {
      throw ApiError.conflict('Объект определяется до оценки технической возможности');
    }
    const body = await ctx.body<{ facilityId?: string; version?: number }>();
    const facility = (await repo.listFacilities(db)).find((f) => f.id === body.facilityId);
    if (!facility) throw ApiError.badRequest('Выберите объект из справочника', { facilityId: 'Объект не найден' });
    await db.tx(async (t) => {
      const ok = await repo.updateRequestFields(t, request.uuid, body.version ?? request.version,
        { facility_id: facility.id, branch_id: facility.branch_id });
      if (!ok) throw ApiError.conflict('Карточка изменилась. Обновите заявку и повторите');
      await t.query(
        `UPDATE assignments SET payload = payload || jsonb_build_object('facility', jsonb_build_object('id', $2::text, 'name', $3::text),
                                                            'branch', jsonb_build_object('id', $4::text, 'name', $5::text))
          WHERE request_id = $1`, [request.uuid, facility.id, facility.name, facility.branch_id, facility.branch_name]);
      await repo.logEvent(t, {
        ...auditOf(ctx, actor), action: 'Объект определён по адресу из заявки', entity: 'request',
        entityId: request.uuid,
        detail: `${request.facilityAddress ?? ''} → ${facility.name} (инв. № ${facility.inv_no}), ${facility.branch_name}`,
        regulationRef: 'п. 16.1',
      });
    });
    const updated = (await repo.getRequest(db, request.uuid))!;
    if (updated.incomingNumber) await notices.requestRegistered(db, updated, await repo.calendar(db));
    return { request: updated };
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
    const registered = (await repo.getRequest(db, request.uuid))!;
    // В день регистрации заявка направляется в филиал (п. 6.2).
    await notices.requestRegistered(db, registered, await repo.calendar(db));
    return { request: registered };
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
    // Истечение оферты и срока замечаний к АВР определяет сервер по датам (табл. 1, п. 94).
    const facts = await serverFacts(request, current);
    const input = { reason: body.reason, offerExpired: facts.offerExpired, silenceAccepted: facts.silenceAccepted };

    // Подача черновика: те же проверки, что при подаче сразу (ТЗ №4, №5).
    const submittingDraft = request.stageCode === 'draft' && body.to === 'registered';
    if (submittingDraft) {
      const stored = (await repo.listRequestServices(db, request.uuid)) as Record<string, any>[];
      const errors = validateAmendment({
        facilityId: request.facilityId,
        facilityAddress: request.facilityAddress,
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
      // Исполнитель нового этапа назначается в том же действии — карточка не остаётся ничьей.
      if (!stage(outcome.opened.stageCode).terminal) await assignMissing(t, request, auditOf(ctx, actor));
      if (submittingDraft) await registerAssignment(t, request.uuid, request.number ?? '', cal, ctx, actor);
      for (const event of outcome.events) {
        await repo.logEvent(t, {
          ...auditOf(ctx, actor), action: event.message, entity: 'request',
          entityId: request.uuid, detail: body.reason ?? '', regulationRef: event.regulationRef ?? null,
        });
      }
      // Ответ о технической возможности — исполнение поручения ОР ПСД по существу (п. 9, В5).
      if (request.stageCode === 'tv_review') {
        const done = await assignmentsRepo.markFulfilled(t, request.uuid, today());
        if (done) {
          await repo.logEvent(t, {
            ...auditOf(ctx, actor), action: done.onTime ? 'Поручение исполнено в срок' : 'Поручение исполнено с нарушением срока',
            entity: 'request', entityId: request.uuid, detail: 'Дан ответ о технической возможности', regulationRef: 'п. 9',
          });
        }
      }
      // Расторжение (пп. 96–97): действующие договоры заявки прекращаются вместе с ней.
      if (body.to === 'closed_cancelled') {
        for (const c of await contractsRepo.activeContracts(t, request.uuid)) {
          await contractsRepo.terminateContract(t, c.id, today(), null);
          await repo.logEvent(t, {
            ...auditOf(ctx, actor), action: 'Договор расторгнут вместе с заявкой', entity: 'request',
            entityId: request.uuid, detail: `${c.service}: договор ${c.number}. ${body.reason ?? ''}`, regulationRef: 'пп. 96–97',
          });
        }
      }
      // Работы приняты — договоры исполнены (п. 127).
      if (body.to === 'closed_done') {
        for (const c of await contractsRepo.activeContracts(t, request.uuid)) {
          if (c.accepted_at) continue;
          await contractsRepo.updateAvr(t, c.id, {
            accepted_at: today(), accepted_by_silence: !request.closingConfirmed && facts.silenceAccepted,
          });
        }
      }
      if (stage(body.to!).terminal) {
        const n = await assignmentsRepo.closeForRequest(t, request.uuid, `Заявка закрыта: ${stage(body.to!).name.toLowerCase()}`);
        if (n) {
          await repo.logEvent(t, {
            ...auditOf(ctx, actor), action: 'Поручения по заявке закрыты вместе с ней', entity: 'request',
            entityId: request.uuid, detail: `поручений: ${n}`, regulationRef: 'ТЗ №7',
          });
        }
      }
    });

    const updated = (await repo.getRequest(db, request.uuid))!;
    await notifyTransition(updated, request.stageCode, body.to, body.reason ?? null, cal);
    return { request: updated };
  });

  /** Задача технического учёта по техническому акту монтажа (пп. 13–14; правило 19). */
  async function registryTaskAfterMount(r: repo.RequestRow, userId: string) {
    const services = (await repo.listRequestServices(db, r.uuid)) as Record<string, any>[];
    const smr = services.find((s) => s.service === 'СМР') ?? services[0];
    const p = smr?.params ?? {};
    const body = `Выполнен монтаж по заявке ${r.number} (${r.counterpartyName}): ${p.equipment ?? 'оборудование'}` +
      `${p.quantity ? `, ${p.quantity} шт.` : ''}${p.weight ? `, масса ${p.weight} кг` : ''}${p.height ? `, высота ${p.height} м` : ''}` +
      `${p.power ? `, мощность ${p.power} кВт` : ''}. Внесите изменения в реестр АМС и загрузки.`;
    const dueAt = addWorkingDays(today(), 1, await repo.calendar(db));
    const row = await db.one<{ id: string }>(
      `INSERT INTO registry_change_requests (facility_id, request_id, body, created_by, due_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`, [r.facilityId, r.uuid, body, userId, dueAt]);
    await repo.logEvent(db, {
      actorName: 'Система', action: 'Поставлена задача технического учёта: внести монтаж в реестр',
      entity: 'request', entityId: r.uuid, detail: `срок ${dueAt}`, regulationRef: 'пп. 13–14',
    });
    await notifyRoles(['assets'], {
      eventKey: 'registry_change_requested', ruleId: 19,
      subject: `Монтаж по заявке ${r.number}: изменить реестр АМС`,
      body: `${body}\n\nСрок — не позднее ${dueAt} (пп. 13–14 Регламента).`,
      payload: { changeId: row!.id, requestId: r.uuid },
    });
  }

  async function notifyRoles(roles: Role[], message: Parameters<typeof notify>[2]) {
    await notify(db, await roleRecipients(db, roles), message);
  }

  /** Письма по итогам перехода (В4): кому и что сообщить — по норме Регламента. */
  async function notifyTransition(r: repo.RequestRow, from: StageCode, to: StageCode, reason: string | null,
    cal: Awaited<ReturnType<typeof repo.calendar>>) {
    if (from === 'tv_review' && to === 'offer') await notices.tvAnswered(db, r, true, null);
    if (from === 'offer' && to === 'awaiting_payment') {
      const contracts = (await contractsRepo.activeContracts(db, r.uuid)).filter((c) => !c.paid_at);
      await notices.offerSent(db, r, r.dueAt, contracts);
    }
    if (['tu', 'psd', 'smr_prep', 'smr'].includes(to)) await notices.serviceStarted(db, r, to, r.dueAt);
    if (to === 'closing' && r.avrSentAt) await notices.avrSent(db, r, r.avrSentAt, cal);
    if (to === 'closed_rejected') {
      if (from === 'tv_review') await notices.tvAnswered(db, r, false, reason);
      else await notices.requestClosed(db, r, to, reason);
    }
    if (to === 'closed_cancelled' || to === 'closed_done') await notices.requestClosed(db, r, to, reason);
  }

  /** Фиксация оценки технической возможности (раздел 4, п. 16.5). */
  router.post('/api/v1/requests/:id/tv', async (ctx) => {
    guardOrigin(ctx);
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'request.tv');

    const body = await ctx.body<{
      status?: 'pending' | 'confirmed' | 'unavailable';
      masterFileVersion?: string;
      verificationCalc?: 'not_required' | 'required' | 'done' | null;
      /** Основание подтверждения ТВ вопреки последнему расчёту (п. 16.4). */
      overrideReason?: string;
      version?: number;
    }>();
    const request = await loadVisible(actor, ctx.params.id);
    const masterVersion = String(body.masterFileVersion ?? '').trim();

    if (body.status === 'confirmed' && !masterVersion) {
      throw ApiError.regulation([{
        code: 'no_master_version',
        message: 'Укажите версию мастер-файла «Реестр АМС и загрузки», использованную при расчёте',
        regulationRef: 'п. 16.5',
      }]);
    }
    // Версия выбирается из опубликованных службой технического учёта (пп. 13, 16.5, В7).
    // Пока ни одна версия не опубликована, указывается версия мастер-файла, как в нём записано.
    if (masterVersion) {
      const published = await db.query<{ version: string }>('SELECT version FROM registry_versions');
      if (published.length && !published.some((p) => p.version === masterVersion)) {
        throw ApiError.badRequest('Выберите версию реестра из опубликованных',
          { masterFileVersion: `Опубликованы: ${published.map((p) => p.version).join(', ')}` });
      }
    }
    // Решение за инженером (п. 16.4), но подтверждение вопреки расчёту фиксируется с основанием.
    let overrideReason: string | null = null;
    if (body.status === 'confirmed') {
      const last = await db.one<{ verdict: string; registry_version: string | null }>(
        `SELECT verdict, registry_version FROM capacity_checks WHERE request_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [request.uuid]);
      if (last?.verdict === 'insufficient') {
        overrideReason = String(body.overrideReason ?? '').trim();
        if (overrideReason.length < 10) {
          throw ApiError.regulation([{
            code: 'calc_insufficient',
            message: 'Последний расчёт по реестру показал недостаток ёмкости. Подтвердить ТВ можно, указав основание решения инженера',
            regulationRef: 'п. 16.4',
          }]);
        }
      }
    }

    const ok = await repo.updateStage(
      db, request.uuid, request.stageCode, customerStatus(request),
      body.version ?? request.version,
      {
        tv_status: body.status ?? request.tvStatus,
        master_file_version: masterVersion || request.masterFileVersion,
        verification_calc: body.verificationCalc ?? request.verificationCalcDecision,
        tv_override_reason: body.status === 'confirmed' ? overrideReason : null,
        // Повторная оценка ТВ по п. 47 снимает требование переоценки.
        ...(body.status === 'confirmed' && request.tvRecheckRequired ? { tv_recheck_required_at: null } : {}),
      },
    );
    if (!ok) throw ApiError.conflict('Карточка изменилась. Обновите заявку и повторите');

    await repo.logEvent(db, {
      ...auditOf(ctx, actor), action: 'Зафиксирована оценка технической возможности',
      entity: 'request', entityId: request.uuid,
      detail: `${body.status ?? request.tvStatus} · реестр ${masterVersion}` +
        (overrideReason ? ` · вопреки расчёту: ${overrideReason}` : ''),
      regulationRef: overrideReason ? 'пп. 16.3–16.5' : 'пп. 16.3, 16.5',
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

  /** Журнал действий: доступен ОКО и ДИТ (ТЗ №12). */
  const auditFilter = (q: URLSearchParams): repo.EventFilter => {
    const date = (key: string) => {
      const v = q.get(key) ?? '';
      return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
    };
    return {
      entity: q.get('entity') || undefined,
      entityId: q.get('entityId') || undefined,
      actorId: q.get('actorId') || undefined,
      actor: q.get('actor') || undefined,
      result: q.get('result') || undefined,
      q: q.get('q') || undefined,
      dateFrom: date('dateFrom'),
      dateTo: date('dateTo'),
      limit: Number(q.get('limit') ?? 200),
      offset: Number(q.get('offset') ?? 0),
    };
  };
  const requireAuditor = (actor: Actor) => {
    if (!actor.roles.includes('admin') && !actor.roles.includes('oko')) throw ApiError.forbidden();
  };

  router.get('/api/v1/audit', async (ctx) => {
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    requireAuditor(actor);
    return { events: await repo.searchEvents(db, auditFilter(ctx.query)) };
  });

  /** Выгрузка журнала в CSV с теми же фильтрами — для проверки и хранения. */
  router.get('/api/v1/audit/export', async (ctx) => {
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    requireAuditor(actor);
    const filter = { ...auditFilter(ctx.query), limit: 5000, offset: 0 };
    const rows = await repo.searchEvents(db, filter) as Record<string, any>[];
    const cell = (v: unknown) => {
      let text = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@]/.test(text)) text = "'" + text;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const RESULT: Record<string, string> = { success: 'выполнено', denied: 'отказ', error: 'ошибка' };
    const lines = [['Дата и время', 'Пользователь', 'IP', 'Действие', 'Объект', 'Идентификатор',
      'Подробности', 'Результат', 'Пункт Регламента'].map(cell).join(';')];
    for (const e of rows) {
      lines.push([new Date(e.occurred_at).toISOString(), e.actor_name, e.ip_address, e.action, e.entity,
        e.entity_id, e.detail, RESULT[e.result] ?? e.result, e.regulation_ref].map(cell).join(';'));
    }
    await repo.logEvent(db, {
      ...auditOf(ctx, actor), action: 'Выгрузка журнала действий', entity: 'audit', entityId: 'export',
      detail: `${rows.length} записей`, regulationRef: 'ТЗ №12',
    });
    ctx.res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'private, no-store',
    });
    ctx.res.end('\uFEFF' + lines.join('\r\n') + '\r\n');
    return RAW_RESPONSE;
  });

  /* ------------------ договоры, поручения, служебные записки ---------------- */

  const deps: RouteDeps = {
    db,
    actor: (ctx) => actorOf(requireIdentity(ctx.req.headers, auth)),
    guardOrigin,
    audit: auditOf,
    loadVisible,
    store,
    scan: (ctx, actor, file, entityId) => scanUpload(ctx, actor, file, entityId),
  };
  registerContractRoutes(router, deps);
  registerAssignmentRoutes(router, deps);
  registerMemoRoutes(router, deps);
  registerAmendmentRoutes(router, deps);
  registerUserRoutes(router, deps);
  registerMonitoringRoutes(router, deps);
  registerCapacityRoutes(router, deps);
  registerReportRoutes(router, deps);
  registerAttachmentRoutes(router, deps);
  registerControlRoutes(router, deps);
  registerExecutorRoutes(router, deps);
  registerDirectoryRoutes(router, deps);
  registerPermitRoutes(router, deps);

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
      requestNumber: q.get('request') || undefined,
      pending: q.get('pending') === '1',
      // Филиал видит только свои документы; остальным ролям архив открыт целиком.
      branchId: onlyBranch(actor) ? (actor.branchId ?? '00000000-0000-0000-0000-000000000000') : undefined,
      limit: Number(q.get('limit') ?? 50),
      offset: Number(q.get('offset') ?? 0),
    });
    return { documents: rows };
  });

  /** Выгрузка найденных документов архива в CSV с теми же фильтрами (С6). */
  router.get('/api/v1/documents/export', async (ctx) => {
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'documents.view');
    const q = ctx.query;
    const rows = await docs.searchDocuments(db, {
      kind: q.get('kind') || undefined, facility: q.get('facility') || undefined, owner: q.get('owner') || undefined,
      contractor: q.get('contractor') || undefined, dateFrom: q.get('dateFrom') || undefined, dateTo: q.get('dateTo') || undefined,
      requestNumber: q.get('request') || undefined, pending: q.get('pending') === '1',
      branchId: onlyBranch(actor) ? (actor.branchId ?? '00000000-0000-0000-0000-000000000000') : undefined,
      limit: 200, offset: 0,
    });
    const cell = (v: unknown) => {
      let text = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@]/.test(text)) text = "'" + text;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const lines = [['Вид', 'Номер', 'Форма', 'Заявка', 'Объект', 'Собственник', 'Подрядчик', 'Филиал', 'Дата', 'Действует до',
      'Завизирован', 'Файл'].map(cell).join(';')];
    for (const d of rows) {
      lines.push([d.kind, d.number, d.form_code, d.request_number, d.facility_name, d.owner_name, d.contractor_name, d.branch_name,
        d.doc_date, d.valid_until, d.approved ? 'да' : 'нет', d.file_name].map(cell).join(';'));
    }
    await repo.logEvent(db, {
      ...auditOf(ctx, actor), action: 'Выгрузка архива документов', entity: 'document', entityId: 'export',
      detail: `${rows.length} записей`,
    });
    ctx.res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="documents-${today()}.csv"`,
      'Cache-Control': 'private, no-store',
    });
    ctx.res.end('\uFEFF' + lines.join('\r\n') + '\r\n');
    return RAW_RESPONSE;
  });

  /** Сколько документов ждёт визы — отметка в меню (С14). */
  router.get('/api/v1/documents/pending-count', async (ctx) => {
    const actor = await actorOf(requireIdentity(ctx.req.headers, auth));
    rbac.require(actor, 'documents.view');
    return { count: await docs.pendingCount(db, onlyBranch(actor) ? actor.branchId ?? undefined : undefined) };
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
   * Форма бланка акта — поле карточки для поиска и отчётов; акт оформляется вне
   * системы и загружается готовым файлом. По ответу ОР ПСД (29.09.2026): Р-1 —
   * закрывающий документ по любому договору ОР ПСД (ТУ, ПСД, СМР), № 2В — акт
   * приёмки объёма и стоимости работ, он есть во всех договорах СМР (п. 70).
   * Поэтому АВР по ТУ и ПСД — только Р-1 (подставляется сам), по СМР — Р-1 или
   * № 2В на выбор, без значения по умолчанию. Без привязки к заявке (загрузка
   * старых актов в архив) форма не обязательна. Технический АВР филиала —
   * Приложение 6, акт приёма-передачи — произвольная форма (п. 58).
   */
  const ALL_KINDS = ['Акт приема-передачи', 'Технический АВР', 'АВР', 'ТУ', 'ПСД (РП)', 'Договор', 'Распоряжение', 'КП', 'Приложение'];
  const DOCUMENT_REF: Record<string, string> = {
    'Акт приема-передачи': 'п. 58', 'Технический АВР': 'п. 66', 'АВР': 'пп. 70, 91', 'ТУ': 'пп. 24, 31',
    'ПСД (РП)': 'пп. 42, 47', 'Договор': 'пп. 21, 32, 48', 'КП': 'п. 21', 'Распоряжение': 'п. 60',
  };

  /** Виды документов, которые загружает роль (В2). */
  function uploadKindsOf(actor: Actor): string[] {
    if (actor.roles.includes('admin')) return ALL_KINDS;
    const kinds = new Set<string>();
    if (actor.roles.includes('orpsd')) {
      for (const k of ['ТУ', 'ПСД (РП)', 'Договор', 'КП', 'Распоряжение', 'АВР', 'Приложение']) kinds.add(k);
    }
    if (actor.roles.includes('branch')) for (const k of ['Акт приема-передачи', 'Технический АВР']) kinds.add(k);
    return [...kinds];
  }

  /** Дата через N месяцев (п. 31 — 6 месяцев, п. 47 — 36 месяцев); конец месяца не «перескакивает». */
  function addMonths(iso: string, months: number): string {
    const [y, m, d] = iso.split('-').map(Number);
    const target = new Date(Date.UTC(y, m - 1 + months, 1));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(d, last));
    return target.toISOString().slice(0, 10);
  }

  function resolveActForm(kind: string, requested: string, services: Service[]): string | { error: string } {
    if (kind === 'АВР') {
      const smr = services.includes('СМР');
      const allowed = smr || !services.length ? ['Р-1', '2В'] : ['Р-1'];
      if (requested) {
        if (allowed.includes(requested)) return requested;
        return { error: allowed.length > 1 ? 'Допустимы: Р-1, 2В' : 'По ТУ и ПСД акт оформляется по форме Р-1; № 2В — только для СМР' };
      }
      if (!services.length) return '';
      return smr ? { error: 'Выберите форму акта по СМР: Р-1 или № 2В' } : 'Р-1';
    }
    const allowed = ['Р-1', '2В', 'Прил. 6', 'произвольная'];
    if (requested) return allowed.includes(requested) ? requested : { error: 'Допустимы: Р-1, 2В, Прил. 6' };
    if (kind === 'Технический АВР') return 'Прил. 6';
    if (kind === 'Акт приема-передачи') return 'произвольная'; // п. 58
    return '';
  }

  /**
   * Антивирусная проверка до записи файла. Заражённый файл отклоняется и
   * фиксируется в журнале как отказ; при недоступном антивирусе загрузка
   * откладывается — непроверенный файл в архив не попадает.
   */
  async function scanUpload(ctx: Ctx, actor: Actor, file: { filename: string; data: Buffer }, entityId: string) {
    const scanner = options.scanner;
    if (!scanner) return;
    let result;
    try {
      result = await scanner.scan(file.data, file.filename);
    } catch (error) {
      if (!(error instanceof ScannerUnavailableError)) throw error;
      await repo.logEvent(db, {
        ...auditOf(ctx, actor), action: 'Антивирусная проверка недоступна', entity: 'document',
        entityId, detail: `${file.filename}: ${error.message}`, result: 'error',
      });
      throw new ApiError('Антивирусная проверка сейчас недоступна — файл не загружен. Повторите позже или обратитесь в ДИТ.',
        503, 'antivirus_unavailable');
    }
    if (!result.clean) {
      await repo.logEvent(db, {
        ...auditOf(ctx, actor), action: 'Файл отклонён антивирусной проверкой', entity: 'document',
        entityId, detail: `${file.filename}: ${result.signature}`, result: 'denied',
      });
      throw ApiError.badRequest(`Файл «${file.filename}» не прошёл антивирусную проверку (${scanner.name}: ${result.signature})`);
    }
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
    if (!ALL_KINDS.includes(kind)) throw ApiError.badRequest('Укажите вид документа', { kind: 'Недопустимый вид' });
    // Каждое подразделение загружает свои документы (В2): ОР ПСД — ТУ, рабочий
    // проект, КП, договор, распоряжение, АВР (пп. 21–26, 32–44, 60, ТЗ); филиал —
    // акты приёма-передачи и технический АВР (пп. 58, 66).
    if (!uploadKindsOf(actor).includes(kind)) {
      throw ApiError.forbidden(`Документ «${kind}» загружает другое подразделение`);
    }

    const fields: Record<string, string> = {};
    const required = kind === 'Приложение' ? ['number', 'docDate'] : ['number', 'docDate', 'facilityId', 'ownerId', 'contractor'];
    for (const key of required) if (!String(meta[key] ?? '').trim()) fields[key] = 'Заполните реквизит';
    const docDate = String(meta.docDate ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(docDate)) fields.docDate = 'Дата в формате ГГГГ-ММ-ДД';
    else if (docDate > today()) fields.docDate = 'Дата акта не может быть в будущем';
    // Срок действия: ТУ — не более 6 месяцев (п. 31), рабочий проект — 36 месяцев (п. 47).
    // Без даты действия система не напомнит об истечении, поэтому для ТУ она обязательна.
    let validUntil = String(meta.validUntil ?? '').trim() || null;
    const limitMonths = kind === 'ТУ' ? 6 : kind === 'ПСД (РП)' ? 36 : null;
    if (limitMonths && /^\d{4}-\d{2}-\d{2}$/.test(docDate)) {
      const limit = addMonths(docDate, limitMonths);
      if (!validUntil) validUntil = limit;
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) fields.validUntil = 'Дата в формате ГГГГ-ММ-ДД';
      else if (validUntil > limit) fields.validUntil = `Не позднее ${limit}: ${kind === 'ТУ' ? 'ТУ действуют не более 6 месяцев (п. 31)' : 'рабочий проект — 36 месяцев (п. 47)'}`;
      else if (validUntil < docDate) fields.validUntil = 'Срок действия не может быть раньше даты документа';
    }
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

    // Форма акта (п. 70): по ТУ и ПСД — Р-1, по СМР — Р-1 или № 2В; технический АВР филиала — Приложение 6.
    const requestId = String(meta.requestId ?? '') || null;
    const linked = requestId ? await repo.getRequest(db, requestId) : null;
    if (requestId && !linked) throw ApiError.badRequest('Заявка не найдена', { requestId: 'Проверьте номер заявки' });
    if (linked) await loadVisible(actor, linked.uuid);
    // АВР оформляется по договору (В6): форма и привязка — по услуге договора.
    const contractId = String(meta.contractId ?? '') || null;
    const contract = contractId ? await contractsRepo.getContract(db, contractId) : null;
    if (contractId && (!contract || contract.request_id !== requestId)) {
      throw ApiError.badRequest('Договор не относится к заявке', { contractId: 'Выберите договор заявки' });
    }
    const formCode = resolveActForm(kind, String(meta.formCode ?? '').trim(),
      contract?.service ? [contract.service] : linked?.services ?? []);
    if (typeof formCode !== 'string') throw ApiError.badRequest('Проверьте форму бланка акта', { formCode: formCode.error });

    // Акт направляется в течение 2 рабочих дней с даты составления (пп. 28, 58).
    const lateUpload = ['Акт приема-передачи', 'Технический АВР'].includes(kind) &&
      workingDaysBetween(docDate, today(), await repo.calendar(db)) > 2;

    await scanUpload(ctx, actor, file, 'upload');
    const stored = await store.put(randomUUID(), file.filename, file.data);
    let documentId: string;
    try {
      documentId = await docs.createDocument(db, {
        requestId, contractId, lateUpload,
        kind, formCode,
        number: String(meta.number).trim(),
        facilityId, ownerId: String(meta.ownerId ?? '') || null,
        contractorName: String(meta.contractor ?? '').trim(),
        branchId: facility?.branch_id ?? actor.branchId,
        docDate, validUntil,
        fingerprint, createdBy: actor.id,
      }, stored);
    } catch (error) {
      // Запись в базу не удалась — файл в хранилище не оставляем.
      await store.remove(stored.key).catch(() => {});
      throw error;
    }

    await repo.logEvent(db, {
      ...auditOf(ctx, actor), action: 'Загружен документ', entity: 'document', entityId: documentId,
      detail: `${kind} ${meta.number} · файл ${stored.fileName} · ${stored.sha256.slice(0, 12)}` +
        (linked ? ` · заявка ${linked.number}` : ''),
      regulationRef: DOCUMENT_REF[kind] ?? null,
    });
    if (linked) {
      await repo.logEvent(db, {
        ...auditOf(ctx, actor), action: `Загружен документ «${kind}»`, entity: 'request', entityId: linked.uuid,
        detail: `${meta.number}${contract ? ` · договор ${contract.number}` : ''}`, regulationRef: DOCUMENT_REF[kind] ?? null,
      });
      if (lateUpload) {
        await repo.logEvent(db, {
          ...auditOf(ctx, actor), action: 'Акт направлен с нарушением срока', entity: 'request', entityId: linked.uuid,
          detail: `${kind} ${meta.number} от ${docDate}: более 2 рабочих дней`, regulationRef: 'пп. 28, 58', result: 'error',
        });
      }
      // Акт филиала ждёт визы ОР ПСД (пп. 58, 66).
      if (['Акт приема-передачи', 'Технический АВР'].includes(kind)) {
        await notices.actAwaitingApproval(db, linked, kind, String(meta.number).trim());
      }
    }
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

    await scanUpload(ctx, actor, file, document.id);
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
      regulationRef: DOCUMENT_REF[document.kind] ?? null,
    });
    const linked = document.request_id ? await repo.getRequest(db, document.request_id) : null;
    if (linked) {
      await repo.logEvent(db, {
        ...auditOf(ctx, actor), action: `Завизирован документ «${document.kind}»`, entity: 'request',
        entityId: linked.uuid, detail: document.number, regulationRef: DOCUMENT_REF[document.kind] ?? null,
      });
      // Правила 11 и 13: распоряжение на СМР, АВР и ЭСФ в 1 операционный день.
      if (document.kind === 'Акт приема-передачи') await notices.transferActApproved(db, linked);
      if (document.kind === 'Технический АВР') {
        await notices.technicalAvrApproved(db, linked);
        // Правило 19 (пп. 13–14): монтаж выполнен — техучёт вносит оборудование в реестр за 1 рабочий день.
        if (linked.facilityId) await registryTaskAfterMount(linked, actor.id);
      }
    }
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
    const inlineType = ['application/pdf', 'image/png', 'image/jpeg'].includes(row.mime);
    // Уровни прав архива (ТЗ): просмотр и скачивание — разные права. Без права
    // скачивания файл открывается только для просмотра в браузере, если его тип это позволяет.
    if (!rbac.can(actor, 'documents.download') && !(preview && inlineType)) {
      await repo.logEvent(db, {
        ...auditOf(ctx, actor), action: 'Отказ в скачивании файла', entity: 'document',
        entityId: document.id, detail: `${row.file_name} · версия ${version}`, result: 'denied',
      });
      throw ApiError.forbidden('Нет права на скачивание файла; доступен просмотр PDF и изображений');
    }
    await repo.logEvent(db, {
      ...auditOf(ctx, actor), action: preview ? 'Просмотр файла' : 'Скачивание файла',
      entity: 'document', entityId: document.id,
      detail: `${row.file_name} · версия ${version}`,
    });

    const { stream, size } = await store.read(row.storage_key);
    const inline = preview && inlineType;
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
    // Доска этапов — рабочий инструмент Общества; Заказчику — «Мои заявки» (В1).
    if (rbac.isCustomer(actor)) throw ApiError.forbidden();
    const rows = await repo.listRequests(db, { scope: rbac.requestScope(actor), limit: 500, state: 'open' });
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

  // Нормативы, изменённые ДИТ, накладываются до обработки первого запроса (С9).
  const ready = loadStageOverrides(db).catch((error) => {
    console.error('Нормативы ДИТ не загружены, действуют значения Регламента:', (error as Error).message);
  });

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    await ready;
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
