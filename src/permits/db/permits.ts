/**
 * Доступ к данным портала допусков.
 *
 * Работники, удостоверения, транспорт и бригады принадлежат организации:
 * каждый запрос ограничен её идентификатором. Состав заявки хранится снимком —
 * правка работника после отправки заявку не меняет.
 */

import type { Db } from '../../db/client.ts';
import type { StoredFile } from '../../storage/files.ts';
import { normalizeModes } from '../domain/basis.ts';
import type { BasisModes, BasisRecord, BasisType } from '../domain/basis.ts';
import type { WorkerDocument, WorkerForCheck } from '../domain/request.ts';

export const MODES_KEY = 'permits.basis_mode';

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
  id: string; counterparty_id: string; kind: 'qualification' | 'basis' | 'pass';
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

export type WorkerRow = {
  id: string; full_name: string; iin: string; position: string; is_active: boolean;
  documents: (WorkerDocument & { id: string; fileName: string | null })[];
};

const WORKER_SELECT = `
  SELECT w.id, w.full_name, w.iin, w.position, w.is_active,
         coalesce(json_agg(json_build_object(
           'id', d.id, 'title', d.title, 'number', d.number, 'validUntil', d.valid_until::text,
           'fileId', d.file_id, 'fileName', f.file_name) ORDER BY d.valid_until)
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
  return db.one<{ id: string; counterparty_id: string; full_name: string; iin: string; is_active: boolean }>(
    `SELECT id, counterparty_id, full_name, iin, is_active FROM contractor_workers WHERE id = $1`, [id]);
}

export async function saveWorker(
  db: Db, counterpartyId: string, w: { id?: string | null; fullName: string; iin: string; position: string }, userId: string,
): Promise<string> {
  if (w.id) {
    const row = await db.one<{ id: string }>(
      `UPDATE contractor_workers SET full_name = $3, iin = $4, position = $5, is_active = true, updated_at = now()
        WHERE id = $1 AND counterparty_id = $2 RETURNING id`, [w.id, counterpartyId, w.fullName, w.iin, w.position]);
    return row?.id ?? '';
  }
  // Работник с тем же ИИН уже есть — обновляем его, а не заводим двойника.
  const row = await db.one<{ id: string }>(
    `INSERT INTO contractor_workers (counterparty_id, full_name, iin, position, created_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (counterparty_id, iin) DO UPDATE
       SET full_name = EXCLUDED.full_name, position = EXCLUDED.position, is_active = true, updated_at = now()
     RETURNING id`, [counterpartyId, w.fullName, w.iin, w.position, userId]);
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
  db: Db, workerId: string, d: { title: string; number: string; validUntil: string; fileId: string }, userId: string,
): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO worker_documents (worker_id, title, number, valid_until, file_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [workerId, d.title, d.number, d.validUntil, d.fileId, userId]);
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

/**
 * Поиск основания в реестрах системы: по выбранной записи либо по номеру.
 * Номер ищется среди записей организации-заявителя, а если там нет — среди всех,
 * чтобы сообщить, что основание оформлено на другую организацию.
 */
export async function findBasis(
  db: Db, type: BasisType, q: { id?: string | null; number: string; counterpartyId: string; facilityId: string | null },
): Promise<BasisRecord | null> {
  if (type === 'lease') return null;
  const number = q.number.trim();
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
  const kind = type === 'tu' ? 'ТУ' : 'Акт приема-передачи';
  const row = await db.one<Record<string, any>>(
    `SELECT d.id, d.number, coalesce(d.owner_id, r.counterparty_id) AS counterparty_id, d.facility_id,
            d.approved, false AS terminated, d.valid_until::text AS valid_until
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
  const [tu, contracts, acts] = await Promise.all([
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
  ]);
  return { tu, smr_contract: contracts, transfer_act: acts, lease: [] };
}

/* ---------------------------- заявки на допуск ---------------------------- */

