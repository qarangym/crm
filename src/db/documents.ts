/**
 * Доступ к данным архива актов.
 *
 * Требования ТЗ по архиву: карточка с реквизитами, поиск по объекту,
 * собственнику, подрядчику и дате в любых сочетаниях, защита от дублей,
 * визирование, версии файлов и журнал обращений.
 */

import type { Db } from './client.ts';
import type { Actor } from '../server/rbac.ts';

export type DocumentRow = {
  id: string;
  request_id: string | null;
  kind: string;
  form_code: string;
  number: string;
  facility_id: string | null;
  facility_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  contractor_name: string;
  branch_id: string | null;
  branch_name: string | null;
  doc_date: string;
  valid_until: string | null;
  approved: boolean;
  approved_at: string | null;
  current_version: number;
  file_name: string | null;
  size_bytes: string | null;
  created_at: string;
};

const SELECT = `
  SELECT d.id, d.request_id, d.kind, d.form_code, d.number, d.facility_id, f.name AS facility_name,
         d.owner_id, cp.name_full AS owner_name, d.contractor_name, d.branch_id, b.name AS branch_name,
         d.doc_date, d.valid_until, d.approved, d.approved_at, d.current_version, d.created_at,
         v.file_name, v.size_bytes
    FROM documents d
    LEFT JOIN facilities f ON f.id = d.facility_id
    LEFT JOIN counterparties cp ON cp.id = d.owner_id
    LEFT JOIN branches b ON b.id = d.branch_id
    LEFT JOIN file_versions v ON v.document_id = d.id AND v.version = d.current_version`;

export type DocumentSearch = {
  kind?: string;
  /** Поиск по наименованию объекта — с учётом опечаток. */
  facility?: string;
  owner?: string;
  contractor?: string;
  dateFrom?: string;
  dateTo?: string;
  requestId?: string;
  /** Филиал: роль «Филиал» видит только свои документы. */
  branchId?: string;
  limit?: number;
  offset?: number;
};

/**
 * Поиск по архиву. Все условия комбинируются — требование архива №4.
 * Поиск идёт на сервере с индексами; выгрузка всего массива в интерфейс,
 * как было в прототипе, на объёме нескольких лет неработоспособна.
 */
export async function searchDocuments(db: Db, filter: DocumentSearch): Promise<DocumentRow[]> {
  const where: string[] = [`d.kind <> 'Приложение'`];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };

  if (filter.kind) add('d.kind = ?', filter.kind);
  if (filter.branchId) add('d.branch_id = ?', filter.branchId);
  if (filter.requestId) add('d.request_id = ?', filter.requestId);
  if (filter.dateFrom) add('d.doc_date >= ?', filter.dateFrom);
  if (filter.dateTo) add('d.doc_date <= ?', filter.dateTo);
  // Нечёткое сравнение: наименования контрагентов часто вводят с опечатками.
  if (filter.facility) add('f.name %> ?', filter.facility);
  if (filter.owner) add('cp.name_full %> ?', filter.owner);
  if (filter.contractor) add('d.contractor_name %> ?', filter.contractor);

  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  return db.query<DocumentRow>(
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY d.doc_date DESC, d.created_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params as never,
  );
}

export async function getDocument(db: Db, id: string): Promise<DocumentRow | null> {
  return db.one<DocumentRow>(`${SELECT} WHERE d.id = $1`, [id]);
}

export async function findByFingerprint(db: Db, fingerprint: string): Promise<DocumentRow | null> {
  return db.one<DocumentRow>(`${SELECT} WHERE d.fingerprint = $1`, [fingerprint]);
}

export type NewDocument = {
  requestId: string | null;
  kind: string;
  formCode: string;
  number: string;
  facilityId: string | null;
  ownerId: string | null;
  contractorName: string;
  branchId: string | null;
  docDate: string;
  validUntil: string | null;
  fingerprint: string | null;
  createdBy: string;
};

