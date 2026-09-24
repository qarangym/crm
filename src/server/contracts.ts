/**
 * Маршруты договоров, оплаты и реквизитов закрытия (План завершения, A1).
 *
 * До этих маршрутов номер договора, оплату, утверждение сметы, распоряжение и
 * флаги закрытия можно было внести только прямо в базу — заявка через
 * интерфейс останавливалась на этапе «КП, договор, счёт».
 *
 * Нормы:
 *   пп. 21, 32, 48 — отдельный договор на каждую услугу;
 *   п. 53          — договор на СМР не ранее утверждения сметы;
 *   пп. 86, 88     — 100 % оплата, ежедневный мониторинг поступления;
 *   пп. 33, 45     — продление срока только с основанием, ПСД — не более 15 р.д.;
 *   пп. 96–97      — расторжение и возврат средств.
 */

import * as repo from '../db/repo.ts';
import * as contracts from '../db/contracts.ts';
import { today } from '../domain/calendar.ts';
import { SERVICES } from '../domain/types.ts';
import type { Service } from '../domain/types.ts';
import { extendStage, MAX_PSD_EXTENSION_DAYS } from '../process/engine.ts';
import { stage } from '../process/stages.ts';
import { ApiError } from './errors.ts';
import type { Router } from './http.ts';
import * as rbac from './rbac.ts';
import type { RouteDeps } from './context.ts';
import { isoDateOrNull } from './context.ts';