export type AccessRequestRow = {
  id: string; number: string; status: 'draft' | 'pending_review' | 'approved' | 'rejected';
  counterparty_id: string; counterparty_name: string; counterparty_bin: string; counterparty_status: string;
  facility_id: string | null; facility_name: string | null; facility_inv_no: string | null; facility_address: string | null;
  branch_id: string | null; branch_name: string | null;
  basis_type: BasisType | null; basis_number: string; basis_document_id: string | null; basis_contract_id: string | null;
  basis_file_id: string | null; basis_file_name: string | null; basis_check: Record<string, any>;
  basis_confirmed_at: string | null; basis_confirmed_by_name: string | null; basis_confirm_note: string | null;
  description: string; period_start: string | null; period_end: string | null; is_urgent: boolean;
  crew_id: string | null; pass_file_id: string | null; pass_file_name: string | null;
  rejection_reason: string | null; reviewed_at: string | null; reviewed_by_name: string | null;
  pd_consent_at: string | null; submitted_at: string | null; created_at: string; updated_at: string;
  created_by: string; created_by_name: string | null; version: number;
  workers_count: number; vehicles_count: number;
};

const REQUEST_SELECT = `
  SELECT a.id, a.number, a.status, a.counterparty_id, c.name_full AS counterparty_name, c.bin AS counterparty_bin,
         c.status AS counterparty_status,
         a.facility_id, f.name AS facility_name, f.inv_no AS facility_inv_no, f.address AS facility_address,
         a.branch_id, b.name AS branch_name,
         a.basis_type, a.basis_number, a.basis_document_id, a.basis_contract_id, a.basis_file_id,
         bf.file_name AS basis_file_name, a.basis_check, a.basis_confirmed_at, bc.full_name AS basis_confirmed_by_name,
         a.basis_confirm_note, a.description,
         to_char(a.period_start, 'YYYY-MM-DD"T"HH24:MI') AS period_start,
         to_char(a.period_end, 'YYYY-MM-DD"T"HH24:MI') AS period_end,
         a.is_urgent, a.crew_id, a.pass_file_id, pf.file_name AS pass_file_name,
         a.rejection_reason, a.reviewed_at, rv.full_name AS reviewed_by_name,
         a.pd_consent_at, a.submitted_at, a.created_at, a.updated_at, a.created_by, cu.full_name AS created_by_name,
         a.version,
         (SELECT count(*)::int FROM access_request_workers w WHERE w.request_id = a.id) AS workers_count,
         (SELECT count(*)::int FROM access_request_vehicles v WHERE v.request_id = a.id) AS vehicles_count
    FROM access_requests a
    JOIN counterparties c ON c.id = a.counterparty_id
    LEFT JOIN facilities f ON f.id = a.facility_id
    LEFT JOIN branches b ON b.id = a.branch_id
    LEFT JOIN permit_files bf ON bf.id = a.basis_file_id
    LEFT JOIN permit_files pf ON pf.id = a.pass_file_id
    LEFT JOIN users bc ON bc.id = a.basis_confirmed_by
    LEFT JOIN users rv ON rv.id = a.reviewed_by
    LEFT JOIN users cu ON cu.id = a.created_by`;

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
  dateFrom?: string | null;
  dateTo?: string | null;
  /** Очередь СУА: сначала срочные, затем по времени отправки. */
  queue?: boolean;
  limit?: number;
};

export function listRequests(db: Db, f: RequestFilter) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  if (f.counterpartyId) add('a.counterparty_id = ?', f.counterpartyId);
  // Черновик — рабочее место подрядчика: сотрудники Общества видят заявку с момента отправки.
  else where.push(`a.status <> 'draft'`);
  if (f.queue) where.push(`a.status = 'pending_review'`);
  else if (f.status) add('a.status = ?', f.status);
  if (f.facilityId) add('a.facility_id = ?', f.facilityId);
  if (f.branchId) add('a.branch_id = ?', f.branchId);
  if (f.urgent === true) where.push('a.is_urgent');
  if (f.dateFrom) add(`coalesce(a.submitted_at, a.created_at) >= ?::date`, f.dateFrom);
  if (f.dateTo) add(`coalesce(a.submitted_at, a.created_at) < ?::date + 1`, f.dateTo);
  if (f.q) {
    params.push(f.q);
    const p = `$${params.length}`;
    where.push(`(a.number ILIKE '%' || ${p} || '%' OR c.name_full ILIKE '%' || ${p} || '%'
          OR c.bin LIKE ${p} || '%' OR f.name ILIKE '%' || ${p} || '%' OR a.basis_number ILIKE '%' || ${p} || '%')`);
  }
  params.push(Math.min(Math.max(Number(f.limit) || 300, 1), 2000));
  const order = f.queue ? 'a.is_urgent DESC, a.submitted_at ASC' : 'coalesce(a.submitted_at, a.created_at) DESC';
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
  facilityId: string | null;
  branchId: string | null;
  basisType: BasisType | null;
  basisNumber: string;
  basisDocumentId: string | null;
  basisContractId: string | null;
  description: string;
  periodStart: string | null;
  periodEnd: string | null;
  isUrgent: boolean;
  crewId: string | null;
};

