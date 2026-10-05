/**
 * Доступ к данным портала допусков.
 *
 * Работники, удостоверения, транспорт и бригады принадлежат организации:
 * каждый запрос ограничен её идентификатором. Состав заявки хранится снимком —
 * правка работника после отправки заявку не меняет.
 */

import type { Db } from '../../db/client.ts';
import { pickPermits } from '../../db/executors.ts';
import type { StoredFile } from '../../storage/files.ts';
import { normalizeModes } from '../domain/basis.ts';
import type { BasisModes, BasisRecord, BasisType } from '../domain/basis.ts';
import type { DocumentKind, WorkerDocument, WorkerForCheck } from '../domain/request.ts';
import { normalizeCisDays, normalizeRules } from '../domain/rules.ts';
import type { PermitRules, WorkType } from '../domain/rules.ts';

export const MODES_KEY = 'permits.basis_mode';
export const RULES_KEY = 'permits.rules';
export const CIS_KEY = 'permits.cis_stay_days';

export async function getRules(db: Db): Promise<PermitRules> {
  const row = await db.one<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [RULES_KEY]);
  return normalizeRules(row?.value);
}

export async function getCisDays(db: Db): Promise<Record<string, number>> {
  const row = await db.one<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [CIS_KEY]);
  return normalizeCisDays(row?.value);
}

export async function setSetting(db: Db, key: string, value: unknown, description: string, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value, description, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, $4, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), description, userId]);
}

export async function getModes(db: Db): Promise<BasisModes> {
  const row = await db.one<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [MODES_KEY]);
  return normalizeModes(row?.value);
}

export async function setModes(db: Db, modes: BasisModes, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value, description, updated_by, updated_at)
     VALUES ($1, $2::jsonb, 'Портал допусков: режим проверки основания по типам', $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [MODES_KEY, JSON.stringify(modes), userId]);
}

/* --------------------------------- файлы --------------------------------- */

export type PermitFile = {
  id: string; counterparty_id: string; kind: 'qualification' | 'basis' | 'pass' | 'letter' | 'passport' | 'visa';
  storage_key: string; file_name: string; mime: string; size_bytes: number; sha256: string;
};

export async function createFile(
  db: Db, counterpartyId: string, kind: PermitFile['kind'], saved: StoredFile, userId: string,
): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO permit_files (counterparty_id, kind, storage_key, file_name, mime, size_bytes, sha256, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [counterpartyId, kind, saved.key, saved.fileName, saved.mime, saved.size, saved.sha256, userId]);
  return row!.id;
}

export function getFile(db: Db, id: string) {
  return db.one<PermitFile>(`SELECT * FROM permit_files WHERE id = $1`, [id]);
}

/* ------------------------------- работники ------------------------------- */

/** Сведения о работнике по Приложению 1 Инструкции. */
export type WorkerPersonal = {
  full_name_latin: string; birth_date: string | null; birth_place: string; citizenship: string;
  id_doc_number: string; id_doc_issued_at: string | null; id_doc_issued_by: string; address: string; employer: string;
};

export type WorkerRow = WorkerPersonal & {
  id: string; full_name: string; iin: string | null; position: string; is_active: boolean;
  documents: (WorkerDocument & { id: string; fileName: string | null })[];
};

const WORKER_SELECT = `
  SELECT w.id, w.full_name, w.iin, w.position, w.is_active, w.full_name_latin, w.birth_date::text AS birth_date,
         w.birth_place, w.citizenship, w.id_doc_number, w.id_doc_issued_at::text AS id_doc_issued_at,
         w.id_doc_issued_by, w.address, w.employer,
         coalesce(json_agg(json_build_object(
           'id', d.id, 'kind', d.kind, 'title', d.title, 'number', d.number, 'validUntil', d.valid_until::text,
           'fileId', d.file_id, 'fileName', f.file_name) ORDER BY d.kind, d.valid_until)
           FILTER (WHERE d.id IS NOT NULL), '[]') AS documents
    FROM contractor_workers w
    LEFT JOIN worker_documents d ON d.worker_id = w.id
    LEFT JOIN permit_files f ON f.id = d.file_id`;

export function listWorkers(db: Db, counterpartyId: string, includeInactive = false) {
  return db.query<WorkerRow>(
    `${WORKER_SELECT}
      WHERE w.counterparty_id = $1 AND ($2 OR w.is_active)
      GROUP BY w.id ORDER BY w.full_name`, [counterpartyId, includeInactive]);
}

export async function workersByIds(db: Db, counterpartyId: string, ids: string[]): Promise<WorkerRow[]> {
  if (!ids.length) return [];
  const rows = await db.query<WorkerRow>(
    `${WORKER_SELECT}
      WHERE w.counterparty_id = $1 AND w.id = ANY($2::uuid[]) AND w.is_active
      GROUP BY w.id`, [counterpartyId, ids]);
  // Порядок — как выбрал подрядчик.
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is WorkerRow => !!r);
}

export function getWorker(db: Db, id: string) {
  return db.one<{ id: string; counterparty_id: string; full_name: string; iin: string | null; is_active: boolean }>(
    `SELECT id, counterparty_id, full_name, iin, is_active FROM contractor_workers WHERE id = $1`, [id]);
}

export type WorkerInput = {
  id?: string | null; fullName: string; iin: string | null; position: string; fullNameLatin: string;
  birthDate: string | null; birthPlace: string; citizenship: string; idDocNumber: string; idDocIssuedAt: string | null;
  idDocIssuedBy: string; address: string; employer: string;
};

export async function saveWorker(db: Db, counterpartyId: string, w: WorkerInput, userId: string): Promise<string> {
  const values = [w.fullName, w.iin, w.position, w.fullNameLatin, w.birthDate, w.birthPlace, w.citizenship,
    w.idDocNumber, w.idDocIssuedAt, w.idDocIssuedBy, w.address, w.employer];
  const set = `full_name = $3, iin = $4, position = $5, full_name_latin = $6, birth_date = $7, birth_place = $8,
    citizenship = $9, id_doc_number = $10, id_doc_issued_at = $11, id_doc_issued_by = $12, address = $13,
    employer = $14, is_active = true, updated_at = now()`;
  // Работник с тем же ИИН (у иностранца — с тем же паспортом) уже есть: обновляем его, а не заводим двойника.
  const existing = w.id ? { id: w.id } : await db.one<{ id: string }>(
    w.iin
      ? `SELECT id FROM contractor_workers WHERE counterparty_id = $1 AND iin = $2`
      : `SELECT id FROM contractor_workers WHERE counterparty_id = $1 AND iin IS NULL AND citizenship = $3 AND id_doc_number = $2`,
    w.iin ? [counterpartyId, w.iin] : [counterpartyId, w.idDocNumber, w.citizenship]);
  if (existing) {
    const row = await db.one<{ id: string }>(
      `UPDATE contractor_workers SET ${set} WHERE id = $1 AND counterparty_id = $2 RETURNING id`,
      [existing.id, counterpartyId, ...values]);
    return row?.id ?? '';
  }
  const row = await db.one<{ id: string }>(
    `INSERT INTO contractor_workers (counterparty_id, full_name, iin, position, full_name_latin, birth_date, birth_place,
       citizenship, id_doc_number, id_doc_issued_at, id_doc_issued_by, address, employer, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`, [counterpartyId, ...values, userId]);
  return row!.id;
}