export function registerContractRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  /** Договоры заявки по услугам. */
  router.get('/api/v1/requests/:id/contracts', async (ctx) => {
    const actor = await deps.actor(ctx);
    const request = await deps.loadVisible(actor, ctx.params.id);
    return { contracts: await contracts.listContracts(db, request.uuid) };
  });

  /**
   * Регистрация договора на услугу заявки. Договор заключается при наличии
   * ТВ (пп. 21, 32, 48); на СМР — не ранее утверждения сметы (п. 53).
   */
  router.post('/api/v1/requests/:id/contracts', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'request.contract');
    const request = await deps.loadVisible(actor, ctx.params.id);

    const body = await ctx.body<{
      service?: Service; number?: string; subject?: string; amount?: number | string | null;
      signedAt?: string; invoiceAt?: string;
    }>();
    const service = body.service as Service;
    const number = String(body.number ?? '').trim();
    const signedAt = isoDateOrNull(body.signedAt);
    const invoiceAt = isoDateOrNull(body.invoiceAt);
    const amountText = String(body.amount ?? '').replace(/\s/g, '').replace(',', '.');
    const amount = amountText ? Number(amountText) : null;

    const fields: Record<string, string> = {};
    if (!SERVICES.includes(service)) fields.service = 'Укажите услугу: ТУ, ПСД или СМР';
    else if (!request.services.includes(service)) fields.service = 'Эта услуга в заявке не заказана';
    if (number.length < 2) fields.number = 'Укажите номер договора';
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) fields.amount = 'Сумма — неотрицательное число';
    if (signedAt === 'invalid') fields.signedAt = 'Дата в формате ГГГГ-ММ-ДД';
    else if (signedAt && signedAt > today()) fields.signedAt = 'Дата подписания не может быть в будущем';
    if (invoiceAt === 'invalid') fields.invoiceAt = 'Дата в формате ГГГГ-ММ-ДД';
    else if (invoiceAt && invoiceAt > today()) fields.invoiceAt = 'Дата счёта не может быть в будущем';
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте реквизиты договора', fields);

    if (stage(request.stageCode).terminal) throw ApiError.conflict('Заявка закрыта');
    if (request.tvStatus !== 'confirmed') {
      throw ApiError.regulation([{
        code: 'tv_not_confirmed', regulationRef: 'пп. 21, 32, 48',
        message: 'Договор заключается при подтверждённой технической возможности',
      }]);
    }
    if (request.freeServices.includes(service)) {
      throw ApiError.badRequest('ТУ на присоединение к сети телерадиовещания выдаются безвозмездно — договор не требуется (п. 20)');
    }
    if (service === 'СМР' && !request.estimateApproved) {
      throw ApiError.regulation([{
        code: 'estimate_not_approved', regulationRef: 'пп. 49, 53',
        message: 'Договор на СМР заключается не ранее утверждения сметной документации',
      }]);
    }
    if (await contracts.activeContract(db, request.uuid, service)) {
      throw ApiError.conflict(`Договор на услугу «${service}» уже зарегистрирован`);
    }
    if (await contracts.findByNumber(db, number)) {
      throw ApiError.conflict(`Договор № ${number} уже есть в системе`);
    }

    const created = await db.tx(async (t) => {
      const row = await contracts.createContract(t, {
        requestId: request.uuid, counterpartyId: request.counterpartyId, service, number,
        subject: String(body.subject ?? '').trim().slice(0, 500) || `${service} по заявке ${request.number}`,
        amount, signedAt, invoiceAt, createdBy: actor.id,
      });
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Зарегистрирован договор', entity: 'request',
        entityId: request.uuid,
        detail: `${service}: договор ${number}${amount !== null ? ` на ${amount}` : ''}`,
        regulationRef: service === 'СМР' ? 'пп. 48, 53' : service === 'ПСД' ? 'п. 32' : 'п. 21',
      });
      return row;
    });
    return { contract: created, request: await repo.getRequest(db, request.uuid) };
  });

  /** Поступление 100 % оплаты по договору (пп. 86, 88). */
  router.post('/api/v1/contracts/:id/payment', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'request.contract');
    const contract = await contracts.getContract(db, ctx.params.id);
    if (!contract || !contract.request_id) throw ApiError.notFound('Договор не найден');
    const request = await deps.loadVisible(actor, contract.request_id);

    const body = await ctx.body<{ paidAt?: string }>();
    const paidAt = isoDateOrNull(body.paidAt);
    if (!paidAt || paidAt === 'invalid') {
      throw ApiError.badRequest('Укажите дату поступления оплаты', { paidAt: 'Дата в формате ГГГГ-ММ-ДД' });
    }
    if (paidAt > today()) {
      throw ApiError.badRequest('Дата поступления оплаты не может быть в будущем', { paidAt: 'Фиксируется фактическое поступление (п. 88)' });
    }
    if (contract.signed_at && paidAt < contract.signed_at) {
      throw ApiError.badRequest('Оплата не может поступить раньше подписания договора', { paidAt: `Договор подписан ${contract.signed_at}` });
    }
    if (contract.status === 'terminated') throw ApiError.conflict('Договор расторгнут');
    if (contract.paid_at) throw ApiError.conflict(`Оплата по договору уже зафиксирована ${contract.paid_at}`);

    await db.tx(async (t) => {
      if (!await contracts.recordPayment(t, contract.id, paidAt)) {
        throw ApiError.conflict('Оплата по договору уже зафиксирована');
      }
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Зафиксировано поступление 100 % оплаты', entity: 'request',
        entityId: request.uuid, detail: `${contract.service}: договор ${contract.number}, оплата ${paidAt}`,
        regulationRef: 'пп. 86, 88',
      });
    });
    return { contract: await contracts.getContract(db, contract.id), request: await repo.getRequest(db, request.uuid) };
  });

  /** Расторжение договора и возврат средств (пп. 96–97). */
  router.post('/api/v1/contracts/:id/terminate', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'request.contract');
    const contract = await contracts.getContract(db, ctx.params.id);
    if (!contract || !contract.request_id) throw ApiError.notFound('Договор не найден');
    const request = await deps.loadVisible(actor, contract.request_id);

    const body = await ctx.body<{ reason?: string; refundAmount?: number | string | null }>();
    const reason = String(body.reason ?? '').trim();
    const refundText = String(body.refundAmount ?? '').replace(/\s/g, '').replace(',', '.');
    const refund = refundText ? Number(refundText) : null;
    const fields: Record<string, string> = {};
    if (reason.length < 5) fields.reason = 'Укажите основание: письмо Заказчика, соглашение о расторжении';
    if (refund !== null && (!Number.isFinite(refund) || refund < 0)) fields.refundAmount = 'Сумма — неотрицательное число';
    if (refund !== null && refund > 0 && !contract.paid_at) fields.refundAmount = 'Возврат возможен только по оплаченному договору';
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте данные расторжения', fields);

    await db.tx(async (t) => {
      if (!await contracts.terminateContract(t, contract.id, today(), refund)) {
        throw ApiError.conflict('Договор уже расторгнут');
      }
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Договор расторгнут', entity: 'request', entityId: request.uuid,
        detail: `${contract.service}: договор ${contract.number}. ${reason}` +
          (refund ? `. Возврат ${refund}` : ''),
        regulationRef: 'пп. 96–97',
      });
    });
    return { contract: await contracts.getContract(db, contract.id), request: await repo.getRequest(db, request.uuid) };
  });

  /**
   * Реквизиты, от которых зависят переходы: утверждение сметы (пп. 41, 52),
   * распоряжение (п. 60), передача результата (пп. 24, 42), направление АВР и
   * ЭСФ (пп. 91–92), подтверждение приёмки Заказчиком (пп. 94–95).
   * Каждое изменение пишется в журнал отдельной записью со ссылкой на пункт.
   */
  router.post('/api/v1/requests/:id/flags', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'request.contract');
    const request = await deps.loadVisible(actor, ctx.params.id);
    if (stage(request.stageCode).terminal) throw ApiError.conflict('Заявка закрыта');

    const body = await ctx.body<{
      estimateApproved?: boolean; orderNumber?: string | null; resultDelivered?: boolean;
      avrSentAt?: string | null; closingConfirmed?: boolean; avrObjection?: string | null;
      version?: number;
    }>();

    const patch: Record<string, unknown> = {};
    const log: { action: string; detail: string; ref: string }[] = [];
    const fields: Record<string, string> = {};
    const orpsdOnly = () => {
      if (!actor.roles.includes('orpsd') && !actor.roles.includes('admin')) {
        throw ApiError.forbidden('Это действие выполняет ОР ПСД');
      }
    };

    if (body.estimateApproved !== undefined) {
      orpsdOnly();
      if (!request.services.includes('СМР') && !request.services.includes('ПСД')) {
        fields.estimateApproved = 'Сметная документация составляется для ПСД и СМР';
      }
      patch.estimate_approved = body.estimateApproved === true;
      log.push({ action: body.estimateApproved ? 'Сметная документация утверждена' : 'Утверждение сметы отменено', detail: '', ref: 'пп. 41, 52' });
    }
    if (body.orderNumber !== undefined) {
      orpsdOnly();
      const order = String(body.orderNumber ?? '').trim();
      if (!request.services.includes('СМР')) fields.orderNumber = 'Распоряжение оформляется только для СМР';
      else if (order && order.length < 2) fields.orderNumber = 'Укажите номер распоряжения';
      patch.order_number = order ? order.slice(0, 64) : null;
      log.push({ action: 'Указано распоряжение о разрешении на СМР', detail: order || 'снято', ref: 'п. 60' });
    }
    if (body.resultDelivered !== undefined) {
      orpsdOnly();
      patch.result_delivered = body.resultDelivered === true;
      log.push({ action: body.resultDelivered ? 'Результат передан Заказчику' : 'Отметка о передаче результата снята', detail: '', ref: 'пп. 24, 42' });
    }
    if (body.avrSentAt !== undefined) {
      const sent = isoDateOrNull(body.avrSentAt);
      if (sent === 'invalid') fields.avrSentAt = 'Дата в формате ГГГГ-ММ-ДД';
      else if (sent && sent > today()) fields.avrSentAt = 'Дата направления не может быть в будущем';
      else if (sent && !request.avrApproved) fields.avrSentAt = 'Сначала загрузите и завизируйте АВР';
      patch.avr_sent_at = sent === 'invalid' ? null : sent;
      log.push({ action: 'АВР и ЭСФ направлены Заказчику', detail: sent ?? 'отметка снята', ref: 'пп. 91–92' });
    }
    if (body.avrObjection !== undefined) {
      // Мотивированные замечания Заказчика к АВР приостанавливают приёмку по молчанию (п. 94).
      const text = String(body.avrObjection ?? '').trim();
      if (text && text.length < 10) fields.avrObjection = 'Замечания должны быть мотивированными: укажите недостатки и условия договора';
      patch.avr_objection = text || null;
      log.push({ action: text ? 'Получены мотивированные замечания Заказчика к АВР' : 'Замечания к АВР урегулированы', detail: text, ref: 'п. 94' });
    }
    if (body.closingConfirmed !== undefined) {
      if (request.stageCode !== 'closing' && body.closingConfirmed) {
        fields.closingConfirmed = 'Приёмка подтверждается на этапе «Приёмка Заказчиком»';
      }
      patch.closing_confirmed = body.closingConfirmed === true;
      log.push({ action: body.closingConfirmed ? 'Заказчик подтвердил приёмку работ' : 'Подтверждение приёмки снято', detail: '', ref: 'пп. 94–95' });
    }

    if (!log.length) throw ApiError.badRequest('Нет изменений');
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте реквизиты', fields);

    await db.tx(async (t) => {
      const ok = await repo.updateRequestFields(t, request.uuid, body.version ?? request.version, patch);
      if (!ok) throw ApiError.conflict('Карточка изменилась. Обновите заявку и повторите');
      for (const entry of log) {
        await repo.logEvent(t, {
          ...deps.audit(ctx, actor), action: entry.action, entity: 'request', entityId: request.uuid,
          detail: entry.detail, regulationRef: entry.ref,
        });
      }
    });
    return { request: await repo.getRequest(db, request.uuid) };
  });

  /**
   * Продление срока текущего этапа (пп. 33, 45, 64). Основание обязательно;
   * разработка ПСД продлевается не более чем на 15 рабочих дней с письменным
   * уведомлением Заказчика.
   */
  router.post('/api/v1/requests/:id/extension', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'request.extend');
    const request = await deps.loadVisible(actor, ctx.params.id);

    const body = await ctx.body<{ days?: number; reason?: string }>();
    const days = Number(body.days);
    const reason = String(body.reason ?? '').trim();
    const fields: Record<string, string> = {};
    if (!Number.isInteger(days) || days <= 0) fields.days = 'Укажите число рабочих дней продления';
    if (reason.length < 5) fields.reason = 'Укажите основание: уведомление Заказчика, дополнительное соглашение';
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте данные продления', fields);

    const current = await repo.currentStageRecord(db, request.uuid);
    if (!current || stage(current.stageCode).terminal) throw ApiError.conflict('У заявки нет открытого этапа');

    let extended;
    try {
      extended = extendStage(current, days, reason, await repo.calendar(db));
    } catch (error) {
      throw ApiError.regulation([{
        code: 'extension_rejected', message: (error as Error).message,
        regulationRef: current.stageCode === 'psd' ? 'п. 33' : 'пп. 45, 64',
      }]);
    }

    await db.tx(async (t) => {
      await repo.saveExtension(t, request.uuid, extended.dueAt!, extended.extendedBy, extended.extensionReason!);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: `Срок этапа «${stage(current.stageCode).name}» продлён на ${days} р.д.`,
        entity: 'request', entityId: request.uuid,
        detail: `Новый срок ${extended.dueAt}. ${reason}`,
        regulationRef: current.stageCode === 'psd' ? `п. 33 (не более ${MAX_PSD_EXTENSION_DAYS} р.д.)` : 'пп. 45, 64',
      });
    });
    return { request: await repo.getRequest(db, request.uuid), currentStage: await repo.currentStageRecord(db, request.uuid) };
  });
}
