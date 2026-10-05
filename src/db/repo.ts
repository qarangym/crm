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
import { toIsoDate, toIsoTimestamp } from '../domain/dates.ts';
import { today } from '../domain/calendar.ts';

/* ------------------------------ пользователи ------------------------------ */

/** Результат поиска: учётная запись, «нет такой» либо «закреплена за другим субъектом». */
export type ActorLookup = Actor | null | 'subject_mismatch';

export async function findActorByIdentity(
  db: Db,
  identity: { userId: string; email: string; displayName: string },
): Promise<ActorLookup> {
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
  // Возвращаем отдельный признак: «адрес не заведён» и «адрес закреплён за другой
  // записью входа» — разные ситуации, и администратору нужно их различать.
  if (row.user_id && row.user_id !== identity.userId) return 'subject_mismatch';
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

/** Учётная запись по id — для входа по сессии (src/server/login.ts). */
export async function findActorById(db: Db, id: string): Promise<Actor | null> {
  const row = await db.one<{
    id: string; email: string; full_name: string; branch_id: string | null;
    counterparty_id: string | null; is_active: boolean; roles: Role[] | null;
  }>(
    `SELECT u.id, u.email, u.full_name, u.branch_id, u.counterparty_id, u.is_active,
            array_remove(array_agg(r.role), NULL) AS roles
       FROM users u LEFT JOIN user_roles r ON r.user_id = u.id
      WHERE u.id = $1 GROUP BY u.id`, [id]);
  if (!row) return null;
  return {
    id: row.id, userId: `local:${row.id}`, email: row.email, fullName: row.full_name,
    roles: (row.roles ?? []) as Role[], branchId: row.branch_id, counterpartyId: row.counterparty_id,
    isActive: row.is_active,
  };
}

/**
 * Контрагент по БИН: находим существующего либо заводим карточку.
 *
 * Нужно для заявок, поступивших бумагой или почтой (п. 6 — такой канал
 * сохраняется): сотрудник вносит их в систему, и организация определяется по
 * БИН. Новая карточка создаётся со статусом «на проверке» — реквизиты
 * подтверждает ответственное подразделение, права это не выдаёт.
 */
export async function resolveCounterparty(
  db: Db,
  applicant: { bin: string; company: string; email?: string; phone?: string; contact?: string },
): Promise<{ id: string; created: boolean }> {
  return db.tx(async (t) => {
    const existing = await t.one<{ id: string }>(
      'SELECT id FROM counterparties WHERE bin = $1', [applicant.bin]);
    if (existing) return { id: existing.id, created: false };

    const created = await t.one<{ id: string }>(
      `INSERT INTO counterparties (bin, name_full, name_short, email, phone, contact_person, status)
       VALUES ($1,$2,$2,$3,$4,$5,'pending')
       ON CONFLICT (bin) DO UPDATE SET name_full = excluded.name_full
       RETURNING id`,
      [applicant.bin, applicant.company.trim(), applicant.email ?? '',
       applicant.phone ?? '', applicant.contact ?? '']);
    return { id: created!.id, created: true };
  });
}

export function listUsers(db: Db, query?: string) {
  const like = query ? `%${query}%` : null;
  return db.query(
    `SELECT u.id, u.email, u.full_name, u.position, u.department, u.is_active, u.is_head,
            u.registration_pending, u.last_login_at, u.password_hash IS NOT NULL AS has_password,
            u.branch_id, b.name AS branch_name, u.counterparty_id, cp.name_full AS counterparty_name,
            array_remove(array_agg(r.role), NULL) AS roles
       FROM users u
       LEFT JOIN user_roles r ON r.user_id = u.id
       LEFT JOIN branches b ON b.id = u.branch_id
       LEFT JOIN counterparties cp ON cp.id = u.counterparty_id
      WHERE $1::text IS NULL OR u.email ILIKE $1 OR u.full_name ILIKE $1
      GROUP BY u.id, b.name, cp.name_full
      ORDER BY u.full_name`, [like]);
}

export type UserInput = {
  email: string; fullName: string; position: string; department: string;
  branchId: string | null; counterpartyId: string | null; isActive: boolean; roles: Role[];
  /** Руководитель подразделения; не указано — не меняется (импорт из кадровой выгрузки). */
  isHead?: boolean | null;
};

/** Создание либо обновление учётной записи вместе с набором ролей. */
export async function upsertUser(db: Db, input: UserInput): Promise<{ id: string; email: string; roles: Role[] }> {
  return db.tx(async (t) => {
    const row = await t.one<{ id: string }>(
      `INSERT INTO users (email, full_name, position, department, branch_id, counterparty_id, is_active, is_head)
       VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8, false))
       ON CONFLICT (email) DO UPDATE SET
         full_name = excluded.full_name, position = excluded.position,
         department = excluded.department, branch_id = excluded.branch_id,
         counterparty_id = excluded.counterparty_id, is_active = excluded.is_active,
         is_head = coalesce($8, users.is_head)
       RETURNING id`,
      [input.email, input.fullName, input.position, input.department,
       input.branchId, input.counterpartyId, input.isActive, input.isHead ?? null]);

    await t.query('DELETE FROM user_roles WHERE user_id = $1', [row!.id]);
    for (const role of input.roles) {
      await t.query('INSERT INTO user_roles (user_id, role) VALUES ($1,$2)', [row!.id, role]);
    }
    return { id: row!.id, email: input.email, roles: input.roles };
  });
}

export async function setUserActive(db: Db, id: string, active: boolean): Promise<boolean> {
  const rows = await db.query('UPDATE users SET is_active = $2 WHERE id = $1 RETURNING id', [id, active]);
  return rows.length > 0;
}

export type EventFilter = {
  entity?: string; entityId?: string; actorId?: string; actor?: string; result?: string;
  /** Поиск по действию и подробностям — например, по имени файла или номеру заявки. */
  q?: string;
  dateFrom?: string; dateTo?: string; limit?: number; offset?: number;
};

/** Журнал действий с фильтрами (ТЗ №12, требования архива: кто и когда работал с файлом). */
export function searchEvents(db: Db, filter: EventFilter) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replaceAll('?', `$${params.length}`));
  };
  if (filter.entity) add('e.entity = ?', filter.entity);
  if (filter.entityId) add('e.entity_id = ?', filter.entityId);
  if (filter.actorId) add('e.actor_id = ?', filter.actorId);
  if (filter.actor) add(`e.actor_name ILIKE '%' || ? || '%'`, filter.actor);
  if (filter.result) add('e.result = ?', filter.result);
  if (filter.q) add(`(e.action ILIKE '%' || ? || '%' OR e.detail ILIKE '%' || ? || '%')`, filter.q);
  if (filter.dateFrom) add('e.occurred_at >= ?::date', filter.dateFrom);
  if (filter.dateTo) add(`e.occurred_at < ?::date + interval '1 day'`, filter.dateTo);
  return db.query(
    `SELECT e.id, e.occurred_at, e.actor_name, e.ip_address, e.action, e.entity, e.entity_id,
            e.detail, e.result, e.regulation_ref
       FROM events e
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT ${Math.min(Math.max(Number(filter.limit) || 200, 1), 5000)}
      OFFSET ${Math.max(Number(filter.offset) || 0, 0)}`, params as never);
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