export async function setWorkerActive(db: Db, counterpartyId: string, id: string, active: boolean): Promise<boolean> {
  const rows = await db.query(
    `UPDATE contractor_workers SET is_active = $3, updated_at = now() WHERE id = $1 AND counterparty_id = $2 RETURNING id`,
    [id, counterpartyId, active]);
  if (!active) await db.query(`DELETE FROM crew_members WHERE worker_id = $1`, [id]);
  return rows.length > 0;
}

export async function addWorkerDocument(
  db: Db, workerId: string, d: { kind: DocumentKind; title: string; number: string; validUntil: string; fileId: string }, userId: string,
): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO worker_documents (worker_id, kind, title, number, valid_until, file_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [workerId, d.kind, d.title, d.number, d.validUntil, d.fileId, userId]);
  return row!.id;
}

/** Обновление удостоверения: новый срок и, если приложен, новый скан. */
export async function updateWorkerDocument(
  db: Db, workerId: string, id: string, d: { title: string; number: string; validUntil: string; fileId: string | null },
): Promise<boolean> {
  const rows = await db.query(
    `UPDATE worker_documents SET title = $3, number = $4, valid_until = $5, file_id = coalesce($6, file_id), updated_at = now()
      WHERE id = $1 AND worker_id = $2 RETURNING id`, [id, workerId, d.title, d.number, d.validUntil, d.fileId]);
  return rows.length > 0;
}

export async function deleteWorkerDocument(db: Db, workerId: string, id: string): Promise<boolean> {
  const rows = await db.query(`DELETE FROM worker_documents WHERE id = $1 AND worker_id = $2 RETURNING id`, [id, workerId]);
  return rows.length > 0;
}

/* ------------------------------- транспорт ------------------------------- */

export type VehicleRow = { id: string; plate: string; model: string; driver_name: string; is_active: boolean };

export function listVehicles(db: Db, counterpartyId: string) {
  return db.query<VehicleRow>(
    `SELECT id, plate, model, driver_name, is_active FROM contractor_vehicles
      WHERE counterparty_id = $1 AND is_active ORDER BY plate`, [counterpartyId]);
}

