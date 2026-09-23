/**
 * Доступ к данным.
 *
 * Функции принимают подключение первым аргументом, поэтому одинаково работают
 * и на пуле, и внутри транзакции. Бизнес-правила здесь не дублируются: их
 * проверяет процессный движок (src/process), а репозиторий только читает и
 * пишет.
 */

import type { Db } from './client.ts';
import type { Role, Service, TvStatus } from '../domain/types.ts';
import type { StageCode } from '../process/stages.ts';
import type { RequestSnapshot } from '../process/transitions.ts';
import type { StageRecord } from '../process/engine.ts';
import type { Actor } from '../server/rbac.ts';

/* ------------------------------ пользователи ------------------------------ */

export async function findActorByIdentity(
  db: Db,
  identity: { userId: string; email: string; displayName: string },
): Promise<Actor | null> {
  const row = await db.one<{
    id: string; user_id: string | null; email: string; full_name: string;
    branch_id: string | null; counterparty_id: string | null; is_active: boolean; roles: Role[] | null;
  }>(
    `SELECT u.id, u.oidc_subject AS user_id, u.email, u.full_name, u.branch_id,
            u.counterparty_id, u.is_active,
            array_remove(array_agg(r.role), NULL) AS roles
       FROM users u
       LEFT JOIN user_roles r ON r.user_id = u.id
      WHERE u.email = $1
      GROUP BY u.id`,
    [identity.email.toLowerCase()],
  );
  if (!row) return null;

  // Учётная запись закрепляется за первым вошедшим субъектом OIDC; подмена отклоняется.
  if (row.user_id && row.user_id !== identity.userId) return null;
  if (!row.user_id) {
    await db.query('UPDATE users SET oidc_subject = $1 WHERE id = $2 AND oidc_subject IS NULL',
      [identity.userId, row.id]);
  }

  return {
    id: row.id,
    userId: identity.userId,
    email: row.email,
    fullName: row.full_name,
    roles: (row.roles ?? []) as Role[],
    branchId: row.branch_id,
    counterpartyId: row.counterparty_id,
    isActive: row.is_active,
  };
}

/**
 * Первичная настройка: если администраторов ещё нет, указанный в окружении
 * адрес получает роль ДИТ. Дальше роли назначает администратор вручную —
 * самопроизвольной выдачи прав не происходит.
 */
export async function bootstrapAdmin(db: Db, email: string, fullName: string): Promise<boolean> {
  return db.tx(async (t) => {
    const exists = await t.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_roles WHERE role = 'admin'`);
    if (Number(exists?.n ?? 0) > 0) return false;

    const user = await t.one<{ id: string }>(
      `INSERT INTO users (email, full_name, department, is_active)
       VALUES ($1, $2, 'ДИТ', true)
       ON CONFLICT (email) DO UPDATE SET full_name = excluded.full_name
       RETURNING id`,
      [email.toLowerCase(), fullName],
    );
    await t.query(
      `INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
      [user!.id],
    );
    return true;
  });
}

/* -------------------------------- справочники ------------------------------ */

export type FacilityRow = {
  id: string; inv_no: string; name: string; kind: string; branch_id: string;
  branch_name: string; address: string; height_m: string | null;
  passport_load_kg: string | null; power_input_kw: string | null;
  registry_version: string | null;
};

export function listFacilities(db: Db): Promise<FacilityRow[]> {
  return db.query<FacilityRow>(
    `SELECT f.id, f.inv_no, f.name, f.kind, f.branch_id, b.name AS branch_name, f.address,
            f.height_m, c.passport_load_kg, c.power_input_kw,
            (SELECT version FROM registry_versions ORDER BY published_at DESC LIMIT 1) AS registry_version
       FROM facilities f
       JOIN branches b ON b.id = f.branch_id
       LEFT JOIN facility_capacity c ON c.facility_id = f.id
      WHERE f.is_active
      ORDER BY f.name`);
}

export function listTiers(db: Db, facilityId: string) {
  return db.query(
    `SELECT id, height_m, capacity_kg, occupied_kg FROM facility_tiers
      WHERE facility_id = $1 ORDER BY height_m DESC`, [facilityId]);
}

export function listTariffs(db: Db, on: string) {
  return db.query(
    `SELECT id, service, name, unit, amount, source, effective_from, effective_to
       FROM tariffs
      WHERE effective_from <= $1 AND (effective_to IS NULL OR effective_to >= $1)
      ORDER BY service, name`, [on]);
}