/** Размещённое оборудование арендаторов — лист «Загрузка» Приложения 8. */
export function listTenants(db: Db, facilityId: string) {
  return db.query(
    `SELECT t.id, t.equipment, t.weight_kg, t.windage_m2, t.power_kw,
            t.mounted_at, t.dismounted_at, cp.name_full AS counterparty_name,
            d.number AS tu_number
       FROM facility_tenants t
       LEFT JOIN counterparties cp ON cp.id = t.counterparty_id
       LEFT JOIN documents d ON d.id = t.tu_document_id
      WHERE t.facility_id = $1 AND t.dismounted_at IS NULL
      ORDER BY cp.name_full`, [facilityId]);
}

export function listTiers(db: Db, facilityId: string) {
  return db.query(
    `SELECT id, height_m, capacity_kg, occupied_kg FROM facility_tiers
      WHERE facility_id = $1 ORDER BY height_m DESC`, [facilityId]);
}

export function listTariffs(db: Db, on: string) {
  return db.query(
    `SELECT id, service, name, unit, amount, source, effective_from, effective_to, placement, is_default
       FROM tariffs
      WHERE effective_from <= $1 AND (effective_to IS NULL OR effective_to >= $1)
      ORDER BY service, name`, [on]);
}

export async function calendar(db: Db): Promise<{ holidays: string[]; workingDays: string[] }> {
  const rows = await db.query<{ day: Date; kind: string }>('SELECT day, kind FROM calendar_days');
  // Через toISOString() праздничные дни сдвинулись бы на сутки назад: см. src/domain/dates.ts.
  return {
    holidays: rows.filter((r) => r.kind === 'holiday').map((r) => toIsoDate(r.day)!),
    workingDays: rows.filter((r) => r.kind === 'working').map((r) => toIsoDate(r.day)!),
  };
}

