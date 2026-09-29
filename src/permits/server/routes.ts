/**
 * API портала допусков: /api/v1/permits/… (План модуля допусков, §7).
 *
 * Подрядчик работает только со сведениями своей организации: работники,
 * удостоверения, транспорт, бригады и заявки. Специалист СУА видит заявки с
 * момента отправки и принимает решение один: одобряет, прикрепляя готовый файл
 * допуска, либо отказывает с причиной (ТЗ портала, §4.3). Статус меняется
 * только отдельными действиями — правкой записи обойти правила нельзя.
 */

import { randomUUID } from 'node:crypto';
import * as repo from '../../db/repo.ts';
import type { Db } from '../../db/client.ts';
import { ApiError } from '../../server/errors.ts';
import type { Ctx, Router } from '../../server/http.ts';
import { RAW_RESPONSE } from '../../server/http.ts';
import { parseMultipart } from '../../server/multipart.ts';
import type { UploadedFile } from '../../server/multipart.ts';
import * as rbac from '../../server/rbac.ts';
import type { Actor } from '../../server/rbac.ts';
import type { RouteDeps } from '../../server/context.ts';
import { sendSheets } from '../../server/reports.ts';
import * as data from '../db/permits.ts';
import type { AccessRequestRow, CompositionWorker, DraftFields, WorkerRow } from '../db/permits.ts';
import { BASIS_NAME, REGISTRY_BACKED, isBasisType, normalizeModes, verifyBasis } from '../domain/basis.ts';
import type { BasisType, BasisVerdict } from '../domain/basis.ts';
import { checkWorkers, localDateTime, normalizePlate, validIin, validPlate, validateForSubmit } from '../domain/request.ts';
import * as notices from './events.ts';

export const STATUS_NAME: Record<AccessRequestRow['status'], string> = {
  draft: 'Черновик',
  pending_review: 'На рассмотрении',
  approved: 'Одобрена',
  rejected: 'Отклонена',
};

const ENTITY = 'access_request';
const REF = 'ТЗ СУА';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INLINE = ['application/pdf', 'image/png', 'image/jpeg'];

/** Местное время объектов: Казахстан, UTC+5. */
export function localNow(now: Date = new Date()): string {
  return new Date(now.getTime() + 5 * 3_600_000).toISOString().slice(0, 16);
}

const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const ids = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((s) => UUID.test(s)) : []);
const isoDate = (v: unknown) => {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
};
const maskIin = (iin: string) => '••••••••' + iin.slice(-4);

