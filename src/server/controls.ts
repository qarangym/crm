/**
 * Нормы Регламента, которые раньше выполнялись вне системы
 * (Проверка функционала, раздел 7):
 *
 *   п. 23        — проект ТУ согласуется с филиалом и утверждается техническим директором;
 *   п. 26        — выданные ТУ направляются в филиал для контроля;
 *   п. 34        — контрольные точки ПСД: исходные данные за 3 р.д., графическая часть,
 *                  согласование с филиалом;
 *   пп. 40–41, 52 — двухуровневая проверка сметы: исполнитель и проверяющий;
 *   пп. 45, 64–65 — дополнительные соглашения с пересчётом суммы и сроков;
 *   п. 57        — претензия Заказчику при непредоставлении оборудования;
 *   пп. 63, 80   — приостановка СМР при изменениях и в неблагоприятную погоду;
 *   пп. 67–69    — отказ Заказчика от подписания технического АВР.
 *
 * Контрольная точка — отметка с датой, автором и комментарием. От части
 * отметок зависят действия: передать ТУ Заказчику нельзя без согласования и
 * утверждения (п. 23), утвердить смету ПСД — без двух уровней проверки (п. 41).
 */

import * as repo from '../db/repo.ts';
import type { Db } from '../db/client.ts';
import type { RequestRow } from '../db/repo.ts';
import * as contractsRepo from '../db/contracts.ts';
import { addCalendarDays, addWorkingDays, calendarDaysBetween, today, workingDaysBetween } from '../domain/calendar.ts';
import type { Role } from '../domain/types.ts';
import type { StageCode } from '../process/stages.ts';
import { stage } from '../process/stages.ts';
import { ApiError } from './errors.ts';
import type { Router } from './http.ts';
import * as rbac from './rbac.ts';
import type { RouteDeps } from './context.ts';
import { isoDateOrNull } from './context.ts';
import { branchRecipients, customerRecipients, notify, roleRecipients, SIGNATURE } from './notify.ts';

export type CheckpointDef = {
  code: string;
  title: string;
  stages: StageCode[];
  roles: Role[];
  regulationRef: string;
  /** Комментарий обязателен (причина, реквизиты претензии). */
  noteRequired?: boolean;
  /** Отметку ставит не тот, кто поставил указанную (двухуровневая проверка). */
  differentFrom?: string;
  /** Нужна для услуги. */
  service?: 'ТУ' | 'ПСД' | 'СМР';
};

export const CHECKPOINTS: CheckpointDef[] = [
  { code: 'tu_branch_agreed', title: 'Проект ТУ согласован с филиалом', stages: ['tu'], roles: ['orpsd', 'branch', 'admin'], regulationRef: 'п. 23', service: 'ТУ' },
  { code: 'tu_director_approved', title: 'ТУ утверждены техническим директором', stages: ['tu'], roles: ['orpsd', 'admin'], regulationRef: 'п. 23', service: 'ТУ' },
  { code: 'psd_input_checked', title: 'Исходные данные проверены на полноту и корректность', stages: ['psd'], roles: ['orpsd', 'admin'], regulationRef: 'п. 34.1', service: 'ПСД' },
  { code: 'psd_graphics_done', title: 'Графическая часть разработана', stages: ['psd'], roles: ['orpsd', 'admin'], regulationRef: 'п. 34', service: 'ПСД' },
  { code: 'psd_estimate_check1', title: 'Смета проверена исполнителем (1-й уровень)', stages: ['psd'], roles: ['orpsd', 'admin'], regulationRef: 'пп. 40–41', service: 'ПСД' },
  { code: 'psd_estimate_check2', title: 'Смета проверена проверяющим (2-й уровень)', stages: ['psd'], roles: ['orpsd', 'admin'], regulationRef: 'пп. 41, 52', service: 'ПСД', differentFrom: 'psd_estimate_check1' },
  { code: 'psd_branch_agreed', title: 'ПСД согласована с филиалом', stages: ['psd'], roles: ['orpsd', 'branch', 'admin'], regulationRef: 'п. 34', service: 'ПСД' },
  { code: 'smr_claim_sent', title: 'Претензия Заказчику: оборудование не предоставлено', stages: ['smr_prep'], roles: ['orpsd', 'admin'], regulationRef: 'п. 57', noteRequired: true, service: 'СМР' },
  { code: 'tavr_refused', title: 'Заказчик отказался подписать технический АВР', stages: ['smr'], roles: ['branch', 'orpsd', 'admin'], regulationRef: 'пп. 67–69', noteRequired: true, service: 'СМР' },
];