export async function vehiclesByIds(db: Db, counterpartyId: string, ids: string[]): Promise<VehicleRow[]> {
  if (!ids.length) return [];
  const rows = await db.query<VehicleRow>(
    `SELECT id, plate, model, driver_name, is_active FROM contractor_vehicles
      WHERE counterparty_id = $1 AND id = ANY($2::uuid[]) AND is_active`, [counterpartyId, ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is VehicleRow => !!r);
}

export async function saveVehicle(
  db: Db, counterpartyId: string, v: { id?: string | null; plate: string; model: string; driverName: string }, userId: string,
): Promise<string> {
  if (v.id) {
    const row = await db.one<{ id: string }>(
      `UPDATE contractor_vehicles SET plate = $3, model = $4, driver_name = $5, is_active = true
        WHERE id = $1 AND counterparty_id = $2 RETURNING id`, [v.id, counterpartyId, v.plate, v.model, v.driverName]);
    return row?.id ?? '';
  }
  const row = await db.one<{ id: string }>(
    `INSERT INTO contractor_vehicles (counterparty_id, plate, model, driver_name, created_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (counterparty_id, plate) DO UPDATE
       SET model = EXCLUDED.model, driver_name = EXCLUDED.driver_name, is_active = true
     RETURNING id`, [counterpartyId, v.plate, v.model, v.driverName, userId]);
  return row!.id;
}

export async function deactivateVehicle(db: Db, counterpartyId: string, id: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE contractor_vehicles SET is_active = false WHERE id = $1 AND counterparty_id = $2 RETURNING id`,
    [id, counterpartyId]);
  await db.query(`DELETE FROM crew_vehicles WHERE vehicle_id = $1`, [id]);
  return rows.length > 0;
}

/* -------------------------------- бригады -------------------------------- */

export type CrewRow = { id: string; name: string; worker_ids: string[]; vehicle_ids: string[]; updated_at: string };

export function listCrews(db: Db, counterpartyId: string) {
  return db.query<CrewRow>(
    `SELECT c.id, c.name, c.updated_at,
            coalesce(array_agg(DISTINCT m.worker_id) FILTER (WHERE m.worker_id IS NOT NULL), '{}') AS worker_ids,
            coalesce(array_agg(DISTINCT v.vehicle_id) FILTER (WHERE v.vehicle_id IS NOT NULL), '{}') AS vehicle_ids
       FROM contractor_crews c
       LEFT JOIN crew_members m ON m.crew_id = c.id
       LEFT JOIN crew_vehicles v ON v.crew_id = c.id
      WHERE c.counterparty_id = $1
      GROUP BY c.id ORDER BY c.name`, [counterpartyId]);
}

export async function saveCrew(
  db: Db, counterpartyId: string, c: { id?: string | null; name: string; workerIds: string[]; vehicleIds: string[] }, userId: string,
): Promise<string> {
  let id = c.id ?? '';
  if (id) {
    const row = await db.one<{ id: string }>(
      `UPDATE contractor_crews SET name = $3, updated_at = now() WHERE id = $1 AND counterparty_id = $2 RETURNING id`,
      [id, counterpartyId, c.name]);
    if (!row) return '';
  } else {
    id = (await db.one<{ id: string }>(
      `INSERT INTO contractor_crews (counterparty_id, name, created_by) VALUES ($1,$2,$3) RETURNING id`,
      [counterpartyId, c.name, userId]))!.id;
  }
  await db.query(`DELETE FROM crew_members WHERE crew_id = $1`, [id]);
  await db.query(`DELETE FROM crew_vehicles WHERE crew_id = $1`, [id]);
  // Только свои действующие работники и транспорт: чужие идентификаторы отбрасываются запросом.
  await db.query(
    `INSERT INTO crew_members (crew_id, worker_id)
     SELECT $1, w.id FROM contractor_workers w WHERE w.counterparty_id = $2 AND w.is_active AND w.id = ANY($3::uuid[])`,
    [id, counterpartyId, c.workerIds]);
  await db.query(
    `INSERT INTO crew_vehicles (crew_id, vehicle_id)
     SELECT $1, v.id FROM contractor_vehicles v WHERE v.counterparty_id = $2 AND v.is_active AND v.id = ANY($3::uuid[])`,
    [id, counterpartyId, c.vehicleIds]);
  return id;
}

export async function deleteCrew(db: Db, counterpartyId: string, id: string): Promise<boolean> {
  const rows = await db.query(`DELETE FROM contractor_crews WHERE id = $1 AND counterparty_id = $2 RETURNING id`,
    [id, counterpartyId]);
  return rows.length > 0;
}

/* ------------------------------- основания ------------------------------- */

/** Организация по БИН — владелец оборудования, если заявку подаёт его подрядчик. */
export async function counterpartyByBin(db: Db, bin: string): Promise<{ id: string; name_full: string } | null> {
  if (!/^\d{12}$/.test(bin)) return null;
  return db.one(`SELECT id, name_full FROM counterparties WHERE bin = $1`, [bin]);
}

/**
 * Поиск основания в реестрах системы: по выбранной записи либо по номеру.
 * Номер ищется среди записей организации-владельца, а если там нет — среди всех,
 * чтобы сообщить, что основание оформлено на другую организацию.
 */
export async function findBasis(
  db: Db, type: BasisType, q: { id?: string | null; number: string; counterpartyId: string; facilityId: string | null },
): Promise<BasisRecord | null> {
  const number = q.number.trim();
  if (type === 'lease') {
    const row = await db.one<Record<string, any>>(
      `SELECT l.id, l.number, l.counterparty_id,
              (SELECT lf.facility_id FROM lease_contract_facilities lf WHERE lf.lease_id = l.id
                ORDER BY (lf.facility_id = $4) DESC LIMIT 1) AS facility_id,
              true AS approved, l.status = 'terminated' AS terminated, l.valid_until::text AS valid_until
         FROM lease_contracts l
        WHERE (($1::uuid IS NOT NULL AND l.id = $1) OR ($1::uuid IS NULL AND lower(l.number) = lower($2)))
        ORDER BY (l.counterparty_id = $3) DESC, l.valid_until DESC LIMIT 1`,
      [q.id ?? null, number, q.counterpartyId, q.facilityId]);
    if (!row) return null;
    // Договор без привязки к объектам действует для всех объектов организации.
    const bound = await db.one(`SELECT 1 FROM lease_contract_facilities WHERE lease_id = $1`, [row.id]);
    return toRecord({ ...row, facility_id: bound ? row.facility_id : null });
  }
  if (type === 'smr_contract') {
    const row = await db.one<Record<string, any>>(
      `SELECT id, number, counterparty_id, NULL::uuid AS facility_id,
              status IN ('signed','paid','executed') AS approved, status = 'terminated' AS terminated,
              valid_until::text AS valid_until
         FROM contracts
        WHERE (service = 'СМР' OR service IS NULL)
          AND (($1::uuid IS NOT NULL AND id = $1) OR ($1::uuid IS NULL AND lower(number) = lower($2)))
        ORDER BY (counterparty_id = $3) DESC, created_at DESC LIMIT 1`, [q.id ?? null, number, q.counterpartyId]);
    return row ? toRecord(row) : null;
  }
  const kind = type === 'tu' ? 'ТУ' : type === 'order' ? 'Распоряжение' : 'Акт приема-передачи';
  const row = await db.one<Record<string, any>>(
    `SELECT d.id, d.number, coalesce(d.owner_id, r.counterparty_id) AS counterparty_id, d.facility_id,
            d.approved, false AS terminated, d.valid_until::text AS valid_until, d.doc_date::text AS doc_date
       FROM documents d
       LEFT JOIN requests r ON r.id = d.request_id
      WHERE d.kind = $1
        AND (($2::uuid IS NOT NULL AND d.id = $2) OR ($2::uuid IS NULL AND lower(d.number) = lower($3)))
      ORDER BY (coalesce(d.owner_id, r.counterparty_id) = $4) DESC,
               ($5::uuid IS NOT NULL AND d.facility_id = $5) DESC, d.approved DESC, d.doc_date DESC
      LIMIT 1`, [kind, q.id ?? null, number, q.counterpartyId, q.facilityId]);
  return row ? toRecord(row) : null;
}

function toRecord(row: Record<string, any>): BasisRecord {
  return {
    id: row.id, number: row.number, counterpartyId: row.counterparty_id ?? null, facilityId: row.facility_id ?? null,
    approved: !!row.approved, terminated: !!row.terminated, validUntil: row.valid_until ?? null,
  };
}

/** Основания организации для выбора в мастере: номер — не свободный текст (ТЗ портала §4.2). */
export async function basisOptions(db: Db, counterpartyId: string, facilityId: string | null) {
  const [tu, contracts, acts, leases] = await Promise.all([
    db.query(
      `SELECT d.id, d.number, d.doc_date::text AS doc_date, d.valid_until::text AS valid_until, d.approved,
              d.facility_id, f.name AS facility_name
         FROM documents d
         LEFT JOIN requests r ON r.id = d.request_id
         LEFT JOIN facilities f ON f.id = d.facility_id
        WHERE d.kind = 'ТУ' AND coalesce(d.owner_id, r.counterparty_id) = $1
        ORDER BY d.doc_date DESC LIMIT 200`, [counterpartyId]),
    db.query(
      `SELECT c.id, c.number, c.signed_at::text AS doc_date, c.valid_until::text AS valid_until, c.status,
              c.status IN ('signed','paid','executed') AS approved
         FROM contracts c
        WHERE c.counterparty_id = $1 AND (c.service = 'СМР' OR c.service IS NULL)
        ORDER BY c.created_at DESC LIMIT 200`, [counterpartyId]),
    db.query(
      `SELECT d.id, d.number, d.doc_date::text AS doc_date, d.approved, d.facility_id, f.name AS facility_name
         FROM documents d
         LEFT JOIN requests r ON r.id = d.request_id
         LEFT JOIN facilities f ON f.id = d.facility_id
        WHERE d.kind = 'Акт приема-передачи' AND coalesce(d.owner_id, r.counterparty_id) = $1
          AND ($2::uuid IS NULL OR d.facility_id = $2)
        ORDER BY d.doc_date DESC LIMIT 200`, [counterpartyId, facilityId]),
    db.query(
      `SELECT l.id, l.number, l.contract_date::text AS doc_date, l.valid_until::text AS valid_until,
              l.status <> 'terminated' AS approved,
              (SELECT string_agg(f.name, ', ') FROM lease_contract_facilities lf JOIN facilities f ON f.id = lf.facility_id
                WHERE lf.lease_id = l.id) AS facility_name
         FROM lease_contracts l
        WHERE l.counterparty_id = $1 AND l.status = 'active'
          AND ($2::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM lease_contract_facilities x WHERE x.lease_id = l.id)
               OR EXISTS (SELECT 1 FROM lease_contract_facilities x WHERE x.lease_id = l.id AND x.facility_id = $2))
        ORDER BY l.valid_until DESC LIMIT 200`, [counterpartyId, facilityId]),
  ]);
  return { tu, smr_contract: contracts, transfer_act: acts, lease: leases, order: [] };
}

/* ---------------------------- заявки на допуск ---------------------------- */

export type AccessStatus = 'draft' | 'pending_review' | 'approved' | 'rejected' | 'withdrawn' | 'revoked' | 'closed';
export type BranchApproval = 'not_required' | 'pending' | 'approved' | 'rejected';

export type AccessRequestRow = {
  id: string; number: string; status: AccessStatus;
  counterparty_id: string; counterparty_name: string; counterparty_bin: string; counterparty_status: string;
  facility_id: string | null; facility_name: string | null; facility_inv_no: string | null; facility_address: string | null;
  facility_kind: string | null;
  branch_id: string | null; branch_name: string | null;
  work_type: WorkType | null; on_ams: boolean; work_hours_from: string; work_hours_to: string; weekend_work: boolean;
  owner_bin: string; owner_name: string;
  basis_type: BasisType | null; basis_number: string; basis_document_id: string | null; basis_contract_id: string | null;
  basis_lease_id: string | null; basis_date: string | null; basis_valid_until: string | null;
  basis_file_id: string | null; basis_file_name: string | null; basis_check: Record<string, any>;
  basis_confirmed_at: string | null; basis_confirmed_by_name: string | null; basis_confirm_note: string | null;
  letter_number: string; letter_date: string | null; signatory_name: string; signatory_position: string;
  letter_file_id: string | null; letter_file_name: string | null;
  description: string; period_start: string | null; period_end: string | null; is_urgent: boolean;
  crew_id: string | null; pass_file_id: string | null; pass_file_name: string | null;
  rejection_reason: string | null; reviewed_at: string | null; reviewed_by_name: string | null;
  pd_consent_at: string | null; submitted_at: string | null; created_at: string; updated_at: string;
  created_by: string; created_by_name: string | null; version: number;
  assignee_id: string | null; assignee_name: string | null; review_due_at: string | null;
  branch_approval: BranchApproval; branch_reasons: string[]; branch_approver_id: string | null;
  branch_approver_name: string | null; branch_due_at: string | null; branch_decided_at: string | null;
  branch_decided_by_name: string | null; branch_channel: string | null; branch_note: string | null;
  provisional: boolean; followup_due_at: string | null; followup_done_at: string | null;
  permit_code: string | null; permit_issued_at: string | null;
  site_officer_id: string | null; site_officer_name: string | null;
  revoke_reason: string | null; revoked_at: string | null; closed_at: string | null; close_note: string | null;
  closed_by_name: string | null;
  extends_request_id: string | null; extends_number: string | null;
  workers_count: number; vehicles_count: number;
};

const REQUEST_SELECT = `
  SELECT a.id, a.number, a.status, a.counterparty_id, c.name_full AS counterparty_name, c.bin AS counterparty_bin,
         c.status AS counterparty_status,
         a.facility_id, f.name AS facility_name, f.inv_no AS facility_inv_no, f.address AS facility_address,
         f.kind AS facility_kind, a.branch_id, b.name AS branch_name,
         a.work_type, a.on_ams, to_char(a.work_hours_from, 'HH24:MI') AS work_hours_from,
         to_char(a.work_hours_to, 'HH24:MI') AS work_hours_to, a.weekend_work, a.owner_bin, a.owner_name,
         a.basis_type, a.basis_number, a.basis_document_id, a.basis_contract_id, a.basis_lease_id,
         a.basis_date::text AS basis_date, a.basis_valid_until::text AS basis_valid_until, a.basis_file_id,
         bf.file_name AS basis_file_name, a.basis_check, a.basis_confirmed_at, bc.full_name AS basis_confirmed_by_name,
         a.basis_confirm_note, a.letter_number, a.letter_date::text AS letter_date, a.signatory_name,
         a.signatory_position, a.letter_file_id, lf.file_name AS letter_file_name, a.description,
         to_char(a.period_start, 'YYYY-MM-DD"T"HH24:MI') AS period_start,
         to_char(a.period_end, 'YYYY-MM-DD"T"HH24:MI') AS period_end,
         a.is_urgent, a.crew_id, a.pass_file_id, pf.file_name AS pass_file_name,
         a.rejection_reason, a.reviewed_at, rv.full_name AS reviewed_by_name,
         a.pd_consent_at, a.submitted_at, a.created_at, a.updated_at, a.created_by, cu.full_name AS created_by_name,
         a.version, a.assignee_id, asg.full_name AS assignee_name, a.review_due_at::text AS review_due_at,
         a.branch_approval, a.branch_reasons, a.branch_approver_id, ba.full_name AS branch_approver_name,
         a.branch_due_at::text AS branch_due_at, a.branch_decided_at, bd.full_name AS branch_decided_by_name,
         a.branch_channel, a.branch_note, a.provisional, a.followup_due_at, a.followup_done_at,
         a.permit_code, a.permit_issued_at, a.site_officer_id, so.full_name AS site_officer_name,
         a.revoke_reason, a.revoked_at, a.closed_at, a.close_note, cl.full_name AS closed_by_name,
         a.extends_request_id, ext.number AS extends_number,
         (SELECT count(*)::int FROM access_request_workers w WHERE w.request_id = a.id) AS workers_count,
         (SELECT count(*)::int FROM access_request_vehicles v WHERE v.request_id = a.id) AS vehicles_count
    FROM access_requests a
    JOIN counterparties c ON c.id = a.counterparty_id
    LEFT JOIN facilities f ON f.id = a.facility_id
    LEFT JOIN branches b ON b.id = a.branch_id
    LEFT JOIN permit_files bf ON bf.id = a.basis_file_id
    LEFT JOIN permit_files pf ON pf.id = a.pass_file_id
    LEFT JOIN permit_files lf ON lf.id = a.letter_file_id
    LEFT JOIN users bc ON bc.id = a.basis_confirmed_by
    LEFT JOIN users rv ON rv.id = a.reviewed_by
    LEFT JOIN users cu ON cu.id = a.created_by
    LEFT JOIN users asg ON asg.id = a.assignee_id AND asg.is_active
    LEFT JOIN users ba ON ba.id = a.branch_approver_id
    LEFT JOIN users bd ON bd.id = a.branch_decided_by
    LEFT JOIN users so ON so.id = a.site_officer_id
    LEFT JOIN users cl ON cl.id = a.closed_by
    LEFT JOIN access_requests ext ON ext.id = a.extends_request_id`;

export function getRequest(db: Db, idOrNumber: string) {
  const byId = /^[0-9a-f-]{36}$/i.test(idOrNumber);
  return db.one<AccessRequestRow>(`${REQUEST_SELECT} WHERE ${byId ? 'a.id = $1::uuid' : 'a.number = $1'}`, [idOrNumber]);
}

export type RequestFilter = {
  counterpartyId?: string | null;
  status?: string | null;
  q?: string | null;
  facilityId?: string | null;
  branchId?: string | null;
  urgent?: boolean | null;
  workType?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  /** Очередь СУА: сначала срочные, затем по времени отправки. */
  queue?: boolean;
  /** Ждут согласования этого руководителя филиала (или замещаемого им). */
  branchApprovers?: string[] | null;
  /** Допуски, действующие на дату (ГГГГ-ММ-ДД): реестр действующих и проверка на объекте. */
  activeOn?: string | null;
  limit?: number;
};

export function listRequests(db: Db, f: RequestFilter) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (f.counterpartyId) add('a.counterparty_id = ?', f.counterpartyId);
  // Черновик — рабочее место подрядчика: сотрудники Общества видят заявку с момента отправки.
  else where.push(`a.status <> 'draft'`);
  if (f.queue) where.push(`a.status = 'pending_review'`);
  else if (f.status) add('a.status = ?', f.status);
  if (f.branchApprovers) add(`a.branch_approval = 'pending' AND a.status = 'pending_review' AND a.branch_approver_id = ANY(?::uuid[])`, f.branchApprovers);
  if (f.activeOn) {
    add(`a.status = 'approved' AND a.period_start::date <= ?::date AND a.period_end::date >= ?::date`, f.activeOn);
  }
  if (f.facilityId) add('a.facility_id = ?', f.facilityId);
  if (f.branchId) add('a.branch_id = ?', f.branchId);
  if (f.workType) add('a.work_type = ?', f.workType);
  if (f.urgent === true) where.push('a.is_urgent');
  if (f.dateFrom) add(`coalesce(a.submitted_at, a.created_at) >= ?::date`, f.dateFrom);
  if (f.dateTo) add(`coalesce(a.submitted_at, a.created_at) < ?::date + 1`, f.dateTo);
  if (f.q) {
    params.push(f.q);
    const p = `$${params.length}`;
    where.push(`(a.number ILIKE '%' || ${p} || '%' OR c.name_full ILIKE '%' || ${p} || '%'
          OR c.bin LIKE ${p} || '%' OR f.name ILIKE '%' || ${p} || '%' OR a.basis_number ILIKE '%' || ${p} || '%'
          OR a.permit_code = upper(${p})
          OR EXISTS (SELECT 1 FROM access_request_workers w WHERE w.request_id = a.id
                      AND (w.full_name ILIKE '%' || ${p} || '%' OR w.iin = ${p})))`);
  }
  params.push(Math.min(Math.max(Number(f.limit) || 300, 1), 2000));
  const order = f.queue ? 'a.is_urgent DESC, a.submitted_at ASC'
    : f.activeOn ? 'f.name, a.period_start' : 'coalesce(a.submitted_at, a.created_at) DESC';
  return db.query<AccessRequestRow>(
    `${REQUEST_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT $${params.length}`,
    params as never[]);
}

export async function nextNumber(db: Db, year = new Date().getFullYear()): Promise<string> {
  const row = await db.one<{ last: number }>(
    `INSERT INTO access_request_counters (year, last) VALUES ($1, 1)
     ON CONFLICT (year) DO UPDATE SET last = access_request_counters.last + 1
     RETURNING last`, [year]);
  return `ЗД-${year}-${String(row!.last).padStart(4, '0')}`;
}

export type DraftFields = {
  workType: WorkType | null;
  onAms: boolean;
  workHoursFrom: string;
  workHoursTo: string;
  weekendWork: boolean;
  ownerBin: string;
  ownerName: string;
  facilityId: string | null;
  branchId: string | null;
  basisType: BasisType | null;
  basisNumber: string;
  basisDocumentId: string | null;
  basisContractId: string | null;
  basisLeaseId: string | null;
  basisDate: string | null;
  basisValidUntil: string | null;
  letterNumber: string;
  letterDate: string | null;
  signatoryName: string;
  signatoryPosition: string;
  description: string;
  periodStart: string | null;
  periodEnd: string | null;
  isUrgent: boolean;
  crewId: string | null;
  extendsRequestId?: string | null;
};

const DRAFT_COLUMNS = [
  'work_type', 'on_ams', 'work_hours_from', 'work_hours_to', 'weekend_work', 'owner_bin', 'owner_name', 'facility_id',
  'branch_id', 'basis_type', 'basis_number', 'basis_document_id', 'basis_contract_id', 'basis_lease_id', 'basis_date',
  'basis_valid_until', 'letter_number', 'letter_date', 'signatory_name', 'signatory_position', 'description',
  'period_start', 'period_end', 'is_urgent', 'crew_id',
];

const draftValues = (d: DraftFields) => [
  d.workType, d.onAms, d.workHoursFrom, d.workHoursTo, d.weekendWork, d.ownerBin, d.ownerName, d.facilityId,
  d.branchId, d.basisType, d.basisNumber, d.basisDocumentId, d.basisContractId, d.basisLeaseId, d.basisDate,
  d.basisValidUntil, d.letterNumber, d.letterDate, d.signatoryName, d.signatoryPosition, d.description,
  d.periodStart, d.periodEnd, d.isUrgent, d.crewId,
];

export async function createDraft(db: Db, counterpartyId: string, d: DraftFields, userId: string): Promise<string> {
  const number = await nextNumber(db);
  const columns = ['number', 'counterparty_id', 'created_by', 'extends_request_id', ...DRAFT_COLUMNS];
  const values = [number, counterpartyId, userId, d.extendsRequestId ?? null, ...draftValues(d)];
  const row = await db.one<{ id: string }>(
    `INSERT INTO access_requests (${columns.join(', ')})
     VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, values);
  return row!.id;
}