export async function createDraft(db: Db, counterpartyId: string, d: DraftFields, userId: string): Promise<string> {
  const number = await nextNumber(db);
  const row = await db.one<{ id: string }>(
    `INSERT INTO access_requests (number, counterparty_id, facility_id, branch_id, basis_type, basis_number,
       basis_document_id, basis_contract_id, description, period_start, period_end, is_urgent, crew_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamp,$11::timestamp,$12,$13,$14) RETURNING id`,
    [number, counterpartyId, d.facilityId, d.branchId, d.basisType, d.basisNumber, d.basisDocumentId, d.basisContractId,
     d.description, d.periodStart, d.periodEnd, d.isUrgent, d.crewId, userId]);
  return row!.id;
}

/** Правка черновика с проверкой версии: две вкладки не затирают друг друга. */
export async function updateDraft(db: Db, id: string, version: number, d: DraftFields): Promise<boolean> {
  const rows = await db.query(
    `UPDATE access_requests SET facility_id = $3, branch_id = $4, basis_type = $5, basis_number = $6,
            basis_document_id = $7, basis_contract_id = $8, description = $9, period_start = $10::timestamp,
            period_end = $11::timestamp, is_urgent = $12, crew_id = $13, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 AND status = 'draft' RETURNING id`,
    [id, version, d.facilityId, d.branchId, d.basisType, d.basisNumber, d.basisDocumentId, d.basisContractId,
     d.description, d.periodStart, d.periodEnd, d.isUrgent, d.crewId]);
  return rows.length > 0;
}