/* --------------------------------- заявки --------------------------------- */

export type RequestRow = RequestSnapshot & {
  uuid: string;
  counterpartyId: string;
  counterpartyName: string;
  /** Объект из справочника; пусто, пока объект не определён по адресу (п. 16.1). */
  facilityId: string | null;
  facilityName: string | null;
  facilityAddress: string | null;
  branchId: string | null;
  branchName: string | null;
  /** Основание подтверждения ТВ вопреки расчёту (п. 16.4). */
  tvOverrideReason: string | null;
  closedAt: string | null;
  closedReason: string | null;
  totalAmount: number | null;
  /** Мотивированные замечания Заказчика к АВР (п. 94). */
  avrObjection: string | null;
  createdAt: string;
  registeredAt: string | null;
  /** Канцелярия подтвердила автоматическую регистрацию (п. 6); пусто — ждёт подтверждения. */
  registrationConfirmedAt: string | null;
  registrationConfirmedBy: string | null;
  version: number;
  /** Реквизиты открытого этапа — для доски и реестра. */
  dueAt: string | null;
  escalationLevel: number;
  ownerParty: string | null;
  stageEnteredAt: string | null;
  /** Ответственный ОР ПСД и исполнитель текущего этапа (src/db/executors.ts); отключённый — как не назначенный. */
  responsibleId: string | null;
  responsibleName: string | null;
  executorId: string | null;
  executorName: string | null;
};