export async function calendar(db: Db): Promise<{ holidays: string[]; workingDays: string[] }> {
  const rows = await db.query<{ day: Date; kind: string }>('SELECT day, kind FROM calendar_days');
  const iso = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 10);
  return {
    holidays: rows.filter((r) => r.kind === 'holiday').map((r) => iso(r.day)),
    workingDays: rows.filter((r) => r.kind === 'working').map((r) => iso(r.day)),
  };
}

/* --------------------------------- заявки --------------------------------- */

export type RequestRow = RequestSnapshot & {
  uuid: string;
  counterpartyId: string;
  counterpartyName: string;
  facilityId: string;
  facilityName: string;
  branchId: string;
  branchName: string;
  totalAmount: number | null;
  createdAt: string;
  registeredAt: string | null;
  version: number;
};

const SELECT_REQUEST = `
  SELECT r.id AS uuid, r.number, r.incoming_number, r.incoming_date,
         r.counterparty_id, cp.name_full AS counterparty_name,
         r.facility_id, f.name AS facility_name,
         r.branch_id, b.name AS branch_name,
         r.stage_code, r.tv_status, r.master_file_version, r.verification_calc,
         r.free_of_charge, r.estimate_approved, r.order_number, r.result_delivered,
         r.closing_confirmed, r.total_amount, r.registered_at, r.created_at, r.version,
         (SELECT array_agg(s.service ORDER BY s.service) FROM request_services s WHERE s.request_id = r.id) AS services,
         (SELECT count(*) FROM request_remarks m WHERE m.request_id = r.id AND m.resolved_at IS NULL) AS open_remarks,
         (SELECT min(c.paid_at) FROM contracts c WHERE c.request_id = r.id AND c.paid_at IS NOT NULL) AS paid_at,
         (SELECT c.number FROM contracts c WHERE c.request_id = r.id ORDER BY c.created_at LIMIT 1) AS contract_number,
         (SELECT max(d.doc_date) FROM documents d
           WHERE d.request_id = r.id AND d.kind = 'Акт приема-передачи' AND d.approved) AS transfer_act_date,
         EXISTS (SELECT 1 FROM documents d WHERE d.request_id = r.id AND d.kind = 'АВР' AND d.approved) AS avr_approved,
         (SELECT max(d.created_at) FROM documents d WHERE d.request_id = r.id AND d.kind = 'АВР') AS avr_sent_at
    FROM requests r
    JOIN counterparties cp ON cp.id = r.counterparty_id
    JOIN facilities f ON f.id = r.facility_id
    JOIN branches b ON b.id = r.branch_id`;

const iso = (v: unknown): string | null =>
  v == null ? null : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

function toSnapshot(row: Record<string, any>, seq: number): RequestRow {
  return {
    id: seq,
    uuid: row.uuid,
    number: row.number,
    incomingNumber: row.incoming_number,
    incomingDate: iso(row.incoming_date),
    stageCode: row.stage_code as StageCode,
    services: (row.services ?? []) as Service[],
    tvStatus: row.tv_status as TvStatus,
    masterFileVersion: row.master_file_version,
    verificationCalcDecision: row.verification_calc,
    contractNumber: row.contract_number,
    freeOfCharge: row.free_of_charge,
    paidAt: iso(row.paid_at),
    estimateApproved: row.estimate_approved,
    orderNumber: row.order_number,
    transferActApprovedDate: iso(row.transfer_act_date),
    avrApproved: row.avr_approved,
    avrSentAt: row.avr_sent_at ? new Date(row.avr_sent_at).toISOString() : null,
    closingConfirmed: row.closing_confirmed,
    resultDelivered: row.result_delivered,
    openRemarks: Number(row.open_remarks ?? 0),
    counterpartyId: row.counterparty_id,
    counterpartyName: row.counterparty_name,
    facilityId: row.facility_id,
    facilityName: row.facility_name,
    branchId: row.branch_id,
    branchName: row.branch_name,
    totalAmount: row.total_amount === null ? null : Number(row.total_amount),
    createdAt: new Date(row.created_at).toISOString(),
    registeredAt: row.registered_at ? new Date(row.registered_at).toISOString() : null,
    version: row.version,
  };
}

export type RequestFilter = {
  scope: { kind: 'all' } | { kind: 'counterparty'; id: string } | { kind: 'branch'; id: string } | { kind: 'none' };
  stageCode?: StageCode;
  branchId?: string;
  service?: Service;
  limit?: number;
  offset?: number;
};