/** Правка черновика с проверкой версии: две вкладки не затирают друг друга. */
export async function updateDraft(db: Db, id: string, version: number, d: DraftFields): Promise<boolean> {
  const set = DRAFT_COLUMNS.map((c, i) => `${c} = $${i + 3}`).join(', ');
  const rows = await db.query(
    `UPDATE access_requests SET ${set}, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 AND status = 'draft' RETURNING id`, [id, version, ...draftValues(d)]);
  return rows.length > 0;
}

/** Снимок бригады и транспорта из текущих данных организации — со сведениями Приложения 1. */
export async function snapshotComposition(
  db: Db, requestId: string, workers: WorkerRow[], vehicles: VehicleRow[],
): Promise<void> {
  await db.query(`DELETE FROM access_request_workers WHERE request_id = $1`, [requestId]);
  await db.query(`DELETE FROM access_request_vehicles WHERE request_id = $1`, [requestId]);
  let i = 0;
  for (const w of workers) {
    const documents = w.documents.map((d) => ({
      id: d.id, kind: d.kind ?? 'qualification', title: d.title, number: d.number ?? '', validUntil: d.validUntil,
      fileId: d.fileId ?? null, fileName: d.fileName ?? null,
    }));
    const details: WorkerPersonal = {
      full_name_latin: w.full_name_latin, birth_date: w.birth_date, birth_place: w.birth_place, citizenship: w.citizenship,
      id_doc_number: w.id_doc_number, id_doc_issued_at: w.id_doc_issued_at, id_doc_issued_by: w.id_doc_issued_by,
      address: w.address, employer: w.employer,
    };
    await db.query(
      `INSERT INTO access_request_workers (request_id, worker_id, sort_order, full_name, iin, position, documents, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
      [requestId, w.id, i++, w.full_name, w.iin, w.position, JSON.stringify(documents), JSON.stringify(details)]);
  }
  i = 0;
  for (const v of vehicles) {
    await db.query(
      `INSERT INTO access_request_vehicles (request_id, vehicle_id, sort_order, plate, model, driver_name)
       VALUES ($1,$2,$3,$4,$5,$6)`, [requestId, v.id, i++, v.plate, v.model, v.driver_name]);
  }
}

export type CompositionWorker = {
  worker_id: string; full_name: string; iin: string | null; position: string; details: Partial<WorkerPersonal>;
  documents: { id: string; kind?: DocumentKind; title: string; number: string; validUntil: string; fileId: string | null; fileName: string | null }[];
};

export async function composition(db: Db, requestId: string) {
  const [workers, vehicles] = await Promise.all([
    db.query<CompositionWorker>(
      `SELECT worker_id, full_name, iin, position, documents, details FROM access_request_workers
        WHERE request_id = $1 ORDER BY sort_order`, [requestId]),
    db.query<{ vehicle_id: string; plate: string; model: string; driver_name: string }>(
      `SELECT vehicle_id, plate, model, driver_name FROM access_request_vehicles
        WHERE request_id = $1 ORDER BY sort_order`, [requestId]),
  ]);
  return { workers, vehicles };
}

export function toCheckWorkers(workers: CompositionWorker[]): WorkerForCheck[] {
  return workers.map((w) => ({
    id: w.worker_id, fullName: w.full_name, iin: w.iin, documents: w.documents,
    citizenship: w.details.citizenship ?? 'KZ', birthDate: w.details.birth_date ?? null,
    birthPlace: w.details.birth_place ?? '', idDocNumber: w.details.id_doc_number ?? '',
    idDocIssuedAt: w.details.id_doc_issued_at ?? null, idDocIssuedBy: w.details.id_doc_issued_by ?? '',
    address: w.details.address ?? '',
  }));
}

export async function setBasisFile(db: Db, id: string, fileId: string | null): Promise<void> {
  await db.query(`UPDATE access_requests SET basis_file_id = $2, version = version + 1, updated_at = now() WHERE id = $1`,
    [id, fileId]);
}

/** Скан подписанного запроса: в черновике, а при аварии — и после допуска (п. 18). */
export async function setLetterFile(db: Db, id: string, fileId: string | null): Promise<void> {
  await db.query(`UPDATE access_requests SET letter_file_id = $2, version = version + 1, updated_at = now() WHERE id = $1`,
    [id, fileId]);
}

/** Люди той же организации, уже допущенные на объект в пересекающийся период (п. 14 — не более 5 одновременно). */
export async function concurrentWorkers(
  db: Db, r: { id: string; counterparty_id: string; facility_id: string | null; period_start: string | null; period_end: string | null },
): Promise<number> {
  if (!r.facility_id || !r.period_start || !r.period_end) return 0;
  const row = await db.one<{ n: number }>(
    `SELECT count(DISTINCT w.worker_id)::int AS n
       FROM access_requests a JOIN access_request_workers w ON w.request_id = a.id
      WHERE a.counterparty_id = $1 AND a.facility_id = $2 AND a.status = 'approved' AND a.id <> $3
        AND a.period_start < $5::timestamp AND a.period_end > $4::timestamp
        AND w.worker_id NOT IN (SELECT worker_id FROM access_request_workers WHERE request_id = $3)`,
    [r.counterparty_id, r.facility_id, r.id, r.period_start, r.period_end]);
  return row?.n ?? 0;
}

export type SubmitPlan = {
  basisCheck: Record<string, unknown>;
  reviewDueAt: string;
  branchReasons: string[];
  branchApproverId: string | null;
  branchDueAt: string | null;
  emergency: boolean;
  followupDueAt: string | null;
  assigneeId: string | null;
};

export async function submit(db: Db, id: string, version: number, plan: SubmitPlan, userId: string): Promise<boolean> {
  const ref = (plan.basisCheck.reference as { id?: string } | null)?.id ?? null;
  const rows = await db.query(
    `UPDATE access_requests SET status = 'pending_review', submitted_at = now(), basis_check = $3::jsonb,
            basis_document_id = CASE WHEN basis_type IN ('tu','transfer_act','order') THEN $4::uuid ELSE NULL END,
            basis_contract_id = CASE WHEN basis_type = 'smr_contract' THEN $4::uuid ELSE NULL END,
            basis_lease_id = CASE WHEN basis_type = 'lease' THEN $4::uuid ELSE NULL END,
            pd_consent_by = $5, pd_consent_at = now(), version = version + 1, updated_at = now(),
            assignee_id = $6, review_due_at = $7::date,
            branch_approval = CASE WHEN jsonb_array_length($8::jsonb) > 0 THEN 'pending' ELSE 'not_required' END,
            branch_reasons = $8::jsonb, branch_approver_id = $9, branch_due_at = $10::date,
            is_urgent = is_urgent OR $11, followup_due_at = $12::timestamptz
      WHERE id = $1 AND version = $2 AND status = 'draft' RETURNING id`,
    [id, version, JSON.stringify(plan.basisCheck), ref, userId, plan.assigneeId, plan.reviewDueAt,
     JSON.stringify(plan.branchReasons), plan.branchApproverId, plan.branchDueAt, plan.emergency, plan.followupDueAt]);
  return rows.length > 0;
}

export async function confirmBasis(db: Db, id: string, version: number, note: string, userId: string,
  validUntil: string | null = null): Promise<boolean> {
  const rows = await db.query(
    `UPDATE access_requests SET basis_confirmed_by = $3, basis_confirmed_at = now(), basis_confirm_note = $4,
            basis_valid_until = coalesce($5::date, basis_valid_until), version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 AND status = 'pending_review' RETURNING id`, [id, version, userId, note, validUntil]);
  return rows.length > 0;
}

/** Решение руководства филиала: в системе, либо СУА фиксирует устное или письменное согласование. */
export async function decideBranch(
  db: Db, id: string, version: number, d: { approved: boolean; channel: 'system' | 'oral' | 'letter'; note: string }, userId: string,
): Promise<boolean> {
  const rows = await db.query(
    `UPDATE access_requests SET branch_approval = $3, branch_decided_by = $4, branch_decided_at = now(),
            branch_channel = $5, branch_note = $6, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 AND status = 'pending_review' AND branch_approval = 'pending' RETURNING id`,
    [id, version, d.approved ? 'approved' : 'rejected', userId, d.channel, d.note]);
  return rows.length > 0;
}

export async function setBranchApprover(db: Db, id: string, userId: string): Promise<void> {
  await db.query(`UPDATE access_requests SET branch_approver_id = $2 WHERE id = $1`, [id, userId]);
}

const permitCode = () => {
  // Без похожих символов (0/O, 1/I): код читают с бумаги и вводят вручную.
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
};

/**
 * Одобрение: электронный допуск с кодом проверки и ответственным лицом филиала.
 * Аварийный допуск по устному согласованию — предварительный: письменное
 * разрешение оформляется в течение 2 календарных дней (п. 18).
 */
export async function approve(
  db: Db, id: string, version: number, a: { passFileId: string | null; siteOfficerId: string | null; provisional: boolean;
    reviewed: boolean }, userId: string,
): Promise<boolean> {
  const rows = await db.query(
    `UPDATE access_requests SET status = 'approved', pass_file_id = coalesce($3, pass_file_id),
            reviewed_by = CASE WHEN $6 THEN $4::uuid ELSE reviewed_by END,
            reviewed_at = CASE WHEN $6 THEN now() ELSE reviewed_at END,
            permit_code = coalesce(permit_code, $7), permit_issued_at = coalesce(permit_issued_at, now()),
            site_officer_id = $5, provisional = $8,
            followup_done_at = CASE WHEN $8 THEN NULL ELSE followup_done_at END,
            version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 AND status = 'pending_review' RETURNING id`,
    [id, version, a.passFileId, userId, a.siteOfficerId, a.reviewed, permitCode(), a.provisional]);
  return rows.length > 0;
}

/** Аварийный допуск оформлен: получен запрос, направлено письменное разрешение (п. 18). */
export async function finalizeEmergency(db: Db, id: string, version: number, passFileId: string | null, userId: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE access_requests SET provisional = false, followup_done_at = now(), followup_done_by = $3,
            pass_file_id = coalesce($4, pass_file_id), reviewed_by = coalesce(reviewed_by, $3),
            reviewed_at = coalesce(reviewed_at, now()), version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 AND status = 'approved' AND provisional RETURNING id`, [id, version, userId, passFileId]);
  return rows.length > 0;
}

export async function reject(db: Db, id: string, version: number, reason: string, userId: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE access_requests SET status = 'rejected', rejection_reason = $3, reviewed_by = $4, reviewed_at = now(),
            version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 AND status = 'pending_review' RETURNING id`, [id, version, reason, userId]);
  return rows.length > 0;
}

/** Отзыв заявки организацией до решения. */
export async function withdraw(db: Db, id: string, version: number, reason: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE access_requests SET status = 'withdrawn', rejection_reason = $3, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 AND status = 'pending_review' RETURNING id`, [id, version, reason]);
  return rows.length > 0;
}