/** Отметки, без которых нельзя передать результат Заказчику (пп. 23, 34, 41). */
export const REQUIRED_FOR_RESULT: Partial<Record<StageCode, string[]>> = {
  tu: ['tu_branch_agreed', 'tu_director_approved'],
  psd: ['psd_input_checked', 'psd_graphics_done', 'psd_estimate_check1', 'psd_estimate_check2', 'psd_branch_agreed'],
};
/** Утверждение сметы ПСД — после двух уровней проверки (пп. 40–41, 52). */
export const REQUIRED_FOR_ESTIMATE = ['psd_estimate_check1', 'psd_estimate_check2'];

export function listCheckpoints(db: Db, requestId: string) {
  return db.query<{ id: string; code: string; done_at: string; note: string; done_by: string; author: string; created_at: string }>(
    `SELECT c.id, c.code, c.done_at::text AS done_at, c.note, c.done_by, u.full_name AS author, c.created_at
       FROM request_checkpoints c JOIN users u ON u.id = c.done_by
      WHERE c.request_id = $1 ORDER BY c.created_at`, [requestId]);
}

/** Невыполненные отметки из перечня — для проверки перед действием. */
export async function missingCheckpoints(db: Db, requestId: string, codes: string[]): Promise<CheckpointDef[]> {
  const done = new Set((await listCheckpoints(db, requestId)).map((c) => c.code));
  return CHECKPOINTS.filter((c) => codes.includes(c.code) && !done.has(c.code));
}

/** Сколько дней прибавить к сроку этапа за время приостановки. */
function pausedExtension(unit: string, from: string, to: string, calendar: Awaited<ReturnType<typeof repo.calendar>>): number {
  return unit === 'calendar' ? calendarDaysBetween(from, to) : workingDaysBetween(from, to, calendar);
}

