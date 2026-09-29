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
import { customerContract } from './customer.ts';
import { notify, roleRecipients } from './notify.ts';
import * as notices from './events.ts';
import type { RequestRow } from '../db/repo.ts';
import { missingCheckpoints, REQUIRED_FOR_ESTIMATE, REQUIRED_FOR_RESULT, tuSentToBranch } from './controls.ts';

/**
 * Услуга по договору оказана — можно оформлять АВР (раздел 11 Регламента):
 * этап услуги пройден, для СМР — подписан технический АВР (п. 66).
 */
export function serviceDone(r: RequestRow, service: Service): boolean {
  if (['avr', 'closing'].includes(r.stageCode)) return true;
  if (service === 'ТУ') return r.passedStages.includes('tu');
  if (service === 'ПСД') return r.passedStages.includes('psd');
  return r.passedStages.includes('smr') || r.technicalAvrApproved;
}

export function registerContractRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  /** Договоры заявки по услугам. */
  router.get('/api/v1/requests/:id/contracts', async (ctx) => {
    const actor = await deps.actor(ctx);
    const request = await deps.loadVisible(actor, ctx.params.id);
    const rows = await contracts.listContracts(db, request.uuid);
    return { contracts: rbac.isCustomer(actor) ? rows.map(customerContract) : rows };
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
      // Счёт — в день получения служебной записки (пп. 84–85; правило 5).
      await notices.contractRegistered(t, request, { service, number, amount });
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
      await notices.paymentReceived(t, request, contract, paidAt);
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
      // Заявка на возврат денежных средств — расчётам с контрагентами (п. 97; правило 16).
      if (refund) {
        await notify(t, await roleRecipients(t, ['accounting']), {
          eventKey: 'refund_requested', ruleId: 16,
          subject: `Возврат по договору ${contract.number} (заявка ${request.number})`,
          body: `Договор ${contract.number} («${contract.service}») расторгнут: ${reason}.\n` +
            `Сумма к возврату Заказчику ${request.counterpartyName}: ${refund} ₸ (п. 97).`,
          payload: { requestId: request.uuid, contractId: contract.id },
        });
      }
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
      // Смета, разработанная в ПСД, утверждается после двух уровней проверки (пп. 40–41, 52).
      if (body.estimateApproved && request.services.includes('ПСД')) {
        const missing = await missingCheckpoints(db, request.uuid, REQUIRED_FOR_ESTIMATE);
        if (missing.length) {
          throw ApiError.regulation(missing.map((m) => ({ code: m.code, message: `Не отмечено: ${m.title.toLowerCase()}`, regulationRef: m.regulationRef })));
        }
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
      // ТУ — после согласования с филиалом и утверждения (п. 23); ПСД — после контрольных точек (пп. 34, 41).
      const required = body.resultDelivered ? REQUIRED_FOR_RESULT[request.stageCode] : undefined;
      if (required) {
        const missing = await missingCheckpoints(db, request.uuid, required);
        if (missing.length) {
          throw ApiError.regulation(missing.map((m) => ({ code: m.code, message: `Не отмечено: ${m.title.toLowerCase()}`, regulationRef: m.regulationRef })));
        }
      }
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
      // Отметка по заявке целиком распространяется на её договоры (В6):
      // АВР направлен — по всем оказанным услугам, приёмка — по всем направленным актам.
      const active = await contracts.activeContracts(t, request.uuid);
      if (patch.avr_sent_at) {
        for (const c of active) {
          if (c.avr_sent_at || c.accepted_at || !c.service || !serviceDone(request, c.service)) continue;
          await contracts.updateAvr(t, c.id, { avr_sent_at: patch.avr_sent_at as string });
        }
      }
      if (patch.closing_confirmed === true) {
        for (const c of active) {
          if (!c.accepted_at && c.avr_sent_at) await contracts.updateAvr(t, c.id, { accepted_at: today(), accepted_by_silence: false });
        }
      }
      for (const entry of log) {
        await repo.logEvent(t, {
          ...deps.audit(ctx, actor), action: entry.action, entity: 'request', entityId: request.uuid,
          detail: entry.detail, regulationRef: entry.ref,
        });
      }
    });
    const updated = (await repo.getRequest(db, request.uuid))!;
    // Выданные ТУ направляются в филиал для контроля (п. 26).
    if (patch.result_delivered === true && request.stageCode === 'tu') await tuSentToBranch(db, updated);
    if (patch.avr_sent_at && updated.stageCode !== 'avr') {
      await notices.avrSent(db, updated, patch.avr_sent_at as string, await repo.calendar(db));
    }
    return { request: updated };
  });

  /**
   * АВР по договору (В6; раздел 11 Регламента). По завершении каждой услуги —
   * АВР и ЭСФ в 1 операционный день (п. 91), направление Заказчику (п. 92),
   * 10 рабочих дней на подписание или мотивированные замечания (п. 94).
   * Договор исполнен, когда работы приняты (п. 127).
   */
  router.post('/api/v1/contracts/:id/avr', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'request.contract');
    const contract = await contracts.getContract(db, ctx.params.id);
    if (!contract || !contract.request_id) throw ApiError.notFound('Договор не найден');
    const request = await deps.loadVisible(actor, contract.request_id);
    if (contract.status === 'terminated') throw ApiError.conflict('Договор расторгнут');

    const body = await ctx.body<{ formedAt?: string | null; sentAt?: string | null; objection?: string | null; acceptedAt?: string | null }>();
    const patch: contracts.AvrPatch = {};
    const log: { action: string; detail: string; ref: string }[] = [];
    const fields: Record<string, string> = {};
    const date = (key: 'formedAt' | 'sentAt' | 'acceptedAt') => {
      const v = isoDateOrNull(body[key]);
      if (v === 'invalid') { fields[key] = 'Дата в формате ГГГГ-ММ-ДД'; return null; }
      if (v && v > today()) { fields[key] = 'Дата не может быть в будущем'; return null; }
      return v;
    };
    const done = contract.service ? serviceDone(request, contract.service) : false;

    if (body.formedAt !== undefined) {
      const v = date('formedAt');
      if (v && !done) fields.formedAt = 'Услуга по договору ещё не оказана';
      patch.avr_formed_at = v;
      log.push({ action: v ? 'АВР и ЭСФ оформлены' : 'Отметка об оформлении АВР снята', detail: v ?? '', ref: 'п. 91' });
    }
    if (body.sentAt !== undefined) {
      const v = date('sentAt');
      const formed = patch.avr_formed_at !== undefined ? patch.avr_formed_at : contract.avr_formed_at;
      if (v && !done) fields.sentAt = 'Услуга по договору ещё не оказана';
      else if (v && !contract.avr_approved) fields.sentAt = 'Сначала загрузите и завизируйте АВР по договору';
      else if (v && contract.accepted_at) fields.sentAt = 'Работы по договору уже приняты';
      else if (v && formed && v < formed) fields.sentAt = 'АВР не может быть направлен раньше оформления';
      patch.avr_sent_at = v;
      if (v && !formed) patch.avr_formed_at = v;
      log.push({ action: v ? 'АВР и ЭСФ направлены Заказчику' : 'Отметка о направлении АВР снята', detail: v ?? '', ref: 'пп. 91–92' });
    }
    if (body.objection !== undefined) {
      const text = String(body.objection ?? '').trim();
      if (text && text.length < 10) fields.objection = 'Замечания должны быть мотивированными: укажите недостатки и условия договора';
      patch.avr_objection = text || null;
      log.push({ action: text ? 'Получены мотивированные замечания Заказчика к АВР' : 'Замечания к АВР урегулированы', detail: text, ref: 'п. 94' });
    }
    if (body.acceptedAt !== undefined) {
      const v = date('acceptedAt');
      const sent = patch.avr_sent_at !== undefined ? patch.avr_sent_at : contract.avr_sent_at;
      if (v && !sent) fields.acceptedAt = 'Сначала отметьте направление АВР Заказчику';
      patch.accepted_at = v;
      patch.accepted_by_silence = false;
      if (v) patch.avr_objection = null;
      log.push({ action: v ? 'Заказчик подписал АВР — работы по договору приняты' : 'Отметка о приёмке снята', detail: v ?? '', ref: 'пп. 94–95, 127' });
    }
    if (!log.length) throw ApiError.badRequest('Нет изменений');
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте реквизиты АВР', fields);

    await db.tx(async (t) => {
      if (!await contracts.updateAvr(t, contract.id, patch)) throw ApiError.conflict('Договор расторгнут');
      for (const entry of log) {
        await repo.logEvent(t, {
          ...deps.audit(ctx, actor), action: entry.action, entity: 'request', entityId: request.uuid,
          detail: `${contract.service}: договор ${contract.number}${entry.detail ? ` · ${entry.detail}` : ''}`,
          regulationRef: entry.ref,
        });
      }
    });
    if (patch.avr_sent_at) {
      await notices.avrSent(db, request, patch.avr_sent_at, await repo.calendar(db), contract.number);
    }
    return { contract: await contracts.getContract(db, contract.id), request: await repo.getRequest(db, request.uuid) };
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
