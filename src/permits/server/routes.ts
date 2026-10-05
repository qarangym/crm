/**
 * API портала допусков: /api/v1/permits/… (План модуля допусков, §7; Инструкция
 * о допуске сторонних организаций на объекты АО «Казтелерадио»).
 *
 * Подрядчик работает только со сведениями своей организации: работники по
 * Приложению 1, удостоверения, транспорт, бригады и заявки. Специалист СУА
 * рассматривает заявку в течение 14 рабочих дней (п. 14); где Инструкция требует,
 * заявку согласует руководство филиала (пп. 8, 14, 18). Одобрение выдаёт
 * электронный допуск с кодом проверки; копия ответа уходит в филиал (п. 15).
 * Статус меняется только отдельными действиями — правкой записи обойти правила нельзя.
 */

import { randomUUID } from 'node:crypto';
import * as repo from '../../db/repo.ts';
import { pickPermits } from '../../db/executors.ts';
import type { Db } from '../../db/client.ts';
import { addWorkingDays, isWorkingDay, today } from '../../domain/calendar.ts';
import { validBin } from '../../domain/validation.ts';
import { ApiError } from '../../server/errors.ts';
import type { Ctx, Router } from '../../server/http.ts';
import { RAW_RESPONSE } from '../../server/http.ts';
import { parseMultipart } from '../../server/multipart.ts';
import type { UploadedFile } from '../../server/multipart.ts';
import * as rbac from '../../server/rbac.ts';
import type { Actor } from '../../server/rbac.ts';
import type { RouteDeps } from '../../server/context.ts';
import { sendSheets } from '../../server/reports.ts';
import { dmy, html, localStamp, printPage, sendHtml } from '../../server/printing.ts';
import * as data from '../db/permits.ts';
import type { AccessRequestRow, CompositionWorker, DraftFields, WorkerRow } from '../db/permits.ts';
import { BASIS_NAME, REGISTRY_BACKED, isBasisType, normalizeModes, verifyBasis } from '../domain/basis.ts';
import type { BasisType, BasisVerdict } from '../domain/basis.ts';
import {
  checkWorkers, clockTime, localDateTime, normalizePlate, validIin, validPlate, validateForSubmit,
} from '../domain/request.ts';
import type { DocumentKind } from '../domain/request.ts';
import {
  ALLOWED_BASIS, BRANCH_REASON_NAME, CIS, COUNTRY_NAME, WORK_TYPES, WORK_TYPE_NAME, WORK_TYPE_REF, basisRequired,
  isResident, isWorkType, normalizeCisDays, normalizeRules, route,
} from '../domain/rules.ts';
import type { BranchReason, RouteVerdict, WorkType } from '../domain/rules.ts';
import * as notices from './events.ts';

export const STATUS_NAME: Record<AccessRequestRow['status'], string> = {
  draft: 'Черновик',
  pending_review: 'На рассмотрении',
  approved: 'Допуск выдан',
  rejected: 'Отклонена',
  withdrawn: 'Отозвана организацией',
  revoked: 'Допуск отозван',
  closed: 'Работы завершены',
};

export const BRANCH_APPROVAL_NAME: Record<AccessRequestRow['branch_approval'], string> = {
  not_required: 'не требуется', pending: 'ждёт решения', approved: 'согласовано', rejected: 'не согласовано',
};

const ENTITY = 'access_request';
const REF = 'Инструкция о допуске';
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
const maskIin = (iin: string | null) => (iin ? '••••••••' + iin.slice(-4) : '—');