export async function createDocument(
  db: Db, data: NewDocument,
  file: { key: string; fileName: string; mime: string; size: number; sha256: string },
): Promise<string> {
  return db.tx(async (t) => {
    const row = await t.one<{ id: string }>(
      `INSERT INTO documents (request_id, kind, form_code, number, facility_id, owner_id,
                              contractor_name, branch_id, doc_date, valid_until, fingerprint, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [data.requestId, data.kind, data.formCode, data.number, data.facilityId, data.ownerId,
       data.contractorName, data.branchId, data.docDate, data.validUntil, data.fingerprint, data.createdBy],
    );
    await addVersion(t, row!.id, 1, file, data.createdBy);
    return row!.id;
  });
}

export async function addVersion(
  db: Db, documentId: string, version: number,
  file: { key: string; fileName: string; mime: string; size: number; sha256: string },
  userId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO file_versions (document_id, version, storage_key, file_name, mime, size_bytes, sha256, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [documentId, version, file.key, file.fileName, file.mime, file.size, file.sha256, userId],
  );
}

/** Замена файла: новая версия, визирование снимается — документ снова требует проверки. */
export async function replaceFile(
  db: Db, documentId: string, currentVersion: number,
  file: { key: string; fileName: string; mime: string; size: number; sha256: string },
  userId: string,
): Promise<number> {
  return db.tx(async (t) => {
    const next = currentVersion + 1;
    const updated = await t.query(
      `UPDATE documents SET current_version = $2, approved = false, approved_by = NULL, approved_at = NULL
        WHERE id = $1 AND current_version = $3 RETURNING id`,
      [documentId, next, currentVersion]);
    if (!updated.length) throw new Error('Документ изменился, обновите карточку');
    await addVersion(t, documentId, next, file, userId);
    return next;
  });
}

export function listVersions(db: Db, documentId: string) {
  return db.query(
    `SELECT v.version, v.file_name, v.size_bytes, v.sha256, v.created_at, u.full_name AS author
       FROM file_versions v JOIN users u ON u.id = v.created_by
      WHERE v.document_id = $1 ORDER BY v.version DESC`, [documentId]);
}

export function getVersion(db: Db, documentId: string, version: number) {
  return db.one<{ storage_key: string; file_name: string; mime: string; sha256: string }>(
    `SELECT storage_key, file_name, mime, sha256 FROM file_versions
      WHERE document_id = $1 AND version = $2`, [documentId, version]);
}

/** Визирование. После него карточка и файл закрыты для правки и удаления. */
export async function approveDocument(db: Db, id: string, userId: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE documents SET approved = true, approved_by = $2, approved_at = now()
      WHERE id = $1 AND NOT approved RETURNING id`, [id, userId]);
  return rows.length > 0;
}

/** Удаление возможно только до визирования — требование ТЗ по архиву. */
export async function deleteDocument(db: Db, id: string): Promise<string[]> {
  return db.tx(async (t) => {
    const keys = await t.query<{ storage_key: string }>(
      `SELECT storage_key FROM file_versions WHERE document_id = $1`, [id]);
    const deleted = await t.query(`DELETE FROM documents WHERE id = $1 AND NOT approved RETURNING id`, [id]);
    if (!deleted.length) return [];
    return keys.map((k) => k.storage_key);
  });
}

/** Документы с истекающим сроком действия: ТУ — 6 месяцев (п. 31), РП — 36 (п. 47). */
export function expiringDocuments(db: Db, withinDays: number) {
  return db.query(
    `SELECT d.id, d.kind, d.number, d.valid_until, cp.email AS owner_email, cp.name_full AS owner_name
       FROM documents d LEFT JOIN counterparties cp ON cp.id = d.owner_id
      WHERE d.valid_until IS NOT NULL
        AND d.valid_until BETWEEN current_date AND current_date + ($1 || ' days')::interval
      ORDER BY d.valid_until`, [String(withinDays)]);
}
