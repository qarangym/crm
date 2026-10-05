/**
 * Маршруты расчёта технической возможности (План завершения, B5; Регламент раздел 4).
 *
 * Раньше калькулятор работал только в браузере: результат нельзя было
 * воспроизвести и проверить. Теперь расчёт выполняет сервер по данным
 * мастер-файла и параметрам заявки и сохраняет его вместе с версией реестра
 * (п. 16.5). Решение о ТВ по-прежнему фиксирует инженер через `/tv`.
 */

import * as repo from '../db/repo.ts';
import type { Db } from '../db/client.ts';
import { addWorkingDays, today } from '../domain/calendar.ts';
import { validText } from '../domain/validation.ts';
import { assessCapacity } from '../process/capacity.ts';
import type { CapacityRequest, CapacityResult } from '../process/capacity.ts';
import { ApiError } from './errors.ts';
import type { Router } from './http.ts';
import * as rbac from './rbac.ts';
import type { RouteDeps } from './context.ts';
import { notify, roleRecipients } from './notify.ts';
import { pickAssets } from '../db/executors.ts';

/** Данные мастер-файла по объекту и расчёт по ним — общий для заявки и экрана реестра. */
async function assessFacility(db: Db, facilityId: string, input: CapacityRequest): Promise<{ result: CapacityResult; registryVersion: string | null }> {
  const facility = await db.one<{ kind: string; passport_load_kg: string | null; power_input_kw: string | null; free_area_m2: string | null }>(
    `SELECT f.kind, c.passport_load_kg, c.power_input_kw, c.free_area_m2
       FROM facilities f LEFT JOIN facility_capacity c ON c.facility_id = f.id WHERE f.id = $1`, [facilityId]);
  if (!facility) throw ApiError.notFound('Объект не найден');
  const tiers = await db.query<{ id: string; height_m: string; capacity_kg: string | null; occupied_kg: string }>(
    `SELECT id, height_m, capacity_kg, occupied_kg FROM facility_tiers WHERE facility_id = $1 ORDER BY height_m DESC`,
    [facilityId]);
  if (input.tierId && !tiers.some((t) => t.id === input.tierId)) {
    throw ApiError.badRequest('Ярус не относится к объекту', { tierId: 'Выберите ярус объекта' });
  }
  const tenants = await db.query<{ weight_kg: string | null; windage_m2: string | null; power_kw: string | null }>(
    `SELECT weight_kg, windage_m2, power_kw FROM facility_tenants WHERE facility_id = $1 AND dismounted_at IS NULL`,
    [facilityId]);
  const setting = await db.one<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'tv_near_limit_percent'`);
  const threshold = typeof setting?.value === 'number' ? setting.value : null;
  const registry = await db.one<{ version: string }>(`SELECT version FROM registry_versions ORDER BY published_at DESC LIMIT 1`);
  const orNull = (v: string | null) => (v === null ? null : Number(v));
  const result = assessCapacity({
    facility: {
      kind: facility.kind,
      passportLoadKg: orNull(facility.passport_load_kg),
      powerInputKw: orNull(facility.power_input_kw),
      freeAreaM2: orNull(facility.free_area_m2),
    },
    tiers: tiers.map((t) => ({ id: t.id, heightM: Number(t.height_m), capacityKg: orNull(t.capacity_kg), occupiedKg: Number(t.occupied_kg) })),
    tenants: tenants.map((t) => ({ weightKg: orNull(t.weight_kg), windageM2: orNull(t.windage_m2), powerKw: orNull(t.power_kw) })),
    request: input,
    nearLimitPercent: threshold,
  });
  return { result, registryVersion: registry?.version ?? null };
}

const num = (v: unknown): number => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

export function registerCapacityRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  router.get('/api/v1/requests/:id/capacity-checks', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'registry.view');
    const request = await deps.loadVisible(actor, ctx.params.id);
    return {
      checks: await db.query(
        `SELECT c.id, c.registry_version, c.verdict, c.input, c.result, c.created_at, u.full_name AS author
           FROM capacity_checks c JOIN users u ON u.id = c.created_by
          WHERE c.request_id = $1 ORDER BY c.created_at DESC`, [request.uuid]),
    };
  });

  /** Расчёт по параметрам заявки; ярус можно указать явно (`tierId`). */
  router.post('/api/v1/requests/:id/capacity-check', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'request.tv');
    const request = await deps.loadVisible(actor, ctx.params.id);
    const body = await ctx.body<{ tierId?: string | null }>();

    const services = (await repo.listRequestServices(db, request.uuid)) as Record<string, any>[];
    const item = services.find((s) => s.placement === 'ams') ?? services.find((s) => s.placement === 'room');
    if (!item) {
      throw ApiError.badRequest('В заявке нет размещения на АМС или в помещении — расчёт ёмкости не требуется');
    }
    const p = item.params ?? {};
    const input: CapacityRequest = {
      placement: item.placement,
      weightKg: num(p.weight), windageM2: num(p.windage), powerKw: num(p.power), areaM2: num(p.area),
      heightM: p.height === undefined || p.height === '' ? null : num(p.height),
      tierId: body.tierId ?? null,
    };

    if (!request.facilityId) throw ApiError.conflict('Сначала определите объект по адресу из заявки (п. 16.1)');
    const { result, registryVersion } = await assessFacility(db, request.facilityId, input);
    const registry = registryVersion ? { version: registryVersion } : null;

    const saved = await db.tx(async (t) => {
      const row = await t.one<{ id: string; created_at: string }>(
        `INSERT INTO capacity_checks (request_id, facility_id, registry_version, verdict, input, result, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
        [request.uuid, request.facilityId, registry?.version ?? null, result.verdict,
         JSON.stringify(input), JSON.stringify(result), actor.id]);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Выполнен расчёт технической возможности', entity: 'request',
        entityId: request.uuid,
        detail: `${result.verdict === 'ok' ? 'ёмкости достаточно' : result.verdict === 'insufficient' ? 'превышение' : 'данных недостаточно'}` +
          ` · реестр ${registry?.version ?? 'не опубликован'}`,
        regulationRef: 'пп. 16.2, 16.5, 17',
      });
      return row!;
    });
    return { check: { id: saved.id, created_at: saved.created_at, registryVersion: registry?.version ?? null, ...result } };
  });

  /**
   * Расчёт по объекту без заявки — экран «Реестр АМС и ТВ» (К3): инженер
   * прикидывает размещение до подачи заявки. Результат не сохраняется.
   */
  router.post('/api/v1/facilities/:id/assess', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'registry.view');
    const body = await ctx.body<{ placement?: string; weightKg?: unknown; windageM2?: unknown; powerKw?: unknown; areaM2?: unknown; heightM?: unknown; tierId?: string | null }>();
    const input: CapacityRequest = {
      placement: body.placement === 'room' ? 'room' : 'ams',
      weightKg: num(body.weightKg), windageM2: num(body.windageM2), powerKw: num(body.powerKw), areaM2: num(body.areaM2),
      heightM: body.heightM === undefined || body.heightM === '' || body.heightM === null ? null : num(body.heightM),
      tierId: body.tierId ?? null,
    };
    return assessFacility(db, ctx.params.id, input);
  });

  /* ---------------------- версии реестра (пп. 13, 16.5; В7) ---------------------- */

  router.get('/api/v1/registry/versions', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'registry.view');
    return {
      versions: await db.query(
        `SELECT v.id, v.version, v.published_at, v.note, u.full_name AS author
           FROM registry_versions v LEFT JOIN users u ON u.id = v.published_by
          ORDER BY v.published_at DESC LIMIT 100`),
    };
  });

  /** Публикация версии мастер-файла — служба технического учёта активов (пп. 12–13). */
  router.post('/api/v1/registry/versions', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'registry.edit');
    const body = await ctx.body<{ version?: string; note?: string }>();
    const version = String(body.version ?? '').trim();
    if (!/^[\p{L}\p{N}._\- ]{2,64}$/u.test(version)) {
      throw ApiError.badRequest('Укажите номер версии', { version: 'Например, 2026-10-01 или 2026.10-1' });
    }
    if (await db.one('SELECT 1 FROM registry_versions WHERE version = $1', [version])) {
      throw ApiError.conflict(`Версия ${version} уже опубликована`);
    }
    const row = await db.tx(async (t) => {
      const saved = await t.one<{ id: string }>(
        `INSERT INTO registry_versions (version, published_by, note) VALUES ($1,$2,$3) RETURNING id`,
        [version, actor.id, String(body.note ?? '').trim()]);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Опубликована версия реестра АМС', entity: 'registry', entityId: saved!.id,
        detail: `${version}${body.note ? `: ${body.note}` : ''}`, regulationRef: 'пп. 13, 16.5',
      });
      return saved!;
    });
    return { id: row.id, version };
  });

  /* ------------------- запросы изменений в техучёт (п. 12; С7) ------------------- */

  router.get('/api/v1/registry/changes', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'registry.view');
    const open = ctx.query.get('open') === '1';
    return {
      changes: await db.query(
        `SELECT c.id, c.facility_id, f.name AS facility_name, f.inv_no, c.request_id, r.number AS request_number,
                c.body, c.created_at, a.full_name AS author, c.due_at::text AS due_at, c.resolved_at,
                c.assignee_id, asg.full_name AS assignee_name,
                rb.full_name AS resolved_by_name, c.resolution
           FROM registry_change_requests c
           JOIN facilities f ON f.id = c.facility_id
           LEFT JOIN requests r ON r.id = c.request_id
           LEFT JOIN users a ON a.id = c.created_by
           LEFT JOIN users asg ON asg.id = c.assignee_id AND asg.is_active
           LEFT JOIN users rb ON rb.id = c.resolved_by
          WHERE ($1::boolean IS FALSE OR c.resolved_at IS NULL)
          ORDER BY c.resolved_at IS NULL DESC, c.created_at DESC LIMIT 300`, [open]),
    };
  });

  /** Запрос изменения реестра: изменения вносит только техучёт (п. 12), срок — 1 рабочий день (пп. 13–14). */
  router.post('/api/v1/registry/changes', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'registry.request');
    const body = await ctx.body<{ facilityId?: string; requestId?: string | null; body?: string }>();
    const text = String(body.body ?? '').trim();
    const facility = await db.one<{ id: string; name: string; inv_no: string }>('SELECT id, name, inv_no FROM facilities WHERE id = $1', [body.facilityId]);
    const fields: Record<string, string> = {};
    if (!facility) fields.facilityId = 'Выберите объект';
    if (!validText(text, 10)) fields.body = 'Опишите, что изменить в реестре и на каком основании';
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте запрос', fields);
    const dueAt = addWorkingDays(today(), 1, await repo.calendar(db));
    const id = await db.tx(async (t) => {
      const assignee = await pickAssets(t);
      const row = await t.one<{ id: string }>(
        `INSERT INTO registry_change_requests (facility_id, request_id, body, created_by, due_at, assignee_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [facility!.id, body.requestId || null, text, actor.id, dueAt, assignee?.id ?? null]);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Запрос изменения реестра АМС', entity: 'registry', entityId: row!.id,
        detail: `${facility!.name} (инв. № ${facility!.inv_no}): ${text}`, regulationRef: 'пп. 12–14',
      });
      await notify(t, assignee ? [assignee.email] : await roleRecipients(t, ['assets']), {
        eventKey: 'registry_change_requested', ruleId: 19,
        subject: `Изменение реестра АМС: ${facility!.name}`,
        body: `${text}\n\nОбъект: ${facility!.name}, инв. № ${facility!.inv_no}.\n` +
          `Внести изменения — не позднее ${dueAt} (пп. 13–14 Регламента).`,
        payload: { changeId: row!.id },
      });
      return row!.id;
    });
    return { id };
  });

  router.post('/api/v1/registry/changes/:id/resolve', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'registry.edit');
    const body = await ctx.body<{ resolution?: string }>();
    const resolution = String(body.resolution ?? '').trim();
    if (resolution.length < 5) throw ApiError.badRequest('Укажите, что сделано', { resolution: 'Например: внесено в версию 2026-10-02' });
    const row = await db.one<{ id: string; author_email: string | null; body: string }>(
      `UPDATE registry_change_requests c SET resolved_at = now(), resolved_by = $2, resolution = $3
         FROM users a WHERE c.id = $1 AND c.resolved_at IS NULL AND a.id = c.created_by
        RETURNING c.id, a.email AS author_email, c.body`, [ctx.params.id, actor.id, resolution]);
    if (!row) throw ApiError.conflict('Запрос уже исполнен или не найден');
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Запрос изменения реестра исполнен', entity: 'registry', entityId: row.id,
      detail: resolution, regulationRef: 'пп. 12–14',
    });
    await notify(db, row.author_email ? [row.author_email] : [], {
      eventKey: 'registry_change_resolved', subject: 'Изменение реестра АМС внесено',
      body: `Запрос: ${row.body}\n\nРезультат: ${resolution}`, payload: { changeId: row.id },
    });
    return { ok: true };
  });
}