/** Есть ли в периоде рабочий день по производственному календарю. */
function hasWorkingDay(start: string, end: string, calendar: { holidays: string[]; workingDays: string[] }): boolean {
  const d = new Date(start.slice(0, 10) + 'T12:00:00Z');
  const last = end.slice(0, 10);
  for (let i = 0; i < 400 && d.toISOString().slice(0, 10) <= last; i++) {
    if (isWorkingDay(d.toISOString().slice(0, 10), calendar)) return true;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return false;
}

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

  const isCentral = (actor: Actor) => rbac.can(actor, 'permit.view') || rbac.can(actor, 'permit.review');
  const isBranchUser = (actor: Actor) => rbac.can(actor, 'permit.branch');
  const isStaff = (actor: Actor) => isCentral(actor) || isBranchUser(actor) || (!rbac.isExternal(actor) && actor.roles.length > 0);
  const isOwn = (actor: Actor, r: { counterparty_id: string }) =>
    rbac.can(actor, 'permit.own') && !!actor.counterpartyId && actor.counterpartyId === r.counterparty_id;

  /** Сотрудник филиала объекта, его ответственное лицо или руководство филиала, которое согласует заявку. */
  async function branchSide(actor: Actor, r: AccessRequestRow): Promise<{ staff: boolean; decider: boolean }> {
    if (rbac.isExternal(actor) || !r.branch_id) return { staff: false, decider: false };
    const deciders = await data.branchDeciders(db, r.branch_id);
    const decider = actor.roles.includes('admin') || r.branch_approver_id === actor.id || deciders.includes(actor.id) ||
      await substitutes(actor.id, r.branch_approver_id);
    const staff = decider || r.site_officer_id === actor.id || await substitutes(actor.id, r.site_officer_id) ||
      (isBranchUser(actor) && actor.branchId === r.branch_id);
    return { staff, decider };
  }

  /** Замещает ли сотрудник сегодня указанного человека (А3). */
  async function substitutes(actorId: string, userId: string | null): Promise<boolean> {
    if (!userId) return false;
    return !!await db.one(
      `SELECT 1 FROM user_absences WHERE user_id = $1 AND substitute_id = $2 AND current_date BETWEEN date_from AND date_to`,
      [userId, actorId]);
  }

  async function denied(ctx: Ctx, actor: Actor, entityId: string, detail: string) {
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Отказ в доступе к заявке на допуск', entity: ENTITY, entityId,
      detail, result: 'denied', regulationRef: REF,
    });
  }

  /** Заявка в пределах прав: своя — всегда; СУА — после отправки; филиал — свои объекты после отправки. */
  async function loadRequest(ctx: Ctx, actor: Actor, id: string): Promise<AccessRequestRow> {
    if (!rbac.can(actor, 'permit.own') && !isStaff(actor)) throw ApiError.forbidden();
    const r = await data.getRequest(db, id);
    if (!r) throw ApiError.notFound('Заявка на допуск не найдена');
    if (isOwn(actor, r)) return r;
    if (r.status !== 'draft' && isCentral(actor)) return r;
    if (r.status !== 'draft' && (await branchSide(actor, r)).staff) return r;
    await denied(ctx, actor, r.id, `${r.number}: попытка открыть заявку без права доступа`);
    throw ApiError.forbidden('Нет доступа к этой заявке');
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
  const fresh = async (id: string, t: Db = db) => (await data.getRequest(t, id))!;

  /* --------------------------- проверка основания --------------------------- */

  /** Чьё основание: владельца оборудования, если заявку подаёт его подрядчик (п. 13). */
  async function basisOwner(r: { owner_bin: string; counterparty_id: string }): Promise<string> {
    if (!r.owner_bin) return r.counterparty_id;
    return (await data.counterpartyByBin(db, r.owner_bin))?.id ?? r.counterparty_id;
  }

  async function verdictFor(r: AccessRequestRow): Promise<BasisVerdict> {
    const modes = await data.getModes(db);
    const owner = await basisOwner(r);
    const input = {
      type: r.basis_type, number: r.basis_number, counterpartyId: owner, facilityId: r.facility_id,
      startDate: r.period_start ? r.period_start.slice(0, 10) : null, hasScan: !!r.basis_file_id,
    };
    if (!r.basis_type || !r.basis_number.trim()) return verifyBasis(input, null, modes);
    const found = await data.findBasis(db, r.basis_type, {
      id: r.basis_document_id ?? r.basis_contract_id ?? r.basis_lease_id, number: r.basis_number,
      counterpartyId: owner, facilityId: r.facility_id,
    });
    return verifyBasis(input, found, modes);
  }

  async function routeFor(r: AccessRequestRow, crewSize: number): Promise<RouteVerdict> {
    const rules = await data.getRules(db);
    const calendar = await repo.calendar(db);
    return route({
      workType: r.work_type, onAms: r.on_ams, hoursFrom: r.work_hours_from, hoursTo: r.work_hours_to,
      weekendWork: r.weekend_work,
      periodHasWorkingDay: !r.period_start || !r.period_end || hasWorkingDay(r.period_start, r.period_end, calendar),
      crewSize, concurrent: await data.concurrentWorkers(db, r),
    }, rules);
  }

  /* ------------------------------ карточка ------------------------------ */

  function shape(r: AccessRequestRow, staff: boolean) {
    return {
      id: r.id, number: r.number, status: r.status, statusName: STATUS_NAME[r.status],
      counterpartyId: r.counterparty_id, counterpartyName: r.counterparty_name, counterpartyBin: r.counterparty_bin,
      facilityId: r.facility_id, facilityName: r.facility_name, facilityInvNo: r.facility_inv_no,
      facilityAddress: r.facility_address, facilityKind: r.facility_kind, branchId: r.branch_id, branchName: r.branch_name,
      workType: r.work_type, workTypeName: r.work_type ? WORK_TYPE_NAME[r.work_type] : null,
      onAms: r.on_ams, workHoursFrom: r.work_hours_from, workHoursTo: r.work_hours_to, weekendWork: r.weekend_work,
      ownerBin: r.owner_bin, ownerName: r.owner_name,
      basisType: r.basis_type, basisTypeName: r.basis_type ? BASIS_NAME[r.basis_type] : null,
      basisNumber: r.basis_number, basisRefId: r.basis_document_id ?? r.basis_contract_id ?? r.basis_lease_id,
      basisDate: r.basis_date, basisValidUntil: r.basis_valid_until,
      basisFileId: r.basis_file_id, basisFileName: r.basis_file_name, basisCheck: r.basis_check,
      basisConfirmedAt: r.basis_confirmed_at,
      basisConfirmedBy: staff ? r.basis_confirmed_by_name : null,
      basisConfirmNote: staff ? r.basis_confirm_note : null,
      letterNumber: r.letter_number, letterDate: r.letter_date, signatoryName: r.signatory_name,
      signatoryPosition: r.signatory_position, letterFileId: r.letter_file_id, letterFileName: r.letter_file_name,
      description: r.description, periodStart: r.period_start, periodEnd: r.period_end, isUrgent: r.is_urgent,
      crewId: r.crew_id, passFileId: r.pass_file_id, passFileName: r.pass_file_name,
      rejectionReason: r.rejection_reason, reviewedAt: r.reviewed_at, reviewedBy: staff ? r.reviewed_by_name : null,
      submittedAt: r.submitted_at, createdAt: r.created_at, updatedAt: r.updated_at,
      createdBy: r.created_by_name, version: r.version,
      assigneeName: staff ? r.assignee_name : null, reviewDueAt: r.review_due_at,
      branchApproval: r.branch_approval, branchApprovalName: BRANCH_APPROVAL_NAME[r.branch_approval],
      branchReasons: (r.branch_reasons ?? []).map((x) => ({ code: x, name: BRANCH_REASON_NAME[x as BranchReason] ?? x })),
      branchApproverName: staff ? r.branch_approver_name : null, branchDueAt: r.branch_due_at,
      branchDecidedAt: r.branch_decided_at, branchDecidedBy: staff ? r.branch_decided_by_name : null,
      branchChannel: r.branch_channel, branchNote: r.branch_note,
      provisional: r.provisional, followupDueAt: r.followup_due_at, followupDoneAt: r.followup_done_at,
      permitCode: ['approved', 'closed'].includes(r.status) ? r.permit_code : null, permitIssuedAt: r.permit_issued_at,
      siteOfficerName: r.site_officer_name,
      revokeReason: r.revoke_reason, revokedAt: r.revoked_at, closedAt: r.closed_at, closeNote: r.close_note,
      closedBy: staff ? r.closed_by_name : null,
      extendsRequestId: r.extends_request_id, extendsNumber: r.extends_number,
      validity: validity(r),
      workersCount: r.workers_count, vehiclesCount: r.vehicles_count,
    };
  }

  /** Действует ли допуск сейчас: для реестра действующих допусков. */
  function validity(r: AccessRequestRow): 'active' | 'upcoming' | 'expired' | null {
    if (r.status !== 'approved' || !r.period_start || !r.period_end) return null;
    const now = localNow();
    if (r.period_end < now) return 'expired';
    if (r.period_start > now) return 'upcoming';
    return 'active';
  }

  /** Работник для карточки: удостоверения со сроками; полный ИИН — владельцу, СУА и филиалу объекта. */
  function cardWorker(w: CompositionWorker, startDate: string | null, full: boolean) {
    const d = w.details ?? {};
    return {
      workerId: w.worker_id, fullName: w.full_name, position: w.position,
      iin: full ? (w.iin ?? '') : maskIin(w.iin),
      citizenship: d.citizenship ?? 'KZ', citizenshipName: COUNTRY_NAME[d.citizenship ?? 'KZ'] ?? d.citizenship,
      employer: d.employer ?? '',
      personal: full ? {
        fullNameLatin: d.full_name_latin ?? '', birthDate: d.birth_date ?? null, birthPlace: d.birth_place ?? '',
        idDocNumber: d.id_doc_number ?? '', idDocIssuedAt: d.id_doc_issued_at ?? null, idDocIssuedBy: d.id_doc_issued_by ?? '',
        address: d.address ?? '',
      } : null,
      documents: w.documents.map((x) => ({ ...x, kind: x.kind ?? 'qualification', expired: !!startDate && x.validUntil < startDate })),
    };
  }

  /** Хронология для подрядчика — по статусам, без имён сотрудников Общества. */
  function customerTimeline(r: AccessRequestRow) {
    const out: { at: string; text: string }[] = [{ at: r.created_at, text: 'Черновик создан' }];
    if (r.submitted_at) out.push({ at: r.submitted_at, text: `Отправлена на рассмотрение в СУА, срок — до ${r.review_due_at ?? '—'}` });
    if (r.branch_decided_at) {
      out.push({ at: r.branch_decided_at, text: r.branch_approval === 'approved' ? 'Согласована руководством филиала' : 'Не согласована руководством филиала' });
    }
    if (r.permit_issued_at) out.push({ at: r.permit_issued_at, text: r.provisional ? 'Аварийный допуск предоставлен' : 'Допуск выдан' });
    if (r.followup_done_at) out.push({ at: r.followup_done_at, text: 'Аварийный допуск оформлен письменно' });
    if (r.status === 'rejected' && r.reviewed_at) out.push({ at: r.reviewed_at, text: `Отклонена: ${r.rejection_reason}` });
    if (r.status === 'withdrawn') out.push({ at: r.updated_at, text: 'Заявка отозвана организацией' });
    if (r.revoked_at) out.push({ at: r.revoked_at, text: `Допуск отозван: ${r.revoke_reason}` });
    if (r.closed_at) out.push({ at: r.closed_at, text: 'Работы завершены, допуск закрыт' });
    return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  async function card(actor: Actor, r: AccessRequestRow) {
    const own = isOwn(actor, r);
    const central = isCentral(actor);
    const reviewer = rbac.can(actor, 'permit.review');
    const branch = await branchSide(actor, r);
    const staff = central || branch.staff;
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
    const routeInfo = r.status === 'draft' ? await routeFor(r, workers.length) : null;
    const needsConfirmation = !!(basis as BasisVerdict).needsConfirmation;
    const pending = r.status === 'pending_review';
    const branchReady = r.branch_approval === 'not_required' || r.branch_approval === 'approved';
    const basisReady = !needsConfirmation || !!r.basis_confirmed_at;
    const cisDays = await data.getCisDays(db);
    const endDate = r.period_end ? r.period_end.slice(0, 10) : null;
    return {
      request: shape(r, staff),
      basis,
      route: routeInfo ? {
        fields: routeInfo.fields, emergency: routeInfo.emergency,
        branchReasons: routeInfo.branchReasons.map((x) => ({ code: x, name: BRANCH_REASON_NAME[x] })),
      } : null,
      workers: workers.map((w) => cardWorker(w, startDate, own || reviewer || branch.staff)),
      vehicles: vehicles.map((v) => ({ vehicleId: v.vehicle_id, plate: v.plate, model: v.model, driverName: v.driver_name })),
      issues: checkWorkers(data.toCheckWorkers(workers), startDate, { endDate, appendix: r.status === 'draft', cisDays }),
      history: staff ? await repo.listEvents(db, ENTITY, r.id) : customerTimeline(r),
      admissions: staff && ['approved', 'closed'].includes(r.status) ? await data.admissions(db, r.id) : [],
      actions: {
        edit: own && r.status === 'draft',
        submit: own && r.status === 'draft',
        delete: own && r.status === 'draft',
        copy: own && r.status !== 'draft',
        // Продление (п. 19): новый запрос по выданному допуску.
        extend: own && ['approved', 'closed'].includes(r.status),
        withdraw: own && pending,
        // При аварии оформленный запрос досылается после допуска (п. 18).
        uploadLetter: own && (r.status === 'draft' || (r.status === 'approved' && r.provisional)),
        confirmBasis: reviewer && pending && needsConfirmation && !r.basis_confirmed_at,
        branchDecide: pending && r.branch_approval === 'pending' && branch.decider,
        recordBranch: reviewer && pending && r.branch_approval === 'pending',
        approve: reviewer && pending && basisReady && branchReady,
        reject: reviewer && pending,
        finalize: reviewer && r.status === 'approved' && r.provisional,
        revoke: reviewer && r.status === 'approved',
        siteCheck: r.status === 'approved' && (branch.staff || actor.roles.includes('admin')),
        close: r.status === 'approved' && !r.provisional && (branch.staff || reviewer),
        downloadPass: ['approved', 'closed'].includes(r.status) && !!r.pass_file_id && (own || staff),
        printPermit: ['approved', 'closed'].includes(r.status) && (own || staff),
        printLetter: own || staff,
        openScans: own || reviewer || branch.staff,
      },
    };
  }

  function fromWorkerRow(w: WorkerRow): CompositionWorker {
    return {
      worker_id: w.id, full_name: w.full_name, iin: w.iin, position: w.position,
      details: {
        full_name_latin: w.full_name_latin, birth_date: w.birth_date, birth_place: w.birth_place, citizenship: w.citizenship,
        id_doc_number: w.id_doc_number, id_doc_issued_at: w.id_doc_issued_at, id_doc_issued_by: w.id_doc_issued_by,
        address: w.address, employer: w.employer,
      },
      documents: w.documents.map((d) => ({
        id: d.id, kind: d.kind ?? 'qualification', title: d.title, number: d.number ?? '', validUntil: d.validUntil,
        fileId: d.fileId ?? null, fileName: d.fileName ?? null,
      })),
    };
  }

  /* ------------------------------ черновик ------------------------------ */

  type DraftBody = {
    workType?: string | null; onAms?: boolean; workHoursFrom?: string; workHoursTo?: string; weekendWork?: boolean;
    ownerBin?: string; ownerName?: string;
    facilityId?: string | null; basisType?: string | null; basisNumber?: string; basisRefId?: string | null;
    basisDate?: string | null; basisValidUntil?: string | null;
    letterNumber?: string; letterDate?: string | null; signatoryName?: string; signatoryPosition?: string;
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
    const workType: WorkType | null = isWorkType(body.workType) ? body.workType : null;
    if (body.workType && !workType) fields.workType = 'Неизвестная цель работ';
    const basisType: BasisType | null = isBasisType(body.basisType) ? body.basisType : null;
    if (body.basisType && !basisType) fields.basisType = 'Неизвестный тип основания';
    if (basisType && workType && !ALLOWED_BASIS[workType].includes(basisType)) {
      fields.basisType = `Для цели «${WORK_TYPE_NAME[workType]}» основание: ${ALLOWED_BASIS[workType].map((b) => BASIS_NAME[b]).join(' или ')}`;
    }
    const ownerBin = text(body.ownerBin, 12);
    if (ownerBin && !validBin(ownerBin)) fields.ownerBin = 'БИН владельца оборудования: 12 цифр, проверьте контрольный разряд';
    const basisOwnerId = ownerBin ? (await data.counterpartyByBin(db, ownerBin))?.id ?? counterpartyId : counterpartyId;

    let basisNumber = text(body.basisNumber, 128);
    let basisDocumentId: string | null = null;
    let basisContractId: string | null = null;
    let basisLeaseId: string | null = null;
    if (basisType && body.basisRefId && UUID.test(String(body.basisRefId))) {
      // Номер выбран из реестра: берём его из записи, а не из текста формы.
      const found = await data.findBasis(db, basisType, { id: String(body.basisRefId), number: '', counterpartyId: basisOwnerId, facilityId });
      if (found && (basisType === 'order' || found.counterpartyId === basisOwnerId)) {
        basisNumber = found.number;
        if (basisType === 'smr_contract') basisContractId = found.id;
        else if (basisType === 'lease') basisLeaseId = found.id;
        else basisDocumentId = found.id;
      }
    }
    const date = (key: keyof DraftBody, label: string) => {
      const raw = body[key];
      if (raw === null || raw === undefined || raw === '') return null;
      const v = isoDate(raw);
      if (!v) fields[key] = `${label}: укажите дату`;
      return v;
    };
    const basisDate = date('basisDate', 'Дата основания');
    const basisValidUntil = date('basisValidUntil', 'Срок действия основания');
    const letterDate = date('letterDate', 'Дата запроса');
    const periodStart = body.periodStart ? localDateTime(body.periodStart) : null;
    const periodEnd = body.periodEnd ? localDateTime(body.periodEnd) : null;
    if (body.periodStart && !periodStart) fields.periodStart = 'Дата и время начала указаны неверно';
    if (body.periodEnd && !periodEnd) fields.periodEnd = 'Дата и время окончания указаны неверно';
    if (periodStart && periodEnd && periodEnd <= periodStart) fields.periodEnd = 'Окончание работ должно быть позже начала';
    const workHoursFrom = body.workHoursFrom ? clockTime(body.workHoursFrom) : '09:00';
    const workHoursTo = body.workHoursTo ? clockTime(body.workHoursTo) : '18:00';
    if (!workHoursFrom) fields.workHoursFrom = 'Время начала работ: ЧЧ:ММ';
    if (!workHoursTo) fields.workHoursTo = 'Время окончания работ: ЧЧ:ММ';
    if (workHoursFrom && workHoursTo && workHoursFrom === workHoursTo) fields.workHoursTo = 'Укажите разное время начала и окончания';

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
      workType, onAms: body.onAms === true, workHoursFrom: workHoursFrom!, workHoursTo: workHoursTo!,
      weekendWork: body.weekendWork === true, ownerBin, ownerName: text(body.ownerName, 500),
      facilityId, branchId, basisType, basisNumber, basisDocumentId, basisContractId, basisLeaseId, basisDate, basisValidUntil,
      letterNumber: text(body.letterNumber, 64), letterDate, signatoryName: text(body.signatoryName, 255),
      signatoryPosition: text(body.signatoryPosition, 255),
      description: text(body.description, 2000), periodStart, periodEnd,
      isUrgent: body.isUrgent === true || workType === 'emergency', crewId,
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
    return card(actor, await fresh(id));
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
    return card(actor, await fresh(r.id));
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

  /**
   * «Подать повторно» и «Продлить допуск» (п. 19): новый черновик из прошлой
   * заявки — без повторного ввода бригады. Период и подписанный запрос — заново.
   */
  async function copyRequest(ctx: Ctx, actor: Actor, extend: boolean) {
    const cp = ownCounterparty(actor);
    const source = await loadRequest(ctx, actor, ctx.params.id);
    if (!isOwn(actor, source)) throw ApiError.forbidden();
    if (extend && !['approved', 'closed'].includes(source.status)) {
      throw ApiError.conflict('Продлить можно только выданный допуск');
    }
    const { workers, vehicles } = await data.composition(db, source.id);
    const liveWorkers = await data.workersByIds(db, cp, workers.map((w) => w.worker_id));
    const liveVehicles = await data.vehiclesByIds(db, cp, vehicles.map((v) => v.vehicle_id));
    const id = await db.tx(async (t) => {
      const created = await data.createDraft(t, cp, {
        workType: source.work_type, onAms: source.on_ams, workHoursFrom: source.work_hours_from,
        workHoursTo: source.work_hours_to, weekendWork: source.weekend_work, ownerBin: source.owner_bin,
        ownerName: source.owner_name, facilityId: source.facility_id, branchId: source.branch_id,
        basisType: source.basis_type, basisNumber: source.basis_number, basisDocumentId: source.basis_document_id,
        basisContractId: source.basis_contract_id, basisLeaseId: source.basis_lease_id, basisDate: source.basis_date,
        basisValidUntil: source.basis_valid_until, letterNumber: '', letterDate: null,
        signatoryName: source.signatory_name, signatoryPosition: source.signatory_position, description: source.description,
        periodStart: null, periodEnd: null, isUrgent: false, crewId: source.crew_id,
        extendsRequestId: extend ? source.id : null,
      }, actor.id);
      await data.snapshotComposition(t, created, liveWorkers, liveVehicles);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: extend ? 'Создан запрос на продление допуска' : 'Создан черновик по прошлой заявке',
        entity: ENTITY, entityId: created, detail: `из ${source.number}`, regulationRef: extend ? 'п. 19 Инструкции' : REF,
      });
      return created;
    });
    return card(actor, await fresh(id));
  }

  router.post('/api/v1/permits/requests/:id/copy', async (ctx) => {
    deps.guardOrigin(ctx);
    return copyRequest(ctx, await deps.actor(ctx), false);
  });

  router.post('/api/v1/permits/requests/:id/extend', async (ctx) => {
    deps.guardOrigin(ctx);
    return copyRequest(ctx, await deps.actor(ctx), true);
  });

  /** Проверка перед отправкой — для предпросмотра в мастере. */
  router.post('/api/v1/permits/requests/:id/check', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadOwnDraft(ctx, actor, ctx.params.id);
    const { basis, fields, issues, route: rv } = await checkForSubmit(r, true);
    return {
      basis, fields, issues,
      route: { emergency: rv.emergency, branchReasons: rv.branchReasons.map((x) => ({ code: x, name: BRANCH_REASON_NAME[x] })) },
    };
  });

  async function checkForSubmit(r: AccessRequestRow, consent: boolean) {
    const { workers, vehicles } = await data.composition(db, r.id);
    const live = await data.workersByIds(db, r.counterparty_id, workers.map((w) => w.worker_id));
    const liveVehicles = await data.vehiclesByIds(db, r.counterparty_id, vehicles.map((v) => v.vehicle_id));
    const basis = await verdictFor(r);
    const rv = await routeFor(r, live.length);
    const result = validateForSubmit({
      workType: r.work_type, facilityId: r.facility_id, basisType: r.basis_type, basisNumber: r.basis_number,
      basisValidUntil: basis.ok ? basis.reference?.validUntil ?? r.basis_valid_until : r.basis_valid_until,
      periodStart: r.period_start, periodEnd: r.period_end,
      workers: data.toCheckWorkers(live.map(fromWorkerRow)),
      vehicles: liveVehicles.map((v) => ({ plate: v.plate })),
      consent, counterpartyBlocked: r.counterparty_status === 'blocked', basis, route: rv,
      ownerBin: r.owner_bin,
      letter: { number: r.letter_number, date: r.letter_date, signatoryName: r.signatory_name,
        signatoryPosition: r.signatory_position, hasFile: !!r.letter_file_id },
      cisDays: await data.getCisDays(db), now: localNow(),
    });
    if (r.work_type && !basisRequired(r.work_type) && !r.basis_type) delete result.fields.basisType;
    if (live.length < workers.length || liveVehicles.length < vehicles.length) {
      result.fields.workers = 'Часть работников или транспорта удалена из списка организации — обновите состав заявки';
    }
    return { basis, live, liveVehicles, route: rv, ...result };
  }

  router.post('/api/v1/permits/requests/:id/submit', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadOwnDraft(ctx, actor, ctx.params.id);
    const body = await ctx.body<{ version?: number; consent?: boolean }>();
    const version = requireVersion(body);
    const { basis, fields, live, liveVehicles, route: rv } = await checkForSubmit(r, body.consent === true);
    if (Object.keys(fields).length) throw ApiError.badRequest('Заявку нельзя отправить', fields);

    const rules = await data.getRules(db);
    const calendar = await repo.calendar(db);
    const day = today();
    const approver = rv.branchReasons.length ? await data.pickBranchApprover(db, r.branch_id) : null;
    // Согласовать некому — решение фиксирует специалист СУА (устно или письмом), заявка не «висит».
    const plan: data.SubmitPlan = {
      basisCheck: basis as unknown as Record<string, unknown>,
      reviewDueAt: rv.emergency ? day : addWorkingDays(day, rules.reviewDays, calendar),
      branchReasons: rv.branchReasons,
      branchApproverId: approver?.id ?? null,
      branchDueAt: rv.branchReasons.length ? (rv.emergency ? day : addWorkingDays(day, rules.branchDays, calendar)) : null,
      emergency: rv.emergency,
      followupDueAt: rv.emergency ? new Date(Date.now() + rules.followupDays * 86_400_000).toISOString() : null,
      assigneeId: (await pickPermits(db))?.id ?? null,
    };
    await db.tx(async (t) => {
      // Снимок на момент отправки: дальнейшая правка работника заявку не меняет.
      await data.snapshotComposition(t, r.id, live, liveVehicles);
      if (!await data.submit(t, r.id, version, plan, actor.id)) throw conflict();
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Заявка на допуск отправлена на рассмотрение', entity: ENTITY,
        entityId: r.id, detail: `${r.number} · ${r.work_type ? WORK_TYPE_NAME[r.work_type] : ''} · основание: ${basis.message}`,
        regulationRef: 'пп. 13, 14 Инструкции',
      });
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Подтверждено согласие работников на обработку персональных данных',
        entity: ENTITY, entityId: r.id, detail: `работников: ${live.length}`, regulationRef: REF,
      });
      if (rv.branchReasons.length) {
        await repo.logEvent(t, {
          ...deps.audit(ctx, actor), action: 'Требуется согласование руководства филиала', entity: ENTITY, entityId: r.id,
          detail: `${rv.branchReasons.map((x) => BRANCH_REASON_NAME[x]).join('; ')} · согласует: ${approver?.name ?? 'не назначен — фиксирует СУА'}`,
          regulationRef: 'пп. 8, 14, 18 Инструкции',
        });
      }
      const saved = await fresh(r.id, t);
      await notices.requestSubmitted(t, saved);
      if (approver) await notices.branchApprovalRequested(t, saved);
    });
    return card(actor, await fresh(r.id));
  });

  /** Отзыв заявки организацией до решения. */
  router.post('/api/v1/permits/requests/:id/withdraw', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadRequest(ctx, actor, ctx.params.id);
    if (!isOwn(actor, r)) throw ApiError.forbidden();
    const body = await ctx.body<{ version?: number; reason?: string }>();
    const version = requireVersion(body);
    const reason = text(body.reason, 1000);
    await db.tx(async (t) => {
      if (!await data.withdraw(t, r.id, version, reason)) throw conflict();
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Заявка на допуск отозвана организацией', entity: ENTITY, entityId: r.id,
        detail: `${r.number}${reason ? ' · ' + reason : ''}`, regulationRef: REF,
      });
      await notices.requestWithdrawn(t, await fresh(r.id, t));
    });
    return card(actor, await fresh(r.id));
  });

  /* --------------------------- файлы заявки --------------------------- */

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

  async function dropFile(saved: { id: string; key: string } | null) {
    if (!saved) return;
    await db.query(`DELETE FROM permit_files WHERE id = $1`, [saved.id]).catch(() => {});
    await deps.store?.remove(saved.key).catch(() => {});
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
        detail: `${saved.fileName} · ${saved.sha256.slice(0, 12)}`, regulationRef: 'п. 13 Инструкции',
      });
    });
    return card(actor, await fresh(r.id));
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
    return card(actor, await fresh(r.id));
  });

  /**
   * Скан официального запроса, подписанного уполномоченным лицом, со списком
   * работников по Приложению 1, заверенным печатью (п. 13). При аварии
   * досылается после допуска в течение 2 календарных дней (п. 18).
   */
  router.post('/api/v1/permits/requests/:id/letter-file', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadRequest(ctx, actor, ctx.params.id);
    if (!isOwn(actor, r)) throw ApiError.forbidden();
    if (!(r.status === 'draft' || (r.status === 'approved' && r.provisional))) {
      throw ApiError.conflict('Запрос прикладывается к черновику, а при аварийном допуске — до его оформления');
    }
    const { form, file } = await singleFile(ctx);
    if (!file) throw ApiError.badRequest('Выберите файл', { file: 'Выберите файл' });
    const saved = await storeFile(ctx, actor, file, r.counterparty_id, 'letter', r.id);
    try {
      await db.tx(async (t) => {
        await data.setLetterFile(t, r.id, saved.id);
        if (r.status !== 'draft') {
          const number = text(form.fields.letterNumber, 64);
          const date = isoDate(form.fields.letterDate);
          await t.query(
            `UPDATE access_requests SET letter_number = coalesce(nullif($2, ''), letter_number),
                    letter_date = coalesce($3::date, letter_date) WHERE id = $1`, [r.id, number, date]);
        }
        await repo.logEvent(t, {
          ...deps.audit(ctx, actor), action: 'Приложен подписанный запрос со списком работников', entity: ENTITY, entityId: r.id,
          detail: `${saved.fileName} · ${saved.sha256.slice(0, 12)}`, regulationRef: r.status === 'draft' ? 'п. 13 Инструкции' : 'п. 18 Инструкции',
        });
      });
    } catch (error) {
      await dropFile(saved);
      throw error;
    }
    return card(actor, await fresh(r.id));
  });

  /* ------------------------------ решение СУА ------------------------------ */

  async function loadPending(ctx: Ctx, actor: Actor, id: string) {
    rbac.require(actor, 'permit.review');
    const r = await loadRequest(ctx, actor, id);
    if (r.status !== 'pending_review') throw ApiError.conflict(`Заявка ${r.number} не на рассмотрении: ${STATUS_NAME[r.status]}`);
    return r;
  }

  /**
   * Ручное подтверждение основания. Для договора аренды специалист указывает
   * срок его действия, и договор вносится в реестр договоров аренды.
   */
  router.post('/api/v1/permits/requests/:id/confirm-basis', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadPending(ctx, actor, ctx.params.id);
    const body = await ctx.body<{ version?: number; note?: string; validUntil?: string; addToRegistry?: boolean }>();
    const version = requireVersion(body);
    if (!(r.basis_check as { needsConfirmation?: boolean }).needsConfirmation) {
      throw ApiError.conflict('Основание подтверждено реестром системы — ручное подтверждение не требуется');
    }
    if (r.basis_confirmed_at) throw ApiError.conflict('Основание уже подтверждено');
    const note = text(body.note, 1000);
    if (note.length < 3) throw ApiError.badRequest('Укажите, чем подтверждено основание', { note: 'Укажите, чем подтверждено основание' });
    const validUntil = body.validUntil ? isoDate(body.validUntil) : null;
    if (r.basis_type === 'lease') {
      const until = validUntil ?? r.basis_valid_until;
      if (!until) throw ApiError.badRequest('Укажите срок действия договора аренды', { validUntil: 'Укажите срок действия договора аренды' });
      if (r.period_end && r.period_end.slice(0, 10) > until) {
        throw ApiError.badRequest('Срок допуска превышает срок договора аренды (пп. 13, 14) — заявку нужно отклонить',
          { validUntil: `Договор действует до ${until}, работы — до ${r.period_end.slice(0, 10)}` });
      }
    }
    await db.tx(async (t) => {
      if (!await data.confirmBasis(t, r.id, version, note, actor.id, validUntil)) throw conflict();
      if (r.basis_type === 'lease' && body.addToRegistry !== false && r.facility_id) {
        const owner = await basisOwner(r);
        const leaseId = await data.saveLease(t, {
          number: r.basis_number, contractDate: r.basis_date, counterpartyId: owner, validFrom: null,
          validUntil: (validUntil ?? r.basis_valid_until)!, status: 'active', note: `Подтверждён по заявке ${r.number}: ${note}`,
          facilityIds: [r.facility_id], source: 'confirmation',
        }, actor.id);
        await t.query(`UPDATE access_requests SET basis_lease_id = $2 WHERE id = $1`, [r.id, leaseId]);
      }
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Основание подтверждено вручную', entity: ENTITY, entityId: r.id,
        detail: `${r.number} · ${note}${validUntil ? ` · действует до ${validUntil}` : ''}`, regulationRef: 'п. 14 Инструкции',
      });
    });
    return card(actor, await fresh(r.id));
  });

  /** Отметка решения филиала: руководитель — в системе, СУА — полученное устно или письмом. */
  router.post('/api/v1/permits/requests/:id/branch-decision', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadRequest(ctx, actor, ctx.params.id);
    if (r.status !== 'pending_review' || r.branch_approval !== 'pending') {
      throw ApiError.conflict('Заявка не ждёт согласования филиала');
    }
    const body = await ctx.body<{ version?: number; approved?: boolean; note?: string; channel?: string }>();
    const version = requireVersion(body);
    const side = await branchSide(actor, r);
    const reviewer = rbac.can(actor, 'permit.review');
    if (!side.decider && !reviewer) {
      await denied(ctx, actor, r.id, `${r.number}: согласование филиала без полномочий`);
      throw ApiError.forbidden('Согласует руководство филиала объекта');
    }
    // Специалист СУА лишь фиксирует решение руководства, полученное вне системы.
    const channel = side.decider && body.channel !== 'oral' && body.channel !== 'letter' ? 'system'
      : body.channel === 'letter' ? 'letter' : 'oral';
    const note = text(body.note, 1000);
    if (channel !== 'system' && note.length < 5) {
      throw ApiError.badRequest('Укажите, кто из руководства филиала и как согласовал',
        { note: 'Например: директор филиала Иванов И.И., по телефону 01.10 в 10:20' });
    }
    if (body.approved === false && note.length < 3) throw ApiError.badRequest('Укажите причину', { note: 'Укажите причину' });
    const approved = body.approved !== false;
    await db.tx(async (t) => {
      if (!await data.decideBranch(t, r.id, version, { approved, channel, note }, actor.id)) throw conflict();
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: approved ? 'Согласовано руководством филиала' : 'Не согласовано руководством филиала',
        entity: ENTITY, entityId: r.id,
        detail: `${r.number} · ${channel === 'system' ? 'в системе' : channel === 'oral' ? 'устно, отметка СУА' : 'письмом, отметка СУА'}${note ? ' · ' + note : ''}`,
        regulationRef: 'пп. 8, 14, 18 Инструкции',
      });
      let saved = await fresh(r.id, t);
      if (!approved) {
        // Без согласования руководства допуск невозможен — заявка отклоняется с этой причиной.
        if (!await data.reject(t, r.id, saved.version, `Не согласовано руководством филиала${note ? ': ' + note : ''}`, actor.id)) throw conflict();
        saved = await fresh(r.id, t);
        await notices.requestRejected(t, saved);
      } else if (saved.work_type === 'emergency') {
        // Аварийные работы: допуск в день запроса по устному согласованию руководителя филиала (п. 18).
        const officer = await data.pickSiteOfficer(t, saved.facility_id, saved.branch_id);
        if (!await data.approve(t, r.id, saved.version, { passFileId: null, siteOfficerId: officer?.id ?? null, provisional: true, reviewed: false }, actor.id)) throw conflict();
        await repo.logEvent(t, {
          ...deps.audit(ctx, actor), action: 'Предоставлен аварийный допуск', entity: ENTITY, entityId: r.id,
          detail: `${r.number} · запрос и письменное разрешение — до ${saved.followup_due_at ? new Date(saved.followup_due_at).toISOString().slice(0, 16).replace('T', ' ') : '—'} UTC`,
          regulationRef: 'п. 18 Инструкции',
        });
        saved = await fresh(r.id, t);
        await notices.requestApproved(t, saved);
      }
      await notices.branchDecided(t, saved);
    });
    return card(actor, await fresh(r.id));
  });

  /**
   * Одобрение: электронный допуск с кодом проверки; подписанный ответ СУА — по
   * желанию файлом. Копия — в филиал объекта (п. 15).
   */
  router.post('/api/v1/permits/requests/:id/approve', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadPending(ctx, actor, ctx.params.id);
    const isMultipart = String(ctx.req.headers['content-type'] ?? '').startsWith('multipart/');
    const { form, file } = isMultipart ? await singleFile(ctx) : { form: { fields: await ctx.body<Record<string, string>>() }, file: undefined };
    const version = requireVersion({ version: form.fields.version });
    if ((r.basis_check as { needsConfirmation?: boolean }).needsConfirmation && !r.basis_confirmed_at) {
      throw ApiError.conflict('Основание не подтверждено реестром: сначала подтвердите его вручную');
    }
    if (r.branch_approval === 'pending') throw ApiError.conflict('Заявка ждёт согласования руководства филиала (пп. 8, 14)');
    if (r.branch_approval === 'rejected') throw ApiError.conflict('Руководство филиала не согласовало заявку');
    const saved = file ? await storeFile(ctx, actor, file, r.counterparty_id, 'pass', r.id) : null;
    try {
      await db.tx(async (t) => {
        const officer = await data.pickSiteOfficer(t, r.facility_id, r.branch_id);
        if (!await data.approve(t, r.id, version, { passFileId: saved?.id ?? null, siteOfficerId: officer?.id ?? null, provisional: false, reviewed: true }, actor.id)) {
          throw conflict();
        }
        const done = await fresh(r.id, t);
        await repo.logEvent(t, {
          ...deps.audit(ctx, actor), action: 'Выдан допуск на объект', entity: ENTITY, entityId: r.id,
          detail: `${r.number} · код ${done.permit_code} · ответственный на объекте: ${officer?.name ?? 'не назначен'}` +
            (saved ? ` · ${saved.fileName} · ${saved.sha256.slice(0, 12)}` : ''),
          regulationRef: 'пп. 14, 15 Инструкции',
        });
        await notices.requestApproved(t, done);
      });
    } catch (error) {
      await dropFile(saved);
      throw error;
    }
    return card(actor, await fresh(r.id));
  });

  /** Аварийный допуск оформлен: получен запрос, направлено письменное разрешение (п. 18). */
  router.post('/api/v1/permits/requests/:id/finalize', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'permit.review');
    const r = await loadRequest(ctx, actor, ctx.params.id);
    if (r.status !== 'approved' || !r.provisional) throw ApiError.conflict('Заявка не является неоформленным аварийным допуском');
    if (!r.letter_file_id) throw ApiError.conflict('Организация ещё не приложила оформленный запрос (п. 18)');
    const isMultipart = String(ctx.req.headers['content-type'] ?? '').startsWith('multipart/');
    const { form, file } = isMultipart ? await singleFile(ctx) : { form: { fields: await ctx.body<Record<string, string>>() }, file: undefined };
    const version = requireVersion({ version: form.fields.version });
    const saved = file ? await storeFile(ctx, actor, file, r.counterparty_id, 'pass', r.id) : null;
    try {
      await db.tx(async (t) => {
        if (!await data.finalizeEmergency(t, r.id, version, saved?.id ?? null, actor.id)) throw conflict();
        await repo.logEvent(t, {
          ...deps.audit(ctx, actor), action: 'Аварийный допуск оформлен письменно', entity: ENTITY, entityId: r.id,
          detail: r.number + (saved ? ` · ${saved.fileName}` : ''), regulationRef: 'п. 18 Инструкции',
        });
        await notices.emergencyFinalized(t, await fresh(r.id, t));
      });
    } catch (error) {
      await dropFile(saved);
      throw error;
    }
    return card(actor, await fresh(r.id));
  });

  /** Отказ — только с причиной (п. 17 Инструкции; ТЗ портала, §4.3). */
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
        detail: `${r.number} · ${reason}`, regulationRef: 'п. 17 Инструкции',
      });
      await notices.requestRejected(t, await fresh(r.id, t));
    });
    return card(actor, await fresh(r.id));
  });

  /** Отзыв выданного допуска — с причиной; уведомляются организация и филиал. */
  router.post('/api/v1/permits/requests/:id/revoke', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'permit.review');
    const r = await loadRequest(ctx, actor, ctx.params.id);
    const body = await ctx.body<{ version?: number; reason?: string }>();
    const version = requireVersion(body);
    const reason = text(body.reason, 2000);
    if (reason.length < 3) throw ApiError.badRequest('Укажите причину отзыва', { reason: 'Укажите причину отзыва' });
    await db.tx(async (t) => {
      if (!await data.revoke(t, r.id, version, reason, actor.id)) throw conflict();
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Допуск отозван', entity: ENTITY, entityId: r.id,
        detail: `${r.number} · ${reason}`, regulationRef: REF,
      });
      await notices.permitRevoked(t, await fresh(r.id, t));
    });
    return card(actor, await fresh(r.id));
  });

  /** Работы завершены: ответственное лицо филиала закрывает допуск (п. 23). */
  router.post('/api/v1/permits/requests/:id/close', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadRequest(ctx, actor, ctx.params.id);
    const side = await branchSide(actor, r);
    if (!side.staff && !rbac.can(actor, 'permit.review')) throw ApiError.forbidden();
    const body = await ctx.body<{ version?: number; note?: string }>();
    const version = requireVersion(body);
    const note = text(body.note, 2000);
    await db.tx(async (t) => {
      if (!await data.close(t, r.id, version, note, actor.id)) {
        throw ApiError.conflict(r.provisional ? 'Аварийный допуск ещё не оформлен письменно' : 'Допуск не действует или изменён');
      }
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Работы завершены, допуск закрыт', entity: ENTITY, entityId: r.id,
        detail: `${r.number}${note ? ' · ' + note : ''}`, regulationRef: 'п. 23 Инструкции',
      });
      await notices.permitClosed(t, await fresh(r.id, t));
    });
    return card(actor, await fresh(r.id));
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

  /** Подписанный ответ СУА: подрядчику — своей заявки, сотрудникам — в пределах прав. */
  router.get('/api/v1/permits/requests/:id/pass-file', async (ctx) => {
    const actor = await deps.actor(ctx);
    const r = await loadRequest(ctx, actor, ctx.params.id);
    if (!['approved', 'closed'].includes(r.status) || !r.pass_file_id) throw ApiError.notFound('Файла ответа нет');
    const file = await data.getFile(db, r.pass_file_id);
    if (!file) throw ApiError.notFound('Файл не найден');
    return sendFile(ctx, actor, file, `ответ по заявке ${r.number}`);
  });

  /**
   * Сканы удостоверений, паспортов, запросов и оснований — персональные данные.
   * Открыть их может организация-владелец, а специалист СУА и филиал объекта —
   * только в составе отправленной заявки.
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
    if (UUID.test(requestId) && !rbac.isExternal(actor)) {
      const r = await loadRequest(ctx, actor, requestId);
      const allowed = rbac.can(actor, 'permit.review') || (await branchSide(actor, r)).staff;
      if (allowed && (await data.requestFileIds(db, r.id)).has(file.id)) return sendFile(ctx, actor, file, `заявка ${r.number}`);
    }
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Отказ в доступе к файлу', entity: 'permit_file', entityId: file.id,
      detail: file.file_name, result: 'denied', regulationRef: REF,
    });
    throw ApiError.forbidden('Нет доступа к файлу');
  });

  /* ------------------------------ списки ------------------------------ */

  /** Сотрудники, которых замещает пользователь сегодня, и он сам. */
  async function selfAndReplaced(actor: Actor): Promise<string[]> {
    const rows = await db.query<{ user_id: string }>(
      `SELECT user_id FROM user_absences WHERE substitute_id = $1 AND current_date BETWEEN date_from AND date_to`, [actor.id]);
    return [actor.id, ...rows.map((r) => r.user_id)];
  }

  router.get('/api/v1/permits/requests', async (ctx) => {
    const actor = await deps.actor(ctx);
    const q = ctx.query;
    const mine = rbac.can(actor, 'permit.own') && (!isStaff(actor) || q.get('mine') === '1');
    if (!mine && !isStaff(actor)) throw ApiError.forbidden();
    const scope = q.get('scope');
    // Филиал видит допуски на объекты своего филиала; на согласовании — адресованные ему.
    const branchOnly = !mine && !isCentral(actor) && !actor.roles.includes('admin');
    if (branchOnly && scope !== 'approvals' && !actor.branchId) return { requests: [] };
    const rows = await data.listRequests(db, {
      counterpartyId: mine ? ownCounterparty(actor) : null,
      status: q.get('status') || null,
      q: q.get('q') || null,
      facilityId: UUID.test(q.get('facilityId') ?? '') ? q.get('facilityId') : null,
      branchId: branchOnly && scope !== 'approvals' ? actor.branchId
        : UUID.test(q.get('branchId') ?? '') ? q.get('branchId') : null,
      workType: isWorkType(q.get('workType')) ? q.get('workType') : null,
      urgent: q.get('urgent') === '1' ? true : null,
      dateFrom: isoDate(q.get('dateFrom')), dateTo: isoDate(q.get('dateTo')),
      queue: q.get('queue') === '1',
      branchApprovers: scope === 'approvals' ? await approverScope(actor) : null,
      activeOn: scope === 'active' ? isoDate(q.get('date')) ?? localNow().slice(0, 10) : null,
      limit: Number(q.get('limit')) || 300,
    });
    return { requests: rows.map((r) => shape(r, !mine)) };
  });

  /** Чьи согласования видит пользователь: свои, замещаемых и — руководству филиала — всего филиала. */
  async function approverScope(actor: Actor): Promise<string[]> {
    const own = await selfAndReplaced(actor);
    if (actor.roles.includes('admin') || rbac.can(actor, 'permit.review')) {
      const all = await db.query<{ id: string }>(`SELECT DISTINCT branch_approver_id AS id FROM access_requests WHERE branch_approval = 'pending' AND branch_approver_id IS NOT NULL`);
      return [...own, ...all.map((x) => x.id)];
    }
    return own;
  }

  /** Справочники для мастера и фильтров. Объекты — только наименование и адрес. */
  router.get('/api/v1/permits/meta', async (ctx) => {
    const actor = await deps.actor(ctx);
    if (!rbac.can(actor, 'permit.own') && !isStaff(actor)) throw ApiError.forbidden();
    const [facilities, modes, counterparty, rules, cisDays] = await Promise.all([
      db.query(
        `SELECT f.id, f.inv_no, f.name, f.address, f.kind, f.branch_id, b.name AS branch_name
           FROM facilities f JOIN branches b ON b.id = f.branch_id
          WHERE f.is_active ORDER BY f.name`),
      data.getModes(db),
      actor.counterpartyId
        ? db.one(`SELECT id, bin, name_full, status FROM counterparties WHERE id = $1`, [actor.counterpartyId])
        : null,
      data.getRules(db),
      data.getCisDays(db),
    ]);
    const branches = isStaff(actor)
      ? await db.query(`SELECT id, name FROM branches WHERE is_active ORDER BY name`)
      : [];
    const pendingApprovals = isStaff(actor)
      ? (await data.listRequests(db, { branchApprovers: await selfAndReplaced(actor), limit: 500 })).length : 0;
    return {
      facilities, branches, modes, counterparty, rules, cisDays,
      basisTypes: BASIS_NAME, registryBacked: REGISTRY_BACKED, statuses: STATUS_NAME,
      workTypes: Object.fromEntries(WORK_TYPES.map((w) => [w, WORK_TYPE_NAME[w]])), workTypeRefs: WORK_TYPE_REF,
      allowedBasis: ALLOWED_BASIS, branchReasons: BRANCH_REASON_NAME, countries: COUNTRY_NAME, cis: CIS,
      now: localNow(),
      me: {
        central: isCentral(actor), reviewer: rbac.can(actor, 'permit.review'), branch: isBranchUser(actor),
        branchId: actor.branchId, admin: actor.roles.includes('admin'), pendingApprovals,
      },
    };
  });

  /** Основания организации для выбора в мастере (ТЗ портала §4.2: номер — не свободный текст). */
  router.get('/api/v1/permits/basis-options', async (ctx) => {
    const actor = await deps.actor(ctx);
    const cp = ownCounterparty(actor);
    const facilityId = UUID.test(ctx.query.get('facilityId') ?? '') ? ctx.query.get('facilityId') : null;
    const ownerBin = ctx.query.get('ownerBin') ?? '';
    const owner = ownerBin ? (await data.counterpartyByBin(db, ownerBin))?.id ?? cp : cp;
    return data.basisOptions(db, owner, facilityId);
  });

  /* ------------------------ работники и удостоверения ------------------------ */

  router.get('/api/v1/permits/workers', async (ctx) => {
    const actor = await deps.actor(ctx);
    const cp = ownCounterparty(actor);
    return { workers: await data.listWorkers(db, cp, ctx.query.get('all') === '1') };
  });

  type WorkerBody = {
    id?: string; fullName?: string; iin?: string; position?: string; fullNameLatin?: string; birthDate?: string;
    birthPlace?: string; citizenship?: string; idDocNumber?: string; idDocIssuedAt?: string; idDocIssuedBy?: string;
    address?: string; employer?: string;
  };

  /** Сведения о работнике по Приложению 1 Инструкции. */
  router.post('/api/v1/permits/workers', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const cp = ownCounterparty(actor);
    const body = await ctx.body<WorkerBody>();
    const fullName = text(body.fullName, 255);
    const citizenship = text(body.citizenship || 'KZ', 2).toUpperCase();
    const resident = isResident(citizenship);
    const iin = text(body.iin, 12);
    const fields: Record<string, string> = {};
    if (fullName.length < 5 || !/\s/.test(fullName)) fields.fullName = 'Укажите фамилию, имя и отчество';
    if (!/^[A-Z]{2}$/.test(citizenship)) fields.citizenship = 'Укажите гражданство';
    if (resident && !validIin(iin)) fields.iin = 'ИИН: 12 цифр, проверьте контрольный разряд';
    if (!resident && iin && !validIin(iin)) fields.iin = 'ИИН указан с ошибкой (иностранцу — необязательно)';
    const latin = text(body.fullNameLatin, 255);
    if (!resident && !/^[A-Za-z][A-Za-z\s'.-]+$/.test(latin)) fields.fullNameLatin = 'Для иностранца укажите ФИО латиницей, как в паспорте';
    const idDocNumber = text(body.idDocNumber, 64);
    if (!resident && !idDocNumber) fields.idDocNumber = 'Укажите номер паспорта';
    const birthDate = body.birthDate ? isoDate(body.birthDate) : null;
    if (body.birthDate && !birthDate) fields.birthDate = 'Укажите дату рождения';
    else if (birthDate && (birthDate > localNow().slice(0, 10) || birthDate < '1930-01-01')) fields.birthDate = 'Проверьте дату рождения';
    const issuedAt = body.idDocIssuedAt ? isoDate(body.idDocIssuedAt) : null;
    if (body.idDocIssuedAt && !issuedAt) fields.idDocIssuedAt = 'Укажите дату выдачи';
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте данные работника', fields);
    let id = '';
    try {
      id = await db.tx(async (t) => {
        const saved = await data.saveWorker(t, cp, {
          id: body.id && UUID.test(body.id) ? body.id : null, fullName, iin: iin || null, position: text(body.position, 255),
          fullNameLatin: latin, birthDate, birthPlace: text(body.birthPlace, 255), citizenship, idDocNumber,
          idDocIssuedAt: issuedAt, idDocIssuedBy: text(body.idDocIssuedBy, 255), address: text(body.address, 500),
          employer: text(body.employer, 500),
        }, actor.id);
        if (!saved) throw ApiError.notFound('Работник не найден');
        await repo.logEvent(t, {
          ...deps.audit(ctx, actor), action: body.id ? 'Изменены сведения о работнике' : 'Добавлен работник',
          entity: 'contractor_worker', entityId: saved,
          detail: `${fullName} · ${iin ? 'ИИН ' + maskIin(iin) : 'паспорт ' + citizenship}`, regulationRef: 'Приложение 1 Инструкции',
        });
        return saved;
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw ApiError.badRequest('Работник с таким ИИН или паспортом уже есть в списке', { iin: 'Такой работник уже есть' });
      }
      throw error;
    }
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

  const DOC_KINDS: DocumentKind[] = ['qualification', 'passport', 'visa'];
  const DOC_KIND_NAME: Record<DocumentKind, string> = { qualification: 'Удостоверение', passport: 'Паспорт', visa: 'Виза' };

  /** Удостоверение, копия паспорта или визы: новое либо обновление срока и скана (поле documentId). */
  router.post('/api/v1/permits/workers/:id/documents', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const { cp, worker } = await ownWorker(actor, ctx.params.id);
    const { form, file } = await singleFile(ctx);
    const documentId = UUID.test(form.fields.documentId ?? '') ? form.fields.documentId : null;
    const kind: DocumentKind = DOC_KINDS.includes(form.fields.kind as DocumentKind) ? form.fields.kind as DocumentKind : 'qualification';
    const title = text(form.fields.title, 255) || (kind !== 'qualification' ? DOC_KIND_NAME[kind] : '');
    const validUntil = isoDate(form.fields.validUntil);
    const fields: Record<string, string> = {};
    if (title.length < 3) fields.title = 'Укажите наименование документа';
    if (!validUntil) fields.validUntil = 'Укажите срок действия';
    if (!documentId && !file) fields.file = 'Приложите скан документа';
    if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте документ', fields);

    const fileKind = kind === 'qualification' ? 'qualification' : kind;
    const saved = file ? await storeFile(ctx, actor, file, cp, fileKind, worker.id) : null;
    try {
      await db.tx(async (t) => {
        const entry = { title, number: text(form.fields.number, 128), validUntil: validUntil!, fileId: saved?.id ?? null };
        if (documentId) {
          if (!await data.updateWorkerDocument(t, worker.id, documentId, entry)) throw ApiError.notFound('Документ не найден');
        } else {
          await data.addWorkerDocument(t, worker.id, { ...entry, kind, fileId: saved!.id }, actor.id);
        }
        await repo.logEvent(t, {
          ...deps.audit(ctx, actor), action: documentId ? `Обновлён документ работника (${DOC_KIND_NAME[kind]})` : `Добавлен документ работника (${DOC_KIND_NAME[kind]})`,
          entity: 'contractor_worker', entityId: worker.id,
          detail: `${worker.full_name}: ${title}, до ${validUntil}${saved ? ` · ${saved.fileName}` : ''}`, regulationRef: REF,
        });
      });
    } catch (error) {
      await dropFile(saved);
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
      ...deps.audit(ctx, actor), action: 'Удалён документ работника', entity: 'contractor_worker',
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

  /* ---------------------------- проверка на объекте ---------------------------- */

  /**
   * Допуски на объекты, действующие на дату: филиалу — свои объекты, СУА и ДИТ — все.
   * С отметками дня: сколько работников допущено и сколько не допущено.
   */
  router.get('/api/v1/permits/site', async (ctx) => {
    const actor = await deps.actor(ctx);
    if (!isStaff(actor) || rbac.isExternal(actor)) throw ApiError.forbidden();
    const date = isoDate(ctx.query.get('date')) ?? localNow().slice(0, 10);
    const central = isCentral(actor) || actor.roles.includes('admin');
    if (!central && !actor.branchId) return { date, requests: [] };
    const rows = await data.listRequests(db, {
      activeOn: date, branchId: central ? (UUID.test(ctx.query.get('branchId') ?? '') ? ctx.query.get('branchId') : null) : actor.branchId,
      limit: 500,
    });
    const marks = rows.length ? await db.query<{ request_id: string; admitted: number; refused: number; on_site: number }>(
      `SELECT request_id, count(*) FILTER (WHERE admitted AND worker_id IS NOT NULL)::int AS admitted,
              count(*) FILTER (WHERE NOT admitted)::int AS refused,
              count(*) FILTER (WHERE admitted AND worker_id IS NOT NULL AND left_at IS NULL)::int AS on_site
         FROM site_admissions WHERE work_date = $1 AND request_id = ANY($2::uuid[]) GROUP BY request_id`,
      [date, rows.map((r) => r.id)]) : [];
    const byId = new Map(marks.map((m) => [m.request_id, m]));
    return {
      date,
      requests: rows.map((r) => ({ ...shape(r, true), today: byId.get(r.id) ?? { admitted: 0, refused: 0, on_site: 0 } })),
    };
  });

  /**
   * Проверка по электронному допуску: код с допуска, ИИН или ФИО работника.
   * Показывает, действует ли допуск сегодня, кто в нём и на какой объект.
   */
  router.get('/api/v1/permits/verify', async (ctx) => {
    const actor = await deps.actor(ctx);
    if (!isStaff(actor) || rbac.isExternal(actor)) throw ApiError.forbidden();
    const q = text(ctx.query.get('q'), 64);
    if (q.length < 3) throw ApiError.badRequest('Введите код допуска, ИИН или фамилию', { q: 'Не меньше 3 символов' });
    const rows = await data.listRequests(db, { q, limit: 50 });
    const visible: AccessRequestRow[] = [];
    for (const r of rows.filter((x) => ['approved', 'closed', 'revoked'].includes(x.status))) {
      if (isCentral(actor) || actor.roles.includes('admin') || (await branchSide(actor, r)).staff) visible.push(r);
    }
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Проверка допуска на объекте', entity: ENTITY, entityId: visible[0]?.id ?? 'search',
      detail: `запрос «${q}» · найдено ${visible.length}`, regulationRef: 'п. 23 Инструкции',
    });
    const out = [];
    for (const r of visible.slice(0, 10)) {
      const { workers } = await data.composition(db, r.id);
      const needle = q.toLowerCase();
      out.push({
        ...shape(r, true),
        matchedWorkers: workers.filter((w) => w.iin === q || w.full_name.toLowerCase().includes(needle)).map((w) => w.full_name),
      });
    }
    return { results: out, now: localNow() };
  });

  type AdmissionBody = {
    workDate?: string; workerId?: string; vehicleId?: string; briefingDone?: boolean; briefingRecord?: string;
    clothingOk?: boolean; footwearOk?: boolean; ppeOk?: boolean; documentsOk?: boolean; admitted?: boolean; refusalReason?: string;
  };

  /**
   * Отметка ответственного лица на объекте (пп. 21–23): инструктаж с записью в журнале,
   * спецодежда, спецобувь, СИЗ, удостоверения. Без СИЗ работы запрещены (п. 22).
   */
  router.post('/api/v1/permits/requests/:id/admissions', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadRequest(ctx, actor, ctx.params.id);
    const side = await branchSide(actor, r);
    if (!side.staff && !actor.roles.includes('admin')) {
      await denied(ctx, actor, r.id, `${r.number}: отметка на объекте без полномочий`);
      throw ApiError.forbidden('Отметки на объекте ставит ответственное лицо филиала (п. 20)');
    }
    if (r.status !== 'approved') throw ApiError.conflict(`Допуск не действует: ${STATUS_NAME[r.status]}`);
    const body = await ctx.body<AdmissionBody>();
    const workDate = isoDate(body.workDate) ?? localNow().slice(0, 10);
    if (!r.period_start || !r.period_end || workDate < r.period_start.slice(0, 10) || workDate > r.period_end.slice(0, 10)) {
      throw ApiError.conflict(`Дата ${workDate} вне срока допуска`);
    }
    const { workers, vehicles } = await data.composition(db, r.id);
    const worker = body.workerId ? workers.find((w) => w.worker_id === body.workerId) : null;
    const vehicle = body.vehicleId ? vehicles.find((v) => v.vehicle_id === body.vehicleId) : null;
    if (!worker && !vehicle) throw ApiError.badRequest('Работник или транспорт не входит в допуск', { workerId: 'Нет в списке допуска' });
    const admitted = body.admitted !== false;
    const input: data.AdmissionInput = {
      workDate, workerId: worker?.worker_id ?? null, vehicleId: worker ? null : vehicle!.vehicle_id,
      briefingDone: body.briefingDone === true, briefingRecord: text(body.briefingRecord, 64),
      clothingOk: body.clothingOk === true, footwearOk: body.footwearOk === true, ppeOk: body.ppeOk === true,
      documentsOk: body.documentsOk === true, admitted, refusalReason: admitted ? null : text(body.refusalReason, 1000),
    };
    if (worker && admitted) {
      const fields: Record<string, string> = {};
      if (!input.briefingDone || !input.briefingRecord) fields.briefing = 'Проведите инструктаж и укажите номер записи в журнале (п. 21)';
      if (!input.clothingOk || !input.footwearOk || !input.ppeOk) {
        fields.ppe = 'Без специальной одежды, обуви и СИЗ выполнение работ на объекте запрещается (п. 22)';
      }
      if (!input.documentsOk) fields.documents = 'Сверьте удостоверение личности и квалификационные документы';
      const expired = worker.documents.filter((d) => (d.kind ?? 'qualification') === 'qualification' && d.validUntil < workDate);
      if (expired.length) fields.documents = `Удостоверение «${expired[0].title}» истекло ${expired[0].validUntil} — к работам не допускается`;
      if (Object.keys(fields).length) throw ApiError.badRequest('Работника допустить нельзя', fields);
    }
    if (!admitted && !input.refusalReason) throw ApiError.badRequest('Укажите причину недопуска', { refusalReason: 'Укажите причину' });
    await db.tx(async (t) => {
      await data.saveAdmission(t, r.id, input, actor.id);
      const who = worker?.full_name ?? `транспорт ${vehicle!.plate}`;
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: admitted ? 'Допущен на объект' : 'Не допущен на объект', entity: ENTITY, entityId: r.id,
        detail: `${r.number} · ${workDate} · ${who}` + (worker && admitted ? ` · инструктаж, запись № ${input.briefingRecord}; СИЗ проверены` : '') +
          (admitted ? '' : ` · ${input.refusalReason}`),
        regulationRef: 'пп. 21–23 Инструкции',
      });
    });
    return { admissions: await data.admissions(db, r.id) };
  });

  router.post('/api/v1/permits/requests/:id/admissions/:aid/left', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    const r = await loadRequest(ctx, actor, ctx.params.id);
    if (!(await branchSide(actor, r)).staff && !actor.roles.includes('admin')) throw ApiError.forbidden();
    if (!UUID.test(ctx.params.aid) || !await data.markLeft(db, r.id, ctx.params.aid)) throw ApiError.notFound('Отметка не найдена');
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Убытие с объекта', entity: ENTITY, entityId: r.id, detail: r.number,
      regulationRef: 'п. 23 Инструкции',
    });
    return { admissions: await data.admissions(db, r.id) };
  });

  /* ------------------------------ печатные формы ------------------------------ */

  const dt = (v: string | null) => (v ? `${dmy(v)} ${v.slice(11, 16)}` : '___________');

  function appendixTable(r: AccessRequestRow, workers: CompositionWorker[]): string {
    return `<h2>Приложение 1</h2>
<p>Сведения о специалистах <b>${html(r.owner_name || r.counterparty_name)}${r.owner_name ? ` (подрядная организация: ${html(r.counterparty_name)})` : ''}</b>,
которым необходим допуск на объект <b>${html(r.facility_name)}</b> (${html(r.facility_address ?? '')}).</p>
<table><thead><tr><th>№</th><th>Ф.И.О. (для иностранцев на английском языке)</th><th>Дата, год рождения</th><th>Место рождения</th>
<th>Гражданство</th><th>№ удостоверения личности (для резидентов) / № паспорта (для нерезидентов), дата выдачи, кем выдан</th>
<th>Адрес местожительства</th><th>Место работы, должность</th><th>Удостоверения, подтверждающие квалификацию</th></tr></thead><tbody>
${workers.map((w, i) => {
    const d = w.details ?? {};
    const quals = w.documents.filter((x) => (x.kind ?? 'qualification') === 'qualification')
      .map((x) => `${html(x.title)}${x.number ? ' № ' + html(x.number) : ''}, до ${dmy(x.validUntil)}`).join('<br>');
    return `<tr><td class="c">${i + 1}</td><td>${html(w.full_name)}${d.full_name_latin ? `<br>${html(d.full_name_latin)}` : ''}${w.iin ? `<br><span class="muted">ИИН ${html(w.iin)}</span>` : ''}</td>
<td>${dmy(d.birth_date ?? null)}</td><td>${html(d.birth_place)}</td><td>${html(COUNTRY_NAME[d.citizenship ?? 'KZ'] ?? d.citizenship)}</td>
<td>${html(d.id_doc_number)}, ${dmy(d.id_doc_issued_at ?? null)}, ${html(d.id_doc_issued_by)}</td><td>${html(d.address)}</td>
<td>${html(d.employer || r.counterparty_name)}, ${html(w.position)}</td><td>${quals}</td></tr>`;
  }).join('')}
</tbody></table>`;
  }

  /** Официальный запрос с Приложением 1 — для подписи уполномоченным лицом и печати организации (п. 13). */
  router.get('/api/v1/permits/requests/:id/print/letter', async (ctx) => {
    const actor = await deps.actor(ctx);
    const r = await loadRequest(ctx, actor, ctx.params.id);
    const { workers, vehicles } = await data.composition(db, r.id);
    const basis = r.basis_type
      ? `${BASIS_NAME[r.basis_type]} № ${html(r.basis_number)}${r.basis_date ? ` от ${dmy(r.basis_date)}` : ''}${r.basis_valid_until ? `, действует до ${dmy(r.basis_valid_until)}` : ''}`
      : 'не требуется (п. 14 Инструкции)';
    const body = `<p class="r">Исх. № ${html(r.letter_number) || '_______'} от ${dmy(r.letter_date)}</p>
<p class="r">АО «Казтелерадио»<br>Служба управления активами</p>
<h1>Запрос на допуск на объект Общества</h1>
<p>${html(r.counterparty_name)} (БИН ${html(r.counterparty_bin)})${r.owner_name ? `, подрядная организация арендатора ${html(r.owner_name)} (БИН ${html(r.owner_bin)}),` : ''}
просит предоставить допуск представителям и автотранспортным средствам на объект АО «Казтелерадио»:</p>
<table><tbody>
<tr><th style="width:32%">Объект, территориальная принадлежность</th><td>${html(r.facility_name)}, ${html(r.facility_address ?? '')}, ${html(r.branch_name ?? '')}</td></tr>
<tr><th>Цель и характер работ</th><td>${r.work_type ? WORK_TYPE_NAME[r.work_type] : ''}${r.on_ams ? ', на АМС' : ''}${r.description ? `<br>${html(r.description)}` : ''}</td></tr>
<tr><th>Основание (договор аренды; для монтажа — номер и дата ТУ)</th><td>${basis}</td></tr>
<tr><th>Срок (период) работ</th><td>с ${dt(r.period_start)} по ${dt(r.period_end)}; время работ ${html(r.work_hours_from)}–${html(r.work_hours_to)}${r.weekend_work ? ', включая выходные дни' : ''}</td></tr>
<tr><th>Количество работников / транспорт</th><td>${workers.length} / ${vehicles.length ? vehicles.map((v) => `${html(v.plate)} ${html(v.model)}`).join(', ') : 'нет'}</td></tr>
<tr><th>Номер заявки в портале</th><td>${html(r.number)}</td></tr>
</tbody></table>
${appendixTable(r, workers)}
<p>Работники ознакомлены с требованиями охраны труда и пропускного режима; согласие работников на обработку персональных данных получено.</p>
<div class="sign"><div>${html(r.signatory_position) || 'Должность'}<div class="line"></div></div><div>${html(r.signatory_name) || 'Ф.И.О.'}<div class="line"></div><span class="muted">подпись, М.П.</span></div></div>`;
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Печать запроса с Приложением 1', entity: ENTITY, entityId: r.id, detail: r.number,
      regulationRef: 'п. 13 Инструкции',
    });
    return sendHtml(ctx, printPage(`Запрос ${r.number}`, body));
  });

  /** Электронный допуск и письменный ответ заявителю, копия — филиалу (п. 15). */
  router.get('/api/v1/permits/requests/:id/print/permit', async (ctx) => {
    const actor = await deps.actor(ctx);
    const r = await loadRequest(ctx, actor, ctx.params.id);
    if (!['approved', 'closed'].includes(r.status)) throw ApiError.conflict('Допуск не выдан');
    const { workers, vehicles } = await data.composition(db, r.id);
    const body = `<p class="r">АО «Казтелерадио»<br>Служба управления активами</p>
<p>${html(r.counterparty_name)} (БИН ${html(r.counterparty_bin)})<br>Копия: ${html(r.branch_name ?? 'филиал')}</p>
<h1>${r.provisional ? 'Аварийный допуск' : 'Допуск'} № ${html(r.number)}</h1>
<p class="c"><span class="code">${html(r.permit_code)}</span><br><span class="muted">код для проверки на объекте</span></p>
<p>На Ваш запрос${r.letter_number ? ` исх. № ${html(r.letter_number)} от ${dmy(r.letter_date)}` : ''} сообщаем, что допуск на объект предоставлен:</p>
<table><tbody>
<tr><th style="width:30%">Объект</th><td>${html(r.facility_name)}, инв. № ${html(r.facility_inv_no ?? '')}, ${html(r.facility_address ?? '')}</td></tr>
<tr><th>Филиал</th><td>${html(r.branch_name ?? '')}</td></tr>
<tr><th>Цель работ</th><td>${r.work_type ? WORK_TYPE_NAME[r.work_type] : ''}${r.on_ams ? ', на АМС' : ''}</td></tr>
<tr><th>Срок действия допуска</th><td>с ${dt(r.period_start)} по ${dt(r.period_end)}; время ${html(r.work_hours_from)}–${html(r.work_hours_to)}${r.weekend_work ? ', включая выходные' : ', в рабочие дни'}</td></tr>
<tr><th>Основание</th><td>${r.basis_type ? `${BASIS_NAME[r.basis_type]} № ${html(r.basis_number)}` : '—'}</td></tr>
${r.branch_approval === 'approved' ? `<tr><th>Согласовано руководством филиала</th><td>${localStamp(r.branch_decided_at)}${r.branch_note ? ' · ' + html(r.branch_note) : ''}</td></tr>` : ''}
<tr><th>Ответственное лицо на объекте</th><td>${html(r.site_officer_name ?? 'определяет руководитель филиала')}</td></tr>
</tbody></table>
<h2>Допущенные работники</h2>
<table><thead><tr><th>№</th><th>Ф.И.О.</th><th>Документ, удостоверяющий личность</th><th>Место работы, должность</th></tr></thead><tbody>
${workers.map((w, i) => `<tr><td class="c">${i + 1}</td><td>${html(w.full_name)}</td><td>${w.iin ? 'ИИН ' + html(w.iin) : html(w.details?.id_doc_number ?? '')}</td><td>${html(w.details?.employer || r.counterparty_name)}, ${html(w.position)}</td></tr>`).join('')}
</tbody></table>
${vehicles.length ? `<h2>Автотранспорт</h2><table><thead><tr><th>Госномер</th><th>Марка</th><th>Водитель</th></tr></thead><tbody>
${vehicles.map((v) => `<tr><td>${html(v.plate)}</td><td>${html(v.model)}</td><td>${html(v.driver_name)}</td></tr>`).join('')}</tbody></table>` : ''}
<h2>Условия допуска</h2>
<ol class="muted">
<li>Перед началом работ ответственное лицо филиала проводит инструктаж с записью в журнале регистрации инструктажа на рабочем месте (п. 21).</li>
<li>Работники, не укомплектованные специальной одеждой, обувью и средствами индивидуальной защиты, к работам не допускаются (п. 22).</li>
<li>Работы выполняются с соблюдением требований безопасности и охраны труда, Положения об охранно-пропускном режиме Общества и Инструкции № 31 СОТиТБ-И-39 (пп. 23, 24).</li>
<li>Одновременно на объекте — не более 5 человек, если большее число не согласовано руководством филиала (п. 14).</li>
${r.provisional ? '<li>Аварийный допуск: оформленный запрос предоставляется в течение 2 календарных дней (п. 18).</li>' : ''}
</ol>
<div class="sign"><div>Служба управления активами<div class="line"></div></div><div>${html(r.reviewed_by_name ?? '')}<div class="line"></div><span class="muted">выдан ${localStamp(r.permit_issued_at)}</span></div></div>`;
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: 'Печать допуска', entity: ENTITY, entityId: r.id, detail: r.number,
      regulationRef: 'п. 15 Инструкции',
    });
    return sendHtml(ctx, printPage(`Допуск ${r.number}`, body));
  });

  /* ---------------------------- настройки ---------------------------- */

  router.get('/api/v1/permits/settings', async (ctx) => {
    const actor = await deps.actor(ctx);
    if (!isCentral(actor) && !actor.roles.includes('admin')) throw ApiError.forbidden();
    return {
      modes: await data.getModes(db), registryBacked: REGISTRY_BACKED, basisTypes: BASIS_NAME,
      rules: await data.getRules(db), cisDays: await data.getCisDays(db), countries: COUNTRY_NAME,
    };
  });

  /** Режим проверки оснований, сроки и пределы Инструкции меняет ДИТ (План модуля допусков, §5.3). */
  router.post('/api/v1/permits/settings', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'admin');
    const body = await ctx.body<{ modes?: Record<string, string>; rules?: Record<string, unknown>; cisDays?: Record<string, unknown> }>();
    const modes = normalizeModes(body.modes);
    const rules = body.rules ? normalizeRules(body.rules) : null;
    const cisDays = body.cisDays ? normalizeCisDays(body.cisDays) : null;
    await db.tx(async (t) => {
      await data.setModes(t, modes, actor.id);
      if (rules) await data.setSetting(t, data.RULES_KEY, rules, 'Портал допусков: сроки и пределы Инструкции', actor.id);
      if (cisDays) await data.setSetting(t, data.CIS_KEY, cisDays, 'Портал допусков: срок безвизового пребывания граждан СНГ', actor.id);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Изменены настройки портала допусков', entity: 'settings',
        entityId: data.MODES_KEY,
        detail: Object.entries(modes).map(([k, v]) => `${BASIS_NAME[k as BasisType]}: ${v === 'strict' ? 'строгий' : 'мягкий'}`).join('; ') +
          (rules ? ` · рассмотрение ${rules.reviewDays} р.д., филиал ${rules.branchDays} р.д., до ${rules.maxCrew} чел.` : '') +
          (cisDays ? ` · СНГ: ${Object.entries(cisDays).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''),
        regulationRef: 'ТЗ портала §6.1',
      });
    });
    return { modes, rules: rules ?? await data.getRules(db), cisDays: cisDays ?? await data.getCisDays(db) };
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
      workType: isWorkType(q.get('workType')) ? q.get('workType') : null,
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
        header: ['Номер', 'Отправлена', 'Организация', 'БИН', 'Цель работ', 'На АМС', 'Объект', 'Филиал', 'Основание',
          'Номер основания', 'Проверка основания', 'Подтверждено вручную', 'Начало работ', 'Окончание работ', 'Время работ',
          'Выходные', 'Работников', 'Транспорт', 'Срочно', 'Согласование филиала', 'Срок СУА', 'Статус', 'Дата решения',
          'Специалист СУА', 'Код допуска', 'Ответственный на объекте', 'Причина отказа или отзыва', 'Часов до решения'],
        rows: rows.map((r) => [
          r.number, day(r.submitted_at), r.counterparty_name, r.counterparty_bin, r.work_type ? WORK_TYPE_NAME[r.work_type] : '',
          r.on_ams ? 'да' : '', r.facility_name, r.branch_name,
          r.basis_type ? BASIS_NAME[r.basis_type] : '', r.basis_number, (r.basis_check as { message?: string }).message ?? '',
          r.basis_confirmed_at ? 'да' : '', r.period_start?.replace('T', ' ') ?? '', r.period_end?.replace('T', ' ') ?? '',
          `${r.work_hours_from}–${r.work_hours_to}`, r.weekend_work ? 'да' : '',
          r.workers_count, r.vehicles_count, r.is_urgent ? 'да' : '', BRANCH_APPROVAL_NAME[r.branch_approval],
          r.review_due_at ?? '', STATUS_NAME[r.status], day(r.reviewed_at), r.reviewed_by_name, r.permit_code ?? '',
          r.site_officer_name ?? '', r.rejection_reason ?? r.revoke_reason ?? '', hours(r),
        ]),
      };
      const totals = {
        name: 'Итоги',
        header: ['Показатель', 'Значение'],
        rows: [
          ['Всего заявок', summary.total], ['На рассмотрении', summary.pending], ['Допусков выдано', summary.approved],
          ['Отклонено', summary.rejected], ['Отозвано организацией', summary.withdrawn], ['Допусков отозвано', summary.revoked],
          ['Срочных', summary.urgent], ['Аварийных', summary.emergency], ['С согласованием филиала', summary.branchApproval],
          ['Просрочено рассмотрение (14 р.д.)', summary.overdue], ['Основание подтверждено вручную', summary.manualBasis],
          ['Среднее время до решения, ч', summary.avgDecisionHours], ['Медиана времени до решения, ч', summary.medianDecisionHours],
          ...Object.entries(summary.byWorkType).map(([k, n]) => [`Цель: ${WORK_TYPE_NAME[k as WorkType]}`, n]),
          ...summary.rejectionReasons.map((x) => [`Причина отказа: ${x.reason}`, x.count]),
        ],
      };
      return sendSheets(ctx, format, 'zayavki-na-dopusk', format === 'csv' ? [sheet] : [sheet, totals]);
    }
    return { rows: rows.map((r) => shape(r, true)), summary };
  });
}
