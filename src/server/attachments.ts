/**
 * Приложения к заявке и документы по заявке (Проверка функционала, К5, В1).
 *
 * Регламент п. 7.6: к заявке прикладываются ситуационный план, схема, чертёж
 * или иная пояснительная документация; ТЗ №8 и №13 — приложения переносятся в
 * карточку поручения и хранятся в системе. Заказчик прикладывает файлы к своей
 * заявке до её регистрации делопроизводством и при возврате на доработку;
 * сотрудники, вносящие бумажную заявку, — пока заявка не закрыта.
 *
 * Здесь же — документы по заявке, адресованные Заказчику (выданные ТУ,
 * рабочий проект, КП, договоры, АВР), со скачиванием в пределах своей заявки:
 * общего архива Заказчик не видит.
 */

import { randomUUID } from 'node:crypto';
import * as repo from '../db/repo.ts';
import * as docs from '../db/documents.ts';
import type { RequestRow } from '../db/repo.ts';
import { refreshPayload } from '../db/assignments.ts';
import { today } from '../domain/calendar.ts';
import { stage } from '../process/stages.ts';
import { ApiError } from './errors.ts';
import type { Ctx, Router } from './http.ts';
import { RAW_RESPONSE } from './http.ts';
import { parseMultipart } from './multipart.ts';
import * as rbac from './rbac.ts';
import type { Actor } from './rbac.ts';
import type { RouteDeps } from './context.ts';
import { CUSTOMER_DOCUMENT_KINDS } from './customer.ts';

/** Замечание «Приложения к заявке» снимается, когда приложен новый файл. */
export const ATTACHMENTS_REMARK = 'Приложения к заявке';

/** Максимум файлов за одну загрузку: форма заявки, а не файлообменник. */
const MAX_FILES = 10;

/**
 * Можно ли сейчас менять приложения. Заказчик — пока канцелярия не подтвердила
 * регистрацию и при возврате на доработку; сотрудник — пока заявка не закрыта.
 */
export function attachmentsOpen(actor: Actor, r: RequestRow): { ok: boolean; reason: string } {
  if (stage(r.stageCode).terminal) return { ok: false, reason: 'Заявка закрыта' };
  if (!rbac.isCustomer(actor)) return { ok: true, reason: '' };
  if (r.stageCode === 'draft') return { ok: true, reason: '' };
  if (r.stageCode === 'registered' && !r.registrationConfirmedAt) return { ok: true, reason: '' };
  if (r.openRemarks > 0) return { ok: true, reason: '' };
  return { ok: false, reason: 'Заявка зарегистрирована: дополнительные файлы прикладываются по запросу ОР ПСД' };
}

/** Какие документы заявки видит пользователь. */
function visibleKinds(actor: Actor): string[] | null {
  if (rbac.isCustomer(actor)) return CUSTOMER_DOCUMENT_KINDS;
  if (rbac.can(actor, 'documents.view')) return null; // все
  return ['Приложение'];
}