/** Отзыв выданного допуска: нарушение, расторжение договора аренды и т. п. */
export async function revoke(db: Db, id: string, version: number, reason: string, userId: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE access_requests SET status = 'revoked', revoke_reason = $3, revoked_by = $4, revoked_at = now(),
            version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 AND status = 'approved' RETURNING id`, [id, version, reason, userId]);
  return rows.length > 0;
}

/** Работы завершены: ответственное лицо филиала закрывает допуск (п. 23). */
export async function close(db: Db, id: string, version: number, note: string, userId: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE access_requests SET status = 'closed', closed_by = $4, closed_at = now(), close_note = $3,
            version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 AND status = 'approved' AND NOT provisional RETURNING id`, [id, version, note, userId]);
  return rows.length > 0;
}

export async function deleteDraft(db: Db, id: string): Promise<boolean> {
  const rows = await db.query(`DELETE FROM access_requests WHERE id = $1 AND status = 'draft' RETURNING id`, [id]);
  return rows.length > 0;
}

/** Файлы, на которые ссылается заявка: основание, запрос, сканы из снимка, файл допуска. */
export async function requestFileIds(db: Db, requestId: string): Promise<Set<string>> {
  const rows = await db.query<{ id: string | null }>(
    `SELECT basis_file_id AS id FROM access_requests WHERE id = $1
     UNION SELECT pass_file_id FROM access_requests WHERE id = $1
     UNION SELECT letter_file_id FROM access_requests WHERE id = $1
     UNION SELECT (d ->> 'fileId')::uuid FROM access_request_workers w, jsonb_array_elements(w.documents) d
            WHERE w.request_id = $1 AND d ->> 'fileId' IS NOT NULL`, [requestId]);
  return new Set(rows.map((r) => r.id).filter((id): id is string => !!id));
}

