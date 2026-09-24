/**
 * Исправление заявки по замечаниям (План завершения, A5; ТЗ №11).
 *
 * ОР ПСД возвращает заявку с перечнем замечаний к полям. Заказчик исправляет
 * ту же заявку — номер и история сохраняются — и отправляет повторно.
 * Замечание снимается, когда поле, к которому оно относится, изменено;
 * замечание общего характера снимает ОР ПСД вручную.
 */

import * as repo from '../db/repo.ts';
import { estimate } from '../domain/pricing.ts';
import { today } from '../domain/calendar.ts';
import { validateAmendment } from '../domain/validation.ts';
import type { RequestService, Service, Tariff } from '../domain/types.ts';
import { customerStatus } from '../process/engine.ts';
import type { StageCode } from '../process/stages.ts';
import { ApiError } from './errors.ts';
import type { Router } from './http.ts';
import { enqueue } from './notifications.ts';
import * as rbac from './rbac.ts';
import type { RouteDeps } from './context.ts';

/** Этапы, на которых Заказчик может исправить заявку: до КП и договора. */
const EDITABLE: StageCode[] = ['draft', 'registered', 'tv_review'];

type ServiceInput = {
  service: Service; placement: string; params?: Record<string, unknown>;
  tariffId?: string | null; tariffQuantity?: number | null; basisReference?: string | null;
};

/**
 * Плоское представление полей заявки: ключи совпадают с ключами ошибок
 * проверки формы (`facilityId`, `services.0.weight`), по ним же ставятся
 * замечания. Услуги упорядочены по виду — так же, как их хранит база.
 */
export function flattenRequest(facilityId: string | null, services: ServiceInput[]): Map<string, string> {
  const out = new Map<string, string>();
  out.set('facilityId', String(facilityId ?? ''));
  const sorted = [...services].sort((a, b) => a.service.localeCompare(b.service));
  sorted.forEach((s, i) => {
    const p = `services.${i}.`;
    out.set(`${p}service`, s.service);
    out.set(`${p}placement`, String(s.placement ?? ''));
    out.set(`${p}basisReference`, String(s.basisReference ?? ''));
    out.set(`${p}tariffId`, String(s.tariffId ?? ''));
    out.set(`${p}tariffQuantity`, String(s.tariffQuantity ?? ''));
    for (const [key, value] of Object.entries(s.params ?? {})) out.set(`${p}${key}`, JSON.stringify(value ?? ''));
  });
  return out;
}

/** Изменилось ли поле замечания (точный ключ либо любое поле внутри него, например `services.0`). */
export function remarkFieldChanged(key: string, before: Map<string, string>, after: Map<string, string>): boolean {
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const k of keys) {
    if (k !== key && !k.startsWith(key + '.')) continue;
    if ((before.get(k) ?? '') !== (after.get(k) ?? '')) return true;
  }
  return false;
}