export function registerControlRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  /** Контрольные точки заявки и перечень применимых. */
  router.get('/api/v1/requests/:id/checkpoints', async (ctx) => {
    const actor = await deps.actor(ctx);
    if (rbac.isCustomer(actor)) throw ApiError.forbidden();
    const request = await deps.loadVisible(actor, ctx.params.id);
    const done = await listCheckpoints(db, request.uuid);
    return {
      checkpoints: CHECKPOINTS
        .filter((c) => !c.service || request.services.includes(c.service))
        .map((c) => ({ ...c, done: done.find((d) => d.code === c.code) ?? null })),
      amendments: await db.query(
        `SELECT a.id, a.contract_id, c.number AS contract_number, c.service, a.number, a.signed_at::text AS signed_at,
                a.amount, a.extend_days, a.reason, a.created_at, u.full_name AS author
           FROM contract_amendments a JOIN contracts c ON c.id = a.contract_id LEFT JOIN users u ON u.id = a.created_by
          WHERE c.request_id = $1 ORDER BY a.signed_at, a.created_at`, [request.uuid]),
    };
  });

  /** Отметка контрольной точки. */
  router.post('/api/v1/requests/:id/checkpoints', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const request = await deps.loadVisible(actor, ctx.params.id);
    const body = await ctx.body<{ code?: string; doneAt?: string; note?: string }>();
    const def = CHECKPOINTS.find((c) => c.code === body.code);
    if (!def) throw ApiError.badRequest('Неизвестная контрольная точка');
    if (!def.roles.some((r) => actor.roles.includes(r))) throw ApiError.forbidden('Отметку ставит другое подразделение');
    if (def.service && !request.services.includes(def.service)) throw ApiError.badRequest('Услуга не заказана в заявке');
    if (!def.stages.includes(request.stageCode)) {
      throw ApiError.conflict(`Отметка ставится на этапе «${def.stages.map((s) => stage(s).name).join('», «')}»`);
    }
    const doneAt = isoDateOrNull(body.doneAt) ?? today();
    const note = String(body.note ?? '').trim();
    if (doneAt === 'invalid' || doneAt > today()) throw ApiError.badRequest('Дата отметки', { doneAt: 'Не в будущем, формат ГГГГ-ММ-ДД' });
    if (def.noteRequired && note.length < 10) throw ApiError.badRequest('Укажите причину и реквизиты', { note: 'Не менее 10 символов' });
    if (def.differentFrom) {
      const first = await db.one<{ done_by: string }>(
        'SELECT done_by FROM request_checkpoints WHERE request_id = $1 AND code = $2', [request.uuid, def.differentFrom]);
      if (!first) throw ApiError.conflict('Сначала отметьте проверку первого уровня');
      if (first.done_by === actor.id) {
        throw ApiError.regulation([{ code: 'same_checker', regulationRef: 'пп. 40–41',
          message: 'Второй уровень проверки выполняет другой специалист, не исполнитель первого уровня' }]);
      }
    }
    await db.tx(async (t) => {
      const row = await t.one('INSERT INTO request_checkpoints (request_id, code, done_at, done_by, note) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
        [request.uuid, def.code, doneAt, actor.id, note]);
      if (!row) throw ApiError.conflict('Отметка уже поставлена');
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: def.title, entity: 'request', entityId: request.uuid,
        detail: `${doneAt}${note ? ` · ${note}` : ''}`, regulationRef: def.regulationRef,
      });
      await afterCheckpoint(t, request, def.code, note);
    });
    return { checkpoints: await listCheckpoints(db, request.uuid) };
  });

  /** Снятие ошибочной отметки — автором или ДИТ, пока этап не пройден. */
  router.post('/api/v1/requests/:id/checkpoints/:code/delete', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const request = await deps.loadVisible(actor, ctx.params.id);
    const def = CHECKPOINTS.find((c) => c.code === ctx.params.code);
    if (!def || !def.stages.includes(request.stageCode)) throw ApiError.conflict('Отметку по пройденному этапу снять нельзя');
    const row = await db.one<{ done_by: string }>('SELECT done_by FROM request_checkpoints WHERE request_id = $1 AND code = $2', [request.uuid, def.code]);
    if (!row) throw ApiError.notFound('Отметки нет');
    if (row.done_by !== actor.id && !actor.roles.includes('admin')) throw ApiError.forbidden('Снять отметку может её автор');
    await db.tx(async (t) => {
      await t.query('DELETE FROM request_checkpoints WHERE request_id = $1 AND code = $2', [request.uuid, def.code]);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: `Снята отметка: ${def.title}`, entity: 'request', entityId: request.uuid,
        detail: '', regulationRef: def.regulationRef,
      });
    });
    return { checkpoints: await listCheckpoints(db, request.uuid) };
  });

  /**
   * Приостановка срока этапа СМР (пп. 63, 80): изменения в проекте или
   * неблагоприятные погодные условия. Время приостановки не входит в срок.
   */
  router.post('/api/v1/requests/:id/pause', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    if (!actor.roles.some((r) => ['branch', 'orpsd', 'admin'].includes(r))) throw ApiError.forbidden();
    const request = await deps.loadVisible(actor, ctx.params.id);
    if (request.stageCode !== 'smr') throw ApiError.conflict('Приостанавливается выполнение СМР (пп. 63, 80)');
    const body = await ctx.body<{ reason?: string }>();
    const reason = String(body.reason ?? '').trim();
    if (reason.length < 10) throw ApiError.badRequest('Укажите основание приостановки', { reason: 'Изменения проекта, погодные условия, акт' });
    await db.tx(async (t) => {
      const rows = await t.query(
        `UPDATE request_stages SET paused_at = $2, pause_reason = $3
          WHERE request_id = $1 AND left_at IS NULL AND paused_at IS NULL RETURNING id`, [request.uuid, today(), reason]);
      if (!rows.length) throw ApiError.conflict('Работы уже приостановлены');
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Выполнение СМР приостановлено', entity: 'request', entityId: request.uuid,
        detail: reason, regulationRef: 'пп. 63, 80',
      });
      await notify(t, await customerRecipients(t, request.counterpartyId), {
        eventKey: 'smr_paused', subject: `Заявка ${request.number}: выполнение СМР приостановлено`,
        body: `Основание: ${reason}.\nСрок выполнения работ продлевается на время приостановки (пп. 63, 80).${SIGNATURE}`,
        payload: { requestId: request.uuid },
      });
    });
    return { currentStage: await repo.currentStageRecord(db, request.uuid) };
  });

  router.post('/api/v1/requests/:id/resume', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    if (!actor.roles.some((r) => ['branch', 'orpsd', 'admin'].includes(r))) throw ApiError.forbidden();
    const request = await deps.loadVisible(actor, ctx.params.id);
    const current = await db.one<{ id: string; paused_at: string | null; due_at: string | null; sla_unit: string; paused_days: number }>(
      `SELECT id, paused_at::text AS paused_at, due_at::text AS due_at, sla_unit, paused_days
         FROM request_stages WHERE request_id = $1 AND left_at IS NULL`, [request.uuid]);
    if (!current?.paused_at) throw ApiError.conflict('Работы не приостановлены');
    const calendar = await repo.calendar(db);
    const days = pausedExtension(current.sla_unit, current.paused_at, today(), calendar);
    const due = current.due_at
      ? current.sla_unit === 'calendar' ? addCalendarDays(current.due_at, days) : addWorkingDays(current.due_at, days, calendar)
      : null;
    await db.tx(async (t) => {
      await t.query(
        `UPDATE request_stages SET paused_at = NULL, paused_days = paused_days + $2, due_at = $3,
                extended_by = extended_by + $2,
                extension_reason = coalesce(extension_reason || '; ', '') || $4
          WHERE id = $1`, [current.id, days, due, `приостановка ${current.paused_at}–${today()}`]);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Выполнение СМР возобновлено', entity: 'request', entityId: request.uuid,
        detail: `Приостановка ${current.paused_at} — ${today()}: срок продлён на ${days} дн., новый срок ${due ?? '—'}`,
        regulationRef: 'пп. 63, 80',
      });
    });
    return { currentStage: await repo.currentStageRecord(db, request.uuid) };
  });

  /**
   * Дополнительное соглашение к договору (пп. 45, 64–65): изменение суммы по
   * пересчитанной смете и (или) продление срока оказания услуги.
   */
  router.post('/api/v1/contracts/:id/amendments', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'request.contract');
    const contract = await contractsRepo.getContract(db, ctx.params.id);
    if (!contract?.request_id) throw ApiError.notFound('Договор не найден');
    const request = await deps.loadVisible(actor, contract.request_id);
    if (contract.status === 'terminated') throw ApiError.conflict('Договор расторгнут');
    const body = await ctx.body<{ number?: string; signedAt?: string; amount?: string | number | null; extendDays?: number | null; reason?: string }>();
    const number = String(body.number ?? '').trim();
    const signedAt = isoDateOrNull(body.signedAt);
    const amountText = String(body.amount ?? '').replace(/\s/g, '').replace(',', '.');
    const amount = amountText ? Number(amountText) : null;
    const extend = body.extendDays ? Number(body.extendDays) : null;
    const reason = String(body.reason ?? '').trim();
    const fields: Record<string, string> = {};
    if (number.length < 1) fields.number = 'Номер соглашения';
    if (!signedAt || signedAt === 'invalid') fields.signedAt = 'Дата подписания';
    else if (signedAt > today()) fields.signedAt = 'Не в будущем';
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) fields.amount = 'Новая сумма — неотрицательное число';
    if (extend !== null && (!Number.isInteger(extend) || extend <= 0 || extend > 365)) fields.extendDays = 'Продление, рабочих дней';
    if (amount === null && extend === null) fields.amount = 'Укажите новую сумму и (или) продление срока';
    if (reason.length < 5) fields.reason = 'Основание: пересчёт сметы, изменение объёма';
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте дополнительное соглашение', fields);

    // Продление по соглашению — срока этапа этой услуги, если он сейчас открыт.
    const serviceStage: Record<string, StageCode[]> = { 'ТУ': ['tu'], 'ПСД': ['psd'], 'СМР': ['smr_prep', 'smr'] };
    const current = await repo.currentStageRecord(db, request.uuid);
    const extendsStage = extend && current && contract.service && serviceStage[contract.service]?.includes(current.stageCode);
    if (extend && !extendsStage) {
      throw ApiError.conflict('Срок продлевается, пока услуга по договору оказывается');
    }
    await db.tx(async (t) => {
      const row = await t.one('INSERT INTO contract_amendments (contract_id, number, signed_at, amount, extend_days, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id',
        [contract.id, number, signedAt, amount, extend, reason, actor.id]);
      if (!row) throw ApiError.conflict(`Соглашение № ${number} уже зарегистрировано`);
      if (amount !== null) await t.query('UPDATE contracts SET amount = $2 WHERE id = $1', [contract.id, amount]);
      if (extendsStage && current?.dueAt) {
        const due = addWorkingDays(current.dueAt, extend!, await repo.calendar(t));
        await repo.saveExtension(t, request.uuid, due, current.extendedBy + extend!,
          [current.extensionReason, `допсоглашение № ${number} от ${signedAt}`].filter(Boolean).join('; '));
      }
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Зарегистрировано дополнительное соглашение', entity: 'request', entityId: request.uuid,
        detail: `Договор ${contract.number}, соглашение № ${number} от ${signedAt}` +
          (amount !== null ? `: сумма ${contract.amount ?? '—'} → ${amount}` : '') +
          (extend ? `; срок продлён на ${extend} р.д.` : '') + `. ${reason}`,
        regulationRef: 'пп. 45, 64–65',
      });
    });
    return { request: await repo.getRequest(db, request.uuid), currentStage: await repo.currentStageRecord(db, request.uuid) };
  });
}