export async function listRequests(db: Db, filter: RequestFilter): Promise<RequestRow[]> {
  if (filter.scope.kind === 'none') return [];
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)); };

  if (filter.scope.kind === 'counterparty') add('r.counterparty_id = ?', filter.scope.id);
  if (filter.scope.kind === 'branch') add('r.branch_id = ?', filter.scope.id);
  if (filter.stageCode) add('r.stage_code = ?', filter.stageCode);
  if (filter.branchId) add('r.branch_id = ?', filter.branchId);
  if (filter.service) add('EXISTS (SELECT 1 FROM request_services s WHERE s.request_id = r.id AND s.service = ?)', filter.service);

  const sql = `${SELECT_REQUEST}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.created_at DESC
    LIMIT ${Math.min(filter.limit ?? 100, 500)} OFFSET ${Math.max(filter.offset ?? 0, 0)}`;
  const rows = await db.query<Record<string, any>>(sql, params as never);
  return rows.map((row, i) => toSnapshot(row, i + 1));
}

export async function getRequest(db: Db, id: string): Promise<RequestRow | null> {
  const row = await db.one<Record<string, any>>(`${SELECT_REQUEST} WHERE r.id = $1`, [id]);
  return row ? toSnapshot(row, 1) : null;
}

export function listRequestServices(db: Db, requestId: string) {
  return db.query(
    `SELECT id, service, placement, params, tariff_id, tariff_quantity, amount, basis_reference
       FROM request_services WHERE request_id = $1 ORDER BY service`, [requestId]);
}

export async function nextNumber(db: Db, year: number): Promise<string> {
  const row = await db.one<{ last: number }>(
    `INSERT INTO request_counters (year, last) VALUES ($1, 1)
     ON CONFLICT (year) DO UPDATE SET last = request_counters.last + 1
     RETURNING last`, [year]);
  return `ЗК-${year}-${String(row!.last).padStart(4, '0')}`;
}

export type NewRequest = {
  counterpartyId: string;
  facilityId: string;
  branchId: string;
  createdBy: string;
  stageCode: StageCode;
  freeOfCharge: boolean;
  totalAmount: number | null;
  services: {
    service: Service; placement: string; params: Record<string, unknown>;
    tariffId?: string | null; tariffQuantity?: number | null; amount?: number | null;
    basisReference?: string | null;
  }[];
};