export function registerPermitRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  /* ------------------------------ доступ ------------------------------ */

  /** Организация подрядчика: все его сведения ограничены ею. */
  function ownCounterparty(actor: Actor): string {
    rbac.require(actor, 'permit.own');
    if (!actor.counterpartyId) {
      throw ApiError.forbidden('Учётная запись не привязана к организации. Обратитесь в ДИТ.');
    }
    return actor.counterpartyId;
  }

  const isStaff = (actor: Actor) => rbac.can(actor, 'permit.view') || rbac.can(actor, 'permit.review');
  const isOwn = (actor: Actor, r: { counterparty_id: string }) =>
    rbac.can(actor, 'permit.own') && !!actor.counterpartyId && actor.counterpartyId === r.counterparty_id;

  async function denied(ctx: Ctx, actor: Actor, entityId: string, detail: string) {
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Отказ в доступе к заявке на допуск', entity: ENTITY, entityId,
      detail, result: 'denied', regulationRef: REF,
    });
  }

  /** Заявка в пределах прав: своя — всегда, чужая — сотруднику и только после отправки. */
  async function loadRequest(ctx: Ctx, actor: Actor, id: string): Promise<AccessRequestRow> {
    if (!rbac.can(actor, 'permit.own') && !isStaff(actor)) throw ApiError.forbidden();
    const r = await data.getRequest(db, id);
    if (!r) throw ApiError.notFound('Заявка на допуск не найдена');
    if (isOwn(actor, r)) return r;
    if (isStaff(actor) && r.status !== 'draft') return r;
    await denied(ctx, actor, r.id, `${r.number}: попытка открыть заявку другой организации`);
    throw ApiError.forbidden('Нет доступа к заявке другой организации');
  }

  async function loadOwnDraft(ctx: Ctx, actor: Actor, id: string): Promise<AccessRequestRow> {
    ownCounterparty(actor);
    const r = await loadRequest(ctx, actor, id);
    if (!isOwn(actor, r)) throw ApiError.forbidden();
    if (r.status !== 'draft') throw ApiError.conflict('Заявка уже отправлена: изменить её нельзя. Подайте новую заявку.');
    return r;
  }

  function requireVersion(body: { version?: unknown }): number {
    const version = Number(body.version);
    if (!Number.isInteger(version) || version < 1) throw ApiError.badRequest('Не указана версия заявки');
    return version;
  }

  const conflict = () => ApiError.conflict('Заявку изменили в другом окне — обновите карточку и повторите.');

  /* --------------------------- проверка основания --------------------------- */

  async function verdictFor(
    r: { basis_type: BasisType | null; basis_number: string; basis_document_id: string | null;
      basis_contract_id: string | null; basis_file_id: string | null; counterparty_id: string;
      facility_id: string | null; period_start: string | null },
  ): Promise<BasisVerdict> {
    const modes = await data.getModes(db);
    const input = {
      type: r.basis_type, number: r.basis_number, counterpartyId: r.counterparty_id, facilityId: r.facility_id,
      startDate: r.period_start ? r.period_start.slice(0, 10) : null, hasScan: !!r.basis_file_id,
    };
    if (!r.basis_type || !r.basis_number.trim()) return verifyBasis(input, null, modes);
    const found = await data.findBasis(db, r.basis_type, {
      id: r.basis_document_id ?? r.basis_contract_id, number: r.basis_number,
      counterpartyId: r.counterparty_id, facilityId: r.facility_id,
    });
    return verifyBasis(input, found, modes);
  }

  /* ------------------------------ карточка ------------------------------ */

  function shape(r: AccessRequestRow, staff: boolean) {
    return {
      id: r.id, number: r.number, status: r.status, statusName: STATUS_NAME[r.status],
      counterpartyId: r.counterparty_id, counterpartyName: r.counterparty_name, counterpartyBin: r.counterparty_bin,
      facilityId: r.facility_id, facilityName: r.facility_name, facilityInvNo: r.facility_inv_no,
      facilityAddress: r.facility_address, branchName: r.branch_name,
      basisType: r.basis_type, basisTypeName: r.basis_type ? BASIS_NAME[r.basis_type] : null,
      basisNumber: r.basis_number, basisRefId: r.basis_document_id ?? r.basis_contract_id,
      basisFileId: r.basis_file_id, basisFileName: r.basis_file_name, basisCheck: r.basis_check,
      basisConfirmedAt: r.basis_confirmed_at,
      basisConfirmedBy: staff ? r.basis_confirmed_by_name : null,
      basisConfirmNote: staff ? r.basis_confirm_note : null,
      description: r.description, periodStart: r.period_start, periodEnd: r.period_end, isUrgent: r.is_urgent,
      crewId: r.crew_id, passFileId: r.pass_file_id, passFileName: r.pass_file_name,
      rejectionReason: r.rejection_reason, reviewedAt: r.reviewed_at, reviewedBy: staff ? r.reviewed_by_name : null,
      submittedAt: r.submitted_at, createdAt: r.created_at, updatedAt: r.updated_at,
      createdBy: r.created_by_name, version: r.version,
      workersCount: r.workers_count, vehiclesCount: r.vehicles_count,
    };
  }

  /** Работник для карточки: удостоверения со сроками; полный ИИН — владельцу и СУА. */
  function cardWorker(w: CompositionWorker, startDate: string | null, fullIin: boolean) {
    return {
      workerId: w.worker_id, fullName: w.full_name, position: w.position,
      iin: fullIin ? w.iin : maskIin(w.iin),
      documents: w.documents.map((d) => ({ ...d, expired: !!startDate && d.validUntil < startDate })),
    };
  }

  /** Хронология для подрядчика — по статусам, без имён сотрудников Общества. */
  function customerTimeline(r: AccessRequestRow) {
    const out: { at: string; text: string }[] = [{ at: r.created_at, text: 'Черновик создан' }];
    if (r.submitted_at) out.push({ at: r.submitted_at, text: 'Отправлена на рассмотрение в СУА' });
    if (r.status === 'approved' && r.reviewed_at) out.push({ at: r.reviewed_at, text: 'Одобрена, файл допуска прикреплён' });
    if (r.status === 'rejected' && r.reviewed_at) out.push({ at: r.reviewed_at, text: `Отклонена: ${r.rejection_reason}` });
    return out.reverse();
  }

  async function card(actor: Actor, r: AccessRequestRow) {
    const own = isOwn(actor, r);
    const staff = isStaff(actor);
    const reviewer = rbac.can(actor, 'permit.review');
    const startDate = r.period_start ? r.period_start.slice(0, 10) : null;

    let { workers, vehicles } = await data.composition(db, r.id);
    if (r.status === 'draft') {
      // Черновик показывает актуальные сведения: удостоверение могли обновить в разделе «Бригады».
      const live = await data.workersByIds(db, r.counterparty_id, workers.map((w) => w.worker_id));
      workers = live.map(fromWorkerRow);
      const liveVehicles = await data.vehiclesByIds(db, r.counterparty_id, vehicles.map((v) => v.vehicle_id));
      vehicles = liveVehicles.map((v) => ({ vehicle_id: v.id, plate: v.plate, model: v.model, driver_name: v.driver_name }));
    }
    const basis: BasisVerdict | Record<string, unknown> = r.status === 'draft' ? await verdictFor(r) : r.basis_check;
    const needsConfirmation = !!(basis as BasisVerdict).needsConfirmation;
    const pending = r.status === 'pending_review';
    return {
      request: shape(r, staff),
      basis,
      workers: workers.map((w) => cardWorker(w, startDate, own || reviewer)),
      vehicles: vehicles.map((v) => ({ vehicleId: v.vehicle_id, plate: v.plate, model: v.model, driverName: v.driver_name })),
      issues: checkWorkers(data.toCheckWorkers(workers), startDate),
      history: staff
        ? await repo.listEvents(db, ENTITY, r.id)
        : customerTimeline(r),
      actions: {
        edit: own && r.status === 'draft',
        submit: own && r.status === 'draft',
        delete: own && r.status === 'draft',
        copy: own && r.status !== 'draft',
        confirmBasis: reviewer && pending && needsConfirmation && !r.basis_confirmed_at,
        approve: reviewer && pending && (!needsConfirmation || !!r.basis_confirmed_at),
        reject: reviewer && pending,
        downloadPass: r.status === 'approved' && (own || staff),
        openScans: own || reviewer,
      },
    };
  }

  function fromWorkerRow(w: WorkerRow): CompositionWorker {
    return {
      worker_id: w.id, full_name: w.full_name, iin: w.iin, position: w.position,
      documents: w.documents.map((d) => ({
        id: d.id, title: d.title, number: d.number ?? '', validUntil: d.validUntil, fileId: d.fileId ?? null,
        fileName: d.fileName ?? null,
      })),
    };
  }

  /* ------------------------------ черновик ------------------------------ */

  type DraftBody = {
    facilityId?: string | null; basisType?: string | null; basisNumber?: string; basisRefId?: string | null;
    description?: string; periodStart?: string | null; periodEnd?: string | null; isUrgent?: boolean;
    crewId?: string | null; workerIds?: string[]; vehicleIds?: string[]; version?: number;
  };

  async function parseDraft(counterpartyId: string, body: DraftBody) {
    const fields: Record<string, string> = {};
    let facilityId: string | null = null;
    let branchId: string | null = null;
    if (body.facilityId) {
      const f = UUID.test(String(body.facilityId))
        ? await db.one<{ id: string; branch_id: string }>(
          `SELECT id, branch_id FROM facilities WHERE id = $1 AND is_active`, [body.facilityId])
        : null;
      if (!f) fields.facilityId = 'Объект не найден в справочнике';
      else { facilityId = f.id; branchId = f.branch_id; }
    }
    const basisType: BasisType | null = isBasisType(body.basisType) ? body.basisType : null;
    if (body.basisType && !basisType) fields.basisType = 'Неизвестный тип основания';
    let basisNumber = text(body.basisNumber, 128);
    let basisDocumentId: string | null = null;
    let basisContractId: string | null = null;
    if (basisType && basisType !== 'lease' && body.basisRefId && UUID.test(String(body.basisRefId))) {
      // Номер выбран из реестра: берём его из записи, а не из текста формы.
      const found = await data.findBasis(db, basisType, {
        id: String(body.basisRefId), number: '', counterpartyId, facilityId,
      });
      if (found && found.counterpartyId === counterpartyId) {
        basisNumber = found.number;
        if (basisType === 'smr_contract') basisContractId = found.id;
        else basisDocumentId = found.id;
      }
    }
    const periodStart = body.periodStart ? localDateTime(body.periodStart) : null;
    const periodEnd = body.periodEnd ? localDateTime(body.periodEnd) : null;
    if (body.periodStart && !periodStart) fields.periodStart = 'Дата и время начала указаны неверно';
    if (body.periodEnd && !periodEnd) fields.periodEnd = 'Дата и время окончания указаны неверно';
    if (periodStart && periodEnd && periodEnd <= periodStart) fields.periodEnd = 'Окончание работ должно быть позже начала';

    let crewId: string | null = null;
    if (body.crewId && UUID.test(String(body.crewId))) {
      const crew = await db.one<{ id: string }>(
        `SELECT id FROM contractor_crews WHERE id = $1 AND counterparty_id = $2`, [body.crewId, counterpartyId]);
      crewId = crew?.id ?? null;
    }
    const workers = await data.workersByIds(db, counterpartyId, [...new Set(ids(body.workerIds))]);
    const vehicles = await data.vehiclesByIds(db, counterpartyId, [...new Set(ids(body.vehicleIds))]);
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте данные заявки', fields);

    const draft: DraftFields = {
      facilityId, branchId, basisType, basisNumber, basisDocumentId, basisContractId,
      description: text(body.description, 2000), periodStart, periodEnd, isUrgent: body.isUrgent === true, crewId,
    };
    return { draft, workers, vehicles };
  }

  router.post('/api/v1/permits/requests', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const cp = ownCounterparty(actor);
    const { draft, workers, vehicles } = await parseDraft(cp, await ctx.body<DraftBody>());
    const id = await db.tx(async (t) => {
      const created = await data.createDraft(t, cp, draft, actor.id);
      await data.snapshotComposition(t, created, workers, vehicles);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Создан черновик заявки на допуск', entity: ENTITY, entityId: created,
        detail: `работников: ${workers.length}, транспорт: ${vehicles.length}`, regulationRef: REF,
      });
      return created;
    });
    return card(actor, (await data.getRequest(db, id))!);
  });

  router.patch('/api/v1/permits/requests/:id', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadOwnDraft(ctx, actor, ctx.params.id);
    const body = await ctx.body<DraftBody>();
    const version = requireVersion(body);
    const { draft, workers, vehicles } = await parseDraft(r.counterparty_id, body);
    await db.tx(async (t) => {
      if (!await data.updateDraft(t, r.id, version, draft)) throw conflict();
      await data.snapshotComposition(t, r.id, workers, vehicles);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Изменён черновик заявки на допуск', entity: ENTITY, entityId: r.id,
        detail: r.number, regulationRef: REF,
      });
    });
    return card(actor, (await data.getRequest(db, r.id))!);
  });

  router.get('/api/v1/permits/requests/:id', async (ctx) => {
    const actor = await deps.actor(ctx);
    const r = await loadRequest(ctx, actor, ctx.params.id);
    return card(actor, r);
  });

  router.post('/api/v1/permits/requests/:id/delete', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadOwnDraft(ctx, actor, ctx.params.id);
    await db.tx(async (t) => {
      if (!await data.deleteDraft(t, r.id)) throw conflict();
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Удалён черновик заявки на допуск', entity: ENTITY, entityId: r.id,
        detail: r.number, regulationRef: REF,
      });
    });
    return { ok: true };
  });

  /** «Подать повторно»: новый черновик из прошлой заявки — без повторного ввода бригады. */
  router.post('/api/v1/permits/requests/:id/copy', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const cp = ownCounterparty(actor);
    const source = await loadRequest(ctx, actor, ctx.params.id);
    if (!isOwn(actor, source)) throw ApiError.forbidden();
    const { workers, vehicles } = await data.composition(db, source.id);
    const liveWorkers = await data.workersByIds(db, cp, workers.map((w) => w.worker_id));
    const liveVehicles = await data.vehiclesByIds(db, cp, vehicles.map((v) => v.vehicle_id));
    const id = await db.tx(async (t) => {
      const created = await data.createDraft(t, cp, {
        facilityId: source.facility_id, branchId: source.branch_id, basisType: source.basis_type,
        basisNumber: source.basis_number, basisDocumentId: source.basis_document_id,
        basisContractId: source.basis_contract_id, description: source.description,
        periodStart: null, periodEnd: null, isUrgent: false, crewId: source.crew_id,
      }, actor.id);
      await data.snapshotComposition(t, created, liveWorkers, liveVehicles);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Создан черновик по прошлой заявке', entity: ENTITY, entityId: created,
        detail: `из ${source.number}`, regulationRef: REF,
      });
      return created;
    });
    return card(actor, (await data.getRequest(db, id))!);
  });

  /** Проверка перед отправкой — для предпросмотра в мастере. */
  router.post('/api/v1/permits/requests/:id/check', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadOwnDraft(ctx, actor, ctx.params.id);
    const { basis, fields, issues } = await checkForSubmit(r, true);
    return { basis, fields, issues };
  });

  async function checkForSubmit(r: AccessRequestRow, consent: boolean) {
    const { workers, vehicles } = await data.composition(db, r.id);
    const live = await data.workersByIds(db, r.counterparty_id, workers.map((w) => w.worker_id));
    const liveVehicles = await data.vehiclesByIds(db, r.counterparty_id, vehicles.map((v) => v.vehicle_id));
    const basis = await verdictFor(r);
    const result = validateForSubmit({
      facilityId: r.facility_id, basisType: r.basis_type, basisNumber: r.basis_number,
      periodStart: r.period_start, periodEnd: r.period_end,
      workers: data.toCheckWorkers(live.map(fromWorkerRow)),
      vehicles: liveVehicles.map((v) => ({ plate: v.plate })),
      consent, counterpartyBlocked: r.counterparty_status === 'blocked', basis, now: localNow(),
    });
    if (live.length < workers.length || liveVehicles.length < vehicles.length) {
      result.fields.workers = 'Часть работников или транспорта удалена из списка организации — обновите состав заявки';
    }
    return { basis, live, liveVehicles, ...result };
  }

  router.post('/api/v1/permits/requests/:id/submit', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadOwnDraft(ctx, actor, ctx.params.id);
    const body = await ctx.body<{ version?: number; consent?: boolean }>();
    const version = requireVersion(body);
    const { basis, fields, live, liveVehicles } = await checkForSubmit(r, body.consent === true);
    if (Object.keys(fields).length) throw ApiError.badRequest('Заявку нельзя отправить', fields);

    await db.tx(async (t) => {
      // Снимок на момент отправки: дальнейшая правка работника заявку не меняет.
      await data.snapshotComposition(t, r.id, live, liveVehicles);
      if (!await data.submit(t, r.id, version, basis as unknown as Record<string, unknown>, actor.id)) throw conflict();
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Заявка на допуск отправлена на рассмотрение', entity: ENTITY,
        entityId: r.id, detail: `${r.number} · основание: ${basis.message}`, regulationRef: 'ТЗ портала §4.1–4.2',
      });
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Подтверждено согласие работников на обработку персональных данных',
        entity: ENTITY, entityId: r.id, detail: `работников: ${live.length}`, regulationRef: REF,
      });
      await notices.requestSubmitted(t, (await data.getRequest(t, r.id))!);
    });
    return card(actor, (await data.getRequest(db, r.id))!);
  });

  /* --------------------------- скан основания --------------------------- */

  async function storeFile(
    ctx: Ctx, actor: Actor, file: UploadedFile, counterpartyId: string, kind: data.PermitFile['kind'], entityId: string,
    t: Db = db,
  ): Promise<{ id: string; key: string; fileName: string; sha256: string }> {
    if (!deps.store) throw new ApiError('Хранилище файлов не настроено', 503, 'storage_unavailable');
    await deps.scan(ctx, actor, file, entityId);
    const saved = await deps.store.put(randomUUID(), file.filename, file.data);
    try {
      const id = await data.createFile(t, counterpartyId, kind, saved, actor.id);
      return { id, key: saved.key, fileName: saved.fileName, sha256: saved.sha256 };
    } catch (error) {
      await deps.store.remove(saved.key).catch(() => {});
      throw error;
    }
  }

  async function singleFile(ctx: Ctx) {
    const form = await parseMultipart(ctx.req);
    const file = form.files[0];
    return { form, file };
  }

  router.post('/api/v1/permits/requests/:id/basis-file', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadOwnDraft(ctx, actor, ctx.params.id);
    const { file } = await singleFile(ctx);
    if (!file) throw ApiError.badRequest('Выберите файл', { file: 'Выберите файл' });
    const saved = await storeFile(ctx, actor, file, r.counterparty_id, 'basis', r.id);
    await db.tx(async (t) => {
      await data.setBasisFile(t, r.id, saved.id);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Приложен скан основания', entity: ENTITY, entityId: r.id,
        detail: `${saved.fileName} · ${saved.sha256.slice(0, 12)}`, regulationRef: 'ТЗ портала §4.2',
      });
    });
    return card(actor, (await data.getRequest(db, r.id))!);
  });

  router.post('/api/v1/permits/requests/:id/basis-file/delete', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadOwnDraft(ctx, actor, ctx.params.id);
    await db.tx(async (t) => {
      await data.setBasisFile(t, r.id, null);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Удалён скан основания', entity: ENTITY, entityId: r.id,
        detail: r.basis_file_name ?? '', regulationRef: REF,
      });
    });
    return card(actor, (await data.getRequest(db, r.id))!);
  });

  /* ------------------------------ решение СУА ------------------------------ */

  async function loadPending(ctx: Ctx, actor: Actor, id: string) {
    rbac.require(actor, 'permit.review');
    const r = await loadRequest(ctx, actor, id);
    if (r.status !== 'pending_review') throw ApiError.conflict(`Заявка ${r.number} не на рассмотрении: ${STATUS_NAME[r.status]}`);
    return r;
  }

  router.post('/api/v1/permits/requests/:id/confirm-basis', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadPending(ctx, actor, ctx.params.id);
    const body = await ctx.body<{ version?: number; note?: string }>();
    const version = requireVersion(body);
    if (!(r.basis_check as { needsConfirmation?: boolean }).needsConfirmation) {
      throw ApiError.conflict('Основание подтверждено реестром системы — ручное подтверждение не требуется');
    }
    if (r.basis_confirmed_at) throw ApiError.conflict('Основание уже подтверждено');
    const note = text(body.note, 1000);
    if (note.length < 3) throw ApiError.badRequest('Укажите, чем подтверждено основание', { note: 'Укажите, чем подтверждено основание' });
    await db.tx(async (t) => {
      if (!await data.confirmBasis(t, r.id, version, note, actor.id)) throw conflict();
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Основание подтверждено вручную', entity: ENTITY, entityId: r.id,
        detail: `${r.number} · ${note}`, regulationRef: 'ТЗ портала §4.2',
      });
    });
    return card(actor, (await data.getRequest(db, r.id))!);
  });

  /** Одобрение: специалист СУА прикрепляет готовый файл допуска (ТЗ портала, §4.3). */
  router.post('/api/v1/permits/requests/:id/approve', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadPending(ctx, actor, ctx.params.id);
    const { form, file } = await singleFile(ctx);
    const version = requireVersion({ version: form.fields.version });
    if (!file) throw ApiError.badRequest('Прикрепите файл допуска', { file: 'Прикрепите файл допуска' });
    if ((r.basis_check as { needsConfirmation?: boolean }).needsConfirmation && !r.basis_confirmed_at) {
      throw ApiError.conflict('Основание не подтверждено реестром: сначала подтвердите его вручную');
    }
    const saved = await storeFile(ctx, actor, file, r.counterparty_id, 'pass', r.id);
    try {
      await db.tx(async (t) => {
        if (!await data.approve(t, r.id, version, saved.id, actor.id)) throw conflict();
        await repo.logEvent(t, {
          ...deps.audit(ctx, actor), action: 'Заявка на допуск одобрена, прикреплён файл допуска', entity: ENTITY,
          entityId: r.id, detail: `${r.number} · ${saved.fileName} · ${saved.sha256.slice(0, 12)}`,
          regulationRef: 'ТЗ портала §4.3',
        });
        await notices.requestApproved(t, (await data.getRequest(t, r.id))!);
      });
    } catch (error) {
      await db.query(`DELETE FROM permit_files WHERE id = $1`, [saved.id]).catch(() => {});
      await deps.store?.remove(saved.key).catch(() => {});
      throw error;
    }
    return card(actor, (await data.getRequest(db, r.id))!);
  });

  /** Отказ — только с причиной (ТЗ портала, §4.3). */
  router.post('/api/v1/permits/requests/:id/reject', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadPending(ctx, actor, ctx.params.id);
    const body = await ctx.body<{ version?: number; reason?: string }>();
    const version = requireVersion(body);
    const reason = text(body.reason, 2000);
    if (!reason) throw ApiError.badRequest('Укажите причину отказа', { reason: 'Укажите причину отказа' });
    await db.tx(async (t) => {
      if (!await data.reject(t, r.id, version, reason, actor.id)) throw conflict();
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Заявка на допуск отклонена', entity: ENTITY, entityId: r.id,
        detail: `${r.number} · ${reason}`, regulationRef: 'ТЗ портала §4.3',
      });
      await notices.requestRejected(t, (await data.getRequest(t, r.id))!);
    });
    return card(actor, (await data.getRequest(db, r.id))!);
  });

  /* -------------------------------- файлы -------------------------------- */

  async function sendFile(ctx: Ctx, actor: Actor, file: data.PermitFile, detail: string) {
    if (!deps.store) throw new ApiError('Хранилище файлов не настроено', 503, 'storage_unavailable');
    const preview = ctx.query.get('preview') === '1' && INLINE.includes(file.mime);
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: preview ? 'Просмотр файла' : 'Скачивание файла', entity: 'permit_file',
      entityId: file.id, detail: `${file.file_name} · ${detail}`, regulationRef: REF,
    });
    const { stream, size } = await deps.store.read(file.storage_key);
    ctx.res.writeHead(200, {
      'Content-Type': file.mime,
      'Content-Length': size,
      'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.file_name)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    });
    stream.pipe(ctx.res);
    return RAW_RESPONSE;
  }

  /** Файл допуска: подрядчику — своей заявки, сотрудникам — в пределах прав. */
  router.get('/api/v1/permits/requests/:id/pass-file', async (ctx) => {
    const actor = await deps.actor(ctx);
    const r = await loadRequest(ctx, actor, ctx.params.id);
    if (r.status !== 'approved' || !r.pass_file_id) throw ApiError.notFound('Файла допуска нет: заявка не одобрена');
    const file = await data.getFile(db, r.pass_file_id);
    if (!file) throw ApiError.notFound('Файл допуска не найден');
    return sendFile(ctx, actor, file, `файл допуска по заявке ${r.number}`);
  });

  /**
   * Сканы удостоверений и оснований — персональные данные. Открыть их может
   * организация-владелец и специалист СУА — в составе отправленной заявки.
   */
  router.get('/api/v1/permits/files/:fileId', async (ctx) => {
    const actor = await deps.actor(ctx);
    if (!UUID.test(ctx.params.fileId)) throw ApiError.notFound('Файл не найден');
    const file = await data.getFile(db, ctx.params.fileId);
    if (!file) throw ApiError.notFound('Файл не найден');
    if (rbac.can(actor, 'permit.own') && actor.counterpartyId === file.counterparty_id) {
      return sendFile(ctx, actor, file, 'своя организация');
    }
    const requestId = ctx.query.get('request') ?? '';
    if (rbac.can(actor, 'permit.review') && UUID.test(requestId)) {
      const r = await loadRequest(ctx, actor, requestId);
      if ((await data.requestFileIds(db, r.id)).has(file.id)) return sendFile(ctx, actor, file, `заявка ${r.number}`);
    }
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Отказ в доступе к файлу', entity: 'permit_file', entityId: file.id,
      detail: file.file_name, result: 'denied', regulationRef: REF,
    });
    throw ApiError.forbidden('Нет доступа к файлу');
  });

  /* ------------------------------ списки ------------------------------ */

  router.get('/api/v1/permits/requests', async (ctx) => {
    const actor = await deps.actor(ctx);
    const q = ctx.query;
    const mine = rbac.can(actor, 'permit.own') && (!isStaff(actor) || q.get('mine') === '1');
    if (!mine && !isStaff(actor)) throw ApiError.forbidden();
    const rows = await data.listRequests(db, {
      counterpartyId: mine ? ownCounterparty(actor) : null,
      status: q.get('status') || null,
      q: q.get('q') || null,
      facilityId: UUID.test(q.get('facilityId') ?? '') ? q.get('facilityId') : null,
      branchId: UUID.test(q.get('branchId') ?? '') ? q.get('branchId') : null,
      urgent: q.get('urgent') === '1' ? true : null,
      dateFrom: isoDate(q.get('dateFrom')), dateTo: isoDate(q.get('dateTo')),
      queue: q.get('queue') === '1',
      limit: Number(q.get('limit')) || 300,
    });
    return { requests: rows.map((r) => shape(r, isStaff(actor))) };
  });

  /** Справочники для мастера и фильтров. Объекты — только наименование и адрес. */
  router.get('/api/v1/permits/meta', async (ctx) => {
    const actor = await deps.actor(ctx);
    if (!rbac.can(actor, 'permit.own') && !isStaff(actor)) throw ApiError.forbidden();
    const [facilities, modes, counterparty] = await Promise.all([
      db.query(
        `SELECT f.id, f.inv_no, f.name, f.address, f.branch_id, b.name AS branch_name
           FROM facilities f JOIN branches b ON b.id = f.branch_id
          WHERE f.is_active ORDER BY f.name`),
      data.getModes(db),
      actor.counterpartyId
        ? db.one(`SELECT id, bin, name_full, status FROM counterparties WHERE id = $1`, [actor.counterpartyId])
        : null,
    ]);
    const branches = isStaff(actor)
      ? await db.query(`SELECT id, name FROM branches WHERE is_active ORDER BY name`)
      : [];
    return {
      facilities, branches, modes, counterparty,
      basisTypes: BASIS_NAME, registryBacked: REGISTRY_BACKED, statuses: STATUS_NAME, now: localNow(),
    };
  });

  /** Основания организации для выбора в мастере (ТЗ портала §4.2: номер — не свободный текст). */
  router.get('/api/v1/permits/basis-options', async (ctx) => {
    const actor = await deps.actor(ctx);
    const cp = ownCounterparty(actor);
    const facilityId = UUID.test(ctx.query.get('facilityId') ?? '') ? ctx.query.get('facilityId') : null;
    return data.basisOptions(db, cp, facilityId);
  });

  /* ------------------------ работники и удостоверения ------------------------ */

  router.get('/api/v1/permits/workers', async (ctx) => {
    const actor = await deps.actor(ctx);
    const cp = ownCounterparty(actor);
    return { workers: await data.listWorkers(db, cp, ctx.query.get('all') === '1') };
  });

  router.post('/api/v1/permits/workers', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const cp = ownCounterparty(actor);
    const body = await ctx.body<{ id?: string; fullName?: string; iin?: string; position?: string }>();
    const fullName = text(body.fullName, 255);
    const iin = text(body.iin, 12);
    const fields: Record<string, string> = {};
    if (fullName.length < 5 || !/\s/.test(fullName)) fields.fullName = 'Укажите фамилию, имя и отчество';
    if (!validIin(iin)) fields.iin = 'ИИН: 12 цифр, проверьте контрольный разряд';
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте данные работника', fields);
    const id = await db.tx(async (t) => {
      const saved = await data.saveWorker(t, cp, {
        id: body.id && UUID.test(body.id) ? body.id : null, fullName, iin, position: text(body.position, 255),
      }, actor.id);
      if (!saved) throw ApiError.notFound('Работник не найден');
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: body.id ? 'Изменены сведения о работнике' : 'Добавлен работник',
        entity: 'contractor_worker', entityId: saved, detail: `${fullName} · ИИН ${maskIin(iin)}`, regulationRef: REF,
      });
      return saved;
    });
    return { worker: (await data.listWorkers(db, cp, true)).find((w) => w.id === id) };
  });

  router.post('/api/v1/permits/workers/:id/deactivate', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const cp = ownCounterparty(actor);
    if (!UUID.test(ctx.params.id) || !await data.setWorkerActive(db, cp, ctx.params.id, false)) {
      throw ApiError.notFound('Работник не найден');
    }
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Работник исключён из списка организации', entity: 'contractor_worker',
      entityId: ctx.params.id, detail: '', regulationRef: REF,
    });
    return { ok: true };
  });

  async function ownWorker(actor: Actor, id: string) {
    const cp = ownCounterparty(actor);
    const worker = UUID.test(id) ? await data.getWorker(db, id) : null;
    if (!worker || worker.counterparty_id !== cp) throw ApiError.notFound('Работник не найден');
    return { cp, worker };
  }

  /** Удостоверение: новое либо обновление срока и скана существующего (поле documentId). */
  router.post('/api/v1/permits/workers/:id/documents', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const { cp, worker } = await ownWorker(actor, ctx.params.id);
    const { form, file } = await singleFile(ctx);
    const documentId = UUID.test(form.fields.documentId ?? '') ? form.fields.documentId : null;
    const title = text(form.fields.title, 255);
    const validUntil = isoDate(form.fields.validUntil);
    const fields: Record<string, string> = {};
    if (title.length < 3) fields.title = 'Укажите наименование документа';
    if (!validUntil) fields.validUntil = 'Укажите срок действия';
    if (!documentId && !file) fields.file = 'Приложите скан документа';
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте удостоверение', fields);

    const saved = file ? await storeFile(ctx, actor, file, cp, 'qualification', worker.id) : null;
    try {
      await db.tx(async (t) => {
        const entry = { title, number: text(form.fields.number, 128), validUntil: validUntil!, fileId: saved?.id ?? null };
        if (documentId) {
          if (!await data.updateWorkerDocument(t, worker.id, documentId, entry)) throw ApiError.notFound('Документ не найден');
        } else {
          await data.addWorkerDocument(t, worker.id, { ...entry, fileId: saved!.id }, actor.id);
        }
        await repo.logEvent(t, {
          ...deps.audit(ctx, actor), action: documentId ? 'Обновлено удостоверение работника' : 'Добавлено удостоверение работника',
          entity: 'contractor_worker', entityId: worker.id,
          detail: `${worker.full_name}: ${title}, до ${validUntil}${saved ? ` · ${saved.fileName}` : ''}`, regulationRef: REF,
        });
      });
    } catch (error) {
      if (saved) {
        await db.query(`DELETE FROM permit_files WHERE id = $1`, [saved.id]).catch(() => {});
        await deps.store?.remove(saved.key).catch(() => {});
      }
      throw error;
    }
    return { worker: (await data.listWorkers(db, cp, true)).find((w) => w.id === worker.id) };
  });

  router.post('/api/v1/permits/workers/:id/documents/:docId/delete', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const { cp, worker } = await ownWorker(actor, ctx.params.id);
    if (!UUID.test(ctx.params.docId) || !await data.deleteWorkerDocument(db, worker.id, ctx.params.docId)) {
      throw ApiError.notFound('Документ не найден');
    }
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Удалено удостоверение работника', entity: 'contractor_worker',
      entityId: worker.id, detail: worker.full_name, regulationRef: REF,
    });
    return { worker: (await data.listWorkers(db, cp, true)).find((w) => w.id === worker.id) };
  });

  /* ------------------------------ транспорт ------------------------------ */

  router.get('/api/v1/permits/vehicles', async (ctx) => {
    const actor = await deps.actor(ctx);
    return { vehicles: await data.listVehicles(db, ownCounterparty(actor)) };
  });

  router.post('/api/v1/permits/vehicles', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const cp = ownCounterparty(actor);
    const body = await ctx.body<{ id?: string; plate?: string; model?: string; driverName?: string }>();
    const plate = normalizePlate(body.plate);
    if (!validPlate(plate)) throw ApiError.badRequest('Проверьте госномер', { plate: 'Госномер: 4–12 букв и цифр' });
    const id = await data.saveVehicle(db, cp, {
      id: body.id && UUID.test(body.id) ? body.id : null, plate,
      model: text(body.model, 128), driverName: text(body.driverName, 255),
    }, actor.id);
    if (!id) throw ApiError.notFound('Транспорт не найден');
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Сохранён транспорт', entity: 'contractor_vehicle', entityId: id,
      detail: plate, regulationRef: REF,
    });
    return { vehicle: (await data.listVehicles(db, cp)).find((v) => v.id === id) };
  });

  router.post('/api/v1/permits/vehicles/:id/delete', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const cp = ownCounterparty(actor);
    if (!UUID.test(ctx.params.id) || !await data.deactivateVehicle(db, cp, ctx.params.id)) {
      throw ApiError.notFound('Транспорт не найден');
    }
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Транспорт исключён из списка организации', entity: 'contractor_vehicle',
      entityId: ctx.params.id, detail: '', regulationRef: REF,
    });
    return { ok: true };
  });

  /* ---------------------------- сохранённые бригады ---------------------------- */

  router.get('/api/v1/permits/crews', async (ctx) => {
    const actor = await deps.actor(ctx);
    return { crews: await data.listCrews(db, ownCounterparty(actor)) };
  });

  router.post('/api/v1/permits/crews', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const cp = ownCounterparty(actor);
    const body = await ctx.body<{ id?: string; name?: string; workerIds?: string[]; vehicleIds?: string[] }>();
    const name = text(body.name, 255);
    if (name.length < 2) throw ApiError.badRequest('Укажите название бригады', { name: 'Укажите название бригады' });
    const workerIds = ids(body.workerIds);
    if (!workerIds.length) throw ApiError.badRequest('Добавьте в бригаду работников', { workers: 'Добавьте в бригаду работников' });
    let id = '';
    try {
      id = await db.tx(async (t) => {
        const saved = await data.saveCrew(t, cp, {
          id: body.id && UUID.test(body.id) ? body.id : null, name, workerIds, vehicleIds: ids(body.vehicleIds),
        }, actor.id);
        if (!saved) throw ApiError.notFound('Бригада не найдена');
        await repo.logEvent(t, {
          ...deps.audit(ctx, actor), action: 'Сохранена бригада', entity: 'contractor_crew', entityId: saved,
          detail: `${name}: работников ${workerIds.length}`, regulationRef: REF,
        });
        return saved;
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw ApiError.badRequest('Бригада с таким названием уже есть', { name: 'Бригада с таким названием уже есть' });
      }
      throw error;
    }
    return { crew: (await data.listCrews(db, cp)).find((c) => c.id === id) };
  });

  router.post('/api/v1/permits/crews/:id/delete', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const cp = ownCounterparty(actor);
    if (!UUID.test(ctx.params.id) || !await data.deleteCrew(db, cp, ctx.params.id)) throw ApiError.notFound('Бригада не найдена');
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Удалена бригада', entity: 'contractor_crew', entityId: ctx.params.id,
      detail: '', regulationRef: REF,
    });
    return { ok: true };
  });

  /* ---------------------------- режим проверки ---------------------------- */

  router.get('/api/v1/permits/settings', async (ctx) => {
    const actor = await deps.actor(ctx);
    if (!isStaff(actor)) throw ApiError.forbidden();
    return { modes: await data.getModes(db), registryBacked: REGISTRY_BACKED, basisTypes: BASIS_NAME };
  });

  /** Режим проверки оснований меняет ДИТ, когда данные в системе полны (План модуля допусков, §5.3). */
  router.post('/api/v1/permits/settings', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    const body = await ctx.body<{ modes?: Record<string, string> }>();
    const modes = normalizeModes(body.modes);
    await db.tx(async (t) => {
      await data.setModes(t, modes, actor.id);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Изменён режим проверки оснований допуска', entity: 'settings',
        entityId: data.MODES_KEY,
        detail: Object.entries(modes).map(([k, v]) => `${BASIS_NAME[k as BasisType]}: ${v === 'strict' ? 'строгий' : 'мягкий'}`).join('; '),
        regulationRef: 'ТЗ портала §6.1',
      });
    });
    return { modes };
  });

  /* -------------------------------- отчёт -------------------------------- */

  /** Отчёт по заявкам на допуск с фильтрами и выгрузкой (ТЗ портала, §5.1). */
  router.get('/api/v1/permits/reports/requests', async (ctx) => {
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'permit.view');
    const q = ctx.query;
    const filter = {
      status: q.get('status') || null,
      q: q.get('q') || null,
      facilityId: UUID.test(q.get('facilityId') ?? '') ? q.get('facilityId') : null,
      branchId: UUID.test(q.get('branchId') ?? '') ? q.get('branchId') : null,
      urgent: q.get('urgent') === '1' ? true : null,
      dateFrom: isoDate(q.get('dateFrom')), dateTo: isoDate(q.get('dateTo')),
    };
    const { rows, summary } = await data.report(db, filter);
    const format = q.get('format');
    if (format === 'csv' || format === 'xlsx') {
      await repo.logEvent(db, {
        ...deps.audit(ctx, actor), action: 'Выгрузка отчёта по заявкам на допуск', entity: 'report',
        entityId: 'access_requests', detail: `${rows.length} заявок · ${format}`, regulationRef: 'ТЗ портала §5.1',
      });
      const hours = (r: AccessRequestRow) => (r.reviewed_at && r.submitted_at
        ? Math.round((Date.parse(r.reviewed_at) - Date.parse(r.submitted_at)) / 360_000) / 10 : null);
      const day = (v: string | null) => (v ? new Date(v).toISOString().slice(0, 10) : '');
      const sheet = {
        name: 'Заявки на допуск',
        header: ['Номер', 'Отправлена', 'Организация', 'БИН', 'Объект', 'Филиал', 'Основание', 'Номер основания',
          'Проверка основания', 'Подтверждено вручную', 'Начало работ', 'Окончание работ', 'Работников', 'Транспорт',
          'Срочно', 'Статус', 'Дата решения', 'Специалист СУА', 'Причина отказа', 'Часов до решения'],
        rows: rows.map((r) => [
          r.number, day(r.submitted_at), r.counterparty_name, r.counterparty_bin, r.facility_name, r.branch_name,
          r.basis_type ? BASIS_NAME[r.basis_type] : '', r.basis_number, (r.basis_check as { message?: string }).message ?? '',
          r.basis_confirmed_at ? 'да' : '', r.period_start?.replace('T', ' ') ?? '', r.period_end?.replace('T', ' ') ?? '',
          r.workers_count, r.vehicles_count, r.is_urgent ? 'да' : '', STATUS_NAME[r.status], day(r.reviewed_at),
          r.reviewed_by_name, r.rejection_reason, hours(r),
        ]),
      };
      const totals = {
        name: 'Итоги',
        header: ['Показатель', 'Значение'],
        rows: [
          ['Всего заявок', summary.total], ['На рассмотрении', summary.pending], ['Одобрено', summary.approved],
          ['Отклонено', summary.rejected], ['Срочных', summary.urgent], ['Основание подтверждено вручную', summary.manualBasis],
          ['Среднее время до решения, ч', summary.avgDecisionHours], ['Медиана времени до решения, ч', summary.medianDecisionHours],
          ...summary.rejectionReasons.map((x) => [`Причина отказа: ${x.reason}`, x.count]),
        ],
      };
      return sendSheets(ctx, format, 'zayavki-na-dopusk', format === 'csv' ? [sheet] : [sheet, totals]);
    }
    return { rows: rows.map((r) => shape(r, true)), summary };
  });
}