const SELECT_REQUEST = `
  SELECT r.id AS uuid, r.number, r.incoming_number, r.incoming_date,
         r.counterparty_id, cp.name_full AS counterparty_name,
         r.facility_id, f.name AS facility_name,
         r.branch_id, b.name AS branch_name,
         r.stage_code, r.tv_status, r.master_file_version, r.verification_calc,
         r.free_of_charge, r.estimate_approved, r.order_number, r.result_delivered,
         r.closing_confirmed, r.total_amount, r.registered_at, r.created_at, r.version,
         r.registration_confirmed_at, rc.full_name AS registration_confirmed_by,
         r.closed_at, r.closed_reason,
         (SELECT array_agg(s.service ORDER BY s.service) FROM request_services s WHERE s.request_id = r.id) AS services,
         (SELECT count(*) FROM request_remarks m WHERE m.request_id = r.id AND m.resolved_at IS NULL) AS open_remarks,
         coalesce(r.avr_sent_at, (SELECT max(c.avr_sent_at) FROM contracts c
                                   WHERE c.request_id = r.id AND c.status <> 'terminated')) AS avr_sent_at,
         r.avr_objection, r.tv_override_reason, r.facility_address, r.tv_recheck_required_at,
         -- Договор и оплата — по каждой услуге (пп. 21, 32, 48, 59).
         (SELECT coalesce(json_agg(json_build_object('service', c.service, 'number', c.number,
                                                     'paidAt', c.paid_at, 'avrSentAt', c.avr_sent_at,
                                                     'acceptedAt', c.accepted_at,
                                                     'avrApproved', EXISTS (SELECT 1 FROM documents d
                                                        WHERE d.kind = 'АВР' AND d.approved
                                                          AND (d.contract_id = c.id OR (d.contract_id IS NULL AND d.request_id = r.id))))
                                   ORDER BY c.service), '[]'::json)
            FROM contracts c
           WHERE c.request_id = r.id AND c.service IS NOT NULL AND c.status <> 'terminated') AS contracts,
         -- Безвозмездные позиции: ТУ на присоединение к сети телерадиовещания (п. 20).
         (SELECT coalesce(array_agg(s.service), '{}') FROM request_services s
           WHERE s.request_id = r.id AND s.service = 'ТУ' AND s.placement = 'network') AS free_services,
         (SELECT coalesce(array_agg(DISTINCT st.stage_code), '{}') FROM request_stages st
           WHERE st.request_id = r.id AND st.left_at IS NOT NULL) AS passed_stages,
         (SELECT max(d.doc_date) FROM documents d
           WHERE d.request_id = r.id AND d.kind = 'Акт приема-передачи' AND d.approved) AS transfer_act_date,
         EXISTS (SELECT 1 FROM documents d
                  WHERE d.request_id = r.id AND d.kind = 'Технический АВР' AND d.approved) AS technical_avr_approved,
         EXISTS (SELECT 1 FROM documents d WHERE d.request_id = r.id AND d.kind = 'АВР' AND d.approved) AS avr_approved,
         -- Открытый этап: контрольная дата и уровень эскалации нужны доске
         -- для SLA-подписи на карточке, без отдельного запроса на каждую заявку.
         open_stage.due_at, open_stage.escalation_level, open_stage.owner_party, open_stage.entered_at,
         ru.id AS responsible_id, ru.full_name AS responsible_name,
         eu.id AS executor_id, eu.full_name AS executor_name
    FROM requests r
    JOIN counterparties cp ON cp.id = r.counterparty_id
    LEFT JOIN facilities f ON f.id = r.facility_id
    LEFT JOIN branches b ON b.id = r.branch_id
    LEFT JOIN LATERAL (
      SELECT s.due_at, s.escalation_level, s.owner_party, s.entered_at, s.assignee_id
        FROM request_stages s
       WHERE s.request_id = r.id AND s.left_at IS NULL
       ORDER BY s.entered_at DESC LIMIT 1
    ) open_stage ON true
    LEFT JOIN users rc ON rc.id = r.registration_confirmed_by
    LEFT JOIN users ru ON ru.id = r.assignee_id AND ru.is_active
    LEFT JOIN users eu ON eu.id = open_stage.assignee_id AND eu.is_active`;