/** Снимок бригады и транспорта из текущих данных организации. */
export async function snapshotComposition(
  db: Db, requestId: string, workers: WorkerRow[], vehicles: VehicleRow[],
): Promise<void> {
  await db.query(`DELETE FROM access_request_workers WHERE request_id = $1`, [requestId]);
  await db.query(`DELETE FROM access_request_vehicles WHERE request_id = $1`, [requestId]);
  let i = 0;
  for (const w of workers) {
    const documents = w.documents.map((d) => ({
      id: d.id, title: d.title, number: d.number ?? '', validUntil: d.validUntil, fileId: d.fileId ?? null,
      fileName: d.fileName ?? null,
    }));
    await db.query(
      `INSERT INTO access_request_workers (request_id, worker_id, sort_order, full_name, iin, position, documents)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [requestId, w.id, i++, w.full_name, w.iin, w.position, JSON.stringify(documents)]);
  }
  i = 0;
  for (const v of vehicles) {
    await db.query(
      `INSERT INTO access_request_vehicles (request_id, vehicle_id, sort_order, plate, model, driver_name)
       VALUES ($1,$2,$3,$4,$5,$6)`, [requestId, v.id, i++, v.plate, v.model, v.driver_name]);
  }
}

export type CompositionWorker = {
  worker_id: string; full_name: string; iin: string; position: string;
  documents: { id: string; title: string; number: string; validUntil: string; fileId: string | null; fileName: string | null }[];
};

export async function composition(db: Db, requestId: string) {
  const [workers, vehicles] = await Promise.all([
    db.query<CompositionWorker>(
      `SELECT worker_id, full_name, iin, position, documents FROM access_request_workers
        WHERE request_id = $1 ORDER BY sort_order`, [requestId]),
    db.query<{ vehicle_id: string; plate: string; model: string; driver_name: string }>(
      `SELECT vehicle_id, plate, model, driver_name FROM access_request_vehicles
        WHERE request_id = $1 ORDER BY sort_order`, [requestId]),
  ]);
  return { workers, vehicles };
}

export function toCheckWorkers(workers: CompositionWorker[]): WorkerForCheck[] {
  return workers.map((w) => ({ id: w.worker_id, fullName: w.full_name, iin: w.iin, documents: w.documents }));
}

export async function setBasisFile(db: Db, id: string, fileId: string | null): Promise<void> {
  await db.query(`UPDATE access_requests SET basis_file_id = $2, version = version + 1, updated_at = now() WHERE id = $1`,
    [id, fileId]);
}

export async function submit(
  db: Db, id: string, version: number, basisCheck: Record<string, unknown>, userId: string,
): Promise<boolean> {
  const rows = await db.query(
    `UPDATE access_requests SET status = 'pending_review', submitted_at = now(), basis_check = $3::jsonb,
            basis_document_id = CASE WHEN basis_type IN ('tu','transfer_act') THEN $4::uuid ELSE NULL END,
            basis_contract_id = CASE WHEN basis_type = 'smr_contract' THEN $4::uuid ELSE NULL END,
            pd_consent_by = $5, pd_consent_at = now(), version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 AND status = 'draft' RETURNING id`,
    [id, version, JSON.stringify(basisCheck), (basisCheck.reference as { id?: string } | null)?.id ?? null, userId]);
  return rows.length > 0;
}

export async function confirmBasis(db: Db, id: string, version: number, note: string, userId: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE access_requests SET basis_confirmed_by = $3, basis_confirmed_at = now(), basis_confirm_note = $4,
            version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 AND status = 'pending_review' RETURNING id`, [id, version, userId, note]);
  return rows.length > 0;
}

export async function approve(db: Db, id: string, version: number, passFileId: string, userId: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE access_requests SET status = 'approved', pass_file_id = $3, reviewed_by = $4, reviewed_at = now(),
            version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 AND status = 'pending_review' RETURNING id`, [id, version, passFileId, userId]);
  return rows.length > 0;
}

export async function reject(db: Db, id: string, version: number, reason: string, userId: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE access_requests SET status = 'rejected', rejection_reason = $3, reviewed_by = $4, reviewed_at = now(),
            version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 AND status = 'pending_review' RETURNING id`, [id, version, reason, userId]);
  return rows.length > 0;
}

export async function deleteDraft(db: Db, id: string): Promise<boolean> {
  const rows = await db.query(`DELETE FROM access_requests WHERE id = $1 AND status = 'draft' RETURNING id`, [id]);
  return rows.length > 0;
}

/** Файлы, на которые ссылается заявка: скан основания, сканы удостоверений из снимка, файл допуска. */
export async function requestFileIds(db: Db, requestId: string): Promise<Set<string>> {
  const rows = await db.query<{ id: string | null }>(
    `SELECT basis_file_id AS id FROM access_requests WHERE id = $1
     UNION SELECT pass_file_id FROM access_requests WHERE id = $1
     UNION SELECT (d ->> 'fileId')::uuid FROM access_request_workers w, jsonb_array_elements(w.documents) d
            WHERE w.request_id = $1 AND d ->> 'fileId' IS NOT NULL`, [requestId]);
  return new Set(rows.map((r) => r.id).filter((id): id is string => !!id));
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
  return {
    rows,
    summary: {
      total: rows.length,
      pending: rows.filter((r) => r.status === 'pending_review').length,
      approved: rows.filter((r) => r.status === 'approved').length,
      rejected: rows.filter((r) => r.status === 'rejected').length,
      urgent: rows.filter((r) => r.is_urgent).length,
      manualBasis: rows.filter((r) => r.basis_confirmed_at).length,
      avgDecisionHours: hours.length ? Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10 : null,
      medianDecisionHours: hours.length ? Math.round(median(hours)! * 10) / 10 : null,
      rejectionReasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([reason, count]) => ({ reason, count })),
    },
  };
}