/* ---------------------------- ответственные лица ---------------------------- */

export type Person = { id: string; name: string; email: string };

const PERSON = `SELECT u.id, u.full_name AS name, u.email FROM users u`;

/**
 * Кто согласует от руководства филиала (пп. 8, 14, 18): директор филиала, затем
 * курирующий заместитель, затем главный инженер области (Приложение 7 Регламента).
 * Отсутствующего заменяет замещающий.
 */
export async function pickBranchApprover(db: Db, branchId: string | null): Promise<Person | null> {
  if (!branchId) return null;
  const row = await db.one<Person>(
    `${PERSON} JOIN branches b ON u.id = ANY(ARRAY[b.director_id, b.curator_id, b.chief_engineer_id])
      WHERE b.id = $1 AND u.is_active
      ORDER BY array_position(ARRAY[b.director_id, b.curator_id, b.chief_engineer_id], u.id) LIMIT 1`, [branchId]);
  return row ? await present(db, row) : null;
}

/**
 * Ответственное лицо на объекте (п. 20): назначенное по объекту, затем по филиалу,
 * затем главный инженер области и директор филиала.
 */
export async function pickSiteOfficer(db: Db, facilityId: string | null, branchId: string | null): Promise<Person | null> {
  const row = await db.one<Person>(
    `${PERSON}
      WHERE u.is_active AND u.id IN (
        SELECT unnest(ARRAY[f.site_officer_id, b.site_officer_id, b.chief_engineer_id, b.director_id])
          FROM branches b LEFT JOIN facilities f ON f.id = $1 WHERE b.id = $2)
      ORDER BY array_position((SELECT ARRAY[f.site_officer_id, b.site_officer_id, b.chief_engineer_id, b.director_id]
          FROM branches b LEFT JOIN facilities f ON f.id = $1 WHERE b.id = $2), u.id) LIMIT 1`, [facilityId, branchId]);
  return row ? await present(db, row) : null;
}