/** Даты приводим через общий помощник: см. src/domain/dates.ts о сдвиге пояса. */
const iso = toIsoDate;

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
    contracts: ((row.contracts ?? []) as { service: Service; number: string; paidAt: string | null;
      avrSentAt: string | null; acceptedAt: string | null; avrApproved: boolean }[])
      .map((c) => ({
        service: c.service, number: c.number, paidAt: c.paidAt ? String(c.paidAt).slice(0, 10) : null,
        avrApproved: !!c.avrApproved,
        avrSentAt: c.avrSentAt ? String(c.avrSentAt).slice(0, 10) : null,
        acceptedAt: c.acceptedAt ? String(c.acceptedAt).slice(0, 10) : null,
      })),
    freeServices: (row.free_services ?? []) as Service[],
    freeOfCharge: row.free_of_charge,
    passedStages: (row.passed_stages ?? []) as StageCode[],
    estimateApproved: row.estimate_approved,
    orderNumber: row.order_number,
    transferActApprovedDate: iso(row.transfer_act_date),
    technicalAvrApproved: row.technical_avr_approved,
    avrApproved: row.avr_approved,
    avrSentAt: iso(row.avr_sent_at),
    avrObjection: row.avr_objection ?? null,
    closingConfirmed: row.closing_confirmed,
    resultDelivered: row.result_delivered,
    openRemarks: Number(row.open_remarks ?? 0),
    facilityDetermined: !!row.facility_id,
    tvRecheckRequired: !!row.tv_recheck_required_at,
    counterpartyId: row.counterparty_id,
    counterpartyName: row.counterparty_name,
    facilityId: row.facility_id ?? null,
    facilityName: row.facility_name ?? null,
    facilityAddress: row.facility_address ?? null,
    branchId: row.branch_id ?? null,
    branchName: row.branch_name ?? null,
    tvOverrideReason: row.tv_override_reason ?? null,
    closedAt: toIsoTimestamp(row.closed_at),
    closedReason: row.closed_reason ?? null,
    totalAmount: row.total_amount === null ? null : Number(row.total_amount),
    createdAt: toIsoTimestamp(row.created_at)!,
    registeredAt: toIsoTimestamp(row.registered_at),
    registrationConfirmedAt: toIsoTimestamp(row.registration_confirmed_at),
    registrationConfirmedBy: row.registration_confirmed_by ?? null,
    version: row.version,
    dueAt: iso(row.due_at),
    escalationLevel: Number(row.escalation_level ?? 0),
    ownerParty: row.owner_party ?? null,
    stageEnteredAt: iso(row.entered_at),
    responsibleId: row.responsible_id ?? null,
    responsibleName: row.responsible_name ?? null,
    executorId: row.executor_id ?? null,
    executorName: row.executor_name ?? null,
  };
}