export function registerAmendmentRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  /** Правка заявки: черновик — в любой момент; поданная — только при открытых замечаниях. */
  router.patch('/api/v1/requests/:id', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'request.edit');
    const request = await deps.loadVisible(actor, ctx.params.id);

    if (!EDITABLE.includes(request.stageCode)) {
      throw ApiError.conflict('Заявку можно исправить только до формирования КП и договора');
    }
    if (request.stageCode !== 'draft' && request.openRemarks === 0) {
      throw ApiError.conflict('Поданная заявка исправляется только по замечаниям ОР ПСД (ТЗ №11)');
    }

    const body = await ctx.body<{ facilityId?: string; services?: ServiceInput[]; version?: number }>();
    const draft = request.stageCode === 'draft';
    const services = (body.services ?? []).map((s) => ({
      service: s.service, placement: s.placement, params: s.params ?? {},
      tariffId: s.tariffId ?? null, tariffQuantity: s.tariffQuantity ?? null,
      basisReference: s.basisReference ?? null,
    }));
    const facilityId = body.facilityId ?? request.facilityId;
    const errors = validateAmendment({ facilityId, services: services as RequestService[] }, draft);
    if (Object.keys(errors).length) throw ApiError.badRequest('Проверьте заполнение формы', errors);

    const facility = (await repo.listFacilities(db)).find((f) => f.id === facilityId);
    if (!facility) throw ApiError.badRequest('Выберите объект из справочника', { facilityId: 'Объект не найден' });

    const stored = (await repo.listRequestServices(db, request.uuid)) as unknown as ServiceInput[];
    const before = flattenRequest(request.facilityId, stored.map((s: any) => ({
      service: s.service, placement: s.placement, params: s.params, tariffId: s.tariff_id,
      tariffQuantity: s.tariff_quantity, basisReference: s.basis_reference,
    })));
    const after = flattenRequest(facility.id, services);
    const changed = [...new Set([...before.keys(), ...after.keys()])]
      .filter((k) => (before.get(k) ?? '') !== (after.get(k) ?? ''));
    if (!changed.length) throw ApiError.badRequest('Изменений нет: исправьте поля, указанные в замечаниях');

    const tariffs = (await repo.listTariffs(db, today())) as unknown as Tariff[];
    const priced = estimate(services as never, tariffs, today());
    const remarks = await repo.openRemarks(db, request.uuid);
    const fixed = remarks.filter((r) => remarkFieldChanged(r.field_key, before, after));

    await db.tx(async (t) => {
      const patch: Record<string, unknown> = {
        facility_id: facility.id,
        branch_id: facility.branch_id,
        free_of_charge: priced.lines.every((l) => l.amount === 0),
        total_amount: priced.hasUndetermined ? null : priced.total,
      };
      // Исходные данные изменились — прежняя оценка ТВ к ним не относится (п. 16).
      if (request.stageCode === 'tv_review' && request.tvStatus !== 'pending') {
        Object.assign(patch, { tv_status: 'pending', master_file_version: null, verification_calc: null });
      }
      const ok = await repo.updateRequestFields(t, request.uuid, body.version ?? request.version, patch);
      if (!ok) throw ApiError.conflict('Карточка изменилась. Обновите заявку и повторите');
      await repo.replaceRequestServices(t, request.uuid,
        services.map((s, i) => ({ ...s, amount: priced.lines[i]?.amount ?? null })));
      await repo.resolveRemarkIds(t, request.uuid, fixed.map((r) => r.id));
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: draft ? 'Черновик заявки изменён' : 'Заявка исправлена по замечаниям',
        entity: 'request', entityId: request.uuid,
        detail: `Изменены поля: ${changed.slice(0, 30).join(', ')}${changed.length > 30 ? '…' : ''}` +
          (fixed.length ? `. Устранено замечаний: ${fixed.length}` : '') +
          (patch.tv_status ? '. Оценка ТВ сброшена: изменились исходные данные' : ''),
        regulationRef: 'ТЗ №11, №12',
      });
    });

    const updated = await repo.getRequest(db, request.uuid);
    return {
      request: { ...updated!, customerStatus: customerStatus(updated!) },
      remarks: await repo.listRemarks(db, request.uuid),
      estimate: priced,
    };
  });

  /**
   * Повторная отправка исправленной заявки ОР ПСД. Пока открыто хотя бы одно
   * замечание, отправка отклоняется с перечнем того, что осталось исправить.
   */
  router.post('/api/v1/requests/:id/resubmit', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'request.edit');
    const request = await deps.loadVisible(actor, ctx.params.id);

    const remaining = await repo.openRemarks(db, request.uuid);
    if (remaining.length) {
      const e = ApiError.badRequest('Исправьте заявку по всем замечаниям');
      e.fields = Object.fromEntries(remaining.map((r) => [r.field_key, r.text]));
      throw e;
    }
    const lastReturn = await db.one<{ email: string; number: string }>(
      `SELECT u.email, r.number FROM request_remarks m
         JOIN users u ON u.id = m.created_by JOIN requests r ON r.id = m.request_id
        WHERE m.request_id = $1 ORDER BY m.created_at DESC LIMIT 1`, [request.uuid]);
    if (!lastReturn) throw ApiError.conflict('Заявка не возвращалась на доработку');

    await db.tx(async (t) => {
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Исправленная заявка отправлена повторно', entity: 'request',
        entityId: request.uuid, detail: request.number ?? '', regulationRef: 'ТЗ №11',
      });
      await enqueue(t, {
        eventKey: 'request_resubmitted', recipient: lastReturn.email,
        subject: `Заявка ${request.number} исправлена по замечаниям`,
        body: `Заказчик исправил заявку ${request.number} и отправил её повторно. ` +
          'Номер и история заявки сохранены.',
        payload: { requestId: request.uuid },
      });
    });
    const updated = await repo.getRequest(db, request.uuid);
    return { request: { ...updated!, customerStatus: customerStatus(updated!) } };
  });

  /** Ручное снятие замечания общего характера — ОР ПСД. */
  router.post('/api/v1/requests/:id/remarks/:remarkId/resolve', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'request.remark');
    const request = await deps.loadVisible(actor, ctx.params.id);
    const body = await ctx.body<{ note?: string }>();
    await db.tx(async (t) => {
      const n = await repo.resolveRemarkIds(t, request.uuid, [ctx.params.remarkId]);
      if (!n) throw ApiError.notFound('Открытое замечание не найдено');
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Замечание снято', entity: 'request', entityId: request.uuid,
        detail: String(body.note ?? '').trim(), regulationRef: 'ТЗ №11',
      });
    });
    return { remarks: await repo.listRemarks(db, request.uuid) };
  });
}