export async function createRequest(db: Db, data: NewRequest, stage: StageRecord): Promise<RequestRow> {
  return db.tx(async (t) => {
    const number = await nextNumber(t, new Date().getFullYear());
    const created = await t.one<{ id: string }>(
      `INSERT INTO requests (number, counterparty_id, facility_id, branch_id, created_by,
                             stage_code, customer_status, free_of_charge, total_amount, registered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $6 = 'draft' THEN NULL ELSE now() END)
       RETURNING id`,
      [number, data.counterpartyId, data.facilityId, data.branchId, data.createdBy,
       data.stageCode, data.stageCode === 'draft' ? 'draft' : 'registered',
       data.freeOfCharge, data.totalAmount],
    );
    const id = created!.id;

    for (const s of data.services) {
      await t.query(
        `INSERT INTO request_services (request_id, service, placement, params, tariff_id,
                                       tariff_quantity, amount, basis_reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, s.service, s.placement, JSON.stringify(s.params ?? {}), s.tariffId ?? null,
         s.tariffQuantity ?? null, s.amount ?? null, s.basisReference ?? null],
      );
    }
    await openStageRecord(t, id, stage);
    const row = await getRequest(t, id);
    return row!;
  });
}

/* ------------------------------ этапы заявки ------------------------------ */

export async function openStageRecord(db: Db, requestId: string, stage: StageRecord): Promise<void> {
  await db.query(
    `INSERT INTO request_stages (request_id, stage_code, entered_at, due_at, sla_value,
                                 sla_unit, owner_party, extended_by, escalation_level)
     VALUES ($1,$2,$3,$4,$5,$6,$7,0,0)`,
    [requestId, stage.stageCode, stage.enteredAt, stage.dueAt, stage.slaValue,
     stage.slaUnit, stage.ownerParty],
  );
}

export async function currentStageRecord(db: Db, requestId: string): Promise<StageRecord | null> {
  const row = await db.one<Record<string, any>>(
    `SELECT * FROM request_stages WHERE request_id = $1 AND left_at IS NULL
      ORDER BY entered_at DESC LIMIT 1`, [requestId]);
  if (!row) return null;
  return {
    requestId: 0,
    stageCode: row.stage_code,
    enteredAt: new Date(row.entered_at).toISOString().slice(0, 10),
    leftAt: null,
    dueAt: iso(row.due_at),
    slaValue: row.sla_value,
    slaUnit: row.sla_unit,
    ownerParty: row.owner_party,
    extendedBy: row.extended_by,
    extensionReason: row.extension_reason,
    escalationLevel: row.escalation_level,
    breached: row.breached,
  };
}

export async function closeStageRecord(db: Db, requestId: string, at: string, breached: boolean): Promise<void> {
  await db.query(
    `UPDATE request_stages SET left_at = $2, breached = $3
      WHERE request_id = $1 AND left_at IS NULL`, [requestId, at, breached]);
}

/** Смена этапа с проверкой версии: параллельная правка возвращает конфликт. */
export async function updateStage(
  db: Db, requestId: string, stageCode: StageCode, customerStatus: string,
  version: number, patch: Record<string, unknown> = {},
): Promise<boolean> {
  const sets = ['stage_code = $3', 'customer_status = $4', 'version = version + 1', 'updated_at = now()'];
  const params: unknown[] = [requestId, version, stageCode, customerStatus];
  for (const [key, value] of Object.entries(patch)) {
    params.push(value);
    sets.push(`${key} = $${params.length}`);
  }
  const rows = await db.query(
    `UPDATE requests SET ${sets.join(', ')} WHERE id = $1 AND version = $2 RETURNING id`,
    params as never);
  return rows.length > 0;
}

export function stageHistory(db: Db, requestId: string) {
  return db.query(
    `SELECT stage_code, entered_at, left_at, due_at, sla_value, sla_unit, owner_party,
            extended_by, extension_reason, escalation_level, breached
       FROM request_stages WHERE request_id = $1 ORDER BY entered_at`, [requestId]);
}

/** Все прохождения этапов — исходные данные для показателей узких мест. */
export function allStageRecords(db: Db, sinceDays = 365) {
  return db.query(
    `SELECT request_id, stage_code, entered_at, left_at, due_at, sla_value, sla_unit,
            owner_party, extended_by, escalation_level, breached
       FROM request_stages
      WHERE entered_at > now() - ($1 || ' days')::interval
      ORDER BY entered_at`, [String(sinceDays)]);
}

/* -------------------------------- замечания ------------------------------- */

export function listRemarks(db: Db, requestId: string) {
  return db.query(
    `SELECT r.id, r.field_key, r.text, r.created_at, r.resolved_at, u.full_name AS author
       FROM request_remarks r JOIN users u ON u.id = r.created_by
      WHERE r.request_id = $1 ORDER BY r.created_at`, [requestId]);
}

export async function addRemark(db: Db, requestId: string, fieldKey: string, text: string, userId: string) {
  await db.query(
    `INSERT INTO request_remarks (request_id, field_key, text, created_by)
     VALUES ($1,$2,$3,$4)`, [requestId, fieldKey, text, userId]);
}

export async function resolveRemarks(db: Db, requestId: string): Promise<void> {
  await db.query(
    `UPDATE request_remarks SET resolved_at = now()
      WHERE request_id = $1 AND resolved_at IS NULL`, [requestId]);
}

/* ---------------------------- журнал действий ----------------------------- */

export async function logEvent(
  db: Db,
  e: {
    actorId?: string | null; actorName?: string; ip?: string | null; userAgent?: string | null;
    action: string; entity: string; entityId: string; detail?: string;
    result?: 'success' | 'denied' | 'error'; regulationRef?: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO events (actor_id, actor_name, ip_address, user_agent, action, entity,
                         entity_id, detail, result, regulation_ref)
     VALUES ($1,$2,$3::inet,$4,$5,$6,$7,$8,$9,$10)`,
    [e.actorId ?? null, e.actorName ?? '', e.ip ?? null, e.userAgent ?? null, e.action,
     e.entity, e.entityId, e.detail ?? '', e.result ?? 'success', e.regulationRef ?? null],
  );
}

export function listEvents(db: Db, entity: string, entityId: string, limit = 200) {
  return db.query(
    `SELECT occurred_at, actor_name, action, detail, result, regulation_ref
       FROM events WHERE entity = $1 AND entity_id = $2
      ORDER BY occurred_at DESC LIMIT $3`, [entity, entityId, limit]);
}