export type RequestFilter = {
  scope: { kind: 'all' } | { kind: 'counterparty'; id: string } | { kind: 'branch'; id: string } | { kind: 'none' };
  stageCode?: StageCode;
  branchId?: string;
  service?: Service;
  /** Действующие либо закрытые заявки (С10). */
  state?: 'open' | 'closed';
  /** Поиск по номеру заявки, входящему номеру, Заказчику и БИН (С10). */
  q?: string;
  /** Сотрудник — ответственный ОР ПСД либо исполнитель текущего этапа. */
  executorId?: string;
  /** Открытые заявки, у которых нет действующего исполнителя этапа или ответственного. */
  unassigned?: boolean;
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
  if (filter.state === 'open') where.push('r.closed_at IS NULL');
  if (filter.state === 'closed') where.push('r.closed_at IS NOT NULL');
  if (filter.q) {
    params.push(`%${filter.q.trim()}%`);
    const n = `$${params.length}`;
    where.push(`(r.number ILIKE ${n} OR r.incoming_number ILIKE ${n} OR cp.name_full ILIKE ${n} OR cp.bin ILIKE ${n})`);
  }
  if (filter.executorId) {
    if (!/^[0-9a-f-]{36}$/i.test(filter.executorId)) return [];
    params.push(filter.executorId);
    const n = `$${params.length}::uuid`;
    where.push(`(ru.id = ${n} OR eu.id = ${n})`);
  }
  if (filter.unassigned) {
    where.push(`r.closed_at IS NULL AND r.stage_code <> 'draft' AND (ru.id IS NULL OR eu.id IS NULL)`);
  }

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
  facilityId: string | null;
  branchId: string | null;
  facilityAddress?: string | null;
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
    // Дата регистрации вычисляется в коде: повторное использование одного
    // параметра и как значения колонки, и в сравнении не даёт PostgreSQL
    // вывести его тип («inconsistent types deduced for parameter»).
    const isDraft = data.stageCode === 'draft';
    // Регистрация автоматическая (п. 6): номер заявки — регистрационный номер, дата — день подачи.
    // Канцелярия подтверждает регистрацию переходом на оценку ТВ и при необходимости исправляет реквизиты.
    const created = await t.one<{ id: string }>(
      `INSERT INTO requests (number, counterparty_id, facility_id, branch_id, created_by,
                             stage_code, customer_status, free_of_charge, total_amount, registered_at,
                             facility_address, incoming_number, incoming_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [number, data.counterpartyId, data.facilityId, data.branchId, data.createdBy,
       data.stageCode, isDraft ? 'draft' : 'registered',
       data.freeOfCharge, data.totalAmount, isDraft ? null : new Date().toISOString(),
       data.facilityAddress?.trim() || null,
       isDraft ? null : number, isDraft ? null : today()],
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
    enteredAt: iso(row.entered_at)!,
    leftAt: null,
    dueAt: iso(row.due_at),
    slaValue: row.sla_value,
    slaUnit: row.sla_unit,
    ownerParty: row.owner_party,
    extendedBy: row.extended_by,
    extensionReason: row.extension_reason,
    escalationLevel: row.escalation_level,
    breached: row.breached,
    pausedAt: iso(row.paused_at),
    pausedDays: row.paused_days ?? 0,
    pauseReason: row.pause_reason ?? null,
  } as StageRecord & { pausedAt: string | null; pausedDays: number; pauseReason: string | null };
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

/**
 * Изменение реквизитов заявки без смены этапа, с проверкой версии.
 * Ключи задаёт код маршрута, а не клиент: значения передаются параметрами.
 */
export async function updateRequestFields(
  db: Db, requestId: string, version: number, patch: Record<string, unknown>,
): Promise<boolean> {
  const sets = ['version = version + 1', 'updated_at = now()'];
  const params: unknown[] = [requestId, version];
  for (const [key, value] of Object.entries(patch)) {
    if (!/^[a-z_]+$/.test(key)) throw new Error(`Недопустимое поле: ${key}`);
    params.push(value);
    sets.push(`${key} = $${params.length}`);
  }
  const rows = await db.query(
    `UPDATE requests SET ${sets.join(', ')} WHERE id = $1 AND version = $2 RETURNING id`,
    params as never);
  return rows.length > 0;
}

/** Продление срока открытого этапа (пп. 33, 45). */
export async function saveExtension(
  db: Db, requestId: string, dueAt: string, extendedBy: number, reason: string,
): Promise<void> {
  await db.query(
    `UPDATE request_stages SET due_at = $2, extended_by = $3, extension_reason = $4
      WHERE request_id = $1 AND left_at IS NULL`, [requestId, dueAt, extendedBy, reason]);
}

export function stageHistory(db: Db, requestId: string) {
  return db.query(
    `SELECT stage_code, entered_at, left_at, due_at, sla_value, sla_unit, owner_party,
            extended_by, extension_reason, escalation_level, breached
       FROM request_stages WHERE request_id = $1
      -- Даты входа совпадают, если этапы пройдены в один день: открытый этап — последним.
      ORDER BY entered_at, left_at IS NULL, left_at`, [requestId]);
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

/** Открытые замечания заявки. */
export function openRemarks(db: Db, requestId: string) {
  return db.query<{ id: string; field_key: string; text: string; created_by: string }>(
    `SELECT id, field_key, text, created_by FROM request_remarks
      WHERE request_id = $1 AND resolved_at IS NULL ORDER BY created_at`, [requestId]);
}

/** Снятие конкретных замечаний: исправлено поле либо ОР ПСД сняло замечание вручную. */
export async function resolveRemarkIds(db: Db, requestId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const rows = await db.query(
    `UPDATE request_remarks SET resolved_at = now()
      WHERE request_id = $1 AND id = ANY($2::uuid[]) AND resolved_at IS NULL RETURNING id`,
    [requestId, ids]);
  return rows.length;
}

/** Замена состава услуг исправленной заявки (ТЗ №11): номер и история сохраняются. */
export async function replaceRequestServices(
  db: Db, requestId: string, services: NewRequest['services'],
): Promise<void> {
  await db.query('DELETE FROM request_services WHERE request_id = $1', [requestId]);
  for (const s of services) {
    await db.query(
      `INSERT INTO request_services (request_id, service, placement, params, tariff_id,
                                     tariff_quantity, amount, basis_reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [requestId, s.service, s.placement, JSON.stringify(s.params ?? {}), s.tariffId ?? null,
       s.tariffQuantity ?? null, s.amount ?? null, s.basisReference ?? null]);
  }
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