export function registerAttachmentRoutes(router: Router, deps: RouteDeps): void {
  const { db } = deps;

  async function requestDocuments(actor: Actor, request: RequestRow) {
    const kinds = visibleKinds(actor);
    const rows = await db.query<Record<string, any>>(
      `SELECT d.id, d.kind, d.number, d.form_code, d.doc_date::text AS doc_date, d.valid_until::text AS valid_until,
              d.approved, d.current_version, d.created_at, d.created_by, d.contract_id,
              v.file_name, v.size_bytes, v.mime, u.full_name AS author
         FROM documents d
         LEFT JOIN file_versions v ON v.document_id = d.id AND v.version = d.current_version
         LEFT JOIN users u ON u.id = d.created_by
        WHERE d.request_id = $1 AND ($2::text[] IS NULL OR d.kind = ANY($2::text[]))
        ORDER BY d.created_at`, [request.uuid, kinds]);
    // Заказчику — только завизированные документы Общества и свои приложения;
    // имя сотрудника, загрузившего файл, ему не показывается.
    if (!rbac.isCustomer(actor)) return rows;
    return rows
      .filter((d) => d.kind === 'Приложение' || d.approved)
      .map(({ author: _author, created_by: _by, ...rest }) => rest);
  }

  /** Документы заявки в пределах прав пользователя. */
  router.get('/api/v1/requests/:id/documents', async (ctx) => {
    const actor = await deps.actor(ctx);
    const request = await deps.loadVisible(actor, ctx.params.id);
    return { documents: await requestDocuments(actor, request), attachmentsOpen: attachmentsOpen(actor, request) };
  });

  /** Скачивание документа заявки. Каждое обращение пишется в журнал. */
  router.get('/api/v1/requests/:id/documents/:docId/file', async (ctx) => {
    const actor = await deps.actor(ctx);
    if (!deps.store) throw new ApiError('Хранилище файлов не настроено', 503, 'storage_unavailable');
    const request = await deps.loadVisible(actor, ctx.params.id);
    const visible = await requestDocuments(actor, request);
    const document = visible.find((d) => d.id === ctx.params.docId);
    if (!document) throw ApiError.notFound('Документ не найден в заявке');

    const version = Number(ctx.query.get('version')) || document.current_version;
    const row = await docs.getVersion(db, document.id, version);
    if (!row) throw ApiError.notFound('Версия файла не найдена');
    const preview = ctx.query.get('preview') === '1';
    const inlineType = ['application/pdf', 'image/png', 'image/jpeg'].includes(row.mime);
    // Документы своей заявки Заказчик скачивает всегда; приложения — все, кто видит заявку.
    const mayDownload = rbac.isCustomer(actor) || document.kind === 'Приложение' || rbac.can(actor, 'documents.download');
    if (!mayDownload && !(preview && inlineType)) {
      throw ApiError.forbidden('Нет права на скачивание файла; доступен просмотр PDF и изображений');
    }
    await repo.logEvent(db, {
      ...deps.audit(ctx, actor), action: preview ? 'Просмотр файла' : 'Скачивание файла',
      entity: 'document', entityId: document.id,
      detail: `${row.file_name} · версия ${version} · заявка ${request.number}`,
    });
    const { stream, size } = await deps.store.read(row.storage_key);
    const inline = preview && inlineType;
    ctx.res.writeHead(200, {
      'Content-Type': row.mime,
      'Content-Length': size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    });
    stream.pipe(ctx.res);
    return RAW_RESPONSE;
  });

  /** Приложения к заявке (п. 7.6): один или несколько файлов. */
  router.post('/api/v1/requests/:id/attachments', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'request.attach');
    if (!deps.store) throw new ApiError('Хранилище файлов не настроено', 503, 'storage_unavailable');
    const request = await deps.loadVisible(actor, ctx.params.id);
    const open = attachmentsOpen(actor, request);
    if (!open.ok) throw ApiError.conflict(open.reason);

    const form = await parseMultipart(ctx.req);
    if (!form.files.length) throw ApiError.badRequest('Выберите файл');
    if (form.files.length > MAX_FILES) throw ApiError.badRequest(`За один раз — не более ${MAX_FILES} файлов`);
    for (const file of form.files) await deps.scan(ctx, actor, file, request.uuid);

    const created: string[] = [];
    const stored: string[] = [];
    try {
      await db.tx(async (t) => {
        for (const file of form.files) {
          const saved = await deps.store!.put(randomUUID(), file.filename, file.data);
          stored.push(saved.key);
          const id = await docs.createDocument(t, {
            requestId: request.uuid, kind: 'Приложение', formCode: '',
            number: file.filename.slice(0, 128), facilityId: request.facilityId,
            ownerId: request.counterpartyId, contractorName: '', branchId: request.branchId,
            docDate: today(), validUntil: null, fingerprint: null, createdBy: actor.id,
          }, saved);
          created.push(id);
          await repo.logEvent(t, {
            ...deps.audit(ctx, actor), action: 'Приложен файл к заявке', entity: 'request', entityId: request.uuid,
            detail: `${saved.fileName} · ${saved.sha256.slice(0, 12)}`, regulationRef: 'п. 7.6',
          });
        }
        // Замечание «приложите документы» устраняется загрузкой (ТЗ №11).
        const remarks = await repo.openRemarks(t, request.uuid);
        const fixed = remarks.filter((r) => r.field_key === ATTACHMENTS_REMARK).map((r) => r.id);
        if (fixed.length) {
          await repo.resolveRemarkIds(t, request.uuid, fixed);
          await repo.logEvent(t, {
            ...deps.audit(ctx, actor), action: 'Замечание к приложениям устранено загрузкой файлов',
            entity: 'request', entityId: request.uuid, detail: `замечаний: ${fixed.length}`, regulationRef: 'ТЗ №11',
          });
        }
        // Карточка поручения несёт перечень приложений (ТЗ №8).
        await refreshPayload(t, request.uuid);
      });
    } catch (error) {
      for (const key of stored) await deps.store.remove(key).catch(() => {});
      throw error;
    }
    const all = await requestDocuments(actor, (await repo.getRequest(db, request.uuid))!);
    return { documents: all.filter((d) => created.includes(d.id)), all };
  });

  /** Удаление своего приложения — пока заявку можно дополнять. */
  router.post('/api/v1/requests/:id/attachments/:docId/delete', async (ctx) => {
    deps.guardOrigin(ctx);
    const actor = await deps.actor(ctx);
    rbac.require(actor, 'request.attach');
    const request = await deps.loadVisible(actor, ctx.params.id);
    const open = attachmentsOpen(actor, request);
    if (!open.ok) throw ApiError.conflict(open.reason);
    const document = await docs.getDocument(db, ctx.params.docId);
    if (!document || document.request_id !== request.uuid || document.kind !== 'Приложение') {
      throw ApiError.notFound('Приложение не найдено');
    }
    const keys = await docs.deleteDocument(db, document.id);
    if (deps.store) for (const key of keys) await deps.store.remove(key).catch(() => {});
    await db.tx(async (t) => {
      await refreshPayload(t, request.uuid);
      await repo.logEvent(t, {
        ...deps.audit(ctx, actor), action: 'Удалено приложение к заявке', entity: 'request',
        entityId: request.uuid, detail: document.number, regulationRef: 'п. 7.6',
      });
    });
    return { ok: true };
  });
}

export type { Ctx };