/** Если человек отсутствует сегодня — его замещающий (А3). */
async function present(db: Db, p: Person): Promise<Person> {
  const sub = await db.one<Person>(
    `${PERSON} JOIN user_absences a ON a.substitute_id = u.id
      WHERE a.user_id = $1 AND current_date BETWEEN a.date_from AND a.date_to AND u.is_active
      ORDER BY a.date_from DESC LIMIT 1`, [p.id]);
  return sub ?? p;
}

/** Руководство филиала, которое вправе согласовать заявку: назначенный, директор, куратор и их замещающие. */
export async function branchDeciders(db: Db, branchId: string | null): Promise<string[]> {
  if (!branchId) return [];
  const rows = await db.query<{ id: string }>(
    `WITH lead AS (SELECT unnest(ARRAY[director_id, curator_id, chief_engineer_id]) AS id FROM branches WHERE id = $1)
     SELECT id FROM lead WHERE id IS NOT NULL
     UNION SELECT a.substitute_id FROM user_absences a JOIN lead l ON l.id = a.user_id
      WHERE current_date BETWEEN a.date_from AND a.date_to`, [branchId]);
  return rows.map((r) => r.id);
}

/* ---------------------------- проверка на объекте ---------------------------- */

export type AdmissionRow = {
  id: string; work_date: string; worker_id: string | null; vehicle_id: string | null; briefing_done: boolean;
  briefing_record: string; clothing_ok: boolean; footwear_ok: boolean; ppe_ok: boolean; documents_ok: boolean;
  admitted: boolean; refusal_reason: string | null; arrived_at: string; left_at: string | null; checked_by_name: string;
};

export function admissions(db: Db, requestId: string, date: string | null = null) {
  return db.query<AdmissionRow>(
    `SELECT s.id, s.work_date::text AS work_date, s.worker_id, s.vehicle_id, s.briefing_done, s.briefing_record,
            s.clothing_ok, s.footwear_ok, s.ppe_ok, s.documents_ok, s.admitted, s.refusal_reason, s.arrived_at, s.left_at,
            u.full_name AS checked_by_name
       FROM site_admissions s JOIN users u ON u.id = s.checked_by
      WHERE s.request_id = $1 AND ($2::date IS NULL OR s.work_date = $2::date)
      ORDER BY s.work_date DESC, s.arrived_at`, [requestId, date]);
}

export type AdmissionInput = {
  workDate: string; workerId: string | null; vehicleId: string | null; briefingDone: boolean; briefingRecord: string;
  clothingOk: boolean; footwearOk: boolean; ppeOk: boolean; documentsOk: boolean; admitted: boolean; refusalReason: string | null;
};

