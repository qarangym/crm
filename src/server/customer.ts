/**
 * Что видит Заказчик (ТЗ №10, №14; Проверка функционала, В1).
 *
 * Заказчику показывается состояние его заявки: номер, статус, замечания,
 * договоры и оплата, адресованные ему документы и история в виде статусов.
 * Внутренняя кухня Общества — журнал с именами сотрудников, служебные записки
 * в филиал, предварительные расчёты технической возможности, эскалации,
 * ответственные подразделения — Заказчику не отдаётся: сервер вырезает эти
 * поля, а не только интерфейс их прячет.
 */

import type { RequestRow } from '../db/repo.ts';
import type { ContractRow } from '../db/contracts.ts';
import { CUSTOMER_STATUS_NAME } from '../domain/types.ts';
import { toIsoDate, toIsoTimestamp } from '../domain/dates.ts';
import { customerStatus } from '../process/engine.ts';
import type { StageCode } from '../process/stages.ts';
import { stage } from '../process/stages.ts';

/**
 * Документы по заявке, которые направляются Заказчику: выданные ТУ и рабочий
 * проект, КП, договоры, акты. Приложения к заявке он загружает сам.
 */
export const CUSTOMER_DOCUMENT_KINDS = ['ТУ', 'ПСД (РП)', 'КП', 'Договор', 'АВР', 'Приложение'];

/**
 * Этапы, срок которых зависит от Заказчика либо обещан ему Регламентом:
 * ответ о технической возможности (п. 9), оплата по оферте (табл. 1),
 * предоставление оборудования (п. 55), рассмотрение АВР (п. 94).
 */
const CUSTOMER_VISIBLE_DUE: StageCode[] = ['tv_review', 'awaiting_payment', 'smr_prep', 'closing'];

/** Заявка в том объёме, который положено видеть Заказчику. */
export function customerRequest(r: RequestRow) {
  const status = customerStatus(r);
  return {
    uuid: r.uuid,
    number: r.number,
    incomingNumber: r.incomingNumber,
    incomingDate: r.incomingDate,
    stageCode: r.stageCode,
    customerStatus: status,
    customerStatusName: CUSTOMER_STATUS_NAME[status],
    services: r.services,
    counterpartyId: r.counterpartyId,
    counterpartyName: r.counterpartyName,
    facilityId: r.facilityId,
    facilityName: r.facilityName,
    branchName: r.branchName,
    totalAmount: r.totalAmount,
    freeServices: r.freeServices,
    contracts: r.contracts,
    openRemarks: r.openRemarks,
    avrSentAt: r.avrSentAt,
    createdAt: r.createdAt,
    registeredAt: r.registeredAt,
    version: r.version,
    dueAt: CUSTOMER_VISIBLE_DUE.includes(r.stageCode) ? r.dueAt : null,
    // Решение по технической возможности сообщается Заказчику только после
    // официального ответа (п. 9): до выхода с этапа оценки — «на проверке».
    tvStatus: r.stageCode === 'tv_review' || r.stageCode === 'registered' || r.stageCode === 'draft'
      ? 'pending' : r.tvStatus,
  };
}

/** Договор без служебных реквизитов. */
export function customerContract(c: ContractRow) {
  return {
    id: c.id, number: c.number, service: c.service, subject: c.subject, amount: c.amount,
    signed_at: c.signed_at, invoice_at: c.invoice_at, paid_at: c.paid_at, status: c.status,
    terminated_at: c.terminated_at, refund_amount: c.refund_amount,
  };
}

/**
 * История заявки для Заказчика — смена статусов и этапов без имён
 * сотрудников и внутренних подробностей.
 */
export function customerTimeline(
  history: Record<string, any>[],
  remarks: Record<string, any>[],
): { at: string; title: string; detail: string }[] {
  const out: { at: string; title: string; detail: string }[] = [];
  for (const h of history) {
    const def = stage(h.stage_code as StageCode);
    out.push({
      at: toIsoTimestamp(h.entered_at) ?? toIsoDate(h.entered_at) ?? '',
      title: def.name,
      detail: CUSTOMER_STATUS_NAME[def.customerStatus],
    });
  }
  for (const m of remarks) {
    out.push({ at: toIsoTimestamp(m.created_at) ?? '', title: 'Заявка возвращена на доработку', detail: String(m.text ?? '') });
    if (m.resolved_at) {
      out.push({ at: toIsoTimestamp(m.resolved_at) ?? '', title: 'Замечание устранено', detail: String(m.text ?? '') });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