/** Последствия отметок: письма по п. 26, пп. 57, 67–69. */
async function afterCheckpoint(t: Db, r: RequestRow, code: string, note: string): Promise<void> {
  if (code === 'smr_claim_sent') {
    await notify(t, await customerRecipients(t, r.counterpartyId), {
      eventKey: 'smr_claim', subject: `Заявка ${r.number}: претензия о непредоставлении оборудования`,
      body: `Оборудование и материалы для выполнения СМР не предоставлены в установленный срок (п. 55).\n${note}\n` +
        'При дальнейшем непредоставлении договор может быть приостановлен и (или) расторгнут (п. 57).' + SIGNATURE,
      payload: { requestId: r.uuid },
    });
  }
  if (code === 'tavr_refused') {
    await notify(t, await roleRecipients(t, ['orpsd', 'management']), {
      eventKey: 'tavr_refused', ruleId: 14, subject: `Заявка ${r.number}: Заказчик отказался подписать технический АВР`,
      body: `Причина: ${note}\n\nФилиал направляет служебную записку с причиной и подтверждающими документами; ` +
        'при разногласиях — претензионный порядок и служебная записка в подразделение по юридическим вопросам (пп. 67–69).',
      payload: { requestId: r.uuid },
    });
  }
}

/** ТУ переданы Заказчику — копия в филиал для контроля (п. 26). */
export async function tuSentToBranch(db: Db, r: RequestRow): Promise<void> {
  if (!r.branchId) return;
  const tu = await db.one<{ number: string; valid_until: string | null }>(
    `SELECT number, valid_until::text AS valid_until FROM documents WHERE request_id = $1 AND kind = 'ТУ'
      ORDER BY created_at DESC LIMIT 1`, [r.uuid]);
  await notify(db, await branchRecipients(db, r.branchId, ['curator', 'engineer']), {
    eventKey: 'tu_sent_branch', subject: `Выданы ТУ по заявке ${r.number}`,
    body: `Технические условия${tu ? ` № ${tu.number}${tu.valid_until ? `, действуют до ${tu.valid_until}` : ''}` : ''} ` +
      `выданы Заказчику ${r.counterpartyName} по объекту ${r.facilityName ?? '—'}. ` +
      'Направляются в филиал для контроля выполнения (п. 26); документ — в карточке заявки.',
    payload: { requestId: r.uuid },
  });
}