export async function saveAdmission(db: Db, requestId: string, a: AdmissionInput, userId: string): Promise<string> {
  const conflict = a.workerId
    ? `(request_id, work_date, worker_id) WHERE worker_id IS NOT NULL`
    : `(request_id, work_date, vehicle_id) WHERE vehicle_id IS NOT NULL`;
  const row = await db.one<{ id: string }>(
    `INSERT INTO site_admissions (request_id, work_date, worker_id, vehicle_id, briefing_done, briefing_record, clothing_ok,
       footwear_ok, ppe_ok, documents_ok, admitted, refusal_reason, checked_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT ${conflict} DO UPDATE SET briefing_done = EXCLUDED.briefing_done,
       briefing_record = EXCLUDED.briefing_record, clothing_ok = EXCLUDED.clothing_ok, footwear_ok = EXCLUDED.footwear_ok,
       ppe_ok = EXCLUDED.ppe_ok, documents_ok = EXCLUDED.documents_ok, admitted = EXCLUDED.admitted,
       refusal_reason = EXCLUDED.refusal_reason, checked_by = EXCLUDED.checked_by, left_at = NULL
     RETURNING id`,
    [requestId, a.workDate, a.workerId, a.vehicleId, a.briefingDone, a.briefingRecord, a.clothingOk, a.footwearOk,
     a.ppeOk, a.documentsOk, a.admitted, a.refusalReason, userId]);
  return row!.id;
}

export async function markLeft(db: Db, requestId: string, admissionId: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE site_admissions SET left_at = now() WHERE id = $1 AND request_id = $2 AND admitted AND left_at IS NULL RETURNING id`,
    [admissionId, requestId]);
  return rows.length > 0;
}

/* ------------------------- реестр договоров аренды ------------------------- */

export type LeaseRow = {
  id: string; number: string; contract_date: string | null; counterparty_id: string; counterparty_name: string;
  counterparty_bin: string; valid_from: string | null; valid_until: string; status: string; note: string; source: string;
  facility_ids: string[]; facility_names: string | null; updated_at: string;
};

export function listLeases(db: Db, f: { q?: string | null; counterpartyId?: string | null; expiringDays?: number | null } = {}) {
  return db.query<LeaseRow>(
    `SELECT l.id, l.number, l.contract_date::text AS contract_date, l.counterparty_id, c.name_full AS counterparty_name,
            c.bin AS counterparty_bin, l.valid_from::text AS valid_from, l.valid_until::text AS valid_until, l.status,
            l.note, l.source, l.updated_at,
            coalesce(array_agg(lf.facility_id) FILTER (WHERE lf.facility_id IS NOT NULL), '{}') AS facility_ids,
            string_agg(f.name, ', ' ORDER BY f.name) AS facility_names
       FROM lease_contracts l
       JOIN counterparties c ON c.id = l.counterparty_id
       LEFT JOIN lease_contract_facilities lf ON lf.lease_id = l.id
       LEFT JOIN facilities f ON f.id = lf.facility_id
      WHERE ($1::text IS NULL OR l.number ILIKE '%' || $1 || '%' OR c.name_full ILIKE '%' || $1 || '%' OR c.bin LIKE $1 || '%')
        AND ($2::uuid IS NULL OR l.counterparty_id = $2)
        AND ($3::int IS NULL OR (l.status = 'active' AND l.valid_until <= current_date + $3))
      GROUP BY l.id, c.id ORDER BY l.valid_until, l.number LIMIT 2000`,
    [f.q || null, f.counterpartyId ?? null, f.expiringDays ?? null]);
}

export type LeaseInput = {
  id?: string | null; number: string; contractDate: string | null; counterpartyId: string; validFrom: string | null;
  validUntil: string; status: 'active' | 'terminated'; note: string; facilityIds: string[];
  source: 'manual' | 'import' | 'confirmation';
};

export async function saveLease(db: Db, l: LeaseInput, userId: string): Promise<string> {
  const existing = l.id ? { id: l.id } : await db.one<{ id: string }>(
    `SELECT id FROM lease_contracts WHERE counterparty_id = $1 AND lower(number) = lower($2)`, [l.counterpartyId, l.number]);
  let id: string;
  if (existing) {
    const row = await db.one<{ id: string }>(
      `UPDATE lease_contracts SET number = $2, contract_date = $3, counterparty_id = $4, valid_from = $5, valid_until = $6,
              status = $7, note = $8, updated_at = now() WHERE id = $1 RETURNING id`,
      [existing.id, l.number, l.contractDate, l.counterpartyId, l.validFrom, l.validUntil, l.status, l.note]);
    if (!row) return '';
    id = row.id;
  } else {
    id = (await db.one<{ id: string }>(
      `INSERT INTO lease_contracts (number, contract_date, counterparty_id, valid_from, valid_until, status, note, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [l.number, l.contractDate, l.counterpartyId, l.validFrom, l.validUntil, l.status, l.note, l.source, userId]))!.id;
  }
  if (l.facilityIds.length || !existing) {
    await db.query(`DELETE FROM lease_contract_facilities WHERE lease_id = $1`, [id]);
    await db.query(
      `INSERT INTO lease_contract_facilities (lease_id, facility_id)
       SELECT $1, f.id FROM facilities f WHERE f.id = ANY($2::uuid[]) ON CONFLICT DO NOTHING`, [id, l.facilityIds]);
  }
  return id;
}

/* --------------------------------- отчёт --------------------------------- */

export async function report(db: Db, f: RequestFilter) {
  const rows = await listRequests(db, { ...f, limit: 2000 });
  const decided = rows.filter((r) => r.reviewed_at && r.submitted_at);
  const hours = decided.map((r) => (Date.parse(r.reviewed_at!) - Date.parse(r.submitted_at!)) / 3_600_000);
  const reasons = new Map<string, number>();
  for (const r of rows) {
    if (r.status === 'rejected' && r.rejection_reason) {
      const key = r.rejection_reason.trim().slice(0, 120);
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
  }
  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const today = new Date().toISOString().slice(0, 10);
  const byWork = new Map<string, number>();
  for (const r of rows) if (r.work_type) byWork.set(r.work_type, (byWork.get(r.work_type) ?? 0) + 1);
  return {
    rows,
    summary: {
      total: rows.length,
      pending: rows.filter((r) => r.status === 'pending_review').length,
      approved: rows.filter((r) => r.status === 'approved' || r.status === 'closed').length,
      rejected: rows.filter((r) => r.status === 'rejected').length,
      withdrawn: rows.filter((r) => r.status === 'withdrawn').length,
      revoked: rows.filter((r) => r.status === 'revoked').length,
      urgent: rows.filter((r) => r.is_urgent).length,
      emergency: rows.filter((r) => r.work_type === 'emergency').length,
      branchApproval: rows.filter((r) => r.branch_approval !== 'not_required').length,
      overdue: rows.filter((r) => r.status === 'pending_review' && r.review_due_at && r.review_due_at < today).length,
      manualBasis: rows.filter((r) => r.basis_confirmed_at).length,
      avgDecisionHours: hours.length ? Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10 : null,
      medianDecisionHours: hours.length ? Math.round(median(hours)! * 10) / 10 : null,
      byWorkType: Object.fromEntries(byWork),
      rejectionReasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([reason, count]) => ({ reason, count })),
    },
  };
}
